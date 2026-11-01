import { DISCLAIMER } from "../disclaimer.js";
import { SafeClientError, UserInputError } from "../errors.js";
import { canonicalAddress } from "./read.js";
import { createTtlCache } from "./cache.js";
import { monthYear, type LegacySource, type PlayerLegacyCard } from "./card.js";
import {
  isHubConsentId,
  matchStoryConsent,
  NOT_AVAILABLE_STATUS,
  NOT_OPTED_IN_STATUS,
  OPT_IN_EXPLANATION,
  STORY_UNAVAILABLE,
  utcDay,
  type StoryOptIn,
} from "../hub/story-optin.js";
import { base58Decode, base58Encode } from "../hub/base58.js";

/** Stories stay in memory at most this long. */
export const STORY_TTL_MS = 10 * 60 * 1000;

/** At most this many stories at once. The oldest entry is dropped past the cap. */
export const STORY_CACHE_MAX = 32;

const LONG_SPAN_MS = 365 * 24 * 60 * 60 * 1000;
const ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,128}$/;
const TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE_LABEL = /^[A-Z][a-z]+ \d{4}$/;

const KNOWN_FACTS = new Set(["profile", "name", "faction", "fleet", "created", "first-activity", "last-activity"]);

/**
 * Band sentences are fixed. A band outside this map is omitted.
 * The card's band string is never copied into the story.
 */
const BAND_TEXT: Readonly<Record<string, string>> = {
  "1–9": "Signatures on the record fall in the 1 to 9 band.",
  "10–99": "Signatures on the record fall in the 10 to 99 band.",
  "100–999": "Signatures on the record fall in the 100 to 999 band.",
  "1,000–9,999": "Signatures on the record fall in the 1,000 to 9,999 band.",
  "10,000 or more": "Signatures on the record fall in the 10,000 or more band.",
  "1 or more": "Signatures on the record fall in the 1 or more band.",
  "10 or more": "Signatures on the record fall in the 10 or more band.",
  "100 or more": "Signatures on the record fall in the 100 or more band.",
  "1,000 or more": "Signatures on the record fall in the 1,000 or more band.",
};

const OPENING: Readonly<Record<StoryShape, string>> = {
  thin: "Short public record. No player profile was found. That's all for now.",
  profile: "Public profile record.",
  faction: "Public faction record.",
  fleets: "Public fleet record.",
  "long-activity": "Public activity record. The first and last signatures are far apart.",
};

const THIN_PARTIAL = "Short public record. No player profile was found. The public read stopped before it finished. That's all for now.";
const UNSOURCED = "Here's what the public chain shows. That's all for now.";
const PARTIAL_NOTE = "The public read stopped before it finished.";

export type StoryShape = "thin" | "profile" | "faction" | "fleets" | "long-activity";

export interface StoryClaim {
  text: string;
  account: string;
  signature: string | null;
}

export interface StoryListing {
  id: string;
  stream: string;
  category: string;
  status: string;
  url: string;
}

export interface StoryLink {
  url: string;
}

export interface StoryListingInput {
  id: string;
  stream: string;
  category: string;
  status: string;
  url: string;
  expiresAt: string;
}

export interface BuiltStory {
  readOnly: true;
  status: "story";
  shape: StoryShape;
  story: string;
  claims: StoryClaim[];
  sources: LegacySource[];
  listings: StoryListing[];
  links?: StoryLink[];
  asOf: string;
  dataMode: "live" | "partial";
  disclaimer: string;
  showLinks: boolean;
}

export interface NotOptedIn {
  readOnly: true;
  status: typeof NOT_OPTED_IN_STATUS;
  explanation: string;
}

export interface StoryUnavailable {
  readOnly: true;
  status: typeof NOT_AVAILABLE_STATUS;
  explanation: string;
}

export type PlayerStoryResult = NotOptedIn | StoryUnavailable | (BuiltStory & { fromCache: boolean });

interface OptInUpdate {
  kind: string;
  hash: string;
  storyOptIn?: StoryOptIn;
}

export interface StoryHubRead {
  hubId: string | null;
  updates: readonly OptInUpdate[];
  listings: readonly unknown[];
}

export interface PlayerStoryDeps {
  playerLegacy(query: { address: string }): Promise<PlayerLegacyCard>;
  /** One read of the pinned hub. Opt-ins and listings come from that same checkout. */
  hub(): Promise<StoryHubRead>;
  now?: () => number;
  cache?: ReturnType<typeof createTtlCache<BuiltStory>>;
}

export function storyShape(card: PlayerLegacyCard): StoryShape {
  if (isThin(card)) return "thin";
  if (longSpan(card)) return "long-activity";
  if (card.fleets.length > 0) return "fleets";
  if (card.profiles.some((profile) => enlisted(profile.faction))) return "faction";
  if (card.profiles.length > 0) return "profile";
  return "thin";
}

/**
 * Plain-language story from one legacy card.
 * Sentences are fixed templates plus counts and dates.
 * Profile names and fleet names are not read.
 */
export function buildPlayerStory(
  card: PlayerLegacyCard,
  options: { showLinks: boolean; listings: readonly StoryListingInput[]; today: string },
): BuiltStory {
  const shape = storyShape(card);
  const claims = shape === "thin" ? thinClaims(card) : richClaims(card, shape);
  const story = claims.length > 0 ? claims.map((claim) => claim.text).join(" ") : UNSOURCED;
  const cited = new Set(claims.map((claim) => claim.account));
  const sources = card.sources
    .filter((source) => cited.has(source.account))
    .map((source) => copySource(source))
    .filter((source) => source.facts.length > 0);
  const listings = shape === "thin" ? [] : relevantListings(options.listings, options.today);
  const links = options.showLinks ? explorerLinks(claims) : undefined;
  return {
    readOnly: true,
    status: "story",
    shape,
    story,
    claims,
    sources,
    listings,
    ...(links && links.length > 0 ? { links } : {}),
    asOf: TIME_PATTERN.test(card.asOf) ? card.asOf : "1970-01-01T00:00:00.000Z",
    dataMode: card.dataMode === "live" ? "live" : "partial",
    disclaimer: DISCLAIMER,
    showLinks: options.showLinks,
  };
}

export function notOptedIn(): NotOptedIn {
  return { readOnly: true, status: NOT_OPTED_IN_STATUS, explanation: OPT_IN_EXPLANATION };
}

export function storyUnavailable(): StoryUnavailable {
  return { readOnly: true, status: NOT_AVAILABLE_STATUS, explanation: STORY_UNAVAILABLE };
}

/**
 * An allow counts only when its signed date is strictly after the latest signed revoke date.
 * The same calendar day goes to the revoke. A player signature already seen is a no-op.
 * A date after `today` does not count.
 */
export function resolveStoryOptIn(
  updates: readonly OptInUpdate[],
  wallet: string,
  options: { hubId: string; today: string },
): { optedIn: boolean; showLinks: boolean; hash: string | null } {
  let winner: { date: string; showLinks: boolean; hash: string } | null = null;
  let maxRevokeDate: string | null = null;
  const seen = new Set<string>();
  for (const update of updates) {
    if (update.kind !== "story-optin" || !update.storyOptIn) continue;
    if (typeof update.hash !== "string" || update.hash.length === 0) continue;
    const opt = update.storyOptIn;
    if (opt.wallet !== wallet || opt.date > options.today) continue;
    const consent = matchStoryConsent(opt, options.hubId);
    if (!consent) continue;
    const signature = signatureKey(opt.signature);
    if (seen.has(signature)) continue;
    seen.add(signature);
    if (opt.action === "revoke") {
      if (maxRevokeDate === null || opt.date > maxRevokeDate) maxRevokeDate = opt.date;
      if (winner && maxRevokeDate !== null && winner.date <= maxRevokeDate) winner = null;
      continue;
    }
    if (maxRevokeDate !== null && opt.date <= maxRevokeDate) continue;
    if (winner && opt.date <= winner.date) continue;
    winner = { date: opt.date, showLinks: consent.showLinks, hash: update.hash };
  }
  if (!winner) return { optedIn: false, showLinks: false, hash: null };
  return { optedIn: true, showLinks: winner.showLinks, hash: winner.hash };
}

function signatureKey(signature: string): string {
  try {
    return base58Encode(base58Decode(signature));
  } catch {
    return signature;
  }
}

export function createPlayerStoryReader(deps: PlayerStoryDeps): (query: { address: string }) => Promise<PlayerStoryResult> {
  const now = deps.now ?? Date.now;
  const cache = deps.cache ?? createTtlCache<BuiltStory>(STORY_TTL_MS, STORY_CACHE_MAX);
  return async ({ address }) => {
    let wallet: string;
    try {
      wallet = canonicalAddress(address);
    } catch (error) {
      if (error instanceof UserInputError) throw error;
      throw new UserInputError("The address is not a Solana address.");
    }
    const today = utcDay(now());
    const bundle = await deps.hub();
    if (!bundle.hubId || !isHubConsentId(bundle.hubId)) return storyUnavailable();
    const decision = resolveStoryOptIn(bundle.updates, wallet, { hubId: bundle.hubId, today });
    if (!decision.optedIn || !decision.hash) return notOptedIn();
    const key = `${wallet}\n${decision.hash}\n${decision.showLinks ? "1" : "0"}`;
    const hit = cache.get(key, now());
    if (hit) return { ...hit, fromCache: true };
    const card = await deps.playerLegacy({ address: wallet });
    if (card.queried.address !== wallet) {
      throw new SafeClientError("The public record did not match this wallet. No story was returned.");
    }
    const story = buildPlayerStory(card, {
      showLinks: decision.showLinks,
      listings: normalizeListings(bundle.listings),
      today,
    });
    cache.set(key, story, now());
    return { ...story, fromCache: false };
  };
}

function thinClaims(card: PlayerLegacyCard): StoryClaim[] {
  const account = card.queried.address;
  const citation =
    cite(card, account, "first-activity") ??
    cite(card, account, "last-activity") ??
    cite(card, account, "profile");
  if (!citation) return [];
  return [
    {
      text: card.dataMode === "partial" ? THIN_PARTIAL : OPENING.thin,
      account: citation.account,
      signature: citation.signature,
    },
  ];
}

function richClaims(card: PlayerLegacyCard, shape: StoryShape): StoryClaim[] {
  const claims: StoryClaim[] = [];
  const opening = openingCitation(card, shape);
  if (opening) claims.push({ text: OPENING[shape], account: opening.account, signature: opening.signature });
  if (card.profiles.length > 0) {
    const profile = card.profiles.find((item) => cite(card, item.address, "profile"));
    const citation = profile ? cite(card, profile.address, "profile") : null;
    if (citation) {
      claims.push({
        text: card.profiles.length === 1 ? "The record includes 1 player profile." : `The record includes ${card.profiles.length} player profiles.`,
        account: citation.account,
        signature: citation.signature,
      });
    }
  }
  for (const profile of card.profiles) {
    const sentence = factionSentence(profile.faction);
    if (!sentence || !profile.factionAccount) continue;
    const citation = cite(card, profile.factionAccount, "faction");
    if (!citation) continue;
    claims.push({ text: sentence, account: citation.account, signature: citation.signature });
  }
  if (card.fleets.length > 0) {
    const fleet = card.fleets.find((item) => cite(card, item.address, "fleet"));
    const citation = fleet ? cite(card, fleet.address, "fleet") : null;
    if (citation) {
      claims.push({
        text: card.fleets.length === 1 ? "The record includes 1 SAGE fleet." : `The record includes ${card.fleets.length} SAGE fleets.`,
        account: citation.account,
        signature: citation.signature,
      });
    }
  }
  const activity = card.activity;
  if (activity) {
    const band = BAND_TEXT[activity.band];
    const bandCite = cite(card, activity.address, "last-activity") ?? cite(card, activity.address, "first-activity");
    if (band && bandCite) claims.push({ text: band, account: bandCite.account, signature: bandCite.signature });
    const first = dateSentence("First seen", activity.firstSeen);
    const firstCite = cite(card, activity.address, "first-activity");
    if (first && firstCite) claims.push({ text: first, account: firstCite.account, signature: firstCite.signature });
    const last = dateSentence("Last seen", activity.lastSeen);
    const lastCite = cite(card, activity.address, "last-activity");
    if (last && lastCite) claims.push({ text: last, account: lastCite.account, signature: lastCite.signature });
  }
  for (const profile of card.profiles) {
    const sentence = dateSentence("A profile record starts in", profile.createdAt);
    const citation = cite(card, profile.address, "created");
    if (!sentence || !citation) continue;
    claims.push({ text: sentence, account: citation.account, signature: citation.signature });
  }
  for (const fleet of card.fleets) {
    const sentence = dateSentence("A fleet record starts in", fleet.createdAt);
    const citation = cite(card, fleet.address, "created");
    if (!sentence || !citation) continue;
    claims.push({ text: sentence, account: citation.account, signature: citation.signature });
  }
  if (card.dataMode === "partial" && claims.length > 0) {
    const anchor = claims[0];
    if (anchor) claims.push({ text: PARTIAL_NOTE, account: anchor.account, signature: anchor.signature });
  }
  return claims;
}

function openingCitation(card: PlayerLegacyCard, shape: StoryShape): { account: string; signature: string | null } | null {
  if (shape === "long-activity" && card.activity) {
    return cite(card, card.activity.address, "first-activity") ?? cite(card, card.activity.address, "last-activity");
  }
  if (shape === "fleets") {
    const fleet = card.fleets.find((item) => cite(card, item.address, "fleet"));
    return fleet ? cite(card, fleet.address, "fleet") : null;
  }
  if (shape === "faction") {
    const profile = card.profiles.find((item) => item.factionAccount && cite(card, item.factionAccount, "faction"));
    return profile?.factionAccount ? cite(card, profile.factionAccount, "faction") : null;
  }
  const profile = card.profiles.find((item) => cite(card, item.address, "profile"));
  return profile ? cite(card, profile.address, "profile") : null;
}

function cite(card: PlayerLegacyCard, account: string, fact: string): { account: string; signature: string | null } | null {
  if (!ADDRESS_PATTERN.test(account)) return null;
  const source = card.sources.find((item) => item.account === account);
  if (!source) return null;
  const match = source.facts.find((item) => item.fact === fact);
  if (!match) return null;
  const signature = match.signature && SIGNATURE_PATTERN.test(match.signature) ? match.signature : null;
  return { account, signature };
}

function copySource(source: LegacySource): LegacySource {
  return {
    account: source.account,
    facts: source.facts
      .filter((fact) => KNOWN_FACTS.has(fact.fact))
      .map((fact) => ({
        fact: fact.fact,
        signature: fact.signature && SIGNATURE_PATTERN.test(fact.signature) ? fact.signature : null,
      })),
  };
}

function explorerLinks(claims: readonly StoryClaim[]): StoryLink[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const claim of claims) {
    pushLink(urls, seen, `https://explorer.solana.com/address/${claim.account}`);
    if (claim.signature) pushLink(urls, seen, `https://explorer.solana.com/tx/${claim.signature}`);
  }
  return urls.map((url) => ({ url }));
}

function pushLink(urls: string[], seen: Set<string>, url: string): void {
  if (seen.has(url)) return;
  seen.add(url);
  urls.push(url);
}

function relevantListings(listings: readonly StoryListingInput[], today: string): StoryListing[] {
  const rows: StoryListing[] = [];
  for (const listing of listings) {
    if (listing.status !== "available" && listing.status !== "inquire_only") continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(listing.expiresAt) || listing.expiresAt < today) continue;
    if (!/^https:\/\/[^\s]+$/.test(listing.url)) continue;
    rows.push({
      id: listing.id,
      stream: listing.stream,
      category: listing.category,
      status: listing.status,
      url: listing.url,
    });
  }
  return rows;
}

function normalizeListings(value: readonly unknown[]): StoryListingInput[] {
  const rows: StoryListingInput[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.stream !== "string" ||
      typeof record.category !== "string" ||
      typeof record.status !== "string" ||
      typeof record.url !== "string" ||
      typeof record.expiresAt !== "string"
    ) {
      continue;
    }
    rows.push({
      id: record.id,
      stream: record.stream,
      category: record.category,
      status: record.status,
      url: record.url,
      expiresAt: record.expiresAt,
    });
  }
  return rows;
}

function factionSentence(faction: string | null): string | null {
  if (faction === "MUD") return "An enlistment with MUD is on the record.";
  if (faction === "ONI") return "An enlistment with ONI is on the record.";
  if (faction === "Ustur") return "An enlistment with Ustur is on the record.";
  return null;
}

function dateSentence(prefix: "First seen" | "Last seen" | "A profile record starts in" | "A fleet record starts in", iso: string | null): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}T/.test(iso)) return null;
  const label = monthYear(iso);
  if (!DATE_LABEL.test(label)) return null;
  return `${prefix} ${label}.`;
}

function enlisted(faction: string | null): boolean {
  return faction === "MUD" || faction === "ONI" || faction === "Ustur";
}

function isThin(card: PlayerLegacyCard): boolean {
  const quiet = !card.activity || (card.activity.band === "none" && card.activity.reachedEnd);
  return card.profiles.length === 0 && card.fleets.length === 0 && quiet;
}

function longSpan(card: PlayerLegacyCard): boolean {
  const activity = card.activity;
  if (!activity?.firstSeen || !activity.lastSeen) return false;
  const start = Date.parse(activity.firstSeen);
  const end = Date.parse(activity.lastSeen);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return end - start >= LONG_SPAN_MS;
}
