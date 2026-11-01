import { parseGithubRepo } from "./github-archive.js";
import { isPublicHttpsUrl } from "./https-url.js";
import { ECOSYSTEM_CATEGORIES, type EcosystemCategory } from "../stubs/hub-update.js";

/**
 * Signed business listing carried on a hub update of kind `listing`.
 * The url is the business's own https page, stored in canonical form.
 * An optional image is a public png, jpeg, or webp logo. Its url, alt, and
 * link are part of the signed payload. This node does not take payment.
 * Unknown fields are rejected. A referral must include disclosure.
 * expiresAt is a UTC date on asOf or at most 90 days later.
 */

export const IMAGE_ALT_MAX = 140;
const RELATIVE_IMAGE_MAX = 200;
const RELATIVE_IMAGE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const IMAGE_EXTENSION = /\.(png|jpe?g|webp)$/i;

export const LISTING_STREAMS = ["referral", "hybrid", "irl", "player"] as const;
export const LISTING_STATUSES = ["available", "sold_out", "inquire_only", "paused", "withdrawn"] as const;
export const OWNERSHIP_PROOF_METHODS = ["wallet_signed", "site_code", "signer_review"] as const;

const MAX_LISTING_DAYS = 90;
const DAY_MS = 86_400_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type ListingStream = (typeof LISTING_STREAMS)[number];
export type ListingStatus = (typeof LISTING_STATUSES)[number];
export type OwnershipProofMethod = (typeof OWNERSHIP_PROOF_METHODS)[number];

export interface OwnershipProof {
  method: OwnershipProofMethod;
  evidenceRef: string;
}

/**
 * Public logo. `url` is https or a path inside the hub repo. `link` is an optional https page.
 * `src` is added at read time for a hub-relative file. It is not accepted in the signed object.
 */
export interface ListingImage {
  url: string;
  alt: string;
  link?: string;
  src?: string;
}

export interface ImagePin {
  repo: string;
  commit: string;
}

export interface Listing {
  stream: ListingStream;
  category: EcosystemCategory;
  title: string;
  owner: string;
  url: string;
  offerText?: string;
  verifyLiveNote?: string;
  status: ListingStatus;
  disclosure?: string;
  asOf: string;
  expiresAt: string;
  ownershipProof?: OwnershipProof;
  image?: ListingImage;
  /**
   * Stable id for this offer across updates. When omitted, the identity is
   * stream, category, and the normalized title and owner.
   */
  listingId?: string;
}

export type ListingFailure = "malformed" | "unknown_field" | "referral_disclosure" | "expiry_window";

export type ListingInspection = { ok: true; listing: Listing } | { ok: false; reason: ListingFailure };

const LISTING_KEYS = new Set([
  "asOf",
  "category",
  "disclosure",
  "expiresAt",
  "image",
  "listingId",
  "offerText",
  "owner",
  "ownershipProof",
  "status",
  "stream",
  "title",
  "url",
  "verifyLiveNote",
]);

const REQUIRED_KEYS = ["asOf", "category", "expiresAt", "owner", "status", "stream", "title", "url"] as const;

export function listingFailureMessage(reason: ListingFailure): string {
  if (reason === "referral_disclosure") return "A referral listing requires disclosure.";
  if (reason === "unknown_field") return "The listing has a field the schema does not allow.";
  if (reason === "expiry_window") return "expiresAt must fall on asOf or within 90 days after asOf.";
  return "The listing does not match the schema.";
}

export function parseListing(value: unknown): Listing | null {
  const inspected = inspectListing(value);
  return inspected.ok ? inspected.listing : null;
}

export function inspectListing(value: unknown): ListingInspection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "malformed" };
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !LISTING_KEYS.has(key))) return { ok: false, reason: "unknown_field" };
  if (REQUIRED_KEYS.some((key) => !keys.includes(key))) return { ok: false, reason: "malformed" };

  if (!isStream(record.stream) || !isCategory(record.category) || !isStatus(record.status)) {
    return { ok: false, reason: "malformed" };
  }
  const title = plainText(record.title, 160);
  const owner = plainText(record.owner, 120);
  if (!title || !owner || !validUrl(record.url)) return { ok: false, reason: "malformed" };
  if (typeof record.asOf !== "string" || typeof record.expiresAt !== "string") return { ok: false, reason: "malformed" };
  if (utcMidnight(record.asOf) === null || utcMidnight(record.expiresAt) === null) return { ok: false, reason: "malformed" };
  const days = spanDays(record.asOf, record.expiresAt);
  if (days === null || days < 0 || days > MAX_LISTING_DAYS) return { ok: false, reason: "expiry_window" };

  const offerText = optionalText(record, keys, "offerText", 500);
  if (!offerText.ok) return { ok: false, reason: "malformed" };
  const verifyLiveNote = optionalText(record, keys, "verifyLiveNote", 500);
  if (!verifyLiveNote.ok) return { ok: false, reason: "malformed" };

  if (record.stream === "referral" && !keys.includes("disclosure")) return { ok: false, reason: "referral_disclosure" };
  let disclosure: string | undefined;
  if (keys.includes("disclosure")) {
    const text = plainText(record.disclosure, 500);
    if (!text) return { ok: false, reason: record.stream === "referral" ? "referral_disclosure" : "malformed" };
    disclosure = text;
  }

  let ownershipProof: OwnershipProof | undefined;
  if (keys.includes("ownershipProof")) {
    const proof = inspectProof(record.ownershipProof);
    if (!proof.ok) return proof;
    ownershipProof = proof.proof;
  }

  let listingId: string | undefined;
  if (keys.includes("listingId")) {
    if (typeof record.listingId !== "string" || !LISTING_ID_PATTERN.test(record.listingId)) {
      return { ok: false, reason: "malformed" };
    }
    listingId = record.listingId;
  }

  let image: ListingImage | undefined;
  if (keys.includes("image")) {
    const parsed = inspectImage(record.image);
    if (!parsed.ok) return parsed;
    image = parsed.image;
  }

  return {
    ok: true,
    listing: {
      stream: record.stream,
      category: record.category,
      title,
      owner,
      url: record.url,
      ...(offerText.text ? { offerText: offerText.text } : {}),
      ...(verifyLiveNote.text ? { verifyLiveNote: verifyLiveNote.text } : {}),
      status: record.status,
      ...(disclosure ? { disclosure } : {}),
      asOf: record.asOf,
      expiresAt: record.expiresAt,
      ...(ownershipProof ? { ownershipProof } : {}),
      ...(image ? { image } : {}),
      ...(listingId ? { listingId } : {}),
    },
  };
}

const LISTING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

/** Explicit `listingId`, or stream, category, and the normalized title and owner. */
export function listingIdentity(listing: {
  listingId?: string;
  stream: string;
  category: string;
  title: string;
  owner: string;
}): string {
  if (listing.listingId) return `id:${listing.listingId}`;
  return `fallback:${listing.stream}|${listing.category}|${foldListingText(listing.title)}|${foldListingText(listing.owner)}`;
}

function foldListingText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function copyListing(listing: Listing): Listing {
  return {
    stream: listing.stream,
    category: listing.category,
    title: listing.title,
    owner: listing.owner,
    url: listing.url,
    ...(listing.offerText ? { offerText: listing.offerText } : {}),
    ...(listing.verifyLiveNote ? { verifyLiveNote: listing.verifyLiveNote } : {}),
    status: listing.status,
    ...(listing.disclosure ? { disclosure: listing.disclosure } : {}),
    asOf: listing.asOf,
    expiresAt: listing.expiresAt,
    ...(listing.ownershipProof
      ? { ownershipProof: { method: listing.ownershipProof.method, evidenceRef: listing.ownershipProof.evidenceRef } }
      : {}),
    ...(listing.image ? { image: copyImage(listing.image) } : {}),
    ...(listing.listingId ? { listingId: listing.listingId } : {}),
  };
}

type ListingCanonicalValue = string | { method: string; evidenceRef: string } | ReturnType<typeof imageCanonical>;

/** Fields covered by the hub update signature. Optional fields are omitted when absent. */
export function listingCanonical(listing: Listing): { [key: string]: ListingCanonicalValue } {
  const document: { [key: string]: ListingCanonicalValue } = {
    asOf: listing.asOf,
    category: listing.category,
    expiresAt: listing.expiresAt,
    owner: listing.owner,
    status: listing.status,
    stream: listing.stream,
    title: listing.title,
    url: listing.url,
  };
  if (listing.disclosure) document.disclosure = listing.disclosure;
  if (listing.offerText) document.offerText = listing.offerText;
  if (listing.ownershipProof) {
    document.ownershipProof = { method: listing.ownershipProof.method, evidenceRef: listing.ownershipProof.evidenceRef };
  }
  if (listing.verifyLiveNote) document.verifyLiveNote = listing.verifyLiveNote;
  if (listing.listingId) document.listingId = listing.listingId;
  if (listing.image) document.image = imageCanonical(listing.image);
  return document;
}

export function utcDateStamp(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export interface SignedListingUpdate {
  id: string;
  created_at: string;
  hash: string;
  signer: string;
  signedBy: readonly string[];
  approvedBy: readonly string[];
  selfApproved: boolean;
  listing: Listing;
  /** True when this row was signed by the claimant rather than an allowlisted curator. */
  claimant?: boolean;
  /** True when an active claim covers this identity. */
  claimed?: boolean;
}

export interface ListingQuery {
  stream?: ListingStream;
  category?: EcosystemCategory;
  status?: ListingStatus;
  includeExpired: boolean;
}

export interface ListingView {
  id: string;
  created_at: string;
  hash: string;
  expired: boolean;
  stream: ListingStream;
  category: EcosystemCategory;
  title: string;
  owner: string;
  url: string;
  offerText?: string;
  verifyLiveNote?: string;
  status: ListingStatus;
  disclosure?: string;
  asOf: string;
  expiresAt: string;
  ownershipProof?: OwnershipProof;
  listingId?: string;
  /** Signed image plus `src` when it resolves to a hub logo. `src` is not part of the signature. */
  image?: ListingImage;
  signer: string;
  signerDisplayName: string | null;
  signedBy: string[];
  approvedBy: string[];
  signedMeaning: string;
  selfApproved: boolean;
  /** Set when an active claim covers this listing. */
  claimed?: true;
}

export function signedMeaning(displayName: string | null): string {
  const who = displayName ? displayName : "an allowlisted wallet";
  return `Signed by ${who}. This signature means that signer published this listing. It does not move money, and this node never handles payment.`;
}

export function claimantSignedMeaning(): string {
  return "Signed by the claimant for this listing. This signature does not move money, and this node never handles payment.";
}

/**
 * Walks `updates` in hub chain order (oldest first). One identity keeps only
 * its newest update. A newest `withdrawn` status drops that identity.
 * Callers pass the verified chain, not a list sorted by `created_at`.
 * Expired means expiresAt is before the UTC date of `today`. The expiry date itself is still shown.
 */
export function projectListings(
  updates: readonly SignedListingUpdate[],
  query: ListingQuery,
  labels: ReadonlyMap<string, string>,
  today: string,
  pin: ImagePin | null = null,
): ListingView[] {
  const byIdentity = new Map<string, ListingView>();
  for (const update of updates) {
    const listing = update.listing;
    const key = listingIdentity(listing);
    if (listing.status === "withdrawn") {
      byIdentity.delete(key);
      continue;
    }
    const signerDisplayName = labels.get(update.signer) ?? null;
    const expired = listing.expiresAt < today;
    byIdentity.set(key, {
      id: update.id,
      created_at: update.created_at,
      hash: update.hash,
      expired,
      stream: listing.stream,
      category: listing.category,
      title: listing.title,
      owner: listing.owner,
      url: listing.url,
      ...(listing.offerText ? { offerText: listing.offerText } : {}),
      ...(listing.verifyLiveNote ? { verifyLiveNote: listing.verifyLiveNote } : {}),
      status: listing.status,
      ...(listing.disclosure ? { disclosure: listing.disclosure } : {}),
      asOf: listing.asOf,
      expiresAt: listing.expiresAt,
      ...(listing.ownershipProof
        ? { ownershipProof: { method: listing.ownershipProof.method, evidenceRef: listing.ownershipProof.evidenceRef } }
        : {}),
      ...(listing.listingId ? { listingId: listing.listingId } : {}),
      ...(listing.image ? { image: viewImage(listing.image, pin) } : {}),
      signer: update.signer,
      signerDisplayName,
      signedBy: [...update.signedBy],
      approvedBy: [...update.approvedBy],
      signedMeaning: update.claimant ? claimantSignedMeaning() : signedMeaning(signerDisplayName),
      selfApproved: update.selfApproved,
      ...(update.claimed ? { claimed: true as const } : {}),
    });
  }
  const rows: ListingView[] = [];
  for (const row of byIdentity.values()) {
    if (query.stream && row.stream !== query.stream) continue;
    if (query.category && row.category !== query.category) continue;
    if (query.status && row.status !== query.status) continue;
    if (row.expired && !query.includeExpired) continue;
    rows.push(row);
  }
  return rows;
}

function inspectProof(value: unknown): { ok: true; proof: OwnershipProof } | { ok: false; reason: ListingFailure } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "malformed" };
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "method" && key !== "evidenceRef")) return { ok: false, reason: "unknown_field" };
  if (keys.length !== 2) return { ok: false, reason: "malformed" };
  if (!isProofMethod(record.method)) return { ok: false, reason: "malformed" };
  const evidenceRef = plainText(record.evidenceRef, 300);
  if (!evidenceRef) return { ok: false, reason: "malformed" };
  return { ok: true, proof: { method: record.method, evidenceRef } };
}

function optionalText(
  record: Record<string, unknown>,
  keys: readonly string[],
  key: string,
  max: number,
): { ok: true; text?: string } | { ok: false } {
  if (!keys.includes(key)) return { ok: true };
  const text = plainText(record[key], max);
  if (!text) return { ok: false };
  return { ok: true, text };
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

function plainText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > max || value !== value.trim()) return null;
  if (hasForbiddenCharacter(value)) return null;
  return value;
}

function validUrl(value: unknown): value is string {
  return isPublicHttpsUrl(value);
}

const IMAGE_KEYS = new Set(["alt", "link", "url"]);

/** png, jpeg, or webp. https, or a hub-relative path. No SVG, data URL, or http URL. */
export function inspectImage(value: unknown): { ok: true; image: ListingImage } | { ok: false; reason: ListingFailure } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "malformed" };
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !IMAGE_KEYS.has(key))) return { ok: false, reason: "unknown_field" };
  if (!keys.includes("url") || !keys.includes("alt")) return { ok: false, reason: "malformed" };
  const alt = plainText(record.alt, IMAGE_ALT_MAX);
  if (!alt || !isImageReference(record.url)) return { ok: false, reason: "malformed" };
  if (keys.includes("link")) {
    if (!validUrl(record.link)) return { ok: false, reason: "malformed" };
    return { ok: true, image: { url: record.url, alt, link: record.link } };
  }
  return { ok: true, image: { url: record.url, alt } };
}

export function copyImage(image: ListingImage): ListingImage {
  return { url: image.url, alt: image.alt, ...(image.link ? { link: image.link } : {}) };
}

export function imageCanonical(image: ListingImage): { alt: string; url: string; link?: string } {
  return image.link ? { alt: image.alt, url: image.url, link: image.link } : { alt: image.alt, url: image.url };
}

/**
 * Hub-relative logos only. The result is `raw.githubusercontent.com` at the
 * pinned 40-character commit. An external https logo stays in the signed url
 * and is not returned here, so the plain page does not load it.
 */
/**
 * True only when `value` is the raw GitHub URL for this pin's owner, repository,
 * and 40-character commit, and the path is a hub-relative logo.
 */
export function pinnedHubLogoUrl(value: string, pin: ImagePin | null): string | null {
  if (!pin || !/^[0-9a-f]{40}$/.test(pin.commit)) return null;
  const repo = parseGithubRepo(pin.repo);
  if (!repo) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "raw.githubusercontent.com") return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.port) return null;
  if (value !== parsed.href) return null;
  const prefix = `/${repo.owner}/${repo.name}/${pin.commit}/`;
  if (!parsed.pathname.startsWith(prefix)) return null;
  const file = parsed.pathname.slice(prefix.length);
  if (!isRelativeImagePath(file)) return null;
  return value;
}

export function resolveImageUrl(url: string, pin: ImagePin | null): string | null {
  if (!pin || !isRelativeImagePath(url) || !/^[0-9a-f]{40}$/.test(pin.commit)) return null;
  const repo = parseGithubRepo(pin.repo);
  if (!repo) return null;
  const resolved = `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${pin.commit}/${url}`;
  return isHttpsImageUrl(resolved) ? resolved : null;
}

export function viewImage(image: ListingImage, pin: ImagePin | null): ListingImage {
  const src = resolveImageUrl(image.url, pin);
  return { ...copyImage(image), ...(src ? { src } : {}) };
}

function isImageReference(value: unknown): value is string {
  return typeof value === "string" && (isHttpsImageUrl(value) || isRelativeImagePath(value));
}

function isHttpsImageUrl(value: string): boolean {
  if (!isPublicHttpsUrl(value)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.search || parsed.hash) return false;
  return imagePathOk(parsed.pathname);
}

function isRelativeImagePath(value: string): boolean {
  if (value.length === 0 || value.length > RELATIVE_IMAGE_MAX) return false;
  if (value.includes("%") || value.includes("\\") || !RELATIVE_IMAGE_PATH.test(value)) return false;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || segment === ".git")) return false;
  return imagePathOk(value);
}

function imagePathOk(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.includes(".svg")) return false;
  return IMAGE_EXTENSION.test(path);
}

function utcMidnight(value: string): number | null {
  if (!DATE_PATTERN.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return time;
}

function spanDays(asOf: string, expiresAt: string): number | null {
  const start = utcMidnight(asOf);
  const end = utcMidnight(expiresAt);
  if (start === null || end === null) return null;
  return Math.round((end - start) / DAY_MS);
}

function isStream(value: unknown): value is ListingStream {
  return typeof value === "string" && (LISTING_STREAMS as readonly string[]).includes(value);
}

function isStatus(value: unknown): value is ListingStatus {
  return typeof value === "string" && (LISTING_STATUSES as readonly string[]).includes(value);
}

function isCategory(value: unknown): value is EcosystemCategory {
  return typeof value === "string" && (ECOSYSTEM_CATEGORIES as readonly string[]).includes(value);
}

function isProofMethod(value: unknown): value is OwnershipProofMethod {
  return typeof value === "string" && (OWNERSHIP_PROOF_METHODS as readonly string[]).includes(value);
}
