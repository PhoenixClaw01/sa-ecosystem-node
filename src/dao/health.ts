import { readFileSync } from "node:fs";

import { readWalletBalancesWithFallback } from "./balances.js";
import { loadCache } from "./cache.js";
import { getJson } from "./galaxy.js";
import { COUNCIL_SHEET_CSV } from "./pip-tracker.js";
import type { SolanaReadRpc } from "./rpc.js";
import { DAO_TREASURY_ADDRESS } from "./wallets.js";
import { publicErrorMessage } from "../errors.js";

export interface SourceHealth {
  source: string;
  ok: boolean;
  asOf: string | null;
  error: string | null;
  /** Set for wallet balances: live chain read, or the treasury cache after that read fails. */
  mode?: "live" | "cached";
  detail?: string | null;
}

export async function probeDataHealth(input: {
  fetchImpl: typeof fetch;
  galaxyBaseUrl: string;
  cachePath: string;
  rpc: SolanaReadRpc;
  now: string;
}): Promise<SourceHealth[]> {
  const galaxyUrl = `${input.galaxyBaseUrl.replace(/\/$/, "")}/proposals`;
  return [
    cacheHealth(input.cachePath),
    await galaxyHealth(input.fetchImpl, galaxyUrl, input.now),
    await sheetHealth(input.fetchImpl, input.now),
    await rpcHealth(input.rpc, input.now),
    await walletBalanceHealth(input.rpc, input.cachePath, input.now),
  ];
}

async function walletBalanceHealth(rpc: SolanaReadRpc, cachePath: string, now: string): Promise<SourceHealth> {
  let cacheBalances: Parameters<typeof readWalletBalancesWithFallback>[0]["cacheBalances"] = null;
  try {
    cacheBalances = loadCache(cachePath).balances;
  } catch {
    cacheBalances = null;
  }
  const read = await readWalletBalancesWithFallback({ rpc, now: new Date(now), cacheBalances });
  if (read.mode === "live") {
    return {
      source: "wallet_balances",
      ok: true,
      asOf: read.asOf,
      error: null,
      mode: "live",
      detail: "One getMultipleAccounts read of the two wallets.",
    };
  }
  if (read.mode === "cached") {
    return {
      source: "wallet_balances",
      ok: true,
      asOf: read.asOf,
      error: null,
      mode: "cached",
      detail: `Cached balances. Live read failed: ${read.liveError}`,
    };
  }
  return {
    source: "wallet_balances",
    ok: false,
    asOf: null,
    error: read.label,
    detail: read.liveError,
  };
}

function cacheHealth(file: string): SourceHealth {
  try {
    const cache = JSON.parse(readFileSync(file, "utf8")) as { generatedAt?: unknown; schemaVersion?: unknown };
    if (cache.schemaVersion !== 1 || typeof cache.generatedAt !== "string") {
      return { source: "treasury_cache", ok: false, asOf: null, error: "The treasury cache is not schema version 1." };
    }
    return { source: "treasury_cache", ok: true, asOf: cache.generatedAt, error: null };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return {
      source: "treasury_cache",
      ok: false,
      asOf: null,
      error: code === "ENOENT" ? "No treasury cache file. Balances were not invented." : publicErrorMessage(error),
    };
  }
}

async function galaxyHealth(fetchImpl: typeof fetch, url: string, now: string): Promise<SourceHealth> {
  try {
    const payload = await getJson(fetchImpl, url);
    if (!Array.isArray(payload)) {
      return { source: "galaxy_proposals", ok: false, asOf: null, error: "Galaxy proposals was not a list." };
    }
    return { source: "galaxy_proposals", ok: true, asOf: now, error: null };
  } catch (error) {
    return { source: "galaxy_proposals", ok: false, asOf: null, error: publicErrorMessage(error) };
  }
}

async function sheetHealth(fetchImpl: typeof fetch, now: string): Promise<SourceHealth> {
  try {
    const response = await fetchImpl(COUNCIL_SHEET_CSV, { method: "GET", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      return { source: "council_sheet", ok: false, asOf: null, error: `Council sheet HTTP ${response.status}.` };
    }
    const text = await response.text();
    if (!text.includes("PIP Name")) {
      return { source: "council_sheet", ok: false, asOf: null, error: "Council sheet did not contain a PIP Name header." };
    }
    return { source: "council_sheet", ok: true, asOf: now, error: null };
  } catch (error) {
    return { source: "council_sheet", ok: false, asOf: null, error: publicErrorMessage(error) };
  }
}

async function rpcHealth(rpc: SolanaReadRpc, now: string): Promise<SourceHealth> {
  try {
    const result = await rpc.call<{ value?: number }>("getBalance", [DAO_TREASURY_ADDRESS, { commitment: "confirmed" }]);
    if (typeof result.value !== "number") {
      return { source: "solana_rpc", ok: false, asOf: null, error: "SOL balance was not a number." };
    }
    return { source: "solana_rpc", ok: true, asOf: now, error: null };
  } catch (error) {
    return { source: "solana_rpc", ok: false, asOf: null, error: publicErrorMessage(error) };
  }
}
