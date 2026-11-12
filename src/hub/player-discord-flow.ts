import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { handleCommitment, normalizeDiscordAccount, parseAttestation } from "./attestation.js";
import { parseClaim } from "./claim.js";
import { normalizeHubRepo } from "./story-optin.js";
import {
  authorSignatureValid,
  hubUpdateHash,
  hubUpdateSigningMessage,
  parseHubPayload,
  type HubUpdatePayload,
  type SignedHubDocument,
} from "./update.js";
import { parseVerifierProof, type VerifierProof } from "./verifier/proof.js";
import type { ProfileKeyVerdict } from "./claim-profile.js";

/**
 * Player claim and Discord attestation drafts.
 * Discord client secrets are not read here. The public server does not import this module.
 * A ready pack is files on disk. Nothing in this module publishes to a hub.
 */

export const PLAYER_PACK_NOTE =
  "Not published. A hub editor commits the signed claim and the signed attestation. Leave proof.json on this machine.";

export const PLAYER_CLAIM_BODY = "Claim for this listing.";
export const PLAYER_ATTESTATION_BODY = "Player attestation.";
export const VERIFIER_ATTESTATION_BODY = "Verifier attestation.";
export const PLAYER_VERIFIER_ID = "self";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

export interface PlayerClaimFields {
  wallet: string;
  hub: string;
  listingId: string;
  profile: string;
  nonce: string;
  expiresAt: string;
  createdAt: string;
  id?: string;
  prev?: string | null;
  showHandles?: boolean;
}

export interface UnsignedHubFile {
  payload: HubUpdatePayload;
  message: { utf8: string; hex: string };
}

export type PackRefusal =
  | "profile_mismatch"
  | "profile_unavailable"
  | "proof"
  | "claim_signature"
  | "attestation_signature"
  | "verifier_signature"
  | "fields";

export interface ReadyPlayerPack {
  claim: SignedHubDocument;
  attestation: SignedHubDocument;
  verifier: SignedHubDocument | null;
  proof: VerifierProof;
}

export function signingMessageText(payload: HubUpdatePayload): { utf8: string; hex: string } {
  const utf8 = new TextDecoder().decode(hubUpdateSigningMessage(payload));
  return { utf8, hex: Buffer.from(utf8).toString("hex") };
}

export function buildPlayerClaimDraft(fields: PlayerClaimFields): UnsignedHubFile | null {
  const hub = normalizeHubRepo(fields.hub);
  if (!hub) return null;
  const id = fields.id?.trim() || `claim-${fields.nonce}`;
  if (!ID_PATTERN.test(id)) return null;
  const claim = parseClaim({
    action: "claim",
    wallet: fields.wallet.trim(),
    hubId: hub,
    nonce: fields.nonce.trim(),
    expiresAt: fields.expiresAt.trim(),
    subject: "player",
    identity: { type: "listing", listingId: fields.listingId.trim() },
    playerProfile: fields.profile.trim(),
    ...(fields.showHandles ? { showHandles: true } : {}),
  });
  if (!claim) return null;
  const payload = parseHubPayload({
    v: 1,
    id,
    created_at: fields.createdAt.trim(),
    author: claim.wallet,
    kind: "claim",
    body: PLAYER_CLAIM_BODY,
    refs: { pip: null, txs: [] },
    prev: fields.prev ?? null,
    claim,
  });
  if (!payload || payload.author !== payload.claim?.wallet) return null;
  return { payload, message: signingMessageText(payload) };
}

export function buildPlayerAttestationDraft(input: {
  proof: unknown;
  hub: string;
  issuedAt: string;
  expiresAt: string;
  prev: string | null;
  id?: string;
}): UnsignedHubFile | null {
  const proof = discordProof(input.proof);
  const hub = normalizeHubRepo(input.hub);
  if (!proof || !hub) return null;
  const account = normalizeDiscordAccount(proof.account);
  if (!account) return null;
  const id = input.id?.trim() || `attest-${proof.nonce}`;
  if (!ID_PATTERN.test(id)) return null;
  const attestation = parseAttestation({
    action: "attest",
    wallet: proof.wallet,
    hubId: hub,
    nonce: proof.nonce,
    issuedAt: input.issuedAt.trim(),
    expiresAt: input.expiresAt.trim(),
    method: "discord",
    verifierId: PLAYER_VERIFIER_ID,
    handleCommitment: handleCommitment(proof.salt, account),
  });
  if (!attestation || attestation.handle) return null;
  const payload = parseHubPayload({
    v: 1,
    id,
    created_at: input.issuedAt.trim(),
    author: proof.wallet,
    kind: "attestation",
    body: PLAYER_ATTESTATION_BODY,
    refs: { pip: null, txs: [] },
    prev: input.prev,
    attestation,
  });
  if (!payload || payload.author !== proof.wallet) return null;
  if (mentionsSecret(payload, proof)) return null;
  return { payload, message: signingMessageText(payload) };
}

export function buildVerifierAttestationDraft(input: {
  proof: unknown;
  hub: string;
  verifierKey: string;
  verifierId: string;
  issuedAt: string;
  expiresAt: string;
  prev: string | null;
  id?: string;
}): UnsignedHubFile | null {
  const proof = discordProof(input.proof);
  const hub = normalizeHubRepo(input.hub);
  if (!proof || !hub) return null;
  const account = normalizeDiscordAccount(proof.account);
  if (!account) return null;
  const verifierKey = input.verifierKey.trim();
  if (!verifierKey || verifierKey === proof.wallet) return null;
  const id = input.id?.trim() || `verify-${proof.nonce}`;
  if (!ID_PATTERN.test(id)) return null;
  const attestation = parseAttestation({
    action: "attest",
    wallet: proof.wallet,
    hubId: hub,
    nonce: proof.nonce,
    issuedAt: input.issuedAt.trim(),
    expiresAt: input.expiresAt.trim(),
    method: "discord",
    verifierId: input.verifierId.trim(),
    handleCommitment: handleCommitment(proof.salt, account),
  });
  if (!attestation || attestation.handle) return null;
  const payload = parseHubPayload({
    v: 1,
    id,
    created_at: input.issuedAt.trim(),
    author: verifierKey,
    kind: "attestation",
    body: VERIFIER_ATTESTATION_BODY,
    refs: { pip: null, txs: [] },
    prev: input.prev,
    attestation,
  });
  if (!payload) return null;
  if (mentionsSecret(payload, proof)) return null;
  return { payload, message: signingMessageText(payload) };
}

/** Accept a signature that already verifies. This does not sign and does not publish. */
export function signedHubDocument(payload: HubUpdatePayload, signature: string): SignedHubDocument | null {
  if (!authorSignatureValid(payload, signature)) return null;
  return { payload, signature, approvals: [] };
}

/**
 * Claim signature, player attestation signature, and a matching Player Profile.
 * A mismatch or an unfinished read produces no files.
 */
export function readyPlayerPack(input: {
  fields: PlayerClaimFields;
  proof: unknown;
  claimSignature: string;
  attestationSignature: string;
  profile: ProfileKeyVerdict;
  verifier?: SignedHubDocument | null;
}): { ok: true; pack: ReadyPlayerPack } | { ok: false; reason: PackRefusal } {
  if (input.profile === "mismatch") return { ok: false, reason: "profile_mismatch" };
  if (input.profile !== "match") return { ok: false, reason: "profile_unavailable" };
  const proof = discordProof(input.proof);
  if (!proof) return { ok: false, reason: "proof" };
  const claimDraft = buildPlayerClaimDraft(input.fields);
  if (!claimDraft || claimDraft.payload.author !== proof.wallet || claimDraft.payload.claim?.nonce !== proof.nonce) {
    return { ok: false, reason: "fields" };
  }
  const claim = signedHubDocument(claimDraft.payload, input.claimSignature);
  if (!claim) return { ok: false, reason: "claim_signature" };
  const attestationDraft = buildPlayerAttestationDraft({
    proof,
    hub: input.fields.hub,
    issuedAt: input.fields.createdAt,
    expiresAt: input.fields.expiresAt,
    prev: hubUpdateHash(claimDraft.payload),
  });
  if (!attestationDraft) return { ok: false, reason: "proof" };
  const attestation = signedHubDocument(attestationDraft.payload, input.attestationSignature);
  if (!attestation) return { ok: false, reason: "attestation_signature" };
  if (input.verifier) {
    if (!authorSignatureValid(input.verifier.payload, input.verifier.signature)) {
      return { ok: false, reason: "verifier_signature" };
    }
    const commitment = attestation.payload.attestation?.handleCommitment;
    if (
      input.verifier.payload.kind !== "attestation" ||
      input.verifier.payload.prev !== hubUpdateHash(attestation.payload) ||
      input.verifier.payload.attestation?.wallet !== proof.wallet ||
      input.verifier.payload.attestation.handleCommitment !== commitment ||
      input.verifier.payload.author === proof.wallet
    ) {
      return { ok: false, reason: "verifier_signature" };
    }
  }
  if (mentionsSecret(claim.payload, proof) || mentionsSecret(attestation.payload, proof)) {
    return { ok: false, reason: "proof" };
  }
  return {
    ok: true,
    pack: { claim, attestation, verifier: input.verifier ?? null, proof },
  };
}

/** Write the signed hub files and the local proof. Proof mode is owner-read only. */
export function writePlayerPack(directory: string, pack: ReadyPlayerPack): string[] {
  mkdirSync(directory, { recursive: true });
  const files: [string, unknown][] = [
    ["claim.signed.json", pack.claim],
    ["attest.signed.json", pack.attestation],
    ["proof.json", pack.proof],
  ];
  if (pack.verifier) files.splice(2, 0, ["attest.verifier.signed.json", pack.verifier]);
  for (const [name] of files) {
    if (existsSync(path.join(directory, name))) throw new Error("An output file already exists. Nothing was replaced.");
  }
  const written: string[] = [];
  for (const [name, value] of files) {
    const file = path.join(directory, name);
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    written.push(name);
  }
  return written;
}

export function discordProof(value: unknown): VerifierProof | null {
  const proof = parseVerifierProof(value);
  if (!proof || proof.method !== "discord") return null;
  if (!normalizeDiscordAccount(proof.account)) return null;
  return proof;
}

/** Raw Discord id, salt, and OAuth state stay out of the hub record. The commitment hash is not scanned. */
function mentionsSecret(payload: HubUpdatePayload, proof: VerifierProof): boolean {
  const attestation = payload.attestation;
  const fields = [
    payload.body,
    payload.id,
    attestation?.handle,
    attestation?.proofUrl,
    attestation?.verifierId,
    attestation?.nonce,
    payload.claim?.discord?.note,
    payload.claim?.discord?.handle,
    payload.claim?.discord?.invite,
  ];
  return fields.some((field) => field === proof.account || field === proof.salt || field === proof.state);
}
