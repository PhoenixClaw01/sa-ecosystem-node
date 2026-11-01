import { createHash } from "node:crypto";

import { base58Decode } from "./base58.js";
import { isPublicHttpsUrl } from "./https-url.js";
import { isHubConsentId } from "./story-optin.js";

/**
 * A verifier key states that wallet W is linked to a Discord account or an X account.
 * The hub author is the verifier public key. The handle is a salted sha256 commitment.
 * A raw handle is optional and is shown only when the subject's claim opts in.
 * Trust is not in this record. Each node applies HUB_TRUSTED_VERIFIERS at read time.
 */

const TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NONCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const VERIFIER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const HANDLE_PATTERN = /^[A-Za-z0-9._]{1,32}$/;

export const ATTESTATION_ACTIONS = ["attest", "revoke"] as const;
export const ATTESTATION_METHODS = ["discord", "x"] as const;

export type AttestationAction = (typeof ATTESTATION_ACTIONS)[number];
export type AttestationMethod = (typeof ATTESTATION_METHODS)[number];

export interface AttestationRecord {
  action: AttestationAction;
  wallet: string;
  hubId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  method: AttestationMethod;
  verifierId: string;
  /** Present on attest. sha256 hex of `salt:normalized handle`. The salt stays with the verifier. */
  handleCommitment?: string;
  /** Raw handle. Public reads omit it unless the subject's claim sets showHandles. */
  handle?: string;
  proofUrl?: string;
  /** Revoke: the attestation update id. */
  targetId?: string;
}

const ATTESTATION_KEYS = new Set([
  "action",
  "expiresAt",
  "handle",
  "handleCommitment",
  "hubId",
  "issuedAt",
  "method",
  "nonce",
  "proofUrl",
  "targetId",
  "verifierId",
  "wallet",
]);

export interface PriorAttestation {
  id: string;
  author: string;
}

/** Lowercase X handle without a leading @. Empty when the text is not a handle. */
export function normalizeXHandle(value: string): string {
  const trimmed = value.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(trimmed)) return "";
  return trimmed;
}

/** Discord snowflake or username, trimmed. The verifier hashes this, not a display name. */
export function normalizeDiscordAccount(value: string): string {
  const trimmed = value.trim();
  if (!/^\d{17,20}$/.test(trimmed) && !/^[A-Za-z0-9._]{2,32}$/.test(trimmed)) return "";
  return trimmed;
}

/** sha256 of `salt:handle`. Salt is not written into the hub record. */
export function handleCommitment(salt: string, handle: string): string {
  return createHash("sha256").update(`${salt}:${handle}`).digest("hex");
}

export function parseAttestation(value: unknown): AttestationRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !ATTESTATION_KEYS.has(key))) return null;
  const required = ["action", "expiresAt", "hubId", "issuedAt", "method", "nonce", "verifierId", "wallet"];
  if (required.some((key) => !keys.includes(key))) return null;
  if (record.action !== "attest" && record.action !== "revoke") return null;
  if (record.method !== "discord" && record.method !== "x") return null;
  if (typeof record.wallet !== "string" || !validAddress(record.wallet)) return null;
  if (typeof record.hubId !== "string" || !isHubConsentId(record.hubId)) return null;
  if (typeof record.nonce !== "string" || !NONCE_PATTERN.test(record.nonce)) return null;
  if (typeof record.issuedAt !== "string" || !validTime(record.issuedAt)) return null;
  if (typeof record.expiresAt !== "string" || !validTime(record.expiresAt)) return null;
  if (typeof record.verifierId !== "string" || !VERIFIER_ID_PATTERN.test(record.verifierId)) return null;

  let handleCommitmentValue: string | undefined;
  if (keys.includes("handleCommitment")) {
    if (typeof record.handleCommitment !== "string" || !HASH_PATTERN.test(record.handleCommitment)) return null;
    handleCommitmentValue = record.handleCommitment;
  }
  let handle: string | undefined;
  if (keys.includes("handle")) {
    if (typeof record.handle !== "string" || !HANDLE_PATTERN.test(record.handle)) return null;
    handle = record.handle;
  }
  let proofUrl: string | undefined;
  if (keys.includes("proofUrl")) {
    if (!isPublicHttpsUrl(record.proofUrl)) return null;
    proofUrl = record.proofUrl;
  }
  let targetId: string | undefined;
  if (keys.includes("targetId")) {
    if (typeof record.targetId !== "string" || !ID_PATTERN.test(record.targetId)) return null;
    targetId = record.targetId;
  }
  if (record.action === "attest" && !handleCommitmentValue) return null;
  if (record.action === "revoke" && (handleCommitmentValue || handle || proofUrl || !targetId)) return null;
  if (record.action === "attest" && targetId) return null;

  return {
    action: record.action,
    wallet: record.wallet,
    hubId: record.hubId,
    nonce: record.nonce,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    method: record.method,
    verifierId: record.verifierId,
    ...(handleCommitmentValue ? { handleCommitment: handleCommitmentValue } : {}),
    ...(handle ? { handle } : {}),
    ...(proofUrl ? { proofUrl } : {}),
    ...(targetId ? { targetId } : {}),
  };
}

export function copyAttestation(attestation: AttestationRecord): AttestationRecord {
  return {
    action: attestation.action,
    wallet: attestation.wallet,
    hubId: attestation.hubId,
    nonce: attestation.nonce,
    issuedAt: attestation.issuedAt,
    expiresAt: attestation.expiresAt,
    method: attestation.method,
    verifierId: attestation.verifierId,
    ...(attestation.handleCommitment ? { handleCommitment: attestation.handleCommitment } : {}),
    ...(attestation.handle ? { handle: attestation.handle } : {}),
    ...(attestation.proofUrl ? { proofUrl: attestation.proofUrl } : {}),
    ...(attestation.targetId ? { targetId: attestation.targetId } : {}),
  };
}

/** Fields covered by the verifier's hub update signature. */
export function attestationCanonical(attestation: AttestationRecord): { [key: string]: string } {
  const document: { [key: string]: string } = {
    action: attestation.action,
    expiresAt: attestation.expiresAt,
    hubId: attestation.hubId,
    issuedAt: attestation.issuedAt,
    method: attestation.method,
    nonce: attestation.nonce,
    verifierId: attestation.verifierId,
    wallet: attestation.wallet,
  };
  if (attestation.handle) document.handle = attestation.handle;
  if (attestation.handleCommitment) document.handleCommitment = attestation.handleCommitment;
  if (attestation.proofUrl) document.proofUrl = attestation.proofUrl;
  if (attestation.targetId) document.targetId = attestation.targetId;
  return document;
}

/**
 * A verifier may revoke an attestation they signed.
 * The subject and threshold signers are decided by the hub update author, not here.
 */
export function verifierCanRevoke(
  author: string,
  targetId: string | undefined,
  prior: readonly PriorAttestation[],
): boolean {
  if (!targetId) return false;
  return prior.some((item) => item.id === targetId && item.author === author);
}

function validTime(value: string): boolean {
  if (!TIME_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function validAddress(value: string): boolean {
  if (!ADDRESS_PATTERN.test(value)) return false;
  try {
    return base58Decode(value).length === 32;
  } catch {
    return false;
  }
}
