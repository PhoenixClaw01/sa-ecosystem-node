import { isDiscordInvite, type GuildListing } from "./guild.js";
import { isPublicHttpsUrl } from "./https-url.js";
import { listingIdentity, type Listing } from "./listing.js";
import { normalizeSearchQuery } from "./search.js";
import { isHubConsentId } from "./story-optin.js";
import { base58Decode } from "./base58.js";

/**
 * A claimant wallet binds itself to one listing identity.
 * The hub author signature over the canonical payload is the claimant's
 * detached ed25519 signature. Curators countersign with the usual approval
 * list. Unknown fields are rejected.
 *
 * Squatting: a player claim becomes active only with an on-chain profile key
 * and only for a listing id that no curator listing used earlier in the chain,
 * unless curators countersign. A guild or business claim becomes active only
 * when curators countersign. Self-attested X and Discord notes do not activate
 * a claim.
 */

const TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NONCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/;
const LISTING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const X_HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
const DISCORD_HANDLE_PATTERN = /^[A-Za-z0-9._]{2,32}$/;
const DISCORD_SNOWFLAKE = /^\d{17,20}$/;
const NOTE_MAX = 280;

export const CLAIM_ACTIONS = ["claim", "revoke", "resolve"] as const;
export const CLAIM_SUBJECTS = ["player", "guild", "business"] as const;

/** Claim-actions past this index stay in the chain and do not become active. */
export const CLAIM_RESOLVE_CAP = 64;

/** Profile reads attempted for one resolution. Further player claims stay inactive. */
export const PROFILE_CHECK_CAP = 32;

export type ClaimAction = (typeof CLAIM_ACTIONS)[number];
export type ClaimSubject = (typeof CLAIM_SUBJECTS)[number];

export interface ClaimIdentityListing {
  type: "listing";
  listingId: string;
}

export interface ClaimIdentityGuild {
  type: "guild";
  name: string;
}

export type ClaimIdentity = ClaimIdentityListing | ClaimIdentityGuild;

export interface ClaimXProof {
  handle: string;
  proofUrl: string;
}

export interface ClaimDiscordProof {
  note: string;
  handle?: string;
  invite?: string;
}

export interface ClaimRecord {
  action: ClaimAction;
  wallet: string;
  hubId: string;
  nonce: string;
  expiresAt: string;
  subject: ClaimSubject;
  identity: ClaimIdentity;
  playerProfile?: string;
  x?: ClaimXProof;
  discord?: ClaimDiscordProof;
  /** When true, a public read may show the handles the subject put on this claim. */
  showHandles?: true;
  /** Revoke: the claim update id. */
  targetId?: string;
  /** Resolve: the claim update id that should win. */
  resolveId?: string;
}

const CLAIM_KEYS = new Set([
  "action",
  "discord",
  "expiresAt",
  "hubId",
  "identity",
  "nonce",
  "playerProfile",
  "resolveId",
  "showHandles",
  "subject",
  "targetId",
  "wallet",
  "x",
]);

export type ClaimAdmission = "ok" | "unknown_signer" | "claim_scope";

export interface AdmittedClaim {
  id: string;
  wallet: string;
  identity: string;
  hubId: string;
  subject: ClaimSubject;
  showHandles: boolean;
  playerProfile?: string;
}

/** Hub id matches and the claim has not expired. Revocation is applied by the caller. */
export function claimCurrentlyValid(claim: ClaimRecord, hubId: string | undefined, nowMs: number): boolean {
  if (!hubId || claim.hubId !== hubId) return false;
  const expires = Date.parse(claim.expiresAt);
  return Number.isFinite(expires) && expires > nowMs;
}

export function claimIdentityKey(identity: ClaimIdentity): string | null {
  if (identity.type === "listing") return `id:${identity.listingId}`;
  const name = normalizeSearchQuery(identity.name);
  if (!name) return null;
  return `guild:${name}`;
}

export function parseClaim(value: unknown): ClaimRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !CLAIM_KEYS.has(key))) return null;
  if (["action", "expiresAt", "hubId", "identity", "nonce", "subject", "wallet"].some((key) => !keys.includes(key))) {
    return null;
  }
  if (record.action !== "claim" && record.action !== "revoke" && record.action !== "resolve") return null;
  if (record.subject !== "player" && record.subject !== "guild" && record.subject !== "business") return null;
  if (typeof record.wallet !== "string" || !validAddress(record.wallet)) return null;
  if (typeof record.hubId !== "string" || !isHubConsentId(record.hubId)) return null;
  if (typeof record.nonce !== "string" || !NONCE_PATTERN.test(record.nonce)) return null;
  if (typeof record.expiresAt !== "string" || !validTime(record.expiresAt)) return null;
  const identity = parseIdentity(record.identity);
  if (!identity) return null;
  if (record.subject === "guild" && identity.type !== "guild") return null;
  if (record.subject !== "guild" && identity.type !== "listing") return null;

  let playerProfile: string | undefined;
  if (keys.includes("playerProfile")) {
    if (typeof record.playerProfile !== "string" || !validAddress(record.playerProfile)) return null;
    playerProfile = record.playerProfile;
  }
  let x: ClaimXProof | undefined;
  if (keys.includes("x")) {
    const parsed = parseX(record.x);
    if (!parsed) return null;
    x = parsed;
  }
  let discord: ClaimDiscordProof | undefined;
  if (keys.includes("discord")) {
    const parsed = parseDiscord(record.discord);
    if (!parsed) return null;
    discord = parsed;
  }
  let showHandles: true | undefined;
  if (keys.includes("showHandles")) {
    if (record.showHandles !== true) return null;
    showHandles = true;
  }
  let targetId: string | undefined;
  if (keys.includes("targetId")) {
    if (typeof record.targetId !== "string" || !LISTING_ID_PATTERN.test(record.targetId)) return null;
    targetId = record.targetId;
  }
  let resolveId: string | undefined;
  if (keys.includes("resolveId")) {
    if (typeof record.resolveId !== "string" || !LISTING_ID_PATTERN.test(record.resolveId)) return null;
    resolveId = record.resolveId;
  }
  if (record.action === "revoke" && !targetId) return null;
  if (record.action !== "revoke" && targetId) return null;
  if (record.action === "resolve" && !resolveId) return null;
  if (record.action !== "resolve" && resolveId) return null;

  return {
    action: record.action,
    wallet: record.wallet,
    hubId: record.hubId,
    nonce: record.nonce,
    expiresAt: record.expiresAt,
    subject: record.subject,
    identity,
    ...(playerProfile ? { playerProfile } : {}),
    ...(x ? { x } : {}),
    ...(discord ? { discord } : {}),
    ...(showHandles ? { showHandles } : {}),
    ...(targetId ? { targetId } : {}),
    ...(resolveId ? { resolveId } : {}),
  };
}

export function copyClaim(claim: ClaimRecord): ClaimRecord {
  return {
    action: claim.action,
    wallet: claim.wallet,
    hubId: claim.hubId,
    nonce: claim.nonce,
    expiresAt: claim.expiresAt,
    subject: claim.subject,
    identity:
      claim.identity.type === "listing"
        ? { type: "listing", listingId: claim.identity.listingId }
        : { type: "guild", name: claim.identity.name },
    ...(claim.playerProfile ? { playerProfile: claim.playerProfile } : {}),
    ...(claim.x ? { x: { handle: claim.x.handle, proofUrl: claim.x.proofUrl } } : {}),
    ...(claim.discord
      ? {
          discord: {
            note: claim.discord.note,
            ...(claim.discord.handle ? { handle: claim.discord.handle } : {}),
            ...(claim.discord.invite ? { invite: claim.discord.invite } : {}),
          },
        }
      : {}),
    ...(claim.showHandles ? { showHandles: true as const } : {}),
    ...(claim.targetId ? { targetId: claim.targetId } : {}),
    ...(claim.resolveId ? { resolveId: claim.resolveId } : {}),
  };
}

type ClaimCanonical = string | boolean | { [key: string]: ClaimCanonical } | undefined;

/** Fields covered by the hub update signature. Optional fields are omitted when absent. */
export function claimCanonical(claim: ClaimRecord): { [key: string]: ClaimCanonical } {
  const identity: { [key: string]: string } =
    claim.identity.type === "listing"
      ? { listingId: claim.identity.listingId, type: "listing" }
      : { name: claim.identity.name, type: "guild" };
  const document: { [key: string]: ClaimCanonical } = {
    action: claim.action,
    expiresAt: claim.expiresAt,
    hubId: claim.hubId,
    identity,
    nonce: claim.nonce,
    subject: claim.subject,
    wallet: claim.wallet,
  };
  if (claim.discord) {
    const discord: { [key: string]: string } = { note: claim.discord.note };
    if (claim.discord.handle) discord.handle = claim.discord.handle;
    if (claim.discord.invite) discord.invite = claim.discord.invite;
    document.discord = discord;
  }
  if (claim.playerProfile) document.playerProfile = claim.playerProfile;
  if (claim.resolveId) document.resolveId = claim.resolveId;
  if (claim.showHandles) document.showHandles = true;
  if (claim.targetId) document.targetId = claim.targetId;
  if (claim.x) document.x = { handle: claim.x.handle, proofUrl: claim.x.proofUrl };
  return document;
}

export function claimantListingAdmission(
  listing: Listing,
  author: string,
  hubId: string | undefined,
  claims: readonly AdmittedClaim[],
  baseline: Listing | undefined,
): ClaimAdmission {
  const grant = authorizingClaim(claims, author, hubId);
  if (!grant) return "unknown_signer";
  if (!listing.listingId || grant.identity !== listingIdentity(listing)) return "claim_scope";
  if (listing.image && isExternalImage(listing.image.url)) return "claim_scope";
  if (grant.subject === "player" && listing.stream !== "player") return "claim_scope";
  if (!baseline) return "ok";
  if (grant.subject === "player" && listing.url !== baseline.url) return "claim_scope";
  if (listing.stream !== baseline.stream) return "claim_scope";
  if (listing.category !== baseline.category) return "claim_scope";
  if (listing.title !== baseline.title) return "claim_scope";
  if (listing.owner !== baseline.owner) return "claim_scope";
  if ((listing.disclosure ?? "") !== (baseline.disclosure ?? "")) return "claim_scope";
  if ((listing.verifyLiveNote ?? "") !== (baseline.verifyLiveNote ?? "")) return "claim_scope";
  if (proofKey(listing) !== proofKey(baseline)) return "claim_scope";
  if ((listing.listingId ?? "") !== (baseline.listingId ?? "")) return "claim_scope";
  return "ok";
}

export function claimantGuildAdmission(
  guild: GuildListing,
  author: string,
  hubId: string | undefined,
  claims: readonly AdmittedClaim[],
  baseline: GuildListing | undefined,
): ClaimAdmission {
  const grant = authorizingClaim(claims, author, hubId);
  if (!grant) return "unknown_signer";
  const normalized = normalizeSearchQuery(guild.name);
  if (!normalized || grant.identity !== `guild:${normalized}`) return "claim_scope";
  if (guild.image && isExternalImage(guild.image.url)) return "claim_scope";
  if (!baseline) return "ok";
  if (guild.name !== baseline.name) return "claim_scope";
  if (tagKey(guild.tags) !== tagKey(baseline.tags)) return "claim_scope";
  return "ok";
}

function authorizingClaim(
  claims: readonly AdmittedClaim[],
  author: string,
  hubId: string | undefined,
): AdmittedClaim | undefined {
  if (!hubId) return undefined;
  return claims.find((claim) => claim.wallet === author && claim.hubId === hubId);
}

function isExternalImage(url: string): boolean {
  return /^https?:/i.test(url);
}

function proofKey(listing: Listing): string {
  if (!listing.ownershipProof) return "";
  return `${listing.ownershipProof.method}:${listing.ownershipProof.evidenceRef}`;
}

function tagKey(tags: readonly string[] | undefined): string {
  return tags ? tags.join("\n") : "";
}

function parseIdentity(value: unknown): ClaimIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.type === "listing") {
    if (keys.length !== 2 || !keys.includes("listingId") || !keys.includes("type")) return null;
    if (typeof record.listingId !== "string" || !LISTING_ID_PATTERN.test(record.listingId)) return null;
    return { type: "listing", listingId: record.listingId };
  }
  if (record.type === "guild") {
    if (keys.length !== 2 || !keys.includes("name") || !keys.includes("type")) return null;
    if (typeof record.name !== "string" || !plainLine(record.name, 80)) return null;
    if (!normalizeSearchQuery(record.name)) return null;
    return { type: "guild", name: record.name };
  }
  return null;
}

function parseX(value: unknown): ClaimXProof | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("handle") || !keys.includes("proofUrl")) return null;
  if (typeof record.handle !== "string" || !X_HANDLE_PATTERN.test(record.handle)) return null;
  if (!isPublicHttpsUrl(record.proofUrl) || !isPublicPostUrl(record.proofUrl)) return null;
  return { handle: record.handle, proofUrl: record.proofUrl };
}

function isPublicPostUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "x.com" && host !== "twitter.com" && host !== "www.x.com" && host !== "www.twitter.com") return false;
  return /\/status\/[0-9]+$/.test(parsed.pathname);
}

function parseDiscord(value: unknown): ClaimDiscordProof | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "handle" && key !== "invite" && key !== "note")) return null;
  if (!keys.includes("note")) return null;
  const note = plainLine(record.note, NOTE_MAX);
  if (!note) return null;
  let handle: string | undefined;
  if (keys.includes("handle")) {
    if (typeof record.handle !== "string" || !DISCORD_HANDLE_PATTERN.test(record.handle)) return null;
    if (DISCORD_SNOWFLAKE.test(record.handle)) return null;
    handle = record.handle;
  }
  let invite: string | undefined;
  if (keys.includes("invite")) {
    if (!isDiscordInvite(record.invite)) return null;
    invite = record.invite;
  }
  return { note, ...(handle ? { handle } : {}), ...(invite ? { invite } : {}) };
}

function plainLine(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value !== value.trim()) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return null;
  }
  return value;
}

function validTime(value: string): boolean {
  if (!TIME_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function validAddress(value: string): boolean {
  if (!ADDRESS_PATTERN.test(value)) return false;
  try {
    return base58Decode(value).length === 32;
  } catch {
    return false;
  }
}
