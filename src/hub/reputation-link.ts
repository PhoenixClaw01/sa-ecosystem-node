import { createPublicKey, verify as cryptoVerify } from "node:crypto";

import { base58Decode, base58Encode } from "./base58.js";
import { isHubConsentId } from "./story-optin.js";

/**
 * Player reputation link carried on a hub update of kind `reputation-link`.
 * Only the player signs the fixed sentence. The hub author publishes it.
 * The scope is part of the sentence, so a publisher cannot widen it.
 * Unknown fields are rejected. `zprofile` and achievements are not scopes.
 *
 * This is the kind. It does not switch M6 and it does not scope a signer set.
 */

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HUB_ID_PATTERN = /^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?(?:\/[a-z0-9._-]+)+$/;
/** Public profile name. One token, so it cannot change the sentence. */
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,32}$/;

/**
 * One scope per signature. `legacy` is the smallest.
 * A link does not imply any other scope.
 */
export const REPUTATION_SCOPES = ["legacy", "fleets", "guild", "story"] as const;
export type ReputationScope = (typeof REPUTATION_SCOPES)[number];
export const REPUTATION_DEFAULT_SCOPE: ReputationScope = "legacy";

export const REPUTATION_LINK_ACTIONS = ["link", "unlink"] as const;
export type ReputationLinkAction = (typeof REPUTATION_LINK_ACTIONS)[number];

export interface ReputationLink {
  action: ReputationLinkAction;
  wallet: string;
  profile: string;
  date: string;
  signature: string;
}

const LINK_KEYS = new Set(["action", "date", "profile", "signature", "wallet"]);

/**
 * Fixed link sentence. The player signs this text.
 * Scope is one of `legacy`, `fleets`, `guild`, or `story`.
 */
export function reputationLinkMessage(
  wallet: string,
  profile: string,
  hubId: string,
  scope: ReputationScope,
  date: string,
): string {
  return `I link wallet ${wallet} to public profile ${profile} on hub ${hubId}. Scope: ${scope}. Date: ${date}.`;
}

/** Fixed unlink sentence. It hides every scope for that wallet and profile. */
export function reputationUnlinkMessage(wallet: string, profile: string, hubId: string, date: string): string {
  return `I unlink wallet ${wallet} from public profile ${profile} on hub ${hubId}. Date: ${date}.`;
}

/** One line. It names the sentence and the hub update kind. It does not describe a player. */
export const REPUTATION_LINK_EXPLANATION =
  "Sign this message with the wallet and publish a reputation-link hub update: I link wallet <address> to public profile <profile> on hub <id>. Scope: legacy|fleets|guild|story. Date: <YYYY-MM-DD>.";

export function parseReputationLink(value: unknown): ReputationLink | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !LINK_KEYS.has(key))) return null;
  if (["action", "date", "profile", "signature", "wallet"].some((key) => !keys.includes(key))) return null;
  if (record.action !== "link" && record.action !== "unlink") return null;
  if (typeof record.wallet !== "string" || !validWallet(record.wallet)) return null;
  if (typeof record.profile !== "string" || !validProfile(record.profile)) return null;
  if (typeof record.date !== "string" || !validDate(record.date)) return null;
  if (typeof record.signature !== "string" || !validPlayerSignature(record.signature)) return null;
  return {
    action: record.action,
    wallet: record.wallet,
    profile: record.profile,
    date: record.date,
    signature: record.signature,
  };
}

export function copyReputationLink(link: ReputationLink): ReputationLink {
  return {
    action: link.action,
    wallet: link.wallet,
    profile: link.profile,
    date: link.date,
    signature: link.signature,
  };
}

/** Fields covered by the hub author signature. The scope is not here. */
export function reputationLinkCanonical(link: ReputationLink): { [key: string]: string } {
  return {
    action: link.action,
    date: link.date,
    profile: link.profile,
    signature: link.signature,
    wallet: link.wallet,
  };
}

export interface ReputationMatch {
  action: ReputationLinkAction;
  /** Set on a link. An unlink has no scope. */
  scope: ReputationScope | null;
}

/**
 * The signature matches the sentence for this hub only.
 * A link is tried against each scope. The matching sentence is the only scope granted.
 */
export function matchReputationLink(link: ReputationLink, hubId: string): ReputationMatch | null {
  if (!HUB_ID_PATTERN.test(hubId)) return null;
  if (link.action === "unlink") {
    return verifyMessage(reputationUnlinkMessage(link.wallet, link.profile, hubId, link.date), link)
      ? { action: "unlink", scope: null }
      : null;
  }
  if (link.action !== "link") return null;
  for (const scope of REPUTATION_SCOPES) {
    if (verifyMessage(reputationLinkMessage(link.wallet, link.profile, hubId, scope, link.date), link)) {
      return { action: "link", scope };
    }
  }
  return null;
}

export function reputationLinkSignatureValid(link: ReputationLink, hubId: string): boolean {
  return matchReputationLink(link, hubId) !== null;
}

/**
 * Signature and hub check only. A future date, a later unlink, or the daily
 * cap does not change this. `inert` means the signature does not match this hub.
 */
export function reputationLinkConsent(link: ReputationLink, hubId: string): "valid" | "inert" {
  if (!isHubConsentId(hubId)) return "inert";
  return matchReputationLink(link, hubId) ? "valid" : "inert";
}

export interface ReputationUpdate {
  kind: string;
  hash: string;
  reputationLink?: ReputationLink;
}

export interface ActiveReputationLink {
  profile: string;
  scope: ReputationScope;
  date: string;
  hash: string;
}

export interface ResolvedReputationLink {
  /** True when at least one scope is still shown. */
  linked: boolean;
  /** Scopes still shown, across profiles, in `REPUTATION_SCOPES` order. */
  scopes: ReputationScope[];
  profiles: { profile: string; scopes: ReputationScope[] }[];
}

/**
 * What this node should show for one wallet.
 * A link counts only when its date is strictly after the latest unlink for that profile.
 * The same calendar day goes to the unlink, whichever record comes first.
 * One counting link per wallet per UTC day. A second link that day stays in the chain and does not add a scope.
 * A date after `today` does not count. A player signature already seen is a no-op.
 * Callers pass updates in chain order.
 */
export function resolveReputationLink(
  updates: readonly ReputationUpdate[],
  wallet: string,
  options: { hubId: string; today: string },
): ResolvedReputationLink {
  const active = activeReputationLinks(updates, wallet, options);
  const byProfile = new Map<string, ReputationScope[]>();
  for (const item of active) {
    const scopes = byProfile.get(item.profile) ?? [];
    if (!scopes.includes(item.scope)) scopes.push(item.scope);
    byProfile.set(item.profile, scopes);
  }
  const profiles = [...byProfile.entries()].map(([profile, scopes]) => ({
    profile,
    scopes: REPUTATION_SCOPES.filter((scope) => scopes.includes(scope)),
  }));
  const scopeSet = new Set(active.map((item) => item.scope));
  return {
    linked: active.length > 0,
    scopes: REPUTATION_SCOPES.filter((scope) => scopeSet.has(scope)),
    profiles,
  };
}

/** Counting links for one wallet. Hashes identify the hub updates a reader may show. */
export function activeReputationLinks(
  updates: readonly ReputationUpdate[],
  wallet: string,
  options: { hubId: string; today: string },
): ActiveReputationLink[] {
  if (!isHubConsentId(options.hubId)) return [];
  const profiles = new Map<string, ProfileState>();
  const linkDays = new Set<string>();
  const seen = new Set<string>();
  for (const update of updates) {
    if (update.kind !== "reputation-link" || !update.reputationLink) continue;
    if (typeof update.hash !== "string" || update.hash.length === 0) continue;
    const link = update.reputationLink;
    if (link.wallet !== wallet || link.date > options.today) continue;
    const matched = matchReputationLink(link, options.hubId);
    if (!matched) continue;
    const signature = signatureKey(link.signature);
    if (seen.has(signature)) continue;
    seen.add(signature);
    const state = profileState(profiles, link.profile);
    if (matched.action === "unlink" || matched.scope === null) {
      if (state.unlinkDate === null || link.date > state.unlinkDate) state.unlinkDate = link.date;
      hideThrough(state);
      continue;
    }
    if (state.unlinkDate !== null && link.date <= state.unlinkDate) continue;
    if (linkDays.has(link.date)) continue;
    const current = state.scopes.get(matched.scope);
    if (current && link.date <= current.date) continue;
    linkDays.add(link.date);
    state.scopes.set(matched.scope, { date: link.date, hash: update.hash });
  }
  const active: ActiveReputationLink[] = [];
  for (const [profile, state] of profiles) {
    for (const scope of REPUTATION_SCOPES) {
      const current = state.scopes.get(scope);
      if (!current) continue;
      active.push({ profile, scope, date: current.date, hash: current.hash });
    }
  }
  return active;
}

/** Hashes of reputation-link updates that are still shown, for every wallet in the list. */
export function shownReputationLinkHashes(
  updates: readonly ReputationUpdate[],
  options: { hubId: string; today: string },
): Set<string> {
  const wallets = new Set<string>();
  for (const update of updates) {
    if (update.kind === "reputation-link" && update.reputationLink) wallets.add(update.reputationLink.wallet);
  }
  const hashes = new Set<string>();
  for (const wallet of wallets) {
    for (const item of activeReputationLinks(updates, wallet, options)) hashes.add(item.hash);
  }
  return hashes;
}

interface ScopeHit {
  date: string;
  hash: string;
}

interface ProfileState {
  unlinkDate: string | null;
  scopes: Map<ReputationScope, ScopeHit>;
}

function profileState(profiles: Map<string, ProfileState>, profile: string): ProfileState {
  const existing = profiles.get(profile);
  if (existing) return existing;
  const created: ProfileState = { unlinkDate: null, scopes: new Map() };
  profiles.set(profile, created);
  return created;
}

function hideThrough(state: ProfileState): void {
  if (state.unlinkDate === null) return;
  for (const [scope, hit] of state.scopes) {
    if (hit.date <= state.unlinkDate) state.scopes.delete(scope);
  }
}

function signatureKey(signature: string): string {
  try {
    return base58Encode(base58Decode(signature));
  } catch {
    return signature;
  }
}

function verifyMessage(message: string, link: ReputationLink): boolean {
  let signature: Uint8Array;
  let publicKey: Uint8Array;
  try {
    signature = base58Decode(link.signature);
    publicKey = base58Decode(link.wallet);
  } catch {
    return false;
  }
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]),
      format: "der",
      type: "spki",
    });
    return cryptoVerify(null, new TextEncoder().encode(message), key, signature);
  } catch {
    return false;
  }
}

function validWallet(value: string): boolean {
  if (!ADDRESS_PATTERN.test(value)) return false;
  try {
    return base58Decode(value).length === 32;
  } catch {
    return false;
  }
}

function validProfile(value: string): boolean {
  if (PROFILE_NAME_PATTERN.test(value)) return true;
  return validWallet(value);
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
