import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

import type { SignerSetConfig } from "../config.js";
import { SafeClientError } from "../errors.js";
import { base58Decode, base58Encode } from "./base58.js";
import { embeddedSignerSetShas, embeddedSignersSha } from "./signers-pin.js";
import type { SignerSet } from "./update.js";

const MAX_SIGNER_BYTES = 64 * 1024;

const MAX_SIGNERS = 200;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .'_()-]{0,79}$/;

export interface HubSigner {
  label: string;
  publicKey: string;
}

/** A label is a display name. It is not an address and it is not a secret. */
export function validHubSignerLabel(value: string): boolean {
  return value.length > 0 && value.trim() === value && LABEL_PATTERN.test(value);
}

function canonicalAddress(value: string): string | null {
  try {
    const bytes = base58Decode(value);
    if (bytes.length !== 32) return null;
    const encoded = base58Encode(bytes);
    return encoded === value ? encoded : null;
  } catch {
    return null;
  }
}

/**
 * `{ v: 1, signers: [{ label, publicKey }] }`.
 * An empty list is valid and causes every hub update to be rejected.
 * Labels are not used in signature checks. The public key is the wallet address.
 */
export function parseHubSigners(value: unknown): HubSigner[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SafeClientError("The signer allowlist does not match schema v1. No updates were returned.");
  }
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || !Array.isArray(record.signers) || Object.keys(record).length !== 2) {
    throw new SafeClientError("The signer allowlist does not match schema v1. No updates were returned.");
  }
  if (record.signers.length > MAX_SIGNERS) {
    throw new SafeClientError("The signer allowlist is too long. No updates were returned.");
  }
  const signers: HubSigner[] = [];
  const keys = new Set<string>();
  const labels = new Set<string>();
  for (const entry of record.signers) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new SafeClientError("The signer allowlist has an entry that is not a labeled Solana address.");
    }
    const fields = entry as Record<string, unknown>;
    if (Object.keys(fields).length !== 2 || typeof fields.label !== "string" || typeof fields.publicKey !== "string") {
      throw new SafeClientError("The signer allowlist has an entry that is not a labeled Solana address.");
    }
    if (!validHubSignerLabel(fields.label)) {
      throw new SafeClientError("The signer allowlist has a label that is not valid. No updates were returned.");
    }
    const publicKey = canonicalAddress(fields.publicKey);
    if (!publicKey) {
      throw new SafeClientError("The signer allowlist has a public key that is not a Solana address.");
    }
    if (keys.has(publicKey)) {
      throw new SafeClientError("The signer allowlist repeats a public key. No updates were returned.");
    }
    if (labels.has(fields.label)) {
      throw new SafeClientError("The signer allowlist repeats a label. No updates were returned.");
    }
    keys.add(publicKey);
    labels.add(fields.label);
    signers.push({ label: fields.label, publicKey });
  }
  return signers;
}

/** One signers.json entry. Keys are label, then publicKey. */
export function formatHubSignerEntry(label: string, publicKey: string): string {
  if (!validHubSignerLabel(label) || !canonicalAddress(publicKey)) {
    throw new SafeClientError("The signer entry is not a labeled Solana address.");
  }
  return JSON.stringify({ label, publicKey });
}

/**
 * Set by the dashboard bundle. The esbuild define inlines the same hash.
 * A bundle built without that define refuses to load signers.
 * The node process has no embedded hash and reads the operator's file.
 */
export const SIGNERS_SHA256_KEY = "__SA_SIGNERS_SHA256";
/** Set by the dashboard bundle: sha256 of each extra signer-set file it ships (for example hub/signers/agents.json). */
export const SIGNER_SET_SHA256S_KEY = "__SA_SIGNER_SET_SHA256S";

function pinnedSignersSha(): string | null {
  const embedded = embeddedSignersSha();
  const value = embedded ?? (globalThis as Record<string, unknown>)[SIGNERS_SHA256_KEY];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new SafeClientError("The signer allowlist could not be read. No updates were returned.");
  }
  return value;
}

/**
 * Hashes of the extra signer-set files a bundle ships. Only read when a primary pin exists.
 * A node process with no pin reads the operator's files and has no extras.
 */
function pinnedSignerSetShas(): string[] {
  const embedded = embeddedSignerSetShas();
  const value = embedded ?? (globalThis as Record<string, unknown>)[SIGNER_SET_SHA256S_KEY];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !/^[0-9a-f]{64}$/.test(entry))) {
    throw new SafeClientError("The signer allowlist could not be read. No updates were returned.");
  }
  return value as string[];
}

function readSignerBytes(filePath: string): Buffer {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("O_NOFOLLOW is required to read the signer allowlist.");
  }
  let fd: number | undefined;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SIGNER_BYTES) throw new Error("not a regular file");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const got = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (got <= 0) throw new Error("short read");
      offset += got;
    }
    return bytes;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readSignerFile(filePath: string): HubSigner[] {
  let bytes: Buffer;
  try {
    bytes = readSignerBytes(filePath);
  } catch (error) {
    if (error instanceof SafeClientError) throw error;
    throw new SafeClientError("The signer allowlist could not be read. No updates were returned.");
  }
  const expected = pinnedSignersSha();
  if (expected !== null) {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected && !pinnedSignerSetShas().includes(actual)) {
      throw new SafeClientError("The signer allowlist does not match the pinned copy. No updates were returned.");
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new SafeClientError("The signer allowlist is not valid JSON. No updates were returned.");
  }
  return parseHubSigners(parsed);
}

/** Public keys only. An empty list is valid and causes every hub update to be rejected. */
export function loadSignerAllowlist(filePath: string): Set<string> {
  return new Set(readSignerFile(filePath).map((signer) => signer.publicKey));
}

/**
 * Signer sets plus the display name for each public key.
 * The first label wins when the same key appears in more than one file.
 * A missing or invalid file rejects the hub read.
 */
export function loadSignerDirectory(sets: readonly SignerSetConfig[]): { sets: SignerSet[]; labels: Map<string, string> } {
  const labels = new Map<string, string>();
  const seen = new Set<string>();
  const loaded = sets.map((set) => {
    if (seen.has(set.id)) {
      throw new SafeClientError("The signer sets repeat an id. No updates were returned.");
    }
    seen.add(set.id);
    const signers = readSignerFile(set.path);
    for (const signer of signers) {
      if (!labels.has(signer.publicKey)) labels.set(signer.publicKey, signer.label);
    }
    return {
      id: set.id,
      threshold: set.threshold,
      publicKeys: new Set(signers.map((signer) => signer.publicKey)),
      ...(set.kinds ? { kinds: [...set.kinds] } : {}),
    };
  });
  return { sets: loaded, labels };
}

/** Read each configured signer set. A missing or invalid file rejects the hub read. */
export function loadSignerSets(sets: readonly SignerSetConfig[]): SignerSet[] {
  return loadSignerDirectory(sets).sets;
}
