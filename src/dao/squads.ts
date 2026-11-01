import { requireDashboardScript } from "./browser-scripts.js";
import { SafeClientError } from "../errors.js";

export interface SquadsMultisig {
  threshold: number;
  authorityIndex: number;
  transactionIndex: number;
  msChangeIndex: number;
  createKey: string;
  allowExternalExecute: boolean;
  members: string[];
}

export interface SquadsTransaction {
  creator: string;
  ms: string;
  transactionIndex: number;
  authorityIndex: number;
  status: string;
  instructionIndex: number;
  approved: string[];
  rejected: string[];
  cancelled: string[];
  executedIndex: number | null;
}

interface SquadsModule {
  PROGRAM: string;
  decodeMs(data: Uint8Array): SquadsMultisig;
  decodeMsTx(data: Uint8Array): SquadsTransaction;
  b64(value: string): Uint8Array;
  vaultAddress(multisig: string, index: number, program?: string): Promise<string>;
  transactionAddress(multisig: string, index: number, program?: string): Promise<string>;
}

/** The dashboard's Squads v3 decoder. The MCP and the page both call this file. */
export function squadsModule(): SquadsModule {
  requireDashboardScript("ata.js");
  requireDashboardScript("squads.js");
  const api = (globalThis as { SA_SQUADS?: SquadsModule }).SA_SQUADS;
  if (!api?.decodeMs || !api.vaultAddress) {
    throw new SafeClientError("dashboard/squads.js did not publish its decoder.");
  }
  return api;
}

export function decodeMultisigAccount(data: Uint8Array): SquadsMultisig {
  try {
    return squadsModule().decodeMs(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "decode failed";
    throw new SafeClientError(`Squads multisig decode failed: ${message}`);
  }
}

export function decodeMultisigTransaction(data: Uint8Array): SquadsTransaction {
  try {
    return squadsModule().decodeMsTx(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "decode failed";
    throw new SafeClientError(`Squads transaction decode failed: ${message}`);
  }
}

export async function multisigVaultAddress(multisig: string, vaultIndex: number): Promise<string> {
  return squadsModule().vaultAddress(multisig, vaultIndex);
}
