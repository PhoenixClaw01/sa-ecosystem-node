import { verifyEd25519Detached } from "../hub/ed25519-verify.js";
import type { HubUpdateSubmission } from "./hub-update.js";

/**
 * On-chain anchors and submit_hub_update stay unimplemented. They are not MCP tools.
 * hub_updates does not use this stub. It accepts an update only when verifyHubUpdates
 * finds an allowlisted author and enough distinct allowlisted approval signatures.
 * The ed25519 helper below only checks a detached signature. It does not publish.
 */

export const APPROVAL_VERIFICATION_STATUS = "not_implemented" as const;

export interface CouncilApproval {
  method: "council_wallet" | "squads_multisig";
  approver: string;
  /** Detached ed25519 signature, hex. */
  signatureHex: string;
}

export interface ApprovalLists {
  approvedEcosystemWallets: readonly string[];
  approverKeys: readonly string[];
  revokedKeys: readonly string[];
}

export interface OnChainAnchor {
  updateHash: string;
  cluster: "solana-mainnet" | "zink";
  signature: string;
}

export interface ApprovalVerdict {
  ok: boolean;
  reason: string;
}

/** Full approval check. Not implemented in v0. */
export type VerifyApproval = (input: {
  submission: HubUpdateSubmission;
  approval: CouncilApproval;
  lists: ApprovalLists;
  anchor: OnChainAnchor;
}) => Promise<ApprovalVerdict>;

/**
 * Detached ed25519 check over the raw message bytes (the same algorithm Solana uses).
 * Wallet-specific message framing is not implemented.
 * Returns false for the wrong length or a bad signature. Does not sign.
 */
export function verifyEd25519Signature(input: {
  message: Uint8Array;
  signature: Uint8Array;
  publicKey: Uint8Array;
}): boolean {
  return verifyEd25519Detached(input.message, input.signature, input.publicKey);
}
