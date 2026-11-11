import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import nacl from "tweetnacl";

import { base58Decode, base58Encode } from "./base58.js";
import {
  approvalSignatureValid,
  authorSignatureValid,
  hubApprovalSigningMessage,
  hubUpdateSigningMessage,
  parseHubPayload,
  parseSignedHubDocument,
  type HubUpdatePayload,
  type SignedHubDocument,
} from "./update.js";

/**
 * Local signing script. The server does not import this file.
 * The agent key file is a Solana CLI JSON array of 64 bytes. This script reads it
 * and does not write it.
 * Wallet approvals use signMessage over the approval text. That path takes a
 * public key and a signature only. It does not read a secret and it does not
 * build a transaction.
 */

const USAGE = [
  "Usage: npm run sign-hub-update -- --keypair <file> (--payload <file> | --approve <file>) [--out <file>]",
  "       npm run sign-hub-update -- --print-approval <file>",
  "       npm run sign-hub-update -- --approve <file> --public-key <address> --signature <signature> [--out <file>]",
  "       npm run sign-hub-update -- --drop-approval <file> --public-key <address> [--out <file>]",
].join("\n");

function fail(message: string): { code: number; stdout: string; stderr: string } {
  return { code: 1, stdout: "", stderr: `${message}\n` };
}

/** Solana CLI JSON array of 64 bytes. The returned buffer is a copy. Callers must not print it. */
export function readSolanaKeyFile(file: string): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    throw new Error("The key file could not be read. It must be a Solana JSON array of 64 bytes.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 64) {
    throw new Error("The key file must be a Solana JSON array of 64 bytes.");
  }
  if (parsed.some((entry) => typeof entry !== "number" || !Number.isInteger(entry) || entry < 0 || entry > 255)) {
    throw new Error("The key file must be a Solana JSON array of 64 bytes.");
  }
  return Uint8Array.from(parsed as number[]);
}

/** Base58 address for a Solana key file buffer. Does not return the secret bytes. */
export function solanaKeyAddress(solanaKey: Uint8Array): string {
  return base58Encode(publicKeyOf(solanaKey));
}

function publicKeyOf(solanaKey: Uint8Array): Uint8Array {
  const derived = nacl.sign.keyPair.fromSeed(solanaKey.subarray(0, 32));
  const embedded = solanaKey.subarray(32);
  if (derived.publicKey.length !== embedded.length) throw new Error("The key file does not contain a matching public key.");
  let diff = 0;
  for (let index = 0; index < embedded.length; index += 1) diff |= (derived.publicKey[index] ?? 0) ^ (embedded[index] ?? 0);
  if (diff !== 0) throw new Error("The key file does not contain a matching public key.");
  return derived.publicKey;
}

/** Sign one payload with a local Solana key. Returns the document the hub tool verifies. */
export function signHubPayload(payloadInput: unknown, solanaKey: Uint8Array): { payload: HubUpdatePayload; signature: string } {
  const payload = parseHubPayload(payloadInput);
  if (!payload) throw new Error("The payload does not match the hub update schema.");
  const author = solanaKeyAddress(solanaKey);
  if (payload.author !== author) throw new Error("The payload author does not match this key.");
  const derived = nacl.sign.keyPair.fromSeed(solanaKey.subarray(0, 32));
  const signature = base58Encode(nacl.sign.detached(hubUpdateSigningMessage(payload), derived.secretKey));
  if (!authorSignatureValid(payload, signature)) throw new Error("The signature did not verify. Nothing was written.");
  return { payload, signature };
}

/** Append one approval signature over the payload's canonical hash. Does not count a duplicate key twice. */
export function approveHubDocument(document: unknown, solanaKey: Uint8Array): SignedHubDocument {
  const parsed = parseSignedHubDocument(document);
  if (!parsed || !authorSignatureValid(parsed.payload, parsed.signature)) {
    throw new Error("The signed update could not be verified. Nothing was written.");
  }
  const publicKey = solanaKeyAddress(solanaKey);
  if (parsed.approvals.some((approval) => approval.publicKey === publicKey)) {
    throw new Error("This key already approved the update. Nothing was written.");
  }
  const derived = nacl.sign.keyPair.fromSeed(solanaKey.subarray(0, 32));
  const signature = base58Encode(nacl.sign.detached(hubApprovalSigningMessage(parsed.payload), derived.secretKey));
  if (!approvalSignatureValid(parsed.payload, publicKey, signature)) {
    throw new Error("The approval signature did not verify. Nothing was written.");
  }
  return { payload: parsed.payload, signature: parsed.signature, approvals: [...parsed.approvals, { publicKey, signature }] };
}

function decodeSignatureBytes(value: string): Uint8Array | null {
  const trimmed = value.trim();
  if (/^(?:0x)?[0-9a-fA-F]{128}$/.test(trimmed)) {
    return new Uint8Array(Buffer.from(trimmed.slice(-128), "hex"));
  }
  if (/[+/=]/.test(trimmed)) {
    const base64 = Buffer.from(trimmed, "base64");
    const roundTrip = base64.toString("base64").replace(/=+$/g, "");
    if (base64.length === 64 && roundTrip === trimmed.replace(/=+$/g, "")) return new Uint8Array(base64);
    return null;
  }
  try {
    const decoded = base58Decode(trimmed);
    if (decoded.length === 64) return decoded;
  } catch {
    return null;
  }
  return null;
}

/** Store a wallet signature as base58. Accepts base58, hex, or base64 of the 64-byte signature. */
export function normalizeWalletSignature(value: string): string {
  if (value.length > 200) throw new Error("The approval signature must be 64 bytes, as base58, hex, or base64.");
  const bytes = decodeSignatureBytes(value);
  if (!bytes) throw new Error("The approval signature must be 64 bytes, as base58, hex, or base64.");
  return base58Encode(bytes);
}

function canonicalAddress(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length > 64) throw new Error("The public key must be a Solana address.");
  try {
    const bytes = base58Decode(trimmed);
    if (bytes.length !== 32) throw new Error("length");
    const encoded = base58Encode(bytes);
    if (encoded !== trimmed) throw new Error("form");
    return encoded;
  } catch {
    throw new Error("The public key must be a Solana address.");
  }
}

/**
 * Attach one approval produced by a wallet signMessage over the approval text.
 * The caller passes the public address and the signature. This function does not
 * read a secret key and does not sign.
 */
export function attachWalletApproval(document: unknown, publicKey: string, signature: string): SignedHubDocument {
  const parsed = parseSignedHubDocument(document);
  if (!parsed || !authorSignatureValid(parsed.payload, parsed.signature)) {
    throw new Error("The signed update could not be verified. Nothing was written.");
  }
  const address = canonicalAddress(publicKey);
  if (parsed.approvals.some((approval) => approval.publicKey === address)) {
    throw new Error("This key already approved the update. Nothing was written.");
  }
  const normalized = normalizeWalletSignature(signature);
  if (!approvalSignatureValid(parsed.payload, address, normalized)) {
    throw new Error("The approval signature did not verify. Nothing was written.");
  }
  return {
    payload: parsed.payload,
    signature: parsed.signature,
    approvals: [...parsed.approvals, { publicKey: address, signature: normalized }],
  };
}

/**
 * Remove one approval by public key. The payload, the author signature, and every other approval stay as they are.
 * Used when an approval is replaced (for example the agent-key migration in protocol/h2h/SPEC.md section 17).
 * Keep the removed signature as provenance outside the manifest before you drop it.
 */
export function dropHubApproval(document: unknown, publicKey: string): SignedHubDocument {
  const parsed = parseSignedHubDocument(document);
  if (!parsed || !authorSignatureValid(parsed.payload, parsed.signature)) {
    throw new Error("The signed update could not be verified. Nothing was written.");
  }
  const address = canonicalAddress(publicKey);
  const kept = parsed.approvals.filter((approval) => approval.publicKey !== address);
  if (kept.length === parsed.approvals.length) {
    throw new Error("This key has no approval on the update. Nothing was written.");
  }
  return { payload: parsed.payload, signature: parsed.signature, approvals: kept };
}

/** Exact bytes for a wallet to sign. The author signature must already verify. */
export function approvalMessageLines(document: unknown): { hex: string; utf8: string } {
  const parsed = parseSignedHubDocument(document);
  if (!parsed || !authorSignatureValid(parsed.payload, parsed.signature)) {
    throw new Error("The signed update could not be verified. Nothing was printed.");
  }
  const bytes = hubApprovalSigningMessage(parsed.payload);
  return { hex: Buffer.from(bytes).toString("hex"), utf8: JSON.stringify(new TextDecoder().decode(bytes)) };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    throw new Error("The update file could not be read.");
  }
}

function writeDocument(outPath: string, document: SignedHubDocument): { code: number; stdout: string; stderr: string } {
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (outPath) writeFileSync(outPath, text);
  const last = document.approvals[document.approvals.length - 1];
  return {
    code: 0,
    stdout: outPath ? "" : text,
    stderr: `Approved ${document.payload.id} as ${last?.publicKey ?? ""}\n`,
  };
}

export function runSignCli(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  let keyPath = "";
  let payloadPath = "";
  let approvePath = "";
  let outPath = "";
  let printApproval = "";
  let publicKey = "";
  let signature = "";
  let dropPath = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) return fail(USAGE);
    if (arg === "--keypair") keyPath = next;
    else if (arg === "--payload") payloadPath = next;
    else if (arg === "--approve") approvePath = next;
    else if (arg === "--out") outPath = next;
    else if (arg === "--print-approval") printApproval = next;
    else if (arg === "--public-key") publicKey = next;
    else if (arg === "--signature") signature = next;
    else if (arg === "--drop-approval") dropPath = next;
    else return fail(USAGE);
    index += 1;
  }

  if (dropPath) {
    if (!publicKey || signature || keyPath || payloadPath || approvePath || printApproval) return fail(USAGE);
    try {
      const dropped = dropHubApproval(readJson(dropPath), publicKey);
      const text = `${JSON.stringify(dropped, null, 2)}\n`;
      if (outPath) writeFileSync(outPath, text);
      return { code: 0, stdout: outPath ? "" : text, stderr: `Dropped the approval by ${publicKey.trim()} from ${dropped.payload.id}\n` };
    } catch (error) {
      const message = error instanceof Error ? error.message : "The approval could not be dropped.";
      return fail(message.length > 300 ? "The approval could not be dropped." : message);
    }
  }

  const walletApproval = Boolean(publicKey || signature);
  if (printApproval) {
    if (keyPath || payloadPath || approvePath || outPath || walletApproval) return fail(USAGE);
  } else if (walletApproval) {
    if (!publicKey || !signature || !approvePath || keyPath || payloadPath || printApproval) return fail(USAGE);
  } else if (!keyPath || (payloadPath ? Boolean(approvePath) : !approvePath)) {
    return fail(USAGE);
  }

  if (keyPath) {
    const keyResolved = path.resolve(keyPath);
    const inputResolved = path.resolve(payloadPath || approvePath);
    if (keyResolved === inputResolved) return fail("The key file and the update file must be different.");
    if (outPath && path.resolve(outPath) === keyResolved) return fail("Refusing to write the signed update over the key file.");
  }

  try {
    if (printApproval) {
      const lines = approvalMessageLines(readJson(printApproval));
      return { code: 0, stdout: `hex:${lines.hex}\nutf8:${lines.utf8}\n`, stderr: "" };
    }
    if (walletApproval) {
      const approved = attachWalletApproval(readJson(approvePath), publicKey, signature);
      return writeDocument(outPath, approved);
    }
    const inputResolved = path.resolve(payloadPath || approvePath);
    const input = readJson(inputResolved);
    const key = readSolanaKeyFile(path.resolve(keyPath));
    if (approvePath) return writeDocument(outPath, approveHubDocument(input, key));
    const signed = signHubPayload(input, key);
    const text = `${JSON.stringify({ payload: signed.payload, signature: signed.signature }, null, 2)}\n`;
    if (outPath) writeFileSync(outPath, text);
    return {
      code: 0,
      stdout: outPath ? "" : text,
      stderr: `Signed ${signed.payload.id} as ${signed.payload.author}\n`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The hub update could not be signed.";
    return fail(message.length > 300 ? "The hub update could not be signed." : message);
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const result = runSignCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
