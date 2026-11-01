import { SafeClientError, UserInputError } from "../errors.js";
import { resolveClaimDirectory, type ClaimDirectory, type ResolvedClaim } from "../hub/claim-resolve.js";
import type { ProfileKeyVerdict } from "../hub/claim-profile.js";
import {
  LISTING_STATUSES,
  LISTING_STREAMS,
  projectListings,
  utcDateStamp,
  viewImage,
  type ImagePin,
  type ListingQuery,
  type ListingStatus,
  type ListingStream,
  type ListingView,
} from "../hub/listing.js";
import {
  guildSearchDocs,
  listingSearchDoc,
  matchSearch,
  normalizeSearchQuery,
  playerSearchDocs,
  SEARCH_QUERY_MAX,
  selectOptedInWallets,
  type SearchHit,
} from "../hub/search.js";
import { normalizeHubRepo, storyOptInConsent } from "../hub/story-optin.js";
import { loadPinnedHubStore, type LoadedHubStore } from "../hub/store.js";
import { createTtlCache } from "../legacy/cache.js";
import { ECOSYSTEM_CATEGORIES, type EcosystemCategory } from "../stubs/hub-update.js";
import {
  HUB_UPDATE_KINDS,
  HUB_UPDATE_SCHEMA,
  verifyHubUpdates,
  type HubUpdateKind,
  type RejectedHubUpdate,
  type SignerSet,
  type VerifiedHubUpdate,
  type VerifyHubUpdatesOptions,
} from "../hub/update.js";

export interface HubReadResult {
  schema: typeof HUB_UPDATE_SCHEMA;
  updates: VerifiedHubUpdate[];
  rejected: RejectedHubUpdate[];
  note: string;
  sourceUrl: string | null;
  /** Normalized https repository URL, or "" when the pin is not one. */
  hubId: string;
  /** Winning public rows. A listing or guild update is shown only when its id is here. */
  picks: Map<string, { claimed: boolean }>;
  claims: ClaimDirectory["claims"];
}

interface HubReadOptions extends VerifyHubUpdatesOptions {
  /** When set, rejected contains only documents whose payload kind is this value. */
  rejectedKind?: HubUpdateKind;
  trustedVerifiers?: ReadonlySet<string>;
  profile?: (wallet: string, profile: string, nowMs: number) => Promise<ProfileKeyVerdict>;
  now?: Date;
}

export interface HubStoreSource {
  repo?: string;
  commit?: string;
  manifestPath?: string;
  manifestHash?: string;
  /** Read manifest.json when the default hub-manifest.json is missing. */
  manifestFallback?: boolean;
}

function isKind(value: string): value is HubUpdateKind {
  return (HUB_UPDATE_KINDS as readonly string[]).includes(value);
}

/** A pinned checkout stays in memory this long. The key is the commit, the manifest hash, and the manifest path. */
export const HUB_PIN_TTL_MS = 60_000;

/** At most this many pinned checkouts. The oldest entry is dropped past the cap. */
export const HUB_PIN_MAX = 8;

const pinCache = createTtlCache<LoadedHubStore>(HUB_PIN_TTL_MS, HUB_PIN_MAX);

function empty(note: string, hubId: string): HubReadResult {
  return { schema: HUB_UPDATE_SCHEMA, updates: [], rejected: [], note, sourceUrl: null, hubId, picks: new Map(), claims: [] };
}

async function loadCachedPinned(pin: {
  repo: string;
  commit: string;
  manifestPath: string;
  manifestHash: string;
  manifestFallback: boolean;
}): Promise<LoadedHubStore> {
  const key = `${pin.repo}\n${pin.commit}\n${pin.manifestHash}\n${pin.manifestPath}\n${pin.manifestFallback ? "1" : "0"}`;
  const hit = pinCache.get(key, Date.now());
  if (hit) return hit;
  const loaded = await loadPinnedHubStore(pin);
  pinCache.set(key, loaded, Date.now());
  return loaded;
}

/**
 * Read signed hub updates from a public git repo pinned to a commit.
 * The manifest hash is checked before any document is verified.
 * An update is returned only when its author is allowlisted and it has
 * at least `threshold` distinct allowlisted approval signatures.
 * An empty allowlist rejects every update.
 */
export async function readHubUpdates(
  source: HubStoreSource,
  allowlist: ReadonlySet<string>,
  threshold: number,
  kind?: string,
  signerSets?: readonly SignerSet[],
  options?: HubReadOptions,
): Promise<HubReadResult> {
  const repo = source.repo?.trim() ?? "";
  const commit = source.commit?.trim() ?? "";
  const manifestHash = source.manifestHash?.trim() ?? "";
  const manifestPath = source.manifestPath?.trim() || "hub-manifest.json";
  if (!repo && !commit && !manifestHash) {
    return empty(
      "HUB_GIT_REPO, HUB_GIT_COMMIT, and HUB_STORE_MANIFEST_HASH are not set. No hub updates were read, and none were invented.",
      "",
    );
  }
  if (!repo || !commit || !manifestHash) {
    throw new SafeClientError("Set HUB_GIT_REPO, HUB_GIT_COMMIT, and HUB_STORE_MANIFEST_HASH together. No updates were read.");
  }
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new SafeClientError("HUB_APPROVAL_THRESHOLD must be a positive integer. No updates were read.");
  }
  if (kind && !isKind(kind)) throw new UserInputError(`Unknown hub update kind ${kind}.`);

  const loaded = await loadCachedPinned({
    repo,
    commit,
    manifestPath,
    manifestHash,
    manifestFallback: source.manifestFallback === true,
  });
  const hubId = normalizeHubRepo(repo) ?? "";
  if (loaded.documents.length === 0) {
    return {
      schema: HUB_UPDATE_SCHEMA,
      updates: [],
      rejected: [],
      note: "The pinned hub store has no updates. None were invented.",
      sourceUrl: loaded.sourceUrl,
      hubId,
      picks: new Map(),
      claims: [],
    };
  }

  const checked = verifyHubUpdates(loaded.documents, allowlist, threshold, signerSets, {
    ...options,
    ...(hubId ? { hubId } : {}),
  });
  const directory = await resolveClaimDirectory(checked.updates, {
    hubId,
    now: options?.now ?? new Date(),
    trustedVerifiers: options?.trustedVerifiers,
    profile: options?.profile,
  });
  const stamped = stampClaimed(selectPublicUpdates(checked.updates, directory.picks), directory);
  const updates = withLogoSrc(
    withStoryConsent(kind ? stamped.filter((update) => update.kind === kind) : stamped, hubId),
    imagePin(source),
  );
  const rejected = options?.rejectedKind
    ? rejectionsForKind(loaded.documents, checked.rejected, options.rejectedKind)
    : checked.rejected;
  return {
    schema: HUB_UPDATE_SCHEMA,
    updates,
    rejected,
    note: "Each returned update is signed by an allowlisted key and has at least the configured number of distinct allowlisted approval signatures over its canonical hash, or it is a claimant listing or guild update covered by an active claim. signedBy lists the author and every wallet whose signature verified, including an author who did not count as an approver. approvedBy lists only the wallets whose approvals counted toward the threshold. selfApproved is true when the author key is the only approver. At threshold 1 that is allowed. At threshold 2 or higher the author approval does not count unless the node allows it. A public key on the local revoked-signer list does not count, and an update whose only valid approvals are from revoked keys is revoked_signer. Revoking a whole signer group is not implemented. A signer-change is applied only after that many other current signers of the named set approve it. Claims and attestations are left out of this list. A claimant update is left out unless that claim is active. The manifest hash matched the pin. Items that failed those checks were left out.",
    sourceUrl: loaded.sourceUrl,
    hubId,
    picks: directory.picks,
    claims: directory.claims,
  };
}

/** Public hub_updates rows. Claims, attestations, and inactive claimant edits are left out. */
export function selectPublicUpdates(
  updates: readonly VerifiedHubUpdate[],
  picks: ReadonlyMap<string, { claimed: boolean }>,
): VerifiedHubUpdate[] {
  return updates.filter((update) => {
    if (update.kind === "claim" || update.kind === "attestation") return false;
    if (update.signerAllowlist !== "self") return true;
    return (update.kind === "listing" || update.kind === "guild") && picks.get(update.id)?.claimed === true;
  });
}

function stampClaimed(updates: readonly VerifiedHubUpdate[], directory: ClaimDirectory): VerifiedHubUpdate[] {
  return updates.map((update) => {
    const pick = directory.picks.get(update.id);
    if (!pick?.claimed) return update;
    return { ...update, claimed: true as const };
  });
}

/** Marks each story-optin. Other kinds are unchanged. The check is the player signature against this hub. */
export function withStoryConsent(updates: readonly VerifiedHubUpdate[], hubId: string): VerifiedHubUpdate[] {
  return updates.map((update) => {
    if (update.kind !== "story-optin" || !update.storyOptIn) return update;
    return { ...update, consent: storyOptInConsent(update.storyOptIn, hubId) };
  });
}

const LISTING_NOTE =
  "list_listings returns listing updates only. The rejected list is listing updates only. The url is the business's own https page or checkout. An optional image is a public png, jpeg, or webp logo covered by the same signature. src is set only for a hub-relative path resolved to raw.githubusercontent.com at the pinned commit. An external https logo stays in url and is not loaded by the plain page. This node does not take payment and does not upload images. A listing whose status is withdrawn is a takedown and is left out. A listing whose expiresAt is before the current UTC date is hidden unless includeExpired is true, and those rows have expired set to true. signerDisplayName is the author's label on the trusted signer file. signedMeaning is one plain line for that signature.";

const UNPINNED_NOTE =
  "HUB_GIT_REPO, HUB_GIT_COMMIT, and HUB_STORE_MANIFEST_HASH are not set. No hub updates were read, and none were invented.";

export interface ListListingsQuery {
  stream?: string;
  category?: string;
  status?: string;
  includeExpired?: boolean;
}

export interface ListingReadResult {
  schema: typeof HUB_UPDATE_SCHEMA;
  listings: ListingView[];
  rejected: RejectedHubUpdate[];
  includeExpired: boolean;
  note: string;
  sourceUrl: string | null;
}

/**
 * Read signed listings from the same pinned store as hub updates.
 * Signer, threshold, revocation, and manifest-pin checks are unchanged.
 * Expired listings are omitted unless includeExpired is set.
 */
export async function listListings(
  source: HubStoreSource,
  allowlist: ReadonlySet<string>,
  threshold: number,
  query: ListListingsQuery = {},
  signerSets?: readonly SignerSet[],
  options?: VerifyHubUpdatesOptions,
  labels: ReadonlyMap<string, string> = new Map(),
  now: Date = new Date(),
): Promise<ListingReadResult> {
  const normalized = normalizeListingQuery(query);
  const checked = await readHubUpdates(source, allowlist, threshold, "listing", signerSets, {
    ...options,
    rejectedKind: "listing",
    now,
  });
  const listings = projectListings(
    checked.updates.flatMap((update) => {
      if (!update.listing || !checked.picks.has(update.id)) return [];
      const pick = checked.picks.get(update.id);
      return [
        {
          id: update.id,
          created_at: update.created_at,
          hash: update.hash,
          signer: update.signer,
          signedBy: update.signedBy,
          approvedBy: update.approvedBy,
          selfApproved: update.selfApproved,
          listing: update.listing,
          ...(update.signerAllowlist === "self" ? { claimant: true } : {}),
          ...(pick?.claimed ? { claimed: true } : {}),
        },
      ];
    }),
    normalized,
    labels,
    utcDateStamp(now),
    imagePin(source),
  );
  return {
    schema: checked.schema,
    listings,
    rejected: checked.rejected,
    includeExpired: normalized.includeExpired,
    note: `${checked.note} ${LISTING_NOTE}`,
    sourceUrl: checked.sourceUrl,
  };
}

function rejectionsForKind(
  documents: readonly unknown[],
  rejected: readonly RejectedHubUpdate[],
  kind: string,
): RejectedHubUpdate[] {
  const ids = new Set<string>();
  for (const document of documents) {
    if (!document || typeof document !== "object") continue;
    const payload = (document as { payload?: unknown }).payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const record = payload as Record<string, unknown>;
    if (record.kind !== kind) continue;
    if (typeof record.id !== "string" || record.id.length === 0 || record.id.length > 80) continue;
    ids.add(record.id);
  }
  return rejected.filter((item) => item.id !== null && ids.has(item.id));
}

function normalizeListingQuery(query: ListListingsQuery): ListingQuery {
  if (query.stream !== undefined && !(LISTING_STREAMS as readonly string[]).includes(query.stream)) {
    throw new UserInputError(`Unknown listing stream ${query.stream}.`);
  }
  if (query.category !== undefined && !(ECOSYSTEM_CATEGORIES as readonly string[]).includes(query.category)) {
    throw new UserInputError(`Unknown listing category ${query.category}.`);
  }
  if (query.status !== undefined && !(LISTING_STATUSES as readonly string[]).includes(query.status)) {
    throw new UserInputError(`Unknown listing status ${query.status}.`);
  }
  if (query.includeExpired !== undefined && typeof query.includeExpired !== "boolean") {
    throw new UserInputError("includeExpired must be true or false.");
  }
  return {
    ...(query.stream ? { stream: query.stream as ListingStream } : {}),
    ...(query.category ? { category: query.category as EcosystemCategory } : {}),
    ...(query.status ? { status: query.status as ListingStatus } : {}),
    includeExpired: query.includeExpired === true,
  };
}

export interface StoryHubContext {
  /** Normalized https repository URL, or null when this node has no such pin. */
  hubId: string | null;
  updates: VerifiedHubUpdate[];
  listings: ListingView[];
  sourceUrl: string | null;
}

/**
 * One pinned read for a player story: story opt-ins and current listings.
 * The checkout is cached by commit and manifest hash.
 */
export async function readStoryContext(
  source: HubStoreSource,
  allowlist: ReadonlySet<string>,
  threshold: number,
  signerSets?: readonly SignerSet[],
  options?: VerifyHubUpdatesOptions,
  labels: ReadonlyMap<string, string> = new Map(),
  now: Date = new Date(),
): Promise<StoryHubContext> {
  const checked = await readHubUpdates(source, allowlist, threshold, undefined, signerSets, { ...options, now });
  const today = utcDateStamp(now);
  const listings = projectListings(
    checked.updates.flatMap((update) => {
      if (update.kind !== "listing" || !update.listing || !checked.picks.has(update.id)) return [];
      const pick = checked.picks.get(update.id);
      return [
        {
          id: update.id,
          created_at: update.created_at,
          hash: update.hash,
          signer: update.signer,
          signedBy: update.signedBy,
          approvedBy: update.approvedBy,
          selfApproved: update.selfApproved,
          listing: update.listing,
          ...(update.signerAllowlist === "self" ? { claimant: true } : {}),
          ...(pick?.claimed ? { claimed: true } : {}),
        },
      ];
    }),
    { includeExpired: false },
    labels,
    today,
    imagePin(source),
  ).filter((listing) => listing.status === "available" || listing.status === "inquire_only");
  return {
    hubId: normalizeHubRepo(source.repo ?? ""),
    updates: checked.updates.filter((update) => update.kind === "story-optin"),
    listings,
    sourceUrl: checked.sourceUrl,
  };
}

export interface SearchReadResult {
  pinned: boolean;
  results: SearchHit[];
  note: string;
  truncated: boolean;
  sourceUrl: string | null;
}

/**
 * Search signed listings and guild listings, plus display names of players
 * with a current story opt-in. Nothing is uploaded. A player who is not
 * opted in is not looked up and is not returned.
 */
export async function searchHub(
  source: HubStoreSource,
  allowlist: ReadonlySet<string>,
  threshold: number,
  query: string,
  signerSets?: readonly SignerSet[],
  options?: VerifyHubUpdatesOptions,
  labels: ReadonlyMap<string, string> = new Map(),
  now: Date = new Date(),
  names: (wallet: string) => Promise<string | null> = async () => null,
): Promise<SearchReadResult> {
  if (typeof query !== "string" || query.length > SEARCH_QUERY_MAX) {
    throw new UserInputError("Search text must be at most 80 characters.");
  }
  const normalized = normalizeSearchQuery(query);
  const pinned = Boolean(source.repo?.trim() && source.commit?.trim() && source.manifestHash?.trim());
  if (!normalized) {
    return { pinned, results: [], note: "Enter a search.", truncated: false, sourceUrl: null };
  }
  if (!pinned) {
    return { pinned: false, results: [], note: UNPINNED_NOTE, truncated: false, sourceUrl: null };
  }
  const checked = await readHubUpdates(source, allowlist, threshold, undefined, signerSets, { ...options, now });
  const today = utcDateStamp(now);
  const pin = imagePin(source);
  const listings = projectListings(
    checked.updates.flatMap((update) => {
      if (update.kind !== "listing" || !update.listing || !checked.picks.has(update.id)) return [];
      const pick = checked.picks.get(update.id);
      return [
        {
          id: update.id,
          created_at: update.created_at,
          hash: update.hash,
          signer: update.signer,
          signedBy: update.signedBy,
          approvedBy: update.approvedBy,
          selfApproved: update.selfApproved,
          listing: update.listing,
          ...(update.signerAllowlist === "self" ? { claimant: true } : {}),
          ...(pick?.claimed ? { claimed: true } : {}),
        },
      ];
    }),
    { includeExpired: false },
    labels,
    today,
    pin,
  );
  const bodies = new Map(checked.updates.filter((update) => update.kind === "listing").map((update) => [update.id, update.body]));
  const docs = listings.map((listing) => listingSearchDoc(listing, bodies.get(listing.id) ?? ""));
  docs.push(
    ...guildSearchDocs(
      checked.updates.flatMap((update) => {
        if (update.kind !== "guild" || !update.guild || !checked.picks.has(update.id)) return [];
        return [{
          name: update.guild.name,
          guild: update.guild,
          created_at: update.created_at,
          ...(checked.picks.get(update.id)?.claimed ? { claimed: true } : {}),
        }];
      }),
      pin,
    ),
  );
  const hubId = normalizeHubRepo(source.repo ?? "");
  const wallets = hubId ? selectOptedInWallets(checked.updates, hubId, today) : [];
  const players = await playerSearchDocs(wallets, names);
  docs.push(...players.docs);
  const note = players.truncated
    ? "Some opted-in players were not checked."
    : "Matches are signed hub listings, guild listings, and display names of players who opted in.";
  return {
    pinned: true,
    results: matchSearch(normalized, docs),
    note,
    truncated: players.truncated,
    sourceUrl: checked.sourceUrl,
  };
}

/** Derived logo src for hub_updates. It is not part of the signed payload. */
function withLogoSrc(updates: VerifiedHubUpdate[], pin: ImagePin | null): VerifiedHubUpdate[] {
  return updates.map((update) => {
    const listing = update.listing?.image
      ? { ...update.listing, image: viewImage(update.listing.image, pin) }
      : update.listing;
    const guild = update.guild?.image ? { ...update.guild, image: viewImage(update.guild.image, pin) } : update.guild;
    if (listing === update.listing && guild === update.guild) return update;
    return {
      ...update,
      ...(listing ? { listing } : {}),
      ...(guild ? { guild } : {}),
    };
  });
}

function imagePin(source: HubStoreSource): ImagePin | null {
  const repo = source.repo?.trim() ?? "";
  const commit = source.commit?.trim() ?? "";
  if (!repo || !commit) return null;
  return { repo, commit };
}

export interface ClaimStatusResult {
  schema: typeof HUB_UPDATE_SCHEMA;
  hubId: string;
  claims: ReturnType<typeof publicClaim>[];
  note: string;
  sourceUrl: string | null;
}

/**
 * Claim state for one identity, or for every claim in the pinned hub.
 * Handles are included only when that claim opts in. X and Discord stay
 * self-attested unless a trusted verifier attestation is current.
 */
export async function claimStatus(
  source: HubStoreSource,
  allowlist: ReadonlySet<string>,
  threshold: number,
  identity: string | undefined,
  signerSets?: readonly SignerSet[],
  options?: HubReadOptions,
  now: Date = new Date(),
): Promise<ClaimStatusResult> {
  if (identity !== undefined && (typeof identity !== "string" || identity.length === 0 || identity.length > 120)) {
    throw new UserInputError("Identity must be a listing id or a guild name.");
  }
  const checked = await readHubUpdates(source, allowlist, threshold, undefined, signerSets, { ...options, now });
  const keys = identity ? identityKeys(identity) : [];
  let claims = identity
    ? checked.claims.filter((claim) => keys.includes(claim.identity) || claim.listingId === identity || claim.guildName === identity)
    : checked.claims;
  if (identity && claims.length === 0) {
    const key = keys[0] ?? identity;
    claims = [
      {
        updateId: "",
        identity: key,
        identityType: key.startsWith("guild:") ? "guild" : "listing",
        ...(key.startsWith("guild:") ? { guildName: key.slice("guild:".length) } : { listingId: key.replace(/^id:/, "") }),
        subject: key.startsWith("guild:") ? "guild" : "business",
        wallet: "",
        state: "unclaimed",
        active: false,
        profile: "absent",
        discord: "absent",
        x: "absent",
        showHandles: false,
        note: "No claim covers this identity.",
      },
    ];
  }
  return {
    schema: checked.schema,
    hubId: checked.hubId,
    claims: claims.map(publicClaim),
    note: checked.hubId
      ? "A claim is active only after its signature, hub, expiry, and subject rules pass. The first eligible claim in chain order wins unless curators resolve it. Guild and business claims need a curator countersign. A player claim needs a matching player profile key, and it does not take a listing a curator already published unless curators countersign. X and Discord notes are self-attested unless a trusted verifier attestation is current."
      : checked.note,
    sourceUrl: checked.sourceUrl,
  };
}

export function publicClaimRow(claim: ResolvedClaim) {
  return publicClaim(claim);
}

function publicClaim(claim: ResolvedClaim) {
  return {
    identity: claim.identity,
    subject: claim.subject,
    state: claim.state,
    active: claim.active,
    profile: claim.profile,
    discord: claim.discord,
    x: claim.x,
    ...(claim.state === "active" && claim.wallet ? { wallet: claim.wallet } : {}),
    ...(claim.listingId ? { listingId: claim.listingId } : {}),
    ...(claim.guildName ? { guildName: claim.guildName } : {}),
    ...(claim.discordHandle ? { discordHandle: claim.discordHandle } : {}),
    ...(claim.xHandle ? { xHandle: claim.xHandle } : {}),
    note: claim.note,
  };
}

function identityKeys(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("id:") || trimmed.startsWith("guild:")) return [trimmed];
  const keys: string[] = [];
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(trimmed)) keys.push(`id:${trimmed}`);
  const name = normalizeSearchQuery(trimmed);
  if (name) keys.push(`guild:${name}`);
  return keys;
}

export function listCategories() {
  return ECOSYSTEM_CATEGORIES.map((id) => ({
    id,
    members: "unknown" as const,
    membersReason: "No public approved-member roster is published for this category.",
  }));
}
