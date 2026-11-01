import { isPublicHttpsUrl } from "./https-url.js";
import { copyImage, imageCanonical, inspectImage, type ListingImage } from "./listing.js";

/**
 * Curator-signed guild listing on a hub update of kind `guild`.
 * Public https links and an optional public logo only.
 * There is no member list and no wallet field. A price or a wallet-shaped
 * token is rejected. Unknown fields are rejected. The image, when present,
 * is covered by the same signature as the rest of the object.
 */

const NAME_MAX = 80;
const DESCRIPTION_MAX = 280;
const TAG_MAX = 32;
const TAGS_MAX = 8;
const LINKS_MAX = 8;
const ADDRESS_TOKEN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const FINANCIAL = /%|\b(?:price|prices|percent|percentage|yield|yields)\b/i;

const DISCORD_MAX = 80;
const DISCORD_CODE = /^[A-Za-z0-9-]{2,32}$/;

const GUILD_KEYS = new Set(["description", "discord", "image", "links", "name", "site", "tags", "withdrawn"]);

export interface GuildListing {
  name: string;
  description: string;
  links: string[];
  tags?: string[];
  image?: ListingImage;
  /** Public https page for the group. */
  site?: string;
  /** Discord invite. Only discord.gg or discord.com/invite. */
  discord?: string;
  /** Signed takedown. Search and list tools omit a withdrawn guild. */
  withdrawn?: true;
}

export type GuildFailure = "malformed" | "unknown_field" | "wallet" | "price";

export type GuildInspection = { ok: true; guild: GuildListing } | { ok: false; reason: GuildFailure };

export function guildFailureMessage(reason: GuildFailure): string {
  if (reason === "unknown_field") return "The guild listing has a field the schema does not allow.";
  if (reason === "wallet") return "A guild listing cannot include a wallet address.";
  if (reason === "price") return "A guild listing cannot include a price.";
  return "The guild listing does not match the schema.";
}

export function parseGuild(value: unknown): GuildListing | null {
  const inspected = inspectGuild(value);
  return inspected.ok ? inspected.guild : null;
}

export function inspectGuild(value: unknown): GuildInspection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "malformed" };
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !GUILD_KEYS.has(key))) return { ok: false, reason: "unknown_field" };
  if (!keys.includes("name") || !keys.includes("description") || !keys.includes("links")) return { ok: false, reason: "malformed" };

  const name = plainLine(record.name, NAME_MAX);
  const description = plainLine(record.description, DESCRIPTION_MAX);
  if (!name || !description) return { ok: false, reason: "malformed" };
  const nameProblem = proseProblem(name);
  if (nameProblem) return { ok: false, reason: nameProblem };
  const descriptionProblem = proseProblem(description);
  if (descriptionProblem) return { ok: false, reason: descriptionProblem };

  const links = httpsLinks(record.links);
  if (!links) return { ok: false, reason: "malformed" };
  for (const link of links) {
    const problem = walletProblem(link);
    if (problem) return { ok: false, reason: problem };
  }

  let tags: string[] | undefined;
  if (keys.includes("tags")) {
    const parsed = tagList(record.tags);
    if (!parsed.ok) return parsed;
    tags = parsed.tags;
  }

  let site: string | undefined;
  if (keys.includes("site")) {
    if (!isPublicHttpsUrl(record.site)) return { ok: false, reason: "malformed" };
    const problem = walletProblem(record.site);
    if (problem) return { ok: false, reason: problem };
    site = record.site;
  }
  let discord: string | undefined;
  if (keys.includes("discord")) {
    if (!isDiscordInvite(record.discord)) return { ok: false, reason: "malformed" };
    const problem = walletProblem(record.discord);
    if (problem) return { ok: false, reason: problem };
    discord = record.discord;
  }

  let withdrawn: true | undefined;
  if (keys.includes("withdrawn")) {
    if (record.withdrawn !== true) return { ok: false, reason: "malformed" };
    withdrawn = true;
  }
  if (!withdrawn && links.length === 0 && !site) return { ok: false, reason: "malformed" };

  let image: ListingImage | undefined;
  if (keys.includes("image")) {
    const parsed = inspectImage(record.image);
    if (!parsed.ok) return parsed.reason === "unknown_field" ? { ok: false, reason: "unknown_field" } : { ok: false, reason: "malformed" };
    const altProblem = proseProblem(parsed.image.alt);
    if (altProblem) return { ok: false, reason: altProblem };
    if (parsed.image.link) {
      const linkProblem = walletProblem(parsed.image.link);
      if (linkProblem) return { ok: false, reason: linkProblem };
    }
    image = parsed.image;
  }

  return {
    ok: true,
    guild: {
      name,
      description,
      links,
      ...(tags ? { tags } : {}),
      ...(image ? { image } : {}),
      ...(site ? { site } : {}),
      ...(discord ? { discord } : {}),
      ...(withdrawn ? { withdrawn } : {}),
    },
  };
}

/**
 * A Discord invite and nothing else.
 * `https://discord.gg/<code>` or `https://discord.com/invite/<code>`.
 * No other host, no userinfo, no port, no query, no hash, no extra path.
 */
export function isDiscordInvite(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > DISCORD_MAX || value !== value.trim()) return false;
  if (value.includes("\\") || value.includes("%") || value.includes("@")) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || value !== parsed.href) return false;
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.port) return false;
  const host = parsed.hostname.toLowerCase();
  if (host === "discord.gg") return DISCORD_CODE.test(parsed.pathname.slice(1)) && parsed.pathname.indexOf("/", 1) === -1;
  if (host === "discord.com") {
    const match = /^\/invite\/([A-Za-z0-9-]{2,32})$/.exec(parsed.pathname);
    return match !== null && DISCORD_CODE.test(match[1] ?? "");
  }
  return false;
}

export function copyGuild(guild: GuildListing): GuildListing {
  return {
    name: guild.name,
    description: guild.description,
    links: [...guild.links],
    ...(guild.tags ? { tags: [...guild.tags] } : {}),
    ...(guild.image ? { image: copyImage(guild.image) } : {}),
    ...(guild.site ? { site: guild.site } : {}),
    ...(guild.discord ? { discord: guild.discord } : {}),
    ...(guild.withdrawn ? { withdrawn: true as const } : {}),
  };
}

/** Fields covered by the hub update signature. Optional fields are omitted when absent. */
export function guildCanonical(guild: GuildListing): {
  [key: string]: string | boolean | string[] | ReturnType<typeof imageCanonical>;
} {
  const document: { [key: string]: string | boolean | string[] | ReturnType<typeof imageCanonical> } = {
    description: guild.description,
    links: [...guild.links],
    name: guild.name,
  };
  if (guild.discord) document.discord = guild.discord;
  if (guild.site) document.site = guild.site;
  if (guild.tags) document.tags = [...guild.tags];
  if (guild.withdrawn) document.withdrawn = true;
  if (guild.image) document.image = imageCanonical(guild.image);
  return document;
}

/** Hub update body on a guild listing. Same public-text rule as the guild fields. */
export function guildBodyProblem(body: string): GuildFailure | null {
  return proseProblem(body);
}

function httpsLinks(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > LINKS_MAX) return null;
  const links: string[] = [];
  for (const item of value) {
    if (!isPublicHttpsUrl(item)) return null;
    links.push(item);
  }
  if (new Set(links).size !== links.length) return null;
  return links;
}

function tagList(value: unknown): { ok: true; tags: string[] } | { ok: false; reason: GuildFailure } {
  if (!Array.isArray(value) || value.length === 0 || value.length > TAGS_MAX) return { ok: false, reason: "malformed" };
  const tags: string[] = [];
  for (const item of value) {
    const tag = plainLine(item, TAG_MAX);
    if (!tag) return { ok: false, reason: "malformed" };
    const problem = proseProblem(tag);
    if (problem) return { ok: false, reason: problem };
    tags.push(tag);
  }
  const folded = new Set(tags.map((tag) => tag.toLowerCase()));
  if (folded.size !== tags.length) return { ok: false, reason: "malformed" };
  return { ok: true, tags };
}

function proseProblem(value: string): "wallet" | "price" | null {
  if (FINANCIAL.test(value)) return "price";
  if (containsAddress(value)) return "wallet";
  return null;
}

/** URLs keep a price or a percent. A wallet-shaped token is still refused. */
function walletProblem(value: string): "wallet" | null {
  return containsAddress(value) ? "wallet" : null;
}

function containsAddress(value: string): boolean {
  for (const token of value.split(/[^1-9A-HJ-NP-Za-km-z]+/)) {
    if (ADDRESS_TOKEN.test(token)) return true;
  }
  return false;
}

function hasForbiddenCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127 || code === 0x85 || code === 0xfeff) return true;
    if (code >= 0x200b && code <= 0x200f) return true;
    if (code === 0x2028 || code === 0x2029) return true;
    if (code >= 0x202a && code <= 0x202e) return true;
    if (code >= 0x2066 && code <= 0x2069) return true;
  }
  return false;
}

function plainLine(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > max || value !== value.trim()) return null;
  if (hasForbiddenCharacter(value)) return null;
  return value;
}
