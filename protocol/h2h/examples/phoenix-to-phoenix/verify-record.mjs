#!/usr/bin/env node
/* global process, console, fetch */
// Zero-dependency check of one signed hub record (Node 18+ built-ins only).
// Usage: node verify-record.mjs <path-or-https-url-of-an-update-json>
// Prints the payload sha256, whether the author signature verifies, and which approval keys verify.
// It does not check a node's allowlist or threshold; it only checks the signatures.
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createHash, createPublicKey, verify } from "node:crypto";

const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
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
function ed25519(publicKeyB58, message, signatureB58) {
  const raw = b58decode(publicKeyB58);
  if (raw.length !== 32) return false;
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
  const sig = b58decode(signatureB58);
  return sig.length === 64 && verify(null, Buffer.from(message, "utf8"), key, sig);
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
