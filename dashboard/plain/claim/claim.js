/**
 * Player claim page. It builds the same signing message as hub-player prepare.
 * It collects a wallet signature in the browser. It does not publish, and it
 * does not call Discord. The client secret stays off this page.
 */

const DOMAIN = "sa-ecosystem-node:hub-update:v1\n";
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const HUB_ID_PATTERN = /^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?(?:\/[a-z0-9._-]+)+$/;
const TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NONCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const RESERVED_HOST_SUFFIXES = ["local", "internal", "home.arpa", "lan", "localdomain", "test", "example", "invalid", "localhost"];

const CLAIM_BODY = "Claim for this listing.";
const ATTESTATION_BODY = "Player attestation.";

export function normalizeClaimHub(repo) {
  const raw = String(repo ?? "").trim();
  if (!raw || raw.startsWith("-") || /\s/.test(raw) || raw.includes("\\") || raw.includes("?") || raw.includes("#")) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || blockedHubHost(host)) return null;
  let path = parsed.pathname;
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
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

export function buildClaimDraft(fields) {
  const hub = normalizeClaimHub(fields && fields.hub);
  const wallet = clean(fields && fields.wallet);
  const profile = clean(fields && fields.profile);
  const listingId = clean(fields && fields.listingId);
  const nonce = clean(fields && fields.nonce);
  const expiresAt = clean(fields && fields.expiresAt);
  const createdAt = clean(fields && fields.createdAt);
  const id = clean(fields && fields.id) || `claim-${nonce}`;
  if (!hub || !validAddress(wallet) || !validAddress(profile)) return null;
  if (!ID_PATTERN.test(listingId) || !NONCE_PATTERN.test(nonce) || !ID_PATTERN.test(id)) return null;
  if (!validTime(expiresAt) || !validTime(createdAt)) return null;
  const prev = fields && Object.prototype.hasOwnProperty.call(fields, "prev") ? fields.prev : null;
  if (prev !== null && (typeof prev !== "string" || !/^[0-9a-f]{64}$/.test(prev))) return null;
  const claim = {
    action: "claim",
    expiresAt,
    hubId: hub,
    identity: { listingId, type: "listing" },
    nonce,
    playerProfile: profile,
    subject: "player",
    wallet,
  };
  if (fields && fields.showHandles === true) claim.showHandles = true;
  const payload = {
    author: wallet,
    body: CLAIM_BODY,
    created_at: createdAt,
    id,
    kind: "claim",
    prev,
    refs: { pip: null, txs: [] },
    v: 1,
    claim,
  };
  return { payload, message: messageFor(payload) };
}

export async function buildAttestationDraft(fields, proof, prev) {
  const parsed = parseDiscordProof(proof);
  const hub = normalizeClaimHub(fields && fields.hub);
  const createdAt = clean(fields && fields.createdAt);
  const expiresAt = clean(fields && fields.expiresAt);
  if (!parsed || !hub || !validTime(createdAt) || !validTime(expiresAt)) return null;
  if (clean(fields && fields.wallet) !== parsed.wallet) return null;
  if (typeof prev !== "string" || !/^[0-9a-f]{64}$/.test(prev)) return null;
  const id = `attest-${parsed.nonce}`;
  if (!ID_PATTERN.test(id)) return null;
  const commitment = await sha256Hex(`${parsed.salt}:${parsed.account}`);
  const payload = {
    author: parsed.wallet,
    body: ATTESTATION_BODY,
    created_at: createdAt,
    id,
    kind: "attestation",
    prev,
    refs: { pip: null, txs: [] },
    v: 1,
    attestation: {
      action: "attest",
      expiresAt,
      handleCommitment: commitment,
      hubId: hub,
      issuedAt: createdAt,
      method: "discord",
      nonce: parsed.nonce,
      verifierId: "self",
      wallet: parsed.wallet,
    },
  };
  if (payload.attestation.handle) return null;
  const text = JSON.stringify(payload);
  if (text.includes(`"${parsed.account}"`) || text.includes(`"${parsed.salt}"`)) return null;
  return { payload, message: messageFor(payload) };
}

export async function claimCanonicalHash(draft) {
  if (!draft) return "";
  return sha256Hex(canonicalJson(draft.payload));
}

export function signedFile(draft, publicKey, signature) {
  if (!draft || publicKey !== draft.payload.author) return null;
  if (typeof signature !== "string" || signature.length < 64 || signature.length > 128) return null;
  return { payload: draft.payload, signature, approvals: [] };
}

export function bindClaimPage(doc, options = {}) {
  const form = doc.getElementById("claim-form");
  if (!form) return;
  form.addEventListener("submit", (event) => event.preventDefault());
  let claim = null;
  let attestation = null;
  const say = (text) => {
    const note = doc.getElementById("claim-status");
    if (note) note.textContent = text;
  };
  const show = (id, value) => {
    const node = doc.getElementById(id);
    if (node) node.textContent = value ?? "";
  };

  doc.getElementById("prepare")?.addEventListener("click", () => {
    claim = buildClaimDraft(readFields(doc));
    attestation = null;
    show("claim-message", claim ? claim.message.utf8 : "");
    show("claim-file", "");
    show("attestation-message", "");
    show("attestation-file", "");
    const sign = doc.getElementById("sign-claim");
    if (sign) sign.disabled = !claim;
    const signAttestation = doc.getElementById("sign-attestation");
    if (signAttestation) signAttestation.disabled = true;
    say(claim ? "Read the message, then sign it. This page does not publish." : "Those fields do not match the claim schema.");
  });

  doc.getElementById("sign-claim")?.addEventListener("click", () => {
    if (!claim) {
      say("Prepare the message first.");
      return;
    }
    void signDraft(doc, options, claim, "claim-file", say);
  });

  doc.getElementById("proof-file")?.addEventListener("change", () => {
    const input = doc.getElementById("proof-file");
    const file = input && input.files ? input.files[0] : null;
    if (!file) return;
    const reader = new (doc.defaultView || globalThis).FileReader();
    reader.addEventListener("load", () => {
      void loadProof(String(reader.result ?? ""), doc, () => claim, (next) => {
        attestation = next;
      }, say, show);
    });
    reader.readAsText(file);
  });

  doc.getElementById("sign-attestation")?.addEventListener("click", () => {
    if (!attestation) {
      say("Load a Discord proof from the operator machine first.");
      return;
    }
    void signDraft(doc, options, attestation, "attestation-file", say);
  });
}

async function loadProof(text, doc, currentClaim, setAttestation, say, show) {
  let proof;
  try {
    proof = JSON.parse(text);
  } catch {
    say("The proof file could not be read.");
    return;
  }
  const fields = readFields(doc);
  const claim = currentClaim() || buildClaimDraft(fields);
  if (!claim) {
    say("Prepare a claim before loading a proof.");
    return;
  }
  const prev = await claimCanonicalHash(claim);
  const draft = await buildAttestationDraft(fields, proof, prev);
  setAttestation(draft);
  show("attestation-message", draft ? draft.message.utf8 : "");
  const button = doc.getElementById("sign-attestation");
  if (button) button.disabled = !draft;
  say(draft ? "Sign the attestation. It is not published." : "The proof does not match this claim.");
}

async function signDraft(doc, options, draft, targetId, say) {
  const wallet = options.wallet || (doc.defaultView && doc.defaultView.solana) || globalThis.solana;
  if (!wallet || typeof wallet.signMessage !== "function") {
    say("Open a wallet that can sign a message. This page does not send a transaction.");
    return;
  }
  try {
    if (typeof wallet.connect === "function") await wallet.connect();
    const address = wallet.publicKey && typeof wallet.publicKey.toString === "function" ? wallet.publicKey.toString() : "";
    if (address !== draft.payload.author) {
      say("The connected wallet does not match this claim.");
      return;
    }
    const signed = await wallet.signMessage(new TextEncoder().encode(draft.message.utf8), "utf8");
    const raw = signed && signed.signature ? signed.signature : signed;
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw || []);
    if (bytes.length !== 64) {
      say("The wallet did not return a signature.");
      return;
    }
    const file = signedFile(draft, address, base58Encode(bytes));
    const node = doc.getElementById(targetId);
    if (node) node.textContent = file ? `${JSON.stringify(file, null, 2)}\n` : "";
    say("Signature stored on this page. Nothing was published.");
  } catch {
    say("The wallet did not sign. Nothing was published.");
  }
}

function readFields(doc) {
  const value = (id) => {
    const node = doc.getElementById(id);
    return node && "value" in node ? String(node.value || "") : "";
  };
  const show = doc.getElementById("show-handles");
  return {
    wallet: value("wallet"),
    hub: value("hub"),
    listingId: value("listing-id"),
    profile: value("profile"),
    nonce: value("nonce"),
    expiresAt: value("expires"),
    createdAt: value("created-at"),
    ...(show && show.checked ? { showHandles: true } : {}),
  };
}

function messageFor(payload) {
  const utf8 = DOMAIN + canonicalJson(payload);
  return { utf8, hex: utf8Hex(utf8) };
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Canonical JSON only accepts safe integers.");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function parseDiscordProof(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.v !== 1 || value.method !== "discord") return null;
  const account = normalizeAccount(value.account);
  if (!account || typeof value.salt !== "string" || value.salt.length < 8) return null;
  if (!validAddress(value.wallet) || !NONCE_PATTERN.test(String(value.nonce || ""))) return null;
  if (!opaqueState(value.state)) return null;
  return { account, salt: value.salt, wallet: value.wallet, nonce: value.nonce, state: value.state };
}

function decodeBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return atob(padded);
}

function opaqueState(state) {
  if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(state)) return false;
  try {
    const parsed = JSON.parse(decodeBase64Url(state));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed.wallet || parsed.nonce || parsed.salt)) {
      return false;
    }
  } catch {
    // Not a JSON binding.
  }
  return true;
}

function normalizeAccount(value) {
  const trimmed = String(value ?? "").trim();
  if (/^\d{17,20}$/.test(trimmed) || /^[A-Za-z0-9._]{2,32}$/.test(trimmed)) return trimmed;
  return "";
}

function blockedHubHost(host) {
  if (!host.includes(".") || isIpHost(host)) return true;
  return RESERVED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isIpHost(host) {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare.includes(":")) return true;
  const parts = bare.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function validAddress(value) {
  if (!ADDRESS_PATTERN.test(value)) return false;
  try {
    return base58Decode(value).length === 32;
  } catch {
    return false;
  }
}

function validTime(value) {
  if (!TIME_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function utf8Hex(text) {
  const bytes = new TextEncoder().encode(text);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function base58Encode(bytes) {
  if (bytes.length === 0) return "";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += (digits[index] ?? 0) << 8;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let encoded = "";
  for (let index = 0; bytes[index] === 0 && index < bytes.length - 1; index += 1) encoded += "1";
  for (let index = digits.length - 1; index >= 0; index -= 1) encoded += ALPHABET[digits[index] ?? 0] ?? "";
  return encoded;
}

function base58Decode(text) {
  if (text.length === 0 || text.length > 128) throw new Error("Invalid base58.");
  const bytes = [0];
  for (const char of text) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) throw new Error("Invalid base58.");
    let carry = value;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += (bytes[index] ?? 0) * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  for (let index = 0; text[index] === "1" && index < text.length - 1; index += 1) zeros += 1;
  const decoded = new Uint8Array(zeros + bytes.length);
  for (let index = 0; index < bytes.length; index += 1) decoded[decoded.length - 1 - index] = bytes[index] ?? 0;
  return decoded;
}

if (typeof document !== "undefined" && document.getElementById("claim-form")) {
  bindClaimPage(document);
}
