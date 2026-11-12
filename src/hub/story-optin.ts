import { isIP } from "node:net";

import { base58Decode } from "./base58.js";
import { verifyEd25519Detached } from "./ed25519-verify.js";

/**
 * Player opt-in carried on a hub update of kind `story-optin`.
 * The player signs a fixed sentence. That sentence names the hub and,
 * for an allow, whether explorer links may be shown. The hub author
 * only publishes the signature. Unknown fields are rejected.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Normalized https repository URL. The scheme's colon is required. */
const HUB_ID_PATTERN = /^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?(?:\/[a-z0-9._-]+)+$/;

export const STORY_OPTIN_ACTIONS = ["allow", "revoke"] as const;
export type StoryOptInAction = (typeof STORY_OPTIN_ACTIONS)[number];
export type StoryLinkConsent = "yes" | "no";

export interface StoryOptIn {
  action: StoryOptInAction;
  wallet: string;
  date: string;
  signature: string;
}

const OPTIN_KEYS = new Set(["action", "date", "signature", "wallet"]);

/**
 * Hub id for a consent sentence. It is the pinned `HUB_GIT_REPO`, normalized:
 * lowercase, https only, no userinfo, query, or fragment, no trailing slash, no trailing `.git`.
 * A local path, an http URL, or a URL with credentials is not a hub id.
 * Example: `https://github.com/owner/repo`.
 */
export function normalizeHubRepo(repo: string): string | null {
  const raw = repo.trim();
  if (!raw || raw.startsWith("-") || /\s/.test(raw) || raw.includes("\\") || raw.includes("?") || raw.includes("#")) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.search || parsed.hash) return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || blockedHubHost(host)) return null;
  let path = parsed.pathname;
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  // GitHub treats the owner and repository as case-insensitive, so the path is lowercased.
  // A case-sensitive host would see a different id.
  path = path.toLowerCase();
  if (path.endsWith(".git")) path = path.slice(0, -4);
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2 || segments.some((segment) => segment === "." || segment === "..")) return null;
  const port = parsed.port && parsed.port !== "443" ? `:${parsed.port}` : "";
  const id = `https://${host}${port}/${segments.join("/")}`;
  if (!HUB_ID_PATTERN.test(id)) return null;
  return id;
}

/** True when `value` is already a normalized hub repository URL. */
export function isHubConsentId(value: string): boolean {
  return HUB_ID_PATTERN.test(value) && normalizeHubRepo(value) === value;
}

/** Fixed allow sentence. `links` is `yes` or `no`. The player signs this text. */
export function storyAllowMessage(wallet: string, date: string, hubId: string, links: StoryLinkConsent): string {
  return `I allow sa-ecosystem-node to tell my public Star Atlas story. Wallet: ${wallet}. Date: ${date}. Hub: ${hubId}. Links: ${links}.`;
}

/** Fixed revoke sentence. The player signs this text. */
export function storyRevokeMessage(wallet: string, date: string, hubId: string): string {
  return `I revoke sa-ecosystem-node from telling my public Star Atlas story. Wallet: ${wallet}. Date: ${date}. Hub: ${hubId}.`;
}

export const NOT_OPTED_IN_STATUS = "not opted in";
export const NOT_AVAILABLE_STATUS = "not available";

/** One line. It names the sentence and the hub update kind. It does not describe a player. */
export const OPT_IN_EXPLANATION =
  "Sign this message with the wallet and publish a story-optin hub update: I allow sa-ecosystem-node to tell my public Star Atlas story. Wallet: <address>. Date: <YYYY-MM-DD>. Hub: <id>. Links: yes|no.";

/** Shown when this node has no https hub repository to check the consent against. */
export const STORY_UNAVAILABLE =
  "This node has no pinned https hub repository, so a player story cannot be checked.";

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function parseStoryOptIn(value: unknown): StoryOptIn | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !OPTIN_KEYS.has(key))) return null;
  if (["action", "date", "signature", "wallet"].some((key) => !keys.includes(key))) return null;
  if (record.action !== "allow" && record.action !== "revoke") return null;
  if (typeof record.wallet !== "string" || !validWallet(record.wallet)) return null;
  if (typeof record.date !== "string" || !validDate(record.date)) return null;
  if (typeof record.signature !== "string" || !validPlayerSignature(record.signature)) return null;
  return {
    action: record.action,
    wallet: record.wallet,
    date: record.date,
    signature: record.signature,
  };
}

export function copyStoryOptIn(opt: StoryOptIn): StoryOptIn {
  return {
    action: opt.action,
    wallet: opt.wallet,
    date: opt.date,
    signature: opt.signature,
  };
}

/** Fields covered by the hub author signature. Links and the hub id are not here. */
export function storyOptInCanonical(opt: StoryOptIn): { [key: string]: string } {
  return {
    action: opt.action,
    date: opt.date,
    signature: opt.signature,
    wallet: opt.wallet,
  };
}

export interface StoryConsent {
  showLinks: boolean;
}

/**
 * The signature matches the sentence for this hub only.
 * An allow is tried as `Links: yes` and then `Links: no`.
 * The matching sentence decides showLinks. A signature for another hub does not match.
 */
export function matchStoryConsent(opt: StoryOptIn, hubId: string): StoryConsent | null {
  if (!HUB_ID_PATTERN.test(hubId)) return null;
  if (opt.action === "revoke") {
    return verifyMessage(storyRevokeMessage(opt.wallet, opt.date, hubId), opt) ? { showLinks: false } : null;
  }
  if (opt.action !== "allow") return null;
  if (verifyMessage(storyAllowMessage(opt.wallet, opt.date, hubId, "yes"), opt)) return { showLinks: true };
  if (verifyMessage(storyAllowMessage(opt.wallet, opt.date, hubId, "no"), opt)) return { showLinks: false };
  return null;
}

/** True when the signature matches this hub's allow or revoke sentence. */
export function storyOptInSignatureValid(opt: StoryOptIn, hubId: string): boolean {
  return matchStoryConsent(opt, hubId) !== null;
}

/**
 * Signature and hub check only. A future date or a later revoke does not change this.
 * `inert` means the signature does not match this hub, so it is not consent.
 */
export function storyOptInConsent(opt: StoryOptIn, hubId: string): "valid" | "inert" {
  if (!isHubConsentId(hubId)) return "inert";
  return matchStoryConsent(opt, hubId) ? "valid" : "inert";
}

function verifyMessage(message: string, opt: StoryOptIn): boolean {
  let signature: Uint8Array;
  let publicKey: Uint8Array;
  try {
    signature = base58Decode(opt.signature);
    publicKey = base58Decode(opt.wallet);
  } catch {
    return false;
  }
  return verifyEd25519Detached(new TextEncoder().encode(message), signature, publicKey);
}

const RESERVED_HOST_SUFFIXES = ["local", "internal", "home.arpa", "lan", "localdomain", "test", "example", "invalid", "localhost"] as const;

function blockedHubHost(host: string): boolean {
  if (!host.includes(".")) return true;
  if (isIP(host) !== 0) return true;
  return RESERVED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function validWallet(value: string): boolean {
  if (!ADDRESS_PATTERN.test(value)) return false;
  try {
    return base58Decode(value).length === 32;
  } catch {
    return false;
  }
}

function validPlayerSignature(value: string): boolean {
  try {
    return base58Decode(value).length === 64;
  } catch {
    return false;
  }
}

function validDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
