import type { AttestationRecord } from "./attestation.js";
import {
  CLAIM_RESOLVE_CAP,
  claimIdentityKey,
  PROFILE_CHECK_CAP,
  type ClaimRecord,
  type ClaimSubject,
} from "./claim.js";
import type { ProfileKeyVerdict } from "./claim-profile.js";
import { listingIdentity } from "./listing.js";
import { normalizeSearchQuery } from "./search.js";
import type { VerifiedHubUpdate } from "./update.js";

/**
 * Read-time claim rules.
 * The first eligible claim in hub-chain order wins an identity.
 * A threshold resolve can name a different eligible claim.
 * A player claim needs a matching profile key. A guild or business claim
 * needs a curator countersign. An earlier curator listing also needs that
 * countersign before a player can take it.
 */

export const CLAIM_STATES = [
  "active",
  "pending_countersign",
  "pending_profile",
  "profile_mismatch",
  "needs_profile",
  "expired",
  "revoked",
  "superseded",
  "hub_mismatch",
  "wallet_cap",
  "profile_cap",
  "over_cap",
  "unclaimed",
] as const;

export type ClaimState = (typeof CLAIM_STATES)[number];

export type LinkState = "verified" | "self-attested, unverified" | "expired" | "revoked" | "absent";

export interface ResolvedClaim {
  updateId: string;
  identity: string;
  identityType: "listing" | "guild";
  listingId?: string;
  guildName?: string;
  subject: ClaimSubject;
  wallet: string;
  state: ClaimState;
  active: boolean;
  profile: ProfileKeyVerdict | "absent";
  discord: LinkState;
  x: LinkState;
  showHandles: boolean;
  discordHandle?: string;
  xHandle?: string;
  note: string;
}

export interface ContentPick {
  claimed: boolean;
}

export interface ClaimDirectory {
  claims: ResolvedClaim[];
  /** Update ids that are the current public row for an identity. */
  picks: Map<string, ContentPick>;
}

export interface ResolveClaimsOptions {
  hubId: string;
  now: Date;
  trustedVerifiers?: ReadonlySet<string>;
  profile?: (wallet: string, profile: string, nowMs: number) => Promise<ProfileKeyVerdict>;
}

interface Candidate {
  update: VerifiedHubUpdate;
  claim: ClaimRecord;
  identity: string;
  index: number;
  state: ClaimState;
  eligible: boolean;
  profile: ProfileKeyVerdict | "absent";
  curatorOccupied: boolean;
  needsCountersign: boolean;
}

export async function resolveClaimDirectory(
  updates: readonly VerifiedHubUpdate[],
  options: ResolveClaimsOptions,
): Promise<ClaimDirectory> {
  const trusted = options.trustedVerifiers ?? new Set<string>();
  const candidates = buildCandidates(updates, options.hubId, options.now);
  await applyProfiles(candidates, options.profile, options.now.getTime());
  applyProfileCap(candidates);
  for (const candidate of candidates) {
    if (candidate.state !== "active" || !candidate.needsCountersign || candidate.update.countersigned === true) continue;
    candidate.state = "pending_countersign";
    candidate.eligible = false;
  }
  applyOrder(candidates, updates, options.hubId);
  const rows = attestationRows(updates, options.hubId, trusted, options.now.getTime());
  const claims = candidates.map((candidate) => presentClaim(candidate, rows));
  return { claims, picks: contentPicks(updates, claims) };
}

export function claimStateNote(state: ClaimState): string {
  switch (state) {
    case "active":
      return "This claim is the current one for this identity.";
    case "pending_countersign":
      return "Curators have not countersigned this claim. A guild, a business, or a listing a curator already published waits for that.";
    case "pending_profile":
      return "The player profile could not be checked, so this claim is not active.";
    case "profile_mismatch":
      return "The claimant wallet is not a current key on that player profile.";
    case "needs_profile":
      return "A player claim needs a player profile address.";
    case "expired":
      return "This claim is past its expiry.";
    case "revoked":
      return "This claim was revoked.";
    case "superseded":
      return "An earlier claim, or a curator resolve, already covers this identity.";
    case "hub_mismatch":
      return "This claim names a different hub.";
    case "wallet_cap":
      return "This wallet already has an earlier claim. One wallet keeps one identity.";
    case "profile_cap":
      return "This player profile already backs another identity.";
    case "over_cap":
      return "This claim is past the number of claims this read will activate.";
    case "unclaimed":
      return "No claim covers this identity.";
    default:
      return "This claim is not active.";
  }
}

function curatorListingFacts(updates: readonly VerifiedHubUpdate[]): { occupied: Set<string>; nonPlayer: Set<string> } {
  const occupied = new Set<string>();
  const nonPlayer = new Set<string>();
  for (const update of updates) {
    if (update.kind !== "listing" || !update.listing?.listingId || update.signerAllowlist !== "allowed") continue;
    const key = listingIdentity(update.listing);
    occupied.add(key);
    if (update.listing.stream !== "player") nonPlayer.add(key);
  }
  return { occupied, nonPlayer };
}

function buildCandidates(updates: readonly VerifiedHubUpdate[], hubId: string, now: Date): Candidate[] {
  const facts = curatorListingFacts(updates);
  const firstWallet = new Map<string, string>();
  const revoked = revokedClaimIds(updates, hubId);
  const candidates: Candidate[] = [];
  let validIndex = 0;
  for (const update of updates) {
    if (update.kind !== "claim" || !update.claim || update.claim.action !== "claim") continue;
    const claim = update.claim;
    const identity = claimIdentityKey(claim.identity);
    if (!identity) continue;
    const occupied = facts.occupied.has(identity);
    const needsCountersign = claim.subject !== "player" || occupied || facts.nonPlayer.has(identity);
    const valid = Boolean(hubId) && claim.hubId === hubId && Date.parse(claim.expiresAt) > now.getTime() && !revoked.has(update.id);
    let state: ClaimState;
    if (!hubId || claim.hubId !== hubId) state = "hub_mismatch";
    else if (Date.parse(claim.expiresAt) <= now.getTime()) state = "expired";
    else if (revoked.has(update.id)) state = "revoked";
    else if (validIndex >= CLAIM_RESOLVE_CAP) state = "over_cap";
    else if (firstWallet.get(claim.wallet) !== undefined && firstWallet.get(claim.wallet) !== update.id) state = "wallet_cap";
    else state = subjectState(update, claim, identity);
    if (valid) {
      if (!firstWallet.has(claim.wallet)) firstWallet.set(claim.wallet, update.id);
      validIndex += 1;
    }
    candidates.push({
      update,
      claim,
      identity,
      index: valid ? validIndex - 1 : -1,
      state,
      eligible: state === "active",
      profile: claim.playerProfile ? "unavailable" : "absent",
      curatorOccupied: occupied,
      needsCountersign,
    });
  }
  return candidates;
}

function subjectState(update: VerifiedHubUpdate, claim: ClaimRecord, identity: string): ClaimState {
  if (claim.subject === "player") {
    if (!claim.playerProfile) return "needs_profile";
    return "active";
  }
  if (update.countersigned !== true) return "pending_countersign";
  if (claim.subject === "guild" && !identity.startsWith("guild:")) return "pending_countersign";
  if (claim.subject === "business" && !identity.startsWith("id:")) return "pending_countersign";
  return "active";
}

async function applyProfiles(
  candidates: Candidate[],
  profile: ResolveClaimsOptions["profile"],
  nowMs: number,
): Promise<void> {
  const held = new Set<string>();
  const matched = new Set<string>();
  let checks = 0;
  let remaining = candidates.filter((candidate) => candidate.state === "active" && candidate.claim.playerProfile);
  while (remaining.length > 0 && checks < PROFILE_CHECK_CAP) {
    const round: Candidate[] = [];
    const seen = new Set<string>();
    for (const candidate of remaining) {
      if (matched.has(candidate.identity) || seen.has(candidate.identity)) continue;
      if (held.has(candidate.identity) && candidate.update.countersigned !== true) continue;
      seen.add(candidate.identity);
      if (checks + round.length >= PROFILE_CHECK_CAP) {
        holdProfile(candidate);
        held.add(candidate.identity);
        continue;
      }
      round.push(candidate);
    }
    if (round.length === 0) break;
    checks += round.length;
    await Promise.all(
      round.map(async (candidate) => {
        const profileAddress = candidate.claim.playerProfile ?? "";
        const verdict = profile
          ? await profile(candidate.claim.wallet, profileAddress, nowMs).catch(() => "unavailable" as const)
          : "unavailable";
        candidate.profile = verdict;
        if (verdict === "match") {
          matched.add(candidate.identity);
          return;
        }
        candidate.eligible = false;
        if (verdict === "unavailable") {
          holdProfile(candidate);
          held.add(candidate.identity);
          return;
        }
        candidate.state = "profile_mismatch";
      }),
    );
    remaining = remaining.filter(
      (candidate) =>
        candidate.state === "active" &&
        !matched.has(candidate.identity) &&
        !(held.has(candidate.identity) && candidate.update.countersigned !== true),
    );
  }
  for (const candidate of remaining) {
    if (held.has(candidate.identity) || matched.has(candidate.identity)) continue;
    holdProfile(candidate);
    held.add(candidate.identity);
  }
}

/** One profile backs one identity, and only after that wallet matched the profile. */
function applyProfileCap(candidates: Candidate[]): void {
  const owner = new Map<string, string>();
  for (const candidate of candidates) {
    const profile = candidate.claim.playerProfile;
    if (candidate.profile !== "match" || !profile) continue;
    const prior = owner.get(profile);
    if (prior === undefined) {
      owner.set(profile, candidate.identity);
      continue;
    }
    if (prior === candidate.identity) continue;
    candidate.state = "profile_cap";
    candidate.eligible = false;
  }
}

function holdProfile(candidate: Candidate): void {
  candidate.state = "pending_profile";
  candidate.eligible = false;
  candidate.profile = "unavailable";
}

function applyOrder(candidates: Candidate[], updates: readonly VerifiedHubUpdate[], hubId: string): void {
  const held = new Set(candidates.filter((candidate) => candidate.state === "pending_profile").map((candidate) => candidate.identity));
  const winner = new Map<string, Candidate>();
  for (const candidate of candidates) {
    if (!candidate.eligible) continue;
    if (held.has(candidate.identity) && candidate.update.countersigned !== true) {
      candidate.eligible = false;
      candidate.state = "superseded";
      continue;
    }
    if (!winner.has(candidate.identity)) winner.set(candidate.identity, candidate);
    else {
      candidate.eligible = false;
      candidate.state = "superseded";
    }
  }
  for (const update of updates) {
    if (update.kind !== "claim" || update.claim?.action !== "resolve" || update.signerAllowlist !== "allowed") continue;
    const claim = update.claim;
    if (!claim || claim.hubId !== hubId) continue;
    const named = candidates.find((item) => item.update.id === claim.resolveId);
    if (!named) continue;
    if (!named.eligible && named.state !== "superseded") continue;
    if (claimIdentityKey(claim.identity) !== named.identity) continue;
    if (named.state !== "active" && named.state !== "superseded") continue;
    const current = winner.get(named.identity);
    if (current && current.update.id !== named.update.id) {
      current.eligible = false;
      current.state = "superseded";
    }
    named.eligible = true;
    named.state = "active";
    winner.set(named.identity, named);
  }
  for (const candidate of candidates) {
    if (candidate.state === "active" && winner.get(candidate.identity)?.update.id !== candidate.update.id) {
      candidate.eligible = false;
      candidate.state = "superseded";
    }
  }
}

function presentClaim(candidate: Candidate, rows: readonly AttestationRow[]): ResolvedClaim {
  const claim = candidate.claim;
  const identity = candidate.identity;
  const showHandles = claim.showHandles === true;
  const discord = linkState("discord", claim, rows);
  const x = linkState("x", claim, rows);
  const discordHandle = showHandles ? optedHandle("discord", claim, rows) : undefined;
  const xHandle = showHandles ? optedHandle("x", claim, rows) : undefined;
  return {
    updateId: candidate.update.id,
    identity,
    identityType: claim.identity.type,
    ...(claim.identity.type === "listing" ? { listingId: claim.identity.listingId } : { guildName: claim.identity.name }),
    subject: claim.subject,
    wallet: claim.wallet,
    state: candidate.state,
    active: candidate.state === "active",
    profile: candidate.profile,
    discord,
    x,
    showHandles,
    ...(discordHandle ? { discordHandle } : {}),
    ...(xHandle ? { xHandle } : {}),
    note: claimStateNote(candidate.state),
  };
}

function linkState(method: "discord" | "x", claim: ClaimRecord, rows: readonly AttestationRow[]): LinkState {
  const selfNote = method === "discord" ? Boolean(claim.discord) : Boolean(claim.x);
  const matched = rows.filter((row) => row.wallet === claim.wallet && row.method === method);
  if (matched.some((row) => row.trusted && !row.revoked && !row.expired)) return "verified";
  const subjectAuthored = matched.some(
    (row) => row.author === claim.wallet && !row.trusted && !row.revoked && !row.expired,
  );
  if (selfNote || subjectAuthored) return "self-attested, unverified";
  if (matched.some((row) => row.revoked && (row.trusted || row.author === claim.wallet))) return "revoked";
  if (matched.some((row) => row.expired && (row.trusted || row.author === claim.wallet))) return "expired";
  return "absent";
}

function optedHandle(method: "discord" | "x", claim: ClaimRecord, rows: readonly AttestationRow[]): string | undefined {
  if (method === "discord" && claim.discord?.handle) return claim.discord.handle;
  if (method === "x" && claim.x?.handle) return claim.x.handle;
  return rows.find(
    (row) =>
      row.wallet === claim.wallet &&
      row.method === method &&
      row.handle &&
      row.trusted &&
      !row.revoked &&
      !row.expired,
  )?.handle;
}

interface AttestationRow {
  id: string;
  author: string;
  wallet: string;
  method: "discord" | "x";
  trusted: boolean;
  expired: boolean;
  revoked: boolean;
  handle?: string;
}

function attestationRows(
  updates: readonly VerifiedHubUpdate[],
  hubId: string,
  trusted: ReadonlySet<string>,
  nowMs: number,
): AttestationRow[] {
  const now = nowMs;
  const issued: AttestationRow[] = [];
  for (const update of updates) {
    const attestation = update.attestation;
    if (update.kind !== "attestation" || !attestation || attestation.action !== "attest") continue;
    if (attestation.hubId !== hubId) continue;
    issued.push({
      id: update.id,
      author: update.author,
      wallet: attestation.wallet,
      method: attestation.method,
      trusted: trusted.has(update.author),
      expired: Date.parse(attestation.expiresAt) <= now,
      revoked: false,
      ...(attestation.handle ? { handle: attestation.handle } : {}),
    });
  }
  for (const update of updates) {
    const attestation = update.attestation;
    if (update.kind !== "attestation" || !attestation || attestation.action !== "revoke" || !attestation.targetId) continue;
    if (attestation.hubId !== hubId) continue;
    const target = issued.find((row) => row.id === attestation.targetId);
    if (!target || attestation.wallet !== target.wallet) continue;
    if (!revokeCounts(update, attestation, target)) continue;
    target.revoked = true;
  }
  return issued;
}

function revokeCounts(
  update: VerifiedHubUpdate,
  attestation: AttestationRecord,
  target: AttestationRow,
): boolean {
  if (update.signerAllowlist === "allowed") return true;
  if (update.author === target.wallet && update.author === attestation.wallet) return true;
  return update.author === target.author;
}

function revokedClaimIds(updates: readonly VerifiedHubUpdate[], hubId: string): Set<string> {
  const claims = new Map(
    updates.flatMap((update) =>
      update.kind === "claim" && update.claim?.action === "claim" ? [[update.id, update] as const] : [],
    ),
  );
  const ids = new Set<string>();
  for (const update of updates) {
    const claim = update.claim;
    if (update.kind !== "claim" || !claim || claim.action !== "revoke" || !claim.targetId) continue;
    if (claim.hubId !== hubId) continue;
    const target = claims.get(claim.targetId);
    if (update.signerAllowlist === "allowed") {
      ids.add(claim.targetId);
      continue;
    }
    if (update.signerAllowlist === "self" && update.author === claim.wallet && target?.claim?.wallet === update.author) {
      ids.add(claim.targetId);
    }
  }
  return ids;
}

function contentPicks(updates: readonly VerifiedHubUpdate[], claims: readonly ResolvedClaim[]): Map<string, ContentPick> {
  const active = new Map(claims.filter((claim) => claim.active).map((claim) => [claim.identity, claim]));
  const curator = new Map<string, { id: string; withdrawn: boolean; author: string }>();
  const claimant = new Map<string, { id: string; withdrawn: boolean; author: string }>();
  const seen: string[] = [];
  const remember = (key: string) => {
    if (!seen.includes(key)) seen.push(key);
  };
  for (const update of updates) {
    if (update.kind === "listing" && update.listing) {
      const key = listingIdentity(update.listing);
      remember(key);
      const slot = { id: update.id, withdrawn: update.listing.status === "withdrawn", author: update.author };
      if (update.signerAllowlist === "self") {
        const claim = active.get(key);
        if (claim && claim.wallet === update.author) claimant.set(key, slot);
      } else curator.set(key, slot);
    }
    if (update.kind === "guild" && update.guild) {
      const name = normalizeSearchQuery(update.guild.name);
      if (!name) continue;
      const key = `guild:${name}`;
      remember(key);
      const slot = { id: update.id, withdrawn: update.guild.withdrawn === true, author: update.author };
      if (update.signerAllowlist === "self") {
        const claim = active.get(key);
        if (claim && claim.wallet === update.author) claimant.set(key, slot);
      } else curator.set(key, slot);
    }
  }
  const picks = new Map<string, ContentPick>();
  for (const key of seen) {
    const claim = active.get(key);
    const mine = claimant.get(key);
    const theirs = curator.get(key);
    if (claim && mine) {
      if (!mine.withdrawn) picks.set(mine.id, { claimed: true });
      continue;
    }
    if (theirs && !theirs.withdrawn) picks.set(theirs.id, { claimed: Boolean(claim) });
  }
  return picks;
}
