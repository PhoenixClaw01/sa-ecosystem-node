import { resolveStoryOptIn } from "../legacy/story.js";
import { pinnedHubLogoUrl, resolveImageUrl, type ImagePin, type ListingImage } from "./listing.js";
import type { StoryOptIn } from "./story-optin.js";
import type { GuildListing } from "./guild.js";
import type { ListingView } from "./listing.js";

/** One search box. Longer text is refused and is not echoed. */
export const SEARCH_QUERY_MAX = 80;

/** How long one search waits for player name reads. Later arrivals are still cached. */
export const SEARCH_PLAYER_BUDGET_MS = 5_000;

/** New name reads started by one search. The legacy gate is not given the whole opt-in list. */
export const SEARCH_NAME_BATCH = 6;

const PLAYER_NAME_TTL_MS = 10 * 60 * 1000;
const PLAYER_NAME_NEGATIVE_TTL_MS = 60_000;
const playerNameCache = new Map<string, { name: string | null; at: number; negative: boolean }>();
const playerNameInFlight = new Map<string, Promise<string | null>>();
let playerNameCursor = 0;

/** Test hook. Production searches share one cache, in-flight map, and rotation cursor. */
export function resetPlayerNameCache(): void {
  playerNameCache.clear();
  playerNameInFlight.clear();
  playerNameCursor = 0;
}

const RESULT_CAP = 40;

export interface SearchImage {
  url: string;
  alt: string;
}

export interface SearchHit {
  kind: "listing" | "guild" | "player";
  name: string;
  link: string;
  description: string;
  image?: SearchImage;
  site?: string;
  discord?: string;
  /** Set when an active claim covers this row. */
  claimed?: true;
}

export interface SearchDoc {
  kind: SearchHit["kind"];
  name: string;
  link: string;
  description: string;
  image?: SearchImage;
  site?: string;
  discord?: string;
  claimed?: true;
  haystack: string;
  /** Required for players. A player without this flag is never returned. */
  optedIn?: boolean;
}

export interface PlayerSearchDocs {
  docs: SearchDoc[];
  truncated: boolean;
}

const CATEGORY_LABEL: Readonly<Record<string, string>> = {
  ip_and_business: "business",
  creators: "creators",
  developers_and_tools: "tools",
  guilds_and_dacs: "guilds groups",
  events: "events",
};

const STREAM_LABEL: Readonly<Record<string, string>> = {
  referral: "referral",
  hybrid: "hybrid",
  irl: "in person",
  player: "player",
};

/** Lowercase, single spaces, control and bidi characters removed. */
export function normalizeSearchQuery(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13) {
      out += " ";
      continue;
    }
    if (code <= 31 || code === 127 || code === 0x85 || code === 0xfeff) continue;
    if (code >= 0x200b && code <= 0x200f) continue;
    if (code === 0x2028 || code === 0x2029) continue;
    if (code >= 0x202a && code <= 0x202e) continue;
    if (code >= 0x2066 && code <= 0x2069) continue;
    out += char;
  }
  return out.replace(/\s+/g, " ").trim().toLowerCase();
}

export function matchSearch(query: string, docs: readonly SearchDoc[]): SearchHit[] {
  const words = query.toLowerCase().split(" ").filter((word) => word.length > 0);
  if (words.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const doc of docs) {
    if (doc.kind === "player" && doc.optedIn !== true) continue;
    const haystack = doc.haystack.toLowerCase();
    if (!words.every((word) => haystack.includes(word))) continue;
    hits.push({
      kind: doc.kind,
      name: doc.name,
      link: doc.link,
      description: doc.description,
      ...(doc.image ? { image: { url: doc.image.url, alt: doc.image.alt } } : {}),
      ...(doc.site ? { site: doc.site } : {}),
      ...(doc.discord ? { discord: doc.discord } : {}),
      ...(doc.claimed ? { claimed: true as const } : {}),
    });
    if (hits.length >= RESULT_CAP) break;
  }
  return hits;
}

export function listingSearchDoc(listing: ListingView, body: string): SearchDoc {
  const description = oneLine(listing.offerText || body || listing.owner);
  const tags = [listing.category, CATEGORY_LABEL[listing.category] ?? "", listing.stream, STREAM_LABEL[listing.stream] ?? ""];
  const haystack = [
    listing.title,
    listing.owner,
    listing.signerDisplayName ?? "",
    listing.offerText ?? "",
    body,
    ...tags,
  ].join(" ");
  return {
    kind: "listing",
    name: listing.title,
    link: listing.url,
    description,
    ...searchImage(listing.image, null),
    ...(listing.claimed ? { claimed: true as const } : {}),
    haystack: normalizeSearchQuery(haystack),
  };
}

/**
 * Newest guild update for each name wins. Pass rows in hub chain order
 * (oldest first, following `prev`). `created_at` is not the order.
 * There is no separate guild-claim signer. A later `withdrawn: true`
 * tombstone removes that name. A live guild still needs site or links;
 * a withdrawn record may omit both.
 */
export function guildSearchDocs(
  guilds: readonly { name: string; guild: GuildListing; claimed?: boolean }[],
  pin: ImagePin | null,
): SearchDoc[] {
  const byName = new Map<string, SearchDoc>();
  for (const row of guilds) {
    const key = normalizeSearchQuery(row.guild.name);
    if (!key) continue;
    if (row.guild.withdrawn) {
      byName.delete(key);
      continue;
    }
    const tags = row.guild.tags ?? [];
    byName.set(key, {
      kind: "guild",
      name: row.guild.name,
      link: row.guild.site || row.guild.links[0] || "",
      description: oneLine(row.guild.description),
      ...searchImage(row.guild.image, pin),
      ...(row.guild.site ? { site: row.guild.site } : {}),
      ...(row.guild.discord ? { discord: row.guild.discord } : {}),
      ...(row.claimed ? { claimed: true as const } : {}),
      haystack: normalizeSearchQuery([row.guild.name, row.guild.description, ...tags].join(" ")),
    });
  }
  return [...byName.values()];
}

export function selectOptedInWallets(
  updates: readonly { kind: string; hash: string; storyOptIn?: StoryOptIn }[],
  hubId: string,
  today: string,
): string[] {
  const wallets = new Set<string>();
  for (const update of updates) {
    if (update.kind === "story-optin" && update.storyOptIn) wallets.add(update.storyOptIn.wallet);
  }
  const chosen: string[] = [];
  for (const wallet of [...wallets].sort()) {
    const decision = resolveStoryOptIn(updates, wallet, { hubId, today });
    if (decision.optedIn) chosen.push(wallet);
  }
  return chosen;
}

export async function playerSearchDocs(
  wallets: readonly string[],
  names: (wallet: string) => Promise<string | null>,
  options?: { budgetMs?: number; now?: () => number },
): Promise<PlayerSearchDocs> {
  const budgetMs = options?.budgetMs ?? SEARCH_PLAYER_BUDGET_MS;
  const now = options?.now ?? Date.now;
  const eligible = [...new Set(wallets.filter((wallet) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)))].sort();
  const known = new Map<string, string | null>();
  const need: string[] = [];
  const time = now();
  for (const wallet of eligible) {
    const hit = playerNameCache.get(wallet);
    const ttl = hit?.negative ? PLAYER_NAME_NEGATIVE_TTL_MS : PLAYER_NAME_TTL_MS;
    if (hit && time - hit.at < ttl) known.set(wallet, hit.name);
    else if (!playerNameInFlight.has(wallet)) need.push(wallet);
  }
  const ordered = rotate(need, playerNameCursor);
  const batch = ordered.slice(0, SEARCH_NAME_BATCH);
  if (need.length > 0) playerNameCursor = (playerNameCursor + batch.length) % need.length;
  const waiting: Promise<{ wallet: string; name: string | null } | null>[] = [];
  for (const wallet of eligible) {
    const running = playerNameInFlight.get(wallet);
    if (running) waiting.push(running.then((name) => ({ wallet, name })));
  }
  for (const wallet of batch) {
    const task = startPlayerLookup(wallet, names, now);
    if (task) waiting.push(task.then((name) => ({ wallet, name })));
  }
  const fresh = await settleWithinBudget(waiting, budgetMs);
  for (const item of fresh) {
    if (item) known.set(item.wallet, item.name);
  }
  for (const wallet of eligible) {
    const hit = playerNameCache.get(wallet);
    const ttl = hit?.negative ? PLAYER_NAME_NEGATIVE_TTL_MS : PLAYER_NAME_TTL_MS;
    if (hit && now() - hit.at < ttl) known.set(wallet, hit.name);
  }
  const docs: SearchDoc[] = [];
  for (const wallet of eligible) {
    const name = known.get(wallet);
    if (!name) continue;
    docs.push({
      kind: "player",
      name,
      link: `#player/${wallet}`,
      description: "Opted in to a public story.",
      haystack: normalizeSearchQuery(name),
      optedIn: true,
    });
  }
  const truncated = eligible.some((wallet) => !known.has(wallet));
  return { docs, truncated };
}

function startPlayerLookup(
  wallet: string,
  names: (wallet: string) => Promise<string | null>,
  now: () => number,
): Promise<string | null> | null {
  const existing = playerNameInFlight.get(wallet);
  if (existing) return existing;
  if (playerNameInFlight.size >= SEARCH_NAME_BATCH) return null;
  const task = names(wallet)
    .then((raw) => {
      const name = cleanDisplayName(raw);
      playerNameCache.set(wallet, { name, at: now(), negative: name === null });
      return name;
    })
    .catch(() => {
      playerNameCache.set(wallet, { name: null, at: now(), negative: true });
      return null;
    })
    .finally(() => {
      if (playerNameInFlight.get(wallet) === task) playerNameInFlight.delete(wallet);
    });
  playerNameInFlight.set(wallet, task);
  return task;
}

/** Waits until the budget or every lookup settles. Late lookups still write the cache. */
async function settleWithinBudget<T>(tasks: readonly Promise<T>[], budgetMs: number): Promise<T[]> {
  if (tasks.length === 0 || budgetMs <= 0) return [];
  const found: T[] = [];
  await new Promise<void>((resolve) => {
    let left = tasks.length;
    const timer = setTimeout(resolve, budgetMs);
    const finish = () => {
      left -= 1;
      if (left <= 0) {
        clearTimeout(timer);
        resolve();
      }
    };
    for (const task of tasks) {
      task.then(
        (value) => {
          found.push(value);
          finish();
        },
        () => finish(),
      );
    }
  });
  return found;
}

function rotate<T>(items: readonly T[], cursor: number): T[] {
  if (items.length === 0) return [];
  const start = ((cursor % items.length) + items.length) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

function searchImage(image: ListingImage | undefined, pin: ImagePin | null): { image?: SearchImage } {
  if (!image) return {};
  const fromSrc = image.src ? pinnedHubLogoUrl(image.src, pin) : null;
  const url = fromSrc ?? resolveImageUrl(image.url, pin);
  if (!url || !pinnedHubLogoUrl(url, pin)) return {};
  return { image: { url, alt: image.alt } };
}

/** Display text with control and bidi characters removed. Case is kept. */
export function cleanDisplayName(value: string | null): string | null {
  if (!value) return null;
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13) {
      out += " ";
      continue;
    }
    if (code <= 31 || code === 127 || code === 0x85 || code === 0xfeff) continue;
    if (code >= 0x200b && code <= 0x200f) continue;
    if (code === 0x2028 || code === 0x2029) continue;
    if (code >= 0x202a && code <= 0x202e) continue;
    if (code >= 0x2066 && code <= 0x2069) continue;
    out += char;
  }
  const cleaned = out.replace(/ {2,}/g, " ").trim();
  if (!cleaned || cleaned.length > 80) return null;
  return cleaned;
}

function oneLine(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > 160 ? cleaned.slice(0, 160).trim() : cleaned;
}
