import { requireDashboardScript } from "./browser-scripts.js";
import {
  balancesFromCacheRows,
  readBalancesWithFallback,
  readTrackedBalances,
  type BalanceRead,
  type TokenBalanceRow,
  type WalletBalanceRead,
} from "./live-balance.js";
import { decodeMultisigAccount, decodeMultisigTransaction, multisigVaultAddress, squadsModule } from "./squads.js";
import type { SolanaReadRpc } from "./rpc.js";
import type { TreasuryCache } from "./types.js";
import { DAO_TREASURY_ADDRESS, ECOSYSTEM_FUND_ADDRESS } from "./wallets.js";
import { SafeClientError } from "../errors.js";

export type { BalanceRead, TokenBalanceRow, WalletBalanceRead };

export const PUBLISHED_MULTISIGS = [
  {
    label: "DAO Treasury multisig",
    address: "D2pEzvQE3Jo6k3H5Cv3uskaUjyQHoFu3hMzpDjHuQ8jj",
    controls: "dao_treasury" as const,
    vault: DAO_TREASURY_ADDRESS,
    vaultIndex: 1,
  },
  {
    label: "Ecosystem Fund multisig",
    address: "8Z8QrJEfiGTj9X4HejbsXyAMQToA7SPNE1scGXnC1Vcy",
    controls: "ecosystem_fund" as const,
    vault: ECOSYSTEM_FUND_ADDRESS,
    vaultIndex: 1,
  },
] as const;

const BASE64_OPTIONS = { encoding: "base64", commitment: "confirmed" } as const;

function loadAta(): { associatedTokenAddress: (owner: string, mint: string) => Promise<string> } {
  requireDashboardScript("ata.js");
  const ata = (globalThis as { SA_ATA?: { associatedTokenAddress: (owner: string, mint: string) => Promise<string> } }).SA_ATA;
  if (!ata) throw new SafeClientError("dashboard/ata.js did not load.");
  return ata;
}

/** One getMultipleAccounts call for both wallets. */
export async function readWalletBalances(rpc: SolanaReadRpc, fetchedAt: string): Promise<WalletBalanceRead[]> {
  return readTrackedBalances(rpc, loadAta().associatedTokenAddress, fetchedAt);
}

/**
 * The same six figures from a treasury cache. Null when any figure is missing,
 * so the caller does not fill the gap with zero.
 */
export function walletBalancesFromCache(cache: TreasuryCache): { wallets: WalletBalanceRead[]; asOf: string } | null {
  return balancesFromCacheRows(cache.balances);
}

/** Live balances, then the treasury cache. The dashboard calls the same function. */
export function readWalletBalancesWithFallback(input: {
  rpc: SolanaReadRpc;
  now: Date;
  cacheBalances?: Parameters<typeof readBalancesWithFallback>[0]["cacheBalances"];
}): Promise<BalanceRead> {
  return readBalancesWithFallback({
    rpc: input.rpc,
    associatedTokenAddress: loadAta().associatedTokenAddress,
    now: input.now,
    cacheBalances: input.cacheBalances,
  });
}

function accountBytes(result: { value?: { data?: [string, string] | unknown } | null }): Uint8Array {
  const data = result.value?.data;
  if (!Array.isArray(data) || typeof data[0] !== "string") {
    throw new SafeClientError("The account was missing or was not base64.");
  }
  return squadsModule().b64(data[0]);
}

export async function readPublishedMultisigs(rpc: SolanaReadRpc, recentLimit = 3) {
  const decoded = [];
  for (const multisig of PUBLISHED_MULTISIGS) {
    const account = await rpc.call<{ value?: { data?: [string, string] } | null }>("getAccountInfo", [
      multisig.address,
      BASE64_OPTIONS,
    ]);
    const ms = decodeMultisigAccount(accountBytes(account));
    const derivedVault = await multisigVaultAddress(multisig.address, multisig.vaultIndex);
    const recent = [];
    const start = Math.max(1, ms.transactionIndex - recentLimit + 1);
    for (let index = ms.transactionIndex; index >= start && index >= 1; index -= 1) {
      const txAddress = await squadsModule().transactionAddress(multisig.address, index);
      const txAccount = await rpc.call<{ value?: { data?: [string, string] } | null }>("getAccountInfo", [
        txAddress,
        BASE64_OPTIONS,
      ]);
      if (!txAccount.value) {
        recent.push({ index, address: txAddress, missing: true });
        continue;
      }
      recent.push({ index, address: txAddress, ...decodeMultisigTransaction(accountBytes(txAccount)) });
    }
    decoded.push({
      label: multisig.label,
      address: multisig.address,
      controls: multisig.controls,
      threshold: ms.threshold,
      members: ms.members,
      transactionIndex: ms.transactionIndex,
      msChangeIndex: ms.msChangeIndex,
      derivedVault,
      expectedVault: multisig.vault,
      vaultMatches: derivedVault === multisig.vault,
      recent,
    });
  }
  return decoded;
}
