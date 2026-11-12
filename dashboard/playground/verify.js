// Browser-side check of one signed hub record. No dependencies.
// The ed25519 rules match src/hub/ed25519-verify.ts and the handshake example:
// reject a bad length, a non-canonical point, a small-order public key or R,
// and a scalar S that is not strictly below the group order, before WebCrypto
// runs its own verify. The signed bytes are HUB_UPDATE_DOMAIN plus the
// canonical payload, rebuilt the same way as src/hub/update.ts.

export const HUB_UPDATE_DOMAIN = "sa-ecosystem-node:hub-update:v1\n";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const FIELD_PRIME = (1n << 255n) - 19n;
const GROUP_ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;
const SMALL_ORDER_Y = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
].map(hexToBytes);

export function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw new Error("not hex");
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) out[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function base58Decode(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 128) throw new Error("not base58");
  let value = 0n;
  for (const ch of text) {
    const digit = B58.indexOf(ch);
    if (digit < 0) throw new Error("not base58");
    value = value * 58n + BigInt(digit);
  }
  const body = [];
  while (value > 0n) {
    body.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  let zeros = 0;
  while (text[zeros] === "1") zeros += 1;
  return Uint8Array.from([...new Array(zeros).fill(0), ...body]);
}

function readLittleEndian(bytes) {
  let value = 0n;
  for (let index = 0; index < bytes.length; index += 1) value |= BigInt(bytes[index] ?? 0) << (8n * BigInt(index));
  return value;
}

export function isCanonicalPoint(point) {
  if (!(point instanceof Uint8Array) || point.length !== 32) return false;
  return (readLittleEndian(point) & ((1n << 255n) - 1n)) < FIELD_PRIME;
}

export function isSmallOrderPoint(point) {
  if (!(point instanceof Uint8Array) || point.length !== 32) return false;
  const last = (point[31] ?? 0) & 0x7f;
  return SMALL_ORDER_Y.some((candidate) => {
    if (candidate[31] !== last) return false;
    for (let index = 0; index < 31; index += 1) if (point[index] !== candidate[index]) return false;
    return true;
  });
}

/** Why a key or signature is refused before WebCrypto runs, or null when it may be checked. */
export function precheckProblem(publicKey, signature) {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) return "The public key is not 32 bytes.";
  if (!(signature instanceof Uint8Array) || signature.length !== 64) return "The signature is not 64 bytes.";
  if (!isCanonicalPoint(publicKey)) return "The public key is not a canonical ed25519 point.";
  if (isSmallOrderPoint(publicKey)) return "The public key is a small-order point. Any signature could look valid under it, so it is refused.";
  const r = signature.subarray(0, 32);
  if (!isCanonicalPoint(r)) return "The signature R value is not a canonical ed25519 point.";
  if (isSmallOrderPoint(r)) return "The signature R value is a small-order point, so it is refused.";
  if (readLittleEndian(signature.subarray(32)) >= GROUP_ORDER) return "The signature S value is not below the group order.";
  return null;
}

function subtleOf(env) {
  const subtle = env?.subtle ?? globalThis.crypto?.subtle;
  if (!subtle) throw new Error("This browser has no WebCrypto.");
  return subtle;
}

/**
 * Detached ed25519 verify. Resolves to { ok, reason }.
 * ok is false with a reason for a refused input, a failed check, or a browser
 * that cannot run Ed25519 (unsupported is true then, and nothing is claimed).
 */
export async function verifyEd25519(message, signature, publicKey, env) {
  const problem = precheckProblem(publicKey, signature);
  if (problem) return { ok: false, reason: problem };
  let subtle;
  try {
    subtle = subtleOf(env);
  } catch (error) {
    return { ok: false, unsupported: true, reason: error.message };
  }
  let key;
  try {
    key = await subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return { ok: false, unsupported: true, reason: "This browser cannot check Ed25519 signatures. Nothing was verified." };
  }
  try {
    const ok = await subtle.verify({ name: "Ed25519" }, key, signature, message);
    return ok ? { ok: true, reason: "The signature matches these exact bytes and this public key." } : { ok: false, reason: "The signature does not match these bytes under this public key." };
  } catch {
    return { ok: false, reason: "The verifier refused this signature." };
  }
}

/** Sorted keys, no whitespace, safe integers only. Same output as canonicalJson in src/hub/update.ts. */
export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Canonical JSON only accepts safe integers.");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("Value cannot be written as canonical JSON.");
}

function imageCanonical(image) {
  return image.link ? { alt: image.alt, url: image.url, link: image.link } : { alt: image.alt, url: image.url };
}

function listingCanonical(listing) {
  const document = {
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
  if (listing.ownershipProof) document.ownershipProof = { method: listing.ownershipProof.method, evidenceRef: listing.ownershipProof.evidenceRef };
  if (listing.verifyLiveNote) document.verifyLiveNote = listing.verifyLiveNote;
  if (listing.listingId) document.listingId = listing.listingId;
  if (listing.image) document.image = imageCanonical(listing.image);
  return document;
}

function guildCanonical(guild) {
  const document = { description: guild.description, links: [...guild.links], name: guild.name };
  if (guild.discord) document.discord = guild.discord;
  if (guild.site) document.site = guild.site;
  if (guild.tags) document.tags = [...guild.tags];
  if (guild.withdrawn) document.withdrawn = true;
  if (guild.image) document.image = imageCanonical(guild.image);
  return document;
}

/** Kinds whose signed body this page can rebuild from a hub_updates row. */
export const REBUILT_KINDS = ["announcement", "proposal-note", "payment-note", "status", "signer-change", "listing", "guild"];

/**
 * Rebuild the canonical payload text of one verified hub_updates row.
 * Returns null for a kind this page does not rebuild.
 */
export function canonicalPayloadOf(update) {
  if (!update || typeof update !== "object" || !REBUILT_KINDS.includes(update.kind)) return null;
  if (!update.refs || typeof update.refs !== "object") return null;
  const document = {
    author: update.author,
    body: update.body,
    created_at: update.created_at,
    id: update.id,
    kind: update.kind,
    prev: update.prev,
    refs: { pip: update.refs.pip, txs: update.refs.txs },
    v: update.v,
  };
  if (update.kind === "signer-change" && update.change) {
    document.change = { op: update.change.op, publicKey: update.change.publicKey, set: update.change.set };
  }
  if (update.kind === "listing" && update.listing) document.listing = listingCanonical(update.listing);
  if (update.kind === "guild" && update.guild) document.guild = guildCanonical(update.guild);
  return canonicalJson(document);
}

export async function sha256Hex(text, env) {
  const digest = await subtleOf(env).digest("SHA-256", new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

/** Flip the low bit of one byte near the middle. Returns the copy and the index. */
export function flipOneByte(bytes) {
  const copy = new Uint8Array(bytes);
  const index = Math.floor(copy.length / 2);
  if (copy.length > 0) copy[index] ^= 0x01;
  return { bytes: copy, index };
}

/**
 * Check one hub_updates row in the browser.
 * Steps: rebuild the canonical payload, confirm its sha256 equals the row hash,
 * then verify the author signature over HUB_UPDATE_DOMAIN + payload.
 * With tamper set, one byte of the signed bytes is flipped first, so a pass is impossible.
 */
export async function verifyHubRecord(update, options = {}) {
  const env = options.env;
  const payload = canonicalPayloadOf(update);
  if (payload === null) {
    return { status: "unchecked", reason: `This page does not rebuild the signed bytes for the ${String(update?.kind ?? "unknown")} kind yet. Nothing was claimed.` };
  }
  let hash;
  try {
    hash = await sha256Hex(payload, env);
  } catch (error) {
    return { status: "unchecked", reason: `The payload could not be hashed: ${error.message}` };
  }
  if (hash !== update.hash) {
    return { status: "unchecked", hash, reason: "The rebuilt payload does not hash to this record's hash, so the exact signed bytes are unknown. Nothing was claimed." };
  }
  let publicKey;
  let signature;
  try {
    publicKey = base58Decode(String(update.author));
    signature = base58Decode(String(update.signature));
  } catch {
    return { status: "fail", hash, reason: "The key or signature is not valid base58." };
  }
  let message = new TextEncoder().encode(HUB_UPDATE_DOMAIN + payload);
  let flipped = null;
  if (options.tamper) {
    const out = flipOneByte(message);
    message = out.bytes;
    flipped = out.index;
  }
  const result = await verifyEd25519(message, signature, publicKey, env);
  if (result.unsupported) return { status: "unchecked", hash, flipped, reason: result.reason };
  return { status: result.ok ? "pass" : "fail", hash, flipped, bytes: message.length, reason: result.reason };
}
