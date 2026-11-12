import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

import { base58Decode } from "./base58.js";
import {
  attestationCanonical,
  copyAttestation,
  parseAttestation,
  verifierCanRevoke,
  type AttestationRecord,
  type PriorAttestation,
} from "./attestation.js";
import {
  claimCanonical,
  claimCurrentlyValid,
  claimantGuildAdmission,
  claimantListingAdmission,
  claimIdentityKey,
  copyClaim,
  parseClaim,
  type AdmittedClaim,
  type ClaimRecord,
} from "./claim.js";
import { copyGuild, guildBodyProblem, guildCanonical, parseGuild, type GuildListing } from "./guild.js";
import { copyListing, listingCanonical, listingIdentity, parseListing, type Listing } from "./listing.js";
import { normalizeSearchQuery } from "./search.js";
import {
  copyReputationLink,
  parseReputationLink,
  reputationLinkCanonical,
  type ReputationLink,
} from "./reputation-link.js";
import { copyStoryOptIn, parseStoryOptIn, storyOptInCanonical, type StoryOptIn } from "./story-optin.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PUBLIC_KEY_LENGTH = 32;
const ED25519_SIGNATURE_LENGTH = 64;

/**
 * Hub update schema sa-ecosystem-node.hub-update.v1.
 * The signed bytes are HUB_UPDATE_DOMAIN plus the canonical payload.
 * `signature` is not part of those bytes. `prev` is the sha256 hex of the
 * previous payload's canonical JSON, or null for the first update.
 */
export const HUB_UPDATE_SCHEMA = "sa-ecosystem-node.hub-update.v1";
export const HUB_UPDATE_DOMAIN = "sa-ecosystem-node:hub-update:v1\n";
/** Approvers sign this prefix plus the payload's canonical sha256 hex. */
export const HUB_APPROVAL_DOMAIN = "sa-ecosystem-node:hub-approval:v1\n";
export const HUB_UPDATE_KINDS = ["announcement", "proposal-note", "payment-note", "status", "signer-change", "listing", "guild", "story-optin", "claim", "attestation", "reputation-link"] as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const TX_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,128}$/;
const BODY_MAX = 4_000;
const TXS_MAX = 20;

export type HubUpdateKind = (typeof HUB_UPDATE_KINDS)[number];

const SET_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** One allowlist a node has chosen to trust. Membership can change only inside verifyHubUpdates. */
export interface SignerSet {
  id: string;
  threshold: number;
  publicKeys: ReadonlySet<string>;
}

/** Adding or removing one public key in a named signer set. */
export interface SignerChange {
  op: "add" | "remove";
  publicKey: string;
  set: string;
}

export interface HubUpdatePayload {
  v: 1;
  id: string;
  created_at: string;
  author: string;
  kind: HubUpdateKind;
  body: string;
  refs: {
    pip: string | null;
    txs: string[];
  };
  prev: string | null;
  /** Present only when kind is signer-change. Omitted from the canonical bytes otherwise. */
  change?: SignerChange;
  /** Present only when kind is listing. Omitted from the canonical bytes otherwise. */
  listing?: Listing;
  /** Present only when kind is guild. Omitted from the canonical bytes otherwise. */
  guild?: GuildListing;
  /** Present only when kind is story-optin. Omitted from the canonical bytes otherwise. */
  storyOptIn?: StoryOptIn;
  /** Present only when kind is reputation-link. Omitted from the canonical bytes otherwise. */
  reputationLink?: ReputationLink;
  /** Present only when kind is claim. Omitted from the canonical bytes otherwise. */
  claim?: ClaimRecord;
  /** Present only when kind is attestation. Omitted from the canonical bytes otherwise. */
  attestation?: AttestationRecord;
}

export interface HubApproval {
  publicKey: string;
  signature: string;
}

export interface SignedHubDocument {
  payload: HubUpdatePayload;
  signature: string;
  approvals: HubApproval[];
}

export interface VerifiedHubUpdate extends HubUpdatePayload {
  verified: true;
  hash: string;
  signature: string;
  signer: string;
  /** `self` means the author signature admitted the update without allowlist membership. */
  signerAllowlist: "allowed" | "self";
  /** True when a claim collected enough allowlisted approvals to count as a curator countersign. */
  countersigned?: boolean;
  approvalCount: number;
  /**
   * Author plus every approval public key whose detached signature verified.
   * This includes the author when that wallet did not count as an approver.
   */
  signedBy: string[];
  /** Approval public keys that counted toward the threshold, sorted. The author is omitted when that approval does not count. */
  approvedBy: string[];
  /** True when the author key is the only key with a valid approval signature. */
  selfApproved: boolean;
  /**
   * Present on `story-optin` and `reputation-link`. `valid` means the player signature matches this hub.
   * It does not mean this sentence is the one currently shown. `inert` means it does not match.
   */
  consent?: "valid" | "inert";
  /**
   * Present on `reputation-link` only. True when this update is a scope still shown
   * for its wallet and profile. An unlink, a same-day second link, a future date,
   * and an inert signature are false. History stays in the chain either way.
   */
  linkShown?: boolean;
  /** Set at read time on the current public row when an active claim covers it. Not signed. */
  claimed?: true;
}

export interface RejectedHubUpdate {
  id: string | null;
  reason:
    | "malformed"
    | "bad_signature"
    | "unknown_signer"
    | "revoked_signer"
    | "below_threshold"
    | "broken_chain"
    | "replayed_id"
    | "self_add"
    | "replay"
    | "drops_below_threshold"
    | "untrusted_set"
    | "claim_scope";
}

type Canonical = null | boolean | number | string | Canonical[] | { [key: string]: Canonical };

function canonicalJson(value: Canonical): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Canonical JSON only accepts safe integers.");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as Canonical)}`).join(",")}}`;
}

/** Sorted keys, no whitespace. This is the document half of the signed message. */
export function canonicalHubPayload(payload: HubUpdatePayload): string {
  const document: { [key: string]: Canonical } = {
    author: payload.author,
    body: payload.body,
    created_at: payload.created_at,
    id: payload.id,
    kind: payload.kind,
    prev: payload.prev,
    refs: {
      pip: payload.refs.pip,
      txs: payload.refs.txs,
    },
    v: payload.v,
  };
  if (payload.kind === "signer-change" && payload.change) {
    document.change = {
      op: payload.change.op,
      publicKey: payload.change.publicKey,
      set: payload.change.set,
    };
  }
  if (payload.kind === "listing" && payload.listing) {
    document.listing = listingCanonical(payload.listing);
  }
  if (payload.kind === "guild" && payload.guild) {
    document.guild = guildCanonical(payload.guild);
  }
  if (payload.kind === "story-optin" && payload.storyOptIn) {
    document.storyOptIn = storyOptInCanonical(payload.storyOptIn);
  }
  if (payload.kind === "reputation-link" && payload.reputationLink) {
    document.reputationLink = reputationLinkCanonical(payload.reputationLink);
  }
  if (payload.kind === "claim" && payload.claim) {
    document.claim = claimCanonical(payload.claim) as Canonical;
  }
  if (payload.kind === "attestation" && payload.attestation) {
    document.attestation = attestationCanonical(payload.attestation);
  }
  return canonicalJson(document);
}

export function hubUpdateSigningMessage(payload: HubUpdatePayload): Uint8Array {
  return new TextEncoder().encode(HUB_UPDATE_DOMAIN + canonicalHubPayload(payload));
}

export function hubUpdateHash(payload: HubUpdatePayload): string {
  return createHash("sha256").update(canonicalHubPayload(payload)).digest("hex");
}

/**
 * UTF-8 text a Solana wallet signs for one approval.
 * Phantom signs these bytes with detached ed25519. This text is not a transaction.
 */
export function hubApprovalMessageText(payload: HubUpdatePayload): string {
  return HUB_APPROVAL_DOMAIN + hubUpdateHash(payload);
}

/** Detached approval message. Every approver signs this same canonical hash. */
export function hubApprovalSigningMessage(payload: HubUpdatePayload): Uint8Array {
  return new TextEncoder().encode(hubApprovalMessageText(payload));
}

function isKind(value: string): value is HubUpdateKind {
  return (HUB_UPDATE_KINDS as readonly string[]).includes(value);
}

function validTime(value: string): boolean {
  if (!TIME_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function validAuthor(value: string): boolean {
  try {
    return base58Decode(value).length === 32;
  } catch {
    return false;
  }
}

function validSignature(value: string): boolean {
  try {
    return base58Decode(value).length === ED25519_SIGNATURE_LENGTH;
  } catch {
    return false;
  }
}

function parseSignerChange(value: unknown): SignerChange | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3) return null;
  if (record.op !== "add" && record.op !== "remove") return null;
  if (typeof record.publicKey !== "string" || !validAuthor(record.publicKey)) return null;
  if (typeof record.set !== "string" || !SET_ID_PATTERN.test(record.set)) return null;
  return { op: record.op, publicKey: record.publicKey, set: record.set };
}

/** Fresh payload with txs sorted. Returns null when the value is not schema v1. */
export function parseHubPayload(value: unknown): HubUpdatePayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const baseKeys = ["author", "body", "created_at", "id", "kind", "prev", "refs", "v"];
  if (baseKeys.some((key) => !keys.includes(key))) return null;
  const extra = keys.filter((key) => !baseKeys.includes(key));
  if (extra.length > 1) return null;
  const extraKey = extra[0];
  if (
    extraKey !== undefined &&
    extraKey !== "change" &&
    extraKey !== "listing" &&
    extraKey !== "guild" &&
    extraKey !== "storyOptIn" &&
    extraKey !== "reputationLink" &&
    extraKey !== "claim" &&
    extraKey !== "attestation"
  ) {
    return null;
  }
  if (record.v !== 1) return null;
  if (typeof record.id !== "string" || !ID_PATTERN.test(record.id)) return null;
  if (typeof record.created_at !== "string" || !validTime(record.created_at)) return null;
  if (typeof record.author !== "string" || !validAuthor(record.author)) return null;
  if (typeof record.kind !== "string" || !isKind(record.kind)) return null;
  if (typeof record.body !== "string" || record.body.length === 0 || record.body.length > BODY_MAX) return null;
  if (record.prev !== null && (typeof record.prev !== "string" || !HASH_PATTERN.test(record.prev))) return null;
  if (!record.refs || typeof record.refs !== "object" || Array.isArray(record.refs)) return null;
  const refs = record.refs as Record<string, unknown>;
  if (Object.keys(refs).length !== 2) return null;
  if (refs.pip !== null && (typeof refs.pip !== "string" || !ID_PATTERN.test(refs.pip))) return null;
  if (!Array.isArray(refs.txs) || refs.txs.length > TXS_MAX) return null;
  if (refs.txs.some((tx) => typeof tx !== "string" || !TX_PATTERN.test(tx))) return null;
  const txs = [...refs.txs] as string[];
  if (new Set(txs).size !== txs.length) return null;
  txs.sort();
  let change: SignerChange | undefined;
  let listing: Listing | undefined;
  let guild: GuildListing | undefined;
  let storyOptIn: StoryOptIn | undefined;
  let reputationLink: ReputationLink | undefined;
  let claim: ClaimRecord | undefined;
  let attestation: AttestationRecord | undefined;
  if (record.kind === "signer-change") {
    if (extraKey !== "change") return null;
    change = parseSignerChange(record.change) ?? undefined;
    if (!change) return null;
  } else if (record.kind === "listing") {
    if (extraKey !== "listing") return null;
    listing = parseListing(record.listing) ?? undefined;
    if (!listing) return null;
  } else if (record.kind === "guild") {
    if (extraKey !== "guild") return null;
    guild = parseGuild(record.guild) ?? undefined;
    if (!guild || guildBodyProblem(record.body)) return null;
  } else if (record.kind === "story-optin") {
    if (extraKey !== "storyOptIn") return null;
    storyOptIn = parseStoryOptIn(record.storyOptIn) ?? undefined;
    if (!storyOptIn) return null;
  } else if (record.kind === "reputation-link") {
    if (extraKey !== "reputationLink") return null;
    reputationLink = parseReputationLink(record.reputationLink) ?? undefined;
    if (!reputationLink) return null;
  } else if (record.kind === "claim") {
    if (extraKey !== "claim") return null;
    claim = parseClaim(record.claim) ?? undefined;
    if (!claim) return null;
  } else if (record.kind === "attestation") {
    if (extraKey !== "attestation") return null;
    attestation = parseAttestation(record.attestation) ?? undefined;
    if (!attestation) return null;
  } else if (extraKey !== undefined) {
    return null;
  }
  return {
    v: 1,
    id: record.id,
    created_at: record.created_at,
    author: record.author,
    kind: record.kind,
    body: record.body,
    refs: { pip: refs.pip as string | null, txs },
    prev: record.prev as string | null,
    ...(change ? { change } : {}),
    ...(listing ? { listing: copyListing(listing) } : {}),
    ...(guild ? { guild: copyGuild(guild) } : {}),
    ...(storyOptIn ? { storyOptIn: copyStoryOptIn(storyOptIn) } : {}),
    ...(reputationLink ? { reputationLink: copyReputationLink(reputationLink) } : {}),
    ...(claim ? { claim: copyClaim(claim) } : {}),
    ...(attestation ? { attestation: copyAttestation(attestation) } : {}),
  };
}

function parseApprovals(value: unknown): HubApproval[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) return null;
  const approvals: HubApproval[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (Object.keys(record).length !== 2) return null;
    if (typeof record.publicKey !== "string" || !validAuthor(record.publicKey)) return null;
    if (typeof record.signature !== "string" || !validSignature(record.signature)) return null;
    approvals.push({ publicKey: record.publicKey, signature: record.signature });
  }
  return approvals;
}

export function parseSignedHubDocument(value: unknown): SignedHubDocument | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "payload" && key !== "signature" && key !== "approvals")) return null;
  if (!keys.includes("payload") || !keys.includes("signature")) return null;
  if (typeof record.signature !== "string" || !validSignature(record.signature)) return null;
  const payload = parseHubPayload(record.payload);
  if (!payload) return null;
  const approvals = parseApprovals(record.approvals);
  if (!approvals) return null;
  return { payload, signature: record.signature, approvals };
}

export function authorSignatureValid(payload: HubUpdatePayload, signature: string): boolean {
  try {
    return verifyDetached(hubUpdateSigningMessage(payload), base58Decode(signature), base58Decode(payload.author));
  } catch {
    return false;
  }
}

export function approvalSignatureValid(payload: HubUpdatePayload, publicKey: string, signature: string): boolean {
  try {
    return verifyDetached(hubApprovalSigningMessage(payload), base58Decode(signature), base58Decode(publicKey));
  } catch {
    return false;
  }
}

function verifyDetached(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  if (publicKey.length !== ED25519_PUBLIC_KEY_LENGTH) return false;
  if (signature.length !== ED25519_SIGNATURE_LENGTH) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]),
      format: "der",
      type: "spki",
    });
    return cryptoVerify(null, message, key, signature);
  } catch {
    return false;
  }
}

function documentId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const payload = (value as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") return null;
  const id = (payload as { id?: unknown }).id;
  return typeof id === "string" && id.length <= 80 ? id : null;
}

interface Candidate {
  payload: HubUpdatePayload;
  signature: string;
  approvals: HubApproval[];
  hash: string;
  approvalCount: number;
  signedBy: string[];
  approvedBy: string[];
  selfApproved: boolean;
  signerAllowlist: "allowed" | "self";
  countersigned: boolean;
}

interface MutableSignerSet {
  id: string;
  threshold: number;
  publicKeys: Set<string>;
}

type Policy =
  | {
      ok: true;
      approvalCount: number;
      signedBy: string[];
      approvedBy: string[];
      selfApproved: boolean;
      apply?: (sets: MutableSignerSet[]) => void;
      signerAllowlist?: "allowed" | "self";
      countersigned?: boolean;
    }
  | { ok: false; reason: RejectedHubUpdate["reason"] };

interface ChainCursor {
  claims: AdmittedClaim[];
  revoked: Set<string>;
  listingBaseline: Map<string, Listing>;
  guildBaseline: Map<string, GuildListing>;
  attestations: PriorAttestation[];
}

function emptyCursor(): ChainCursor {
  return { claims: [], revoked: new Set(), listingBaseline: new Map(), guildBaseline: new Map(), attestations: [] };
}

function remember(
  cursor: ChainCursor,
  payload: HubUpdatePayload,
  meta: { signerAllowlist: "allowed" | "self"; hubId?: string; nowMs: number },
): void {
  if (payload.kind === "claim" && payload.claim?.action === "revoke" && payload.claim.targetId) {
    const target = cursor.claims.find((claim) => claim.id === payload.claim?.targetId);
    const subject = payload.author === payload.claim.wallet && target?.wallet === payload.author;
    if (meta.signerAllowlist === "allowed" || subject) cursor.revoked.add(payload.claim.targetId);
    cursor.claims = cursor.claims.filter((claim) => !cursor.revoked.has(claim.id));
  }
  if (payload.kind === "claim" && payload.claim?.action === "claim") {
    const identity = claimIdentityKey(payload.claim.identity);
    if (
      identity &&
      !cursor.revoked.has(payload.id) &&
      claimCurrentlyValid(payload.claim, meta.hubId, meta.nowMs)
    ) {
      cursor.claims.push({
        id: payload.id,
        wallet: payload.claim.wallet,
        identity,
        hubId: payload.claim.hubId,
        subject: payload.claim.subject,
        showHandles: payload.claim.showHandles === true,
        ...(payload.claim.playerProfile ? { playerProfile: payload.claim.playerProfile } : {}),
      });
    }
  }
  if (payload.kind === "listing" && payload.listing) {
    const key = listingIdentity(payload.listing);
    if (!cursor.listingBaseline.has(key)) cursor.listingBaseline.set(key, copyListing(payload.listing));
  }
  if (payload.kind === "guild" && payload.guild) {
    const name = normalizeSearchQuery(payload.guild.name);
    const key = name ? `guild:${name}` : "";
    if (key && !cursor.guildBaseline.has(key)) cursor.guildBaseline.set(key, copyGuild(payload.guild));
  }
  if (payload.kind === "attestation" && payload.attestation?.action === "attest") {
    const attestation = payload.attestation;
    const expires = Date.parse(attestation.expiresAt);
    if (meta.hubId && attestation.hubId === meta.hubId && Number.isFinite(expires) && expires > meta.nowMs) {
      cursor.attestations.push({ id: payload.id, author: payload.author });
    }
  }
}

/** Options for one verification pass. Omitted fields keep the testnet defaults. */
export interface VerifyHubUpdatesOptions {
  /**
   * When true, the author's approval counts toward a threshold of 2 or more.
   * Threshold 1 always counts it. A signer-change never counts the author.
   * Default false.
   */
  allowAuthorApproval?: boolean;
  /** Public keys whose approvals do not count. Applied locally, at verify time. */
  revokedSigners?: ReadonlySet<string>;
  /**
   * Normalized https hub id. Claimant listing and guild updates are admitted
   * only when a prior claim in this chain names this id.
   */
  hubId?: string;
  /** Clock for claim and attestation expiry at verify time. Defaults to the current time. */
  now?: Date;
}

function cloneSets(sets: readonly SignerSet[]): MutableSignerSet[] {
  return sets.map((set) => ({
    id: set.id,
    threshold: set.threshold,
    publicKeys: new Set(set.publicKeys),
  }));
}

interface ApprovalSplit {
  counted: string[];
  revoked: string[];
}

function classifyApprovals(
  payload: HubUpdatePayload,
  approvals: readonly HubApproval[],
  allowlist: ReadonlySet<string>,
  excludeAuthor: boolean,
  revoked: ReadonlySet<string>,
): ApprovalSplit {
  const counted: string[] = [];
  const revokedKeys: string[] = [];
  const message = hubApprovalSigningMessage(payload);
  for (const approval of approvals) {
    if (excludeAuthor && approval.publicKey === payload.author) continue;
    if (!allowlist.has(approval.publicKey)) continue;
    if (counted.includes(approval.publicKey) || revokedKeys.includes(approval.publicKey)) continue;
    let signature: Uint8Array;
    let publicKey: Uint8Array;
    try {
      signature = base58Decode(approval.signature);
      publicKey = base58Decode(approval.publicKey);
    } catch {
      continue;
    }
    if (!verifyDetached(message, signature, publicKey)) continue;
    if (revoked.has(approval.publicKey)) revokedKeys.push(approval.publicKey);
    else counted.push(approval.publicKey);
  }
  return { counted, revoked: revokedKeys };
}

/** True when the only valid approval signature belongs to the author. */
function authorIsOnlyApprover(payload: HubUpdatePayload, approvals: readonly HubApproval[]): boolean {
  const keys: string[] = [];
  const message = hubApprovalSigningMessage(payload);
  for (const approval of approvals) {
    if (keys.includes(approval.publicKey)) continue;
    let signature: Uint8Array;
    let publicKey: Uint8Array;
    try {
      signature = base58Decode(approval.signature);
      publicKey = base58Decode(approval.publicKey);
    } catch {
      continue;
    }
    if (!verifyDetached(message, signature, publicKey)) continue;
    keys.push(approval.publicKey);
  }
  return keys.length === 1 && keys[0] === payload.author;
}

function excludeAuthorApproval(threshold: number, allowAuthorApproval: boolean, signerChange: boolean): boolean {
  if (signerChange) return true;
  return threshold >= 2 && !allowAuthorApproval;
}

function thresholdMiss(split: ApprovalSplit): RejectedHubUpdate["reason"] {
  if (split.counted.length > 0) return "below_threshold";
  if (split.revoked.length > 0) return "revoked_signer";
  return "below_threshold";
}

/** Approval keys that counted toward a threshold that was met. */
function countedApprovers(groups: readonly { counted: readonly string[] }[]): string[] {
  return [...new Set(groups.flatMap((group) => group.counted))].sort();
}

/** Author plus every approval key with a valid detached signature, whether or not it counted. */
function walletsThatSigned(payload: HubUpdatePayload, approvals: readonly HubApproval[]): string[] {
  const keys = new Set<string>([payload.author]);
  const message = hubApprovalSigningMessage(payload);
  for (const approval of approvals) {
    let signature: Uint8Array;
    let publicKey: Uint8Array;
    try {
      signature = base58Decode(approval.signature);
      publicKey = base58Decode(approval.publicKey);
    } catch {
      continue;
    }
    if (!verifyDetached(message, signature, publicKey)) continue;
    keys.add(approval.publicKey);
  }
  return [...keys].sort();
}

function countersignOf(
  candidate: Candidate,
  sets: readonly MutableSignerSet[],
  revoked: ReadonlySet<string>,
): { met: boolean; count: number; approvedBy: string[] } {
  const results = sets.map((set) => {
    const split = classifyApprovals(candidate.payload, candidate.approvals, set.publicKeys, true, revoked);
    return { ...split, count: split.counted.length, met: split.counted.length >= set.threshold };
  });
  const passing = results.filter((item) => item.met);
  return {
    met: passing.length > 0,
    count: passing.length > 0 ? Math.max(...passing.map((item) => item.count)) : 0,
    approvedBy: passing.length > 0 ? countedApprovers(passing) : [],
  };
}

function selfAdmission(
  signedBy: string[],
  approvedBy: string[] = [],
  approvalCount = 0,
  countersigned = false,
): Policy {
  return {
    ok: true,
    approvalCount,
    signedBy,
    approvedBy,
    selfApproved: false,
    signerAllowlist: "self",
    ...(countersigned ? { countersigned: true } : {}),
  };
}

function evaluate(
  candidate: Candidate,
  sets: readonly MutableSignerSet[],
  options: { allowAuthorApproval: boolean; revoked: ReadonlySet<string>; hubId?: string; nowMs: number },
  cursor: ChainCursor,
): Policy {
  const signedBy = walletsThatSigned(candidate.payload, candidate.approvals);
  const selfApproved = authorIsOnlyApprover(candidate.payload, candidate.approvals);
  if (candidate.payload.kind === "signer-change") return evaluateSignerChange(candidate, sets, signedBy, selfApproved, options);
  if (candidate.payload.kind === "claim" && candidate.payload.claim) {
    const claim = candidate.payload.claim;
    if (claim.action === "claim") {
      if (candidate.payload.author !== claim.wallet) return { ok: false, reason: "claim_scope" };
      const countersign = countersignOf(candidate, sets, options.revoked);
      return selfAdmission(signedBy, countersign.approvedBy, countersign.count, countersign.met);
    }
    if (claim.action === "revoke" && candidate.payload.author === claim.wallet) return selfAdmission(signedBy);
  }
  if (candidate.payload.kind === "attestation" && candidate.payload.attestation) {
    const attestation = candidate.payload.attestation;
    if (attestation.action === "attest") {
      if (attestation.handle) {
        const consent = cursor.claims.some(
          (claim) => claim.wallet === attestation.wallet && claim.showHandles && claim.hubId === attestation.hubId,
        );
        if (!consent) return { ok: false, reason: "claim_scope" };
      }
      return selfAdmission(signedBy);
    }
    if (attestation.action === "revoke" && candidate.payload.author === attestation.wallet) return selfAdmission(signedBy);
    if (
      attestation.action === "revoke" &&
      verifierCanRevoke(candidate.payload.author, attestation.targetId, cursor.attestations)
    ) {
      return selfAdmission(signedBy);
    }
  }
  const memberships = sets.filter((set) => set.publicKeys.has(candidate.payload.author));
  if (memberships.length === 0) {
    if (candidate.payload.kind === "listing" && candidate.payload.listing) {
      const key = listingIdentity(candidate.payload.listing);
      const reason = claimantListingAdmission(
        candidate.payload.listing,
        candidate.payload.author,
        options.hubId,
        cursor.claims,
        cursor.listingBaseline.get(key),
      );
      return reason === "ok" ? selfAdmission(signedBy) : { ok: false, reason };
    }
    if (candidate.payload.kind === "guild" && candidate.payload.guild) {
      const reason = claimantGuildAdmission(
        candidate.payload.guild,
        candidate.payload.author,
        options.hubId,
        cursor.claims,
        cursor.guildBaseline.get(`guild:${normalizeSearchQuery(candidate.payload.guild.name)}`),
      );
      return reason === "ok" ? selfAdmission(signedBy) : { ok: false, reason };
    }
    return { ok: false, reason: "unknown_signer" };
  }
  const results = memberships.map((set) => {
    const split = classifyApprovals(
      candidate.payload,
      candidate.approvals,
      set.publicKeys,
      excludeAuthorApproval(set.threshold, options.allowAuthorApproval, false),
      options.revoked,
    );
    return { ...split, count: split.counted.length, met: split.counted.length >= set.threshold };
  });
  const passing = results.filter((item) => item.met);
  if (passing.length === 0) {
    if (results.some((item) => item.count > 0)) return { ok: false, reason: "below_threshold" };
    if (results.some((item) => item.revoked.length > 0)) return { ok: false, reason: "revoked_signer" };
    return { ok: false, reason: "below_threshold" };
  }
  // A story-optin or reputation-link whose player signature does not match this
  // hub stays in the chain. Consent is decided later, so a bad signature cannot
  // drop later updates. The daily cap is also decided later, for the same reason.
  return {
    ok: true,
    approvalCount: Math.max(...passing.map((item) => item.count)),
    signedBy,
    approvedBy: countedApprovers(passing),
    selfApproved,
  };
}

function evaluateSignerChange(
  candidate: Candidate,
  sets: readonly MutableSignerSet[],
  signedBy: string[],
  selfApproved: boolean,
  options: { allowAuthorApproval: boolean; revoked: ReadonlySet<string> },
): Policy {
  const change = candidate.payload.change;
  if (!change) return { ok: false, reason: "malformed" };
  if (change.op === "add" && change.publicKey === candidate.payload.author) return { ok: false, reason: "self_add" };
  const set = sets.find((item) => item.id === change.set);
  if (!set) return { ok: false, reason: "untrusted_set" };
  if (!set.publicKeys.has(candidate.payload.author)) return { ok: false, reason: "unknown_signer" };
  if (change.op === "add" && set.publicKeys.has(change.publicKey)) return { ok: false, reason: "replay" };
  if (change.op === "remove" && !set.publicKeys.has(change.publicKey)) return { ok: false, reason: "replay" };
  const nextSize = change.op === "remove" ? set.publicKeys.size - 1 : set.publicKeys.size + 1;
  if (nextSize < set.threshold) return { ok: false, reason: "drops_below_threshold" };
  const split = classifyApprovals(
    candidate.payload,
    candidate.approvals,
    set.publicKeys,
    excludeAuthorApproval(set.threshold, options.allowAuthorApproval, true),
    options.revoked,
  );
  if (split.counted.length < set.threshold) return { ok: false, reason: thresholdMiss(split) };
  return {
    ok: true,
    approvalCount: split.counted.length,
    signedBy,
    approvedBy: countedApprovers([split]),
    selfApproved,
    apply(current) {
      const target = current.find((item) => item.id === set.id);
      if (!target) return;
      if (change.op === "add") target.publicKeys.add(change.publicKey);
      else target.publicKeys.delete(change.publicKey);
    },
  };
}

function toVerified(candidate: Candidate): VerifiedHubUpdate {
  return {
    v: candidate.payload.v,
    id: candidate.payload.id,
    created_at: candidate.payload.created_at,
    author: candidate.payload.author,
    kind: candidate.payload.kind,
    body: candidate.payload.body,
    refs: { pip: candidate.payload.refs.pip, txs: [...candidate.payload.refs.txs] },
    prev: candidate.payload.prev,
    ...(candidate.payload.change ? { change: { ...candidate.payload.change } } : {}),
    ...(candidate.payload.listing ? { listing: copyListing(candidate.payload.listing) } : {}),
    ...(candidate.payload.guild ? { guild: copyGuild(candidate.payload.guild) } : {}),
    ...(candidate.payload.storyOptIn ? { storyOptIn: copyStoryOptIn(candidate.payload.storyOptIn) } : {}),
    ...(candidate.payload.reputationLink ? { reputationLink: copyReputationLink(candidate.payload.reputationLink) } : {}),
    ...(candidate.payload.claim ? { claim: copyClaim(candidate.payload.claim) } : {}),
    ...(candidate.payload.attestation ? { attestation: copyAttestation(candidate.payload.attestation) } : {}),
    verified: true,
    hash: candidate.hash,
    signature: candidate.signature,
    signer: candidate.payload.author,
    signerAllowlist: candidate.signerAllowlist,
    ...(candidate.countersigned ? { countersigned: true as const } : {}),
    approvalCount: candidate.approvalCount,
    signedBy: [...candidate.signedBy],
    approvedBy: [...candidate.approvedBy],
    selfApproved: candidate.selfApproved,
  };
}

/**
 * Fail closed. An update is kept only when the author is on a trusted signer
 * set, the author signature matches, and that set's current threshold of
 * distinct member wallets approved the canonical hash. The author signature
 * is not an approval. At threshold 1 the author's approval counts, and
 * `selfApproved` is true when that key is the only approver. At threshold 2
 * or higher the author's approval does not count unless `allowAuthorApproval`
 * is set. `signedBy` lists the author and every wallet whose signature
 * verified, including an author who did not count as an approver.
 * `approvedBy` lists only the wallets whose approvals counted. A
 * signer-change never counts the author. Approvals from
 * `revokedSigners` do not count. If every valid approval is from a revoked
 * key, the reason is `revoked_signer`. An empty allowlist rejects every
 * update. A repeated approver counts once. Accepted signer-changes update
 * that set before the next link is checked.
 */
export function verifyHubUpdates(
  documents: readonly unknown[],
  allowlist: ReadonlySet<string>,
  threshold: number,
  signerSets?: readonly SignerSet[],
  options?: VerifyHubUpdatesOptions,
): { updates: VerifiedHubUpdate[]; rejected: RejectedHubUpdate[] } {
  const rejected: RejectedHubUpdate[] = [];
  const signed: Candidate[] = [];
  const required = Number.isInteger(threshold) && threshold >= 1 ? threshold : Number.POSITIVE_INFINITY;
  const sets = cloneSets(
    signerSets ?? [{ id: "default", threshold: required, publicKeys: allowlist }],
  );
  const policy = {
    allowAuthorApproval: options?.allowAuthorApproval === true,
    revoked: options?.revokedSigners ?? new Set<string>(),
    ...(options?.hubId ? { hubId: options.hubId } : {}),
    nowMs: options?.now?.getTime() ?? Date.now(),
  };
  const cursor = emptyCursor();
  const initialSets = cloneSets(sets);
  for (const document of documents) {
    const parsed = parseSignedHubDocument(document);
    if (!parsed) {
      rejected.push({ id: documentId(document), reason: "malformed" });
      continue;
    }
    if (!authorSignatureValid(parsed.payload, parsed.signature)) {
      rejected.push({ id: parsed.payload.id, reason: "bad_signature" });
      continue;
    }
    signed.push({
      payload: parsed.payload,
      signature: parsed.signature,
      approvals: parsed.approvals,
      hash: hubUpdateHash(parsed.payload),
      approvalCount: 0,
      signedBy: [],
      approvedBy: [],
      selfApproved: false,
      signerAllowlist: "allowed",
      countersigned: false,
    });
  }

  const byHash = new Map<string, Candidate>();
  for (const candidate of signed) {
    if (byHash.has(candidate.hash)) {
      rejected.push({ id: candidate.payload.id, reason: "replayed_id" });
      continue;
    }
    byHash.set(candidate.hash, candidate);
  }

  const byPrev = new Map<string | null, Candidate[]>();
  for (const candidate of byHash.values()) {
    const list = byPrev.get(candidate.payload.prev) ?? [];
    list.push(candidate);
    byPrev.set(candidate.payload.prev, list);
  }

  const handled = new Set<string>();
  const acceptedIds = new Set<string>();
  const updates: VerifiedHubUpdate[] = [];
  let prev: string | null = null;

  const byAge = (left: Candidate, right: Candidate) => {
    if (left.payload.created_at !== right.payload.created_at) {
      return left.payload.created_at < right.payload.created_at ? -1 : 1;
    }
    return left.payload.id < right.payload.id ? -1 : left.payload.id > right.payload.id ? 1 : 0;
  };

  for (let step = 0; step < byHash.size; step += 1) {
    const children: Candidate[] = (byPrev.get(prev) ?? []).filter((child: Candidate) => !handled.has(child.hash)).sort(byAge);
    if (children.length === 0) break;
    const judged: { child: Candidate; decision: Policy }[] = children.map((child) => ({
      child,
      decision: evaluate(child, sets, policy, cursor),
    }));
    let winnerIndex = -1;
    for (let index = 0; index < judged.length; index += 1) {
      const item = judged[index];
      if (!item || !item.decision.ok || acceptedIds.has(item.child.payload.id)) continue;
      winnerIndex = index;
      break;
    }
    if (winnerIndex === -1) {
      for (const item of judged) {
        handled.add(item.child.hash);
        rejected.push({
          id: item.child.payload.id,
          reason: item.decision.ok ? "replayed_id" : item.decision.reason,
        });
      }
      break;
    }
    const winner: { child: Candidate; decision: Policy } | undefined = judged[winnerIndex];
    if (!winner || !winner.decision.ok) break;
    for (let index = 0; index < judged.length; index += 1) {
      if (index === winnerIndex) continue;
      const item = judged[index];
      if (!item) continue;
      handled.add(item.child.hash);
      if (!item.decision.ok) {
        rejected.push({ id: item.child.payload.id, reason: item.decision.reason });
        continue;
      }
      const replay = item.child.payload.id === winner.child.payload.id || acceptedIds.has(item.child.payload.id);
      rejected.push({ id: item.child.payload.id, reason: replay ? "replayed_id" : "broken_chain" });
    }
    winner.decision.apply?.(sets);
    handled.add(winner.child.hash);
    acceptedIds.add(winner.child.payload.id);
    updates.push(
      toVerified({
        ...winner.child,
        approvalCount: winner.decision.approvalCount,
        signedBy: winner.decision.signedBy,
        approvedBy: winner.decision.approvedBy,
        selfApproved: winner.decision.selfApproved,
        signerAllowlist: winner.decision.signerAllowlist ?? "allowed",
        countersigned: winner.decision.countersigned === true,
      }),
    );
    remember(cursor, winner.child.payload, {
      signerAllowlist: winner.decision.signerAllowlist ?? "allowed",
      hubId: policy.hubId,
      nowMs: policy.nowMs,
    });
    prev = winner.child.hash;
  }

  for (const candidate of byHash.values()) {
    if (handled.has(candidate.hash)) continue;
    if (acceptedIds.has(candidate.payload.id)) {
      rejected.push({ id: candidate.payload.id, reason: "replayed_id" });
      continue;
    }
    const decision = evaluate(candidate, initialSets, policy, cursor);
    rejected.push({ id: candidate.payload.id, reason: decision.ok ? "broken_chain" : decision.reason });
  }

  return { updates, rejected };
}
