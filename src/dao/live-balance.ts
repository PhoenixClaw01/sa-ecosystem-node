import { formatRaw } from "./amount.js";
import { liveReadStamp, updatedAgo } from "./freshness.js";
import { SafeClientError, publicErrorMessage } from "../errors.js";
import {
  ATLAS_DECIMALS,
  ATLAS_MINT,
  NATIVE_MINT,
  SOL_DECIMALS,
  TRACKED_WALLETS,
  USDC_MINT,
  symbolForMint,
  type WalletRole,
} from "./wallets.js";

const TOKEN_DECIMALS: Record<string, number> = {
  [ATLAS_MINT]: ATLAS_DECIMALS,
  [USDC_MINT]: 6,
};

export interface LiveAccountSlot {
  wallet: string;
  role: WalletRole;
  name: string;
  kind: "sol" | "token";
  symbol: "SOL" | "ATLAS" | "USDC";
  /** `native` for SOL. The token mint otherwise. */
  mint: string;
  /** Account passed to getMultipleAccounts. The wallet itself for SOL, the standard token account otherwise. */
  address: string;
  decimals: number;
}

export interface ParsedLiveBalance {
  wallet: string;
  role: WalletRole;
  name: string;
  symbol: "SOL" | "ATLAS" | "USDC";
  mint: string;
  amountRaw: string;
  amount: string;
  decimals: number;
  /** True when the standard token account is absent. A successful read of zero, not a failed read. */
  missing: boolean;
  tokenAccount: string | null;
}

type AssociatedTokenAddress = (owner: string, mint: string) => Promise<string>;

/** The six accounts (two wallets, SOL plus standard ATLAS and USDC) read in one batch. */
export async function liveBalanceSlots(associatedTokenAddress: AssociatedTokenAddress): Promise<LiveAccountSlot[]> {
  const slots: LiveAccountSlot[] = [];
  for (const wallet of TRACKED_WALLETS) {
    slots.push({
      wallet: wallet.address,
      role: wallet.role,
      name: wallet.name,
      kind: "sol",
      symbol: "SOL",
      mint: NATIVE_MINT,
      address: wallet.address,
      decimals: SOL_DECIMALS,
    });
    for (const mint of [ATLAS_MINT, USDC_MINT] as const) {
      const symbol = symbolForMint(mint);
      if (symbol !== "ATLAS" && symbol !== "USDC") {
        throw new SafeClientError("A tracked mint has no symbol.");
      }
      slots.push({
        wallet: wallet.address,
        role: wallet.role,
        name: wallet.name,
        kind: "token",
        symbol,
        mint,
        address: await associatedTokenAddress(wallet.address, mint),
        decimals: TOKEN_DECIMALS[mint] ?? 0,
      });
    }
  }
  return slots;
}

function lamportsOf(account: unknown): number | null {
  if (!account || typeof account !== "object") return null;
  const lamports = (account as { lamports?: unknown }).lamports;
  if (typeof lamports !== "number" || !Number.isSafeInteger(lamports) || lamports < 0) return null;
  return lamports;
}

function tokenAmountOf(account: unknown): { mint: string; amount: string; decimals: number } | null {
  if (!account || typeof account !== "object") return null;
  const data = (account as { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const info = (data as { parsed?: { info?: { mint?: unknown; tokenAmount?: { amount?: unknown; decimals?: unknown } } } }).parsed
    ?.info;
  const mint = info?.mint;
  const amount = info?.tokenAmount?.amount;
  const decimals = info?.tokenAmount?.decimals;
  if (typeof mint !== "string" || typeof amount !== "string" || !/^\d+$/.test(amount) || typeof decimals !== "number") return null;
  return { mint, amount, decimals };
}

/**
 * Parse one getMultipleAccounts result. Throws when the payload is the wrong shape,
 * so the caller can keep the cached figure instead of showing a made-up number.
 * A null token account is zero on that standard account.
 */
export function parseMultipleAccountsBalances(
  slots: readonly LiveAccountSlot[],
  value: unknown,
): ParsedLiveBalance[] {
  if (!Array.isArray(value) || value.length !== slots.length) {
    throw new SafeClientError("getMultipleAccounts did not return one entry per balance account. No balance was invented.");
  }
  return slots.map((slot, index) => {
    const account = value[index];
    if (slot.kind === "sol") {
      if (account === null) {
        return {
          wallet: slot.wallet,
          role: slot.role,
          name: slot.name,
          symbol: slot.symbol,
          mint: slot.mint,
          amountRaw: "0",
          amount: "0",
          decimals: slot.decimals,
          missing: false,
          tokenAccount: null,
        };
      }
      const lamports = lamportsOf(account);
      if (lamports === null) {
        throw new SafeClientError(`SOL balance for ${slot.name} was not a safe integer. No balance was invented.`);
      }
      return {
        wallet: slot.wallet,
        role: slot.role,
        name: slot.name,
        symbol: slot.symbol,
        mint: slot.mint,
        amountRaw: String(lamports),
        amount: formatRaw(BigInt(lamports), slot.decimals),
        decimals: slot.decimals,
        missing: false,
        tokenAccount: null,
      };
    }
    if (account === null) {
      return {
        wallet: slot.wallet,
        role: slot.role,
        name: slot.name,
        symbol: slot.symbol,
        mint: slot.mint,
        amountRaw: "0",
        amount: "0",
        decimals: slot.decimals,
        missing: true,
        tokenAccount: slot.address,
      };
    }
    const token = tokenAmountOf(account);
    if (!token || token.mint !== slot.mint) {
      throw new SafeClientError(
        `Token balance for ${slot.name} ${slot.symbol} was unreadable. No balance was invented.`,
      );
    }
    return {
      wallet: slot.wallet,
      role: slot.role,
      name: slot.name,
      symbol: slot.symbol,
      mint: slot.mint,
      amountRaw: token.amount,
      amount: formatRaw(BigInt(token.amount), token.decimals),
      decimals: token.decimals,
      missing: false,
      tokenAccount: slot.address,
    };
  });
}

export interface TokenBalanceRow {
  mint: string;
  symbol: string | null;
  tokenAccount: string;
  amountRaw: string;
  amount: string;
  decimals: number;
  standardAccount: true;
  missing: boolean;
}

export interface WalletBalanceRead {
  role: WalletRole;
  name: string;
  address: string;
  sol: { amountRaw: string; amount: string };
  tokens: TokenBalanceRow[];
  fetchedAt: string;
  note: string;
}

const BALANCE_NOTE = "Standard associated token account only. Other token accounts for the same mint were not listed.";

export interface CachedRawBalance {
  amountRaw: string;
  decimals: number;
  fetchedAt: string;
}

interface BalanceRpc {
  call<T>(method: string, params: readonly unknown[]): Promise<T>;
}

/** A cached raw balance, or null when that wallet and mint are not in the list. */
export function cachedRawBalance(
  balances: readonly { wallet?: unknown; mint?: unknown; amountRaw?: unknown; decimals?: unknown; fetchedAt?: unknown }[],
  wallet: string,
  mint: string,
): CachedRawBalance | null {
  const row = balances.find((item) => item.wallet === wallet && item.mint === mint);
  if (!row || typeof row.amountRaw !== "string" || !/^\d+$/.test(row.amountRaw) || typeof row.decimals !== "number") return null;
  if (typeof row.fetchedAt !== "string" || Number.isNaN(Date.parse(row.fetchedAt))) return null;
  return { amountRaw: row.amountRaw, decimals: row.decimals, fetchedAt: row.fetchedAt };
}

function tokenRow(row: ParsedLiveBalance): TokenBalanceRow {
  return {
    mint: row.mint,
    symbol: row.symbol,
    tokenAccount: row.tokenAccount ?? "",
    amountRaw: row.amountRaw,
    amount: row.amount,
    decimals: row.decimals,
    standardAccount: true,
    missing: row.missing,
  };
}

function groupBalances(rows: readonly ParsedLiveBalance[], fetchedAt: string): WalletBalanceRead[] {
  return TRACKED_WALLETS.map((wallet) => {
    const mine = rows.filter((row) => row.wallet === wallet.address);
    const sol = mine.find((row) => row.symbol === "SOL");
    if (!sol) throw new SafeClientError(`SOL balance for ${wallet.name} was missing. No balance was invented.`);
    return {
      role: wallet.role,
      name: wallet.name,
      address: wallet.address,
      sol: { amountRaw: sol.amountRaw, amount: sol.amount },
      tokens: mine.filter((row) => row.symbol !== "SOL").map(tokenRow),
      fetchedAt,
      note: BALANCE_NOTE,
    };
  });
}

/** One getMultipleAccounts call for both published wallets. */
export async function readTrackedBalances(
  rpc: BalanceRpc,
  associatedTokenAddress: AssociatedTokenAddress,
  fetchedAt: string,
): Promise<WalletBalanceRead[]> {
  const slots = await liveBalanceSlots(associatedTokenAddress);
  const result = await rpc.call<{ value?: unknown }>("getMultipleAccounts", [
    slots.map((slot) => slot.address),
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);
  return groupBalances(parseMultipleAccountsBalances(slots, result?.value), fetchedAt);
}

/** The same six figures from cached balance rows. Null when any figure is missing. */
export function balancesFromCacheRows(
  balances: readonly { wallet?: unknown; mint?: unknown; amountRaw?: unknown; decimals?: unknown; fetchedAt?: unknown }[],
): { wallets: WalletBalanceRead[]; asOf: string } | null {
  const rows: ParsedLiveBalance[] = [];
  let asOf: string | null = null;
  for (const wallet of TRACKED_WALLETS) {
    for (const mint of [NATIVE_MINT, ATLAS_MINT, USDC_MINT]) {
      const cached = cachedRawBalance(balances, wallet.address, mint);
      if (!cached) return null;
      const parsedAt = Date.parse(cached.fetchedAt);
      if (asOf === null || parsedAt < Date.parse(asOf)) asOf = cached.fetchedAt;
      const symbol = symbolForMint(mint);
      if (symbol !== "SOL" && symbol !== "ATLAS" && symbol !== "USDC") return null;
      rows.push({
        wallet: wallet.address,
        role: wallet.role,
        name: wallet.name,
        symbol,
        mint,
        amountRaw: cached.amountRaw,
        amount: formatRaw(BigInt(cached.amountRaw), cached.decimals),
        decimals: cached.decimals,
        missing: false,
        tokenAccount: mint === NATIVE_MINT ? null : "",
      });
    }
  }
  if (!asOf) return null;
  return { wallets: groupBalances(rows, asOf), asOf };
}

export interface BalanceTile {
  wallet: string;
  symbol: "SOL" | "ATLAS" | "USDC";
  /** Null when neither the live read nor the cache had this figure. */
  amount: string | null;
  missing: boolean;
  mode: "live" | "cached" | "unavailable";
  text: string;
}

export interface BalanceRead {
  ok: boolean;
  mode: "live" | "cached" | "unavailable";
  asOf: string | null;
  wallets: WalletBalanceRead[];
  tiles: BalanceTile[];
  liveError: string | null;
  label: string;
}

function tileText(input: {
  symbol: "SOL" | "ATLAS" | "USDC";
  missing: boolean;
  mode: "live" | "cached" | "unavailable";
  asOf: string | null;
  nowMs: number;
  liveError: string | null;
}): string {
  if (input.mode === "unavailable") {
    const why = input.liveError ? `Live balance read failed (${input.liveError}). ` : "";
    return `${why}No cached balance was available. No balance was invented.`;
  }
  if (input.mode === "cached") {
    const ago = input.asOf ? updatedAgo(input.asOf, input.nowMs) : "";
    return ago || "Cached value";
  }
  const stamp = input.asOf ? liveReadStamp(input.asOf) : "";
  if (input.symbol === "SOL") return `${stamp}. Native SOL.`;
  if (input.missing) return `${stamp}. No standard token account, so the balance there is 0.`;
  return `${stamp}. Standard token account.`;
}

function tilesFor(
  wallets: readonly WalletBalanceRead[],
  mode: "live" | "cached" | "unavailable",
  asOf: string | null,
  nowMs: number,
  liveError: string | null,
): BalanceTile[] {
  const symbols = ["ATLAS", "USDC", "SOL"] as const;
  const tiles: BalanceTile[] = [];
  for (const wallet of mode === "unavailable" ? TRACKED_WALLETS : wallets) {
    for (const symbol of symbols) {
      const live = wallets.find((item) => item.address === wallet.address);
      const token = symbol === "SOL" ? null : live?.tokens.find((item) => item.symbol === symbol);
      const amount = mode === "unavailable" ? null : symbol === "SOL" ? (live?.sol.amount ?? null) : (token?.amount ?? null);
      const missing = symbol !== "SOL" && token?.missing === true;
      tiles.push({
        wallet: wallet.address,
        symbol,
        amount,
        missing,
        mode: amount === null ? "unavailable" : mode,
        text: tileText({ symbol, missing, mode: amount === null ? "unavailable" : mode, asOf, nowMs, liveError }),
      });
    }
  }
  return tiles;
}

/**
 * Live balances from one getMultipleAccounts call. On failure, the treasury cache
 * rows are used. Neither path invents a number.
 */
export async function readBalancesWithFallback(input: {
  rpc: BalanceRpc;
  associatedTokenAddress: AssociatedTokenAddress;
  now: Date;
  cacheBalances?: readonly { wallet?: unknown; mint?: unknown; amountRaw?: unknown; decimals?: unknown; fetchedAt?: unknown }[] | null;
}): Promise<BalanceRead> {
  const nowMs = input.now.getTime();
  const fetchedAt = input.now.toISOString();
  try {
    const wallets = await readTrackedBalances(input.rpc, input.associatedTokenAddress, fetchedAt);
    const label = liveReadStamp(fetchedAt);
    return {
      ok: true,
      mode: "live",
      asOf: fetchedAt,
      wallets,
      tiles: tilesFor(wallets, "live", fetchedAt, nowMs, null),
      liveError: null,
      label,
    };
  } catch (error) {
    const liveError = publicErrorMessage(error);
    const cached = input.cacheBalances ? balancesFromCacheRows(input.cacheBalances) : null;
    if (!cached) {
      const label = `Live balance read failed (${liveError}). No cached balance was available. No balance was invented.`;
      return {
        ok: false,
        mode: "unavailable",
        asOf: null,
        wallets: [],
        tiles: tilesFor([], "unavailable", null, nowMs, liveError),
        liveError,
        label,
      };
    }
    const label = updatedAgo(cached.asOf, nowMs) || "Cached value";
    return {
      ok: true,
      mode: "cached",
      asOf: cached.asOf,
      wallets: cached.wallets,
      tiles: tilesFor(cached.wallets, "cached", cached.asOf, nowMs, liveError),
      liveError,
      label,
    };
  }
}
