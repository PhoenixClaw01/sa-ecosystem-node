import { SafeClientError } from "../errors.js";
import type { CacheMovement } from "./types.js";
import { NATIVE_MINT, SOL_DECIMALS, symbolForMint, type WalletRole } from "./wallets.js";

interface RpcTokenAmount {
  amount?: string;
  decimals?: number;
}

interface RpcTokenBalance {
  mint?: string;
  owner?: string;
  uiTokenAmount?: RpcTokenAmount;
}

interface RpcAccountKey {
  pubkey?: string;
}

export interface RpcParsedTransaction {
  blockTime?: number | null;
  slot?: number;
  meta?: {
    err?: unknown;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: RpcTokenBalance[];
    postTokenBalances?: RpcTokenBalance[];
  } | null;
  transaction?: {
    signatures?: string[];
    message?: { accountKeys?: (RpcAccountKey | string)[] };
  };
}

export interface ParseResult {
  failed: boolean;
  undated: boolean;
  movements: CacheMovement[];
}

interface Side {
  amount: bigint;
  decimals: number;
}

function tokenSide(rows: RpcTokenBalance[] | undefined, owner: string, mint: string): Side | null {
  let amount: bigint | null = null;
  let decimals: number | null = null;
  for (const row of rows ?? []) {
    if (row.owner !== owner || row.mint !== mint) continue;
    const raw = row.uiTokenAmount?.amount;
    const places = row.uiTokenAmount?.decimals;
    if (typeof raw !== "string" || !/^\d+$/.test(raw) || typeof places !== "number") {
      throw new SafeClientError("A token balance was missing its raw amount.");
    }
    amount = (amount ?? 0n) + BigInt(raw);
    if (decimals === null) decimals = places;
    else if (decimals !== places) throw new SafeClientError("A mint reported two decimal scales in one transaction.");
  }
  if (amount === null || decimals === null) return null;
  return { amount, decimals };
}

function accountKeys(tx: RpcParsedTransaction): string[] {
  const keys = tx.transaction?.message?.accountKeys ?? [];
  return keys.map((key) => {
    if (typeof key === "string") return key;
    if (key && typeof key.pubkey === "string") return key.pubkey;
    throw new SafeClientError("A transaction account key was not parsed.");
  });
}

function lamports(value: number | undefined, label: string): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SafeClientError(`${label} was not a safe lamport count.`);
  }
  return BigInt(value);
}

/**
 * Balance changes for the tracked wallets in one parsed transaction.
 * Failed transactions produce no movements. Token amounts stay in raw integers.
 */
export function parseTransaction(
  tx: RpcParsedTransaction,
  signature: string,
  tracked: ReadonlyMap<string, WalletRole>,
): ParseResult {
  if (tx.meta?.err) return { failed: true, undated: false, movements: [] };
  if (tx.blockTime == null) return { failed: false, undated: true, movements: [] };
  const slot = tx.slot;
  if (typeof slot !== "number") throw new SafeClientError("A transaction was missing its slot.");
  const blockTime = tx.blockTime;
  const keys = accountKeys(tx);
  const feePayer = keys[0] ?? null;
  const fee = lamports(tx.meta?.fee ?? 0, "fee");
  const movements: CacheMovement[] = [];

  const mints = new Set<string>();
  for (const row of [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]) {
    if (row.mint && row.owner && tracked.has(row.owner)) mints.add(row.mint);
  }

  for (const [wallet, role] of tracked) {
    for (const mint of mints) {
      const pre = tokenSide(tx.meta?.preTokenBalances, wallet, mint);
      const post = tokenSide(tx.meta?.postTokenBalances, wallet, mint);
      if (!pre && !post) continue;
      const decimals = (post ?? pre)?.decimals;
      if (decimals === undefined) continue;
      if (pre && post && pre.decimals !== post.decimals) {
        throw new SafeClientError("Token decimals changed inside one transaction.");
      }
      const preAmount = pre?.amount ?? 0n;
      const postAmount = post?.amount ?? 0n;
      const delta = postAmount - preAmount;
      if (delta === 0n) continue;
      const others = counterpartyOwners(tx, tracked, wallet, mint, delta);
      movements.push({
        signature,
        slot,
        blockTime,
        wallet,
        role,
        mint,
        symbol: symbolForMint(mint),
        decimals,
        deltaRaw: delta.toString(),
        preRaw: preAmount.toString(),
        postRaw: postAmount.toString(),
        direction: delta > 0n ? "in" : "out",
        internal: others.internal,
        counterparties: others.counterparties,
        attribution: others.attribution,
      });
    }

    const index = keys.indexOf(wallet);
    if (index < 0) continue;
    const preLamports = lamports(tx.meta?.preBalances?.[index], "preBalance");
    const postLamports = lamports(tx.meta?.postBalances?.[index], "postBalance");
    const delta = postLamports - preLamports;
    if (delta === 0n) continue;
    const transfer = wallet === feePayer ? delta + fee : delta;
    const solOthers = solCounterparties(tx, keys, tracked, wallet, transfer);
    movements.push({
      signature,
      slot,
      blockTime,
      wallet,
      role,
      mint: NATIVE_MINT,
      symbol: "SOL",
      decimals: SOL_DECIMALS,
      deltaRaw: delta.toString(),
      preRaw: preLamports.toString(),
      postRaw: postLamports.toString(),
      direction: delta > 0n ? "in" : "out",
      internal: transfer !== 0n && solOthers.internal,
      counterparties: transfer === 0n ? [] : solOthers.counterparties,
      attribution: transfer === 0n ? "fee" : solOthers.attribution,
      transferRaw: transfer.toString(),
      feeRaw: wallet === feePayer ? fee.toString() : "0",
    });
  }

  return { failed: false, undated: false, movements };
}

function counterpartyOwners(
  tx: RpcParsedTransaction,
  tracked: ReadonlyMap<string, WalletRole>,
  wallet: string,
  mint: string,
  ourDelta: bigint,
): { counterparties: string[]; internal: boolean; attribution: "counterparty" | "unattributed" } {
  const owners = new Set<string>();
  for (const row of [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]) {
    if (row.mint === mint && row.owner) owners.add(row.owner);
  }
  const opposite: string[] = [];
  let oppositeSum = 0n;
  for (const owner of owners) {
    if (owner === wallet) continue;
    const pre = tokenSide(tx.meta?.preTokenBalances, owner, mint);
    const post = tokenSide(tx.meta?.postTokenBalances, owner, mint);
    const delta = (post?.amount ?? 0n) - (pre?.amount ?? 0n);
    if (delta === 0n) continue;
    if ((ourDelta > 0n && delta < 0n) || (ourDelta < 0n && delta > 0n)) {
      opposite.push(owner);
      oppositeSum += delta;
    }
  }
  opposite.sort();
  const matched = oppositeSum === -ourDelta && opposite.length > 0;
  const internal = matched && opposite.every((owner) => tracked.has(owner));
  return {
    counterparties: opposite,
    internal,
    attribution: matched ? "counterparty" : "unattributed",
  };
}

function solCounterparties(
  tx: RpcParsedTransaction,
  keys: string[],
  tracked: ReadonlyMap<string, WalletRole>,
  wallet: string,
  transfer: bigint,
): { counterparties: string[]; internal: boolean; attribution: "counterparty" | "unattributed" } {
  if (transfer === 0n) return { counterparties: [], internal: false, attribution: "counterparty" };
  const feePayer = keys[0] ?? null;
  const fee = lamports(tx.meta?.fee ?? 0, "fee");
  const opposite: string[] = [];
  let oppositeSum = 0n;
  keys.forEach((key, index) => {
    if (key === wallet) return;
    const pre = lamports(tx.meta?.preBalances?.[index], "preBalance");
    const post = lamports(tx.meta?.postBalances?.[index], "postBalance");
    const raw = post - pre;
    const otherTransfer = key === feePayer ? raw + fee : raw;
    if (otherTransfer === 0n) return;
    if ((transfer > 0n && otherTransfer < 0n) || (transfer < 0n && otherTransfer > 0n)) {
      opposite.push(key);
      oppositeSum += otherTransfer;
    }
  });
  opposite.sort();
  const matched = opposite.length > 0 && oppositeSum === -transfer;
  return {
    counterparties: opposite,
    internal: matched && opposite.every((key) => tracked.has(key)),
    attribution: matched ? "counterparty" : "unattributed",
  };
}

/** Treasury ATLAS raw delta in a transaction. Null when the wallet's ATLAS balance is absent. */
export function atlasDelta(tx: RpcParsedTransaction, wallet: string, mint: string): bigint | null {
  if (tx.meta?.err) return 0n;
  const pre = tokenSide(tx.meta?.preTokenBalances, wallet, mint);
  const post = tokenSide(tx.meta?.postTokenBalances, wallet, mint);
  if (!pre && !post) return null;
  return (post?.amount ?? 0n) - (pre?.amount ?? 0n);
}

export function atlasPre(tx: RpcParsedTransaction, wallet: string, mint: string): { raw: bigint; decimals: number } | null {
  const pre = tokenSide(tx.meta?.preTokenBalances, wallet, mint);
  if (!pre) return null;
  return { raw: pre.amount, decimals: pre.decimals };
}

export function atlasPost(tx: RpcParsedTransaction, wallet: string, mint: string): { raw: bigint; decimals: number } | null {
  const post = tokenSide(tx.meta?.postTokenBalances, wallet, mint);
  if (!post) return null;
  return { raw: post.amount, decimals: post.decimals };
}
