#!/usr/bin/env node
/* global process, console, fetch */
// Zero-dependency check of one signed hub record (Node 18+ built-ins only).
// Usage: node verify-record.mjs <path-or-https-url-of-an-update-json>
// Prints the payload sha256, whether the author signature verifies, and which approval keys verify.
// It does not check a node's allowlist or threshold; it only checks the signatures.
// The ed25519 check matches src/hub/ed25519-verify.ts: reject a non-canonical or
// small-order public key or R, and a scalar S that is not strictly below the group
// order, before Node's cofactored verifier runs.
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createHash, createPublicKey, verify } from "node:crypto";

const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
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
].map((hex) => Buffer.from(hex, "hex"));

function b58decode(text) {
  let n = 0n;
  for (const ch of text) {
    const i = A.indexOf(ch);
    if (i < 0) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  let zeros = 0;
  while (text[zeros] === "1") zeros += 1;
  return Buffer.concat([Buffer.alloc(zeros), body]);
}
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}
function readLittleEndian(bytes) {
  let value = 0n;
  for (let index = 0; index < bytes.length; index += 1) {
    value |= BigInt(bytes[index] ?? 0) << (8n * BigInt(index));
  }
  return value;
}
function pointAccepted(point) {
  if (point.length !== 32) return false;
  if ((readLittleEndian(point) & ((1n << 255n) - 1n)) >= FIELD_PRIME) return false;
  const last = (point[31] ?? 0) & 0x7f;
  for (const candidate of SMALL_ORDER_Y) {
    if (candidate[31] !== last) continue;
    let matches = true;
    for (let index = 0; index < 31; index += 1) {
      if (point[index] !== candidate[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return false;
  }
  return true;
}
function ed25519(publicKeyB58, message, signatureB58) {
  let raw;
  let sig;
  try {
    raw = b58decode(publicKeyB58);
    sig = b58decode(signatureB58);
  } catch {
    return false;
  }
  if (raw.length !== 32 || sig.length !== 64) return false;
  if (!pointAccepted(raw) || !pointAccepted(sig.subarray(0, 32))) return false;
  if (readLittleEndian(sig.subarray(32)) >= GROUP_ORDER) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
    return verify(null, Buffer.from(message, "utf8"), key, sig);
  } catch {
    return false;
  }
}

const where = process.argv[2];
if (!where) {
  console.error("Usage: node verify-record.mjs <update.json path or https URL>");
  process.exit(2);
}
const text = where.startsWith("https://") ? await (await fetch(where)).text() : readFileSync(where, "utf8");
const doc = JSON.parse(text);
const payloadJson = canonical(doc.payload);
const payloadSha256 = createHash("sha256").update(payloadJson, "utf8").digest("hex");
const author = ed25519(doc.payload.author, `sa-ecosystem-node:hub-update:v1\n${payloadJson}`, doc.signature);
const approvals = (doc.approvals ?? []).map((a) => ({
  publicKey: a.publicKey,
  verifies: ed25519(a.publicKey, `sa-ecosystem-node:hub-approval:v1\n${payloadSha256}`, a.signature),
}));
console.log(JSON.stringify({ id: doc.payload.id, payloadSha256, author: doc.payload.author, authorSignatureVerifies: author, approvals }, null, 2));
process.exit(author && approvals.every((a) => a.verifies) ? 0 : 1);
