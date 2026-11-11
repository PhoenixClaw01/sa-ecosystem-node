import { listListings, readHubUpdates, type HubStoreSource } from "../dao/hub.js";
import { UserInputError } from "../errors.js";
import { signedMeaning } from "../hub/listing.js";
import type { SignerSet } from "../hub/update.js";
import { H2H_CARD, H2H_COMMUNITY_TOOLS } from "./data.generated.js";

/**
 * Read-only H2H bridge feeds (protocol/h2h/SPEC.md sections 5 and 6, code item C5).
 * Nothing here signs, writes, or reads a secret. Markers come only from verified hub records.
 */

export const C4_MARKERS_SCHEMA = "h2h.c4-markers.v1";
export const COMMUNITY_TOOLS_SCHEMA = "h2h.community-tools.v1";
export const H2H_CARD_SCHEMA = "h2h.card.v0";

const MARKER_KINDS = ["listing", "guild", "all"] as const;
type MarkerKind = (typeof MARKER_KINDS)[number];

export interface C4MarkersQuery {
  kind?: string;
  anchored?: boolean;
  stream?: string;
}

type ReadOptions = Parameters<typeof readHubUpdates>[5];

export interface C4Marker {
  id: string;
  kind: "listing" | "guild";
  title: string;
  owner: string | null;
  url: string | null;
  stream: string | null;
  category: string | null;
  status: string | null;
  signer: string;
  approvedBy: string[];
  signedMeaning: string;
  recordHash: string;
  placement: "orbit";
  anchor: { status: "none"; how: null };
}

const MARKERS_DISCLAIMER =
  "Unofficial. Inspired by Star Atlas. These are signed directory records, not game fleets. No marker has coordinates until a signed c4-anchor record exists (code item C1, not built).";

function normalizeMarkersQuery(query: C4MarkersQuery): { kind: MarkerKind; anchored?: boolean; stream?: string } {
  if (query.kind !== undefined && !(MARKER_KINDS as readonly string[]).includes(query.kind)) {
    throw new UserInputError(`Unknown marker kind ${query.kind}.`);
  }
  if (query.anchored !== undefined && typeof query.anchored !== "boolean") throw new UserInputError("anchored must be true or false.");
  if (query.stream !== undefined && (typeof query.stream !== "string" || !/^[a-z_]{1,24}$/.test(query.stream))) {
    throw new UserInputError("stream must be a listing stream id.");
  }
  return {
    kind: (query.kind as MarkerKind | undefined) ?? "all",
    ...(query.anchored !== undefined ? { anchored: query.anchored } : {}),
    ...(query.stream ? { stream: query.stream } : {}),
  };
}

/** Markers for every current listing and guild. Every marker is in orbit: no c4-anchor kind exists yet. */
export async function listC4Markers(
  source: HubStoreSource,
  allowlist: ReadonlySet<string>,
  threshold: number,
  query: C4MarkersQuery = {},
  signerSets?: readonly SignerSet[],
  options?: ReadOptions,
  labels: ReadonlyMap<string, string> = new Map(),
  now: Date = new Date(),
) {
  const q = normalizeMarkersQuery(query);
  const pinned = Boolean(source.repo?.trim() && source.commit?.trim() && source.manifestHash?.trim());
  const markers: C4Marker[] = [];
  let sourceUrl: string | null = null;
  if (pinned && q.anchored !== true) {
    if (q.kind !== "guild") {
      const listings = await listListings(source, allowlist, threshold, q.stream ? { stream: q.stream } : {}, signerSets, options, labels, now);
      sourceUrl = listings.sourceUrl;
      for (const listing of listings.listings) {
        markers.push({
          id: `listing:${listing.id}`,
          kind: "listing",
          title: listing.title,
          owner: listing.owner,
          url: listing.url,
          stream: listing.stream,
          category: listing.category,
          status: listing.status,
          signer: listing.signer,
          approvedBy: [...listing.approvedBy],
          signedMeaning: listing.signedMeaning,
          recordHash: listing.hash,
          placement: "orbit",
          anchor: { status: "none", how: null },
        });
      }
    }
    if (q.kind !== "listing" && !q.stream) {
      const guilds = await readHubUpdates(source, allowlist, threshold, "guild", signerSets, { ...options, now });
      sourceUrl = sourceUrl ?? guilds.sourceUrl;
      for (const update of guilds.updates) {
        if (!update.guild || update.guild.withdrawn || !guilds.picks.has(update.id)) continue;
        const display = labels.get(update.signer) ?? null;
        markers.push({
          id: `guild:${update.id}`,
          kind: "guild",
          title: update.guild.name,
          owner: null,
          url: update.guild.site ?? update.guild.links[0] ?? null,
          stream: null,
          category: null,
          status: null,
          signer: update.signer,
          approvedBy: [...update.approvedBy],
          signedMeaning: signedMeaning(display).replace("this listing", "this guild listing"),
          recordHash: update.hash,
          placement: "orbit",
          anchor: { status: "none", how: null },
        });
      }
    }
  }
  return {
    schema: C4_MARKERS_SCHEMA,
    v: 1,
    generatedAt: now.toISOString(),
    source: pinned
      ? { hubRepo: source.repo?.trim() ?? null, hubCommit: source.commit?.trim() ?? null, manifestHash: source.manifestHash?.trim() ?? null }
      : null,
    realm: { cluster: "zink-ptr", readPackage: null, systemsReadAt: null },
    disclaimer: MARKERS_DISCLAIMER,
    renderers: [] as { stack: string; url: string }[],
    centre: {
      kind: "centre",
      label: null,
      note: "Lore reference only. Not a Council record. No one signs on the Council's behalf. Renderer decides the label.",
    },
    markers,
    note: pinned
      ? "Markers are the current signed listings and guild listings that passed the same signer, threshold, revocation, and manifest-pin checks as hub_updates. Every marker is placement orbit with anchor none, because no c4-anchor record kind exists yet."
      : "HUB_GIT_REPO, HUB_GIT_COMMIT, and HUB_STORE_MANIFEST_HASH are not set. No markers were read, and none were invented.",
    sourceUrl,
  };
}

interface CommunityToolRow {
  id: string;
  name: string;
  url: string;
  what: string;
  license: { spdx: string; note?: string };
  operatedBy: string;
  weOperateIt: boolean;
  h2hCard: string | null;
  addedIn: string | null;
  checkedAt: string;
}

const TOOL_ID = /^[a-z0-9][a-z0-9-]{1,47}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PRICE_OR_REFERRAL = /\$|€|£|\b(?:price|prices|discount|referral|affiliate|airdrop|token sale|guaranteed)\b/i;

function httpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 300) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.includes(".") && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

/** Validate the curated file. A bad row fails the whole feed, so a broken PR cannot ship half a list. */
export function parseCommunityTools(value: unknown): CommunityToolRow[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("community-tools.json must be an object.");
  const record = value as Record<string, unknown>;
  if (record.schema !== COMMUNITY_TOOLS_SCHEMA || !Array.isArray(record.tools) || record.tools.length > 200) {
    throw new Error("community-tools.json does not match h2h.community-tools.v1.");
  }
  const seen = new Set<string>();
  return record.tools.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Tool ${index} is not an object.`);
    const row = entry as Record<string, unknown>;
    const allowed = new Set(["id", "name", "url", "what", "license", "operatedBy", "weOperateIt", "h2hCard", "addedIn", "checkedAt"]);
    for (const key of Object.keys(row)) if (!allowed.has(key)) throw new Error(`Tool ${index} has an unknown field ${key}.`);
    if (typeof row.id !== "string" || !TOOL_ID.test(row.id) || seen.has(row.id)) throw new Error(`Tool ${index} has a missing, invalid, or repeated id.`);
    seen.add(row.id);
    for (const key of ["name", "what", "operatedBy"] as const) {
      const text = row[key];
      if (typeof text !== "string" || text.trim() === "" || text.length > (key === "what" ? 280 : 80)) throw new Error(`Tool ${row.id} has an invalid ${key}.`);
      if (PRICE_OR_REFERRAL.test(text)) throw new Error(`Tool ${row.id} ${key} has a price, referral, or promise word.`);
    }
    if (!httpsUrl(row.url)) throw new Error(`Tool ${row.id} url must be https.`);
    if (row.h2hCard !== null && !httpsUrl(row.h2hCard)) throw new Error(`Tool ${row.id} h2hCard must be https or null.`);
    if (row.addedIn !== null && !httpsUrl(row.addedIn)) throw new Error(`Tool ${row.id} addedIn must be an https PR link or null.`);
    if (typeof row.weOperateIt !== "boolean") throw new Error(`Tool ${row.id} weOperateIt must be true or false.`);
    if (typeof row.checkedAt !== "string" || !DATE.test(row.checkedAt)) throw new Error(`Tool ${row.id} checkedAt must be YYYY-MM-DD.`);
    const license = row.license as Record<string, unknown> | null;
    if (!license || typeof license !== "object" || typeof license.spdx !== "string" || !/^[A-Za-z0-9.+-]{2,40}$/.test(license.spdx)) {
      throw new Error(`Tool ${row.id} license.spdx is missing.`);
    }
    return {
      id: row.id,
      name: row.name as string,
      url: row.url,
      what: row.what as string,
      license: { spdx: license.spdx, ...(typeof license.note === "string" ? { note: license.note } : {}) },
      operatedBy: row.operatedBy as string,
      weOperateIt: row.weOperateIt,
      h2hCard: (row.h2hCard as string | null) ?? null,
      addedIn: (row.addedIn as string | null) ?? null,
      checkedAt: row.checkedAt,
    };
  });
}

export function listCommunityTools(now: Date = new Date()) {
  const tools = parseCommunityTools(H2H_COMMUNITY_TOOLS);
  return {
    schema: COMMUNITY_TOOLS_SCHEMA,
    generatedAt: now.toISOString(),
    tools,
    note: "A curated list in protocol/h2h/community-tools.json. Anyone can add a tool with one pull request, reviewed by a board steward. A row is a pointer, not an endorsement, a referral, or a price. weOperateIt is true only for tools Phoenix runs.",
    howToAdd: "https://github.com/PhoenixClaw01/sa-ecosystem-node/blob/main/protocol/h2h/START-HERE.md",
  };
}

/** Phoenix's own capability card (h2h.card.v0). Static, from protocol/h2h/card.json. */
export function h2hCard(): Record<string, unknown> {
  const card = H2H_CARD as Record<string, unknown>;
  if (card.schema !== H2H_CARD_SCHEMA) throw new Error("protocol/h2h/card.json does not match h2h.card.v0.");
  return card;
}
