import { existsSync } from "node:fs";

import { publicErrorMessage, SafeClientError } from "../errors.js";
import { redactRpcUrl } from "../config.js";
import { utcDay, utcMonth } from "./amount.js";
import { requireDashboardScript } from "./browser-scripts.js";
import { emptyCache, loadCache, saveCache } from "./cache.js";
import {
  atlasDelta,
  atlasPost,
  atlasPre,
  parseTransaction,
  type RpcParsedTransaction,
} from "./parse-tx.js";
import {
  createFallbackRpc,
  listSignatures,
  SIGNATURE_PAGE_LIMIT,
  signaturePage,
  TRANSACTION_OPTIONS,
  type SignatureInfo,
  type SolanaReadRpc,
} from "./rpc.js";
import type {
  AtlasScan,
  CacheMovement,
  ForwardResume,
  ParsedCursor,
  PendingSignature,
  TokenAccountRef,
  TreasuryCache,
} from "./types.js";
import {
  ATLAS_MINT,
  DAO_TREASURY_ADDRESS,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  TRACKED_WALLETS,
  USDC_MINT,
  roleOf,
  symbolForMint,
  type WalletRole,
} from "./wallets.js";
const SCOPED_MINTS = [ATLAS_MINT, USDC_MINT] as const;

export interface RefreshOptions {
  rpcUrl: string;
  rpcUrls?: readonly string[];
  cachePath: string;
  maxAtlasPages?: number;
  /** Signature pages of 1,000 per address. Unset means no cap. */
  maxSignaturePages?: number;
  /**
   * When true, apply signatures newer than each cached cursor oldest-first,
   * then continue the older walk from the oldest parsed signature. The page
   * cap bounds both walks. Signatures past the cap are kept, and the cursor
   * advances as each oldest chunk is applied.
   */
  incremental?: boolean;
  rpc?: SolanaReadRpc;
  now?: () => Date;
  log?: (line: string) => void;
}

interface RawTokenAccount {
  pubkey?: string;
  account?: {
    data?: {
      parsed?: {
        info?: { mint?: string; tokenAmount?: { amount?: string; decimals?: number } };
      };
    };
  };
}

function cacheHasRead(cache: TreasuryCache): boolean {
  return (
    cache.discovery !== null ||
    cache.tokenAccounts.length > 0 ||
    cache.movements.length > 0 ||
    cache.balances.length > 0 ||
    (cache.atlasScan?.pagesScanned ?? 0) > 0
  );
}

interface ForwardFlags {
  /** A page cap stopped the forward list before it reached the cached cursor. */
  listing: boolean;
  /** Applied an oldest chunk and left newer signatures for the next run. */
  applied: boolean;
  /** Applied a stored window whose chain tip had been dropped. Newer signatures remain. */
  remainder: boolean;
}

function finishReason(
  cache: TreasuryCache,
  discoveryNote: string | null,
  maxAtlasPages: number,
  incremental: boolean,
  forward: ForwardFlags,
): string | null {
  const reasons: string[] = [];
  if (discoveryNote) reasons.push(discoveryNote);
  if (forward.listing || forward.applied || forward.remainder) {
    reasons.push(
      "New signatures exceeded the page cap. They are kept and applied oldest-first, and the cached cursor advances with each applied chunk. The next run continues.",
    );
  }
  if (incremental) {
    if (cache.cursors.some((cursor) => !cursor.reachedEnd) || (cache.atlasScan && !cache.atlasScan.reachedEnd)) {
      reasons.push(
        "This run fetched signatures newer than the cached cursor, then walked older history up to the page cap. The next run continues from the oldest parsed signature.",
      );
    }
    return reasons.length > 0 ? reasons.join(" ") : null;
  }
  if (cache.atlasScan && !cache.atlasScan.reachedEnd) {
    reasons.push(
      `The ATLAS signature scan stopped after ${cache.atlasScan.pagesScanned} page(s), under the cap of ${maxAtlasPages}. The next run continues.`,
    );
  }
  if (cache.cursors.some((cursor) => !cursor.reachedEnd)) {
    reasons.push("A signature walk has not reached the oldest signature. The next run continues.");
  }
  return reasons.length > 0 ? reasons.join(" ") : null;
}

export async function refreshTreasury(options: RefreshOptions): Promise<TreasuryCache> {
  const log = options.log ?? ((line: string) => console.error(line));
  const now = options.now ?? (() => new Date());
  const urls = options.rpcUrls && options.rpcUrls.length > 0 ? options.rpcUrls : [options.rpcUrl];
  const rpc = options.rpc ?? createFallbackRpc(urls, fetch, { minIntervalMs: 400, attempts: 5 });
  const label = urls.map((url) => redactRpcUrl(url)).join(" then ");
  const maxAtlasPages = options.maxAtlasPages ?? 400;
  const maxSignaturePages = options.maxSignaturePages ?? Number.POSITIVE_INFINITY;
  const incremental = options.incremental === true;
  const forward: ForwardFlags = { listing: false, applied: false, remainder: false };
  const cache = existsSync(options.cachePath) ? loadCache(options.cachePath) : emptyCache(label, now().toISOString());
  cache.rpc = label;
  log(
    `Treasury refresh RPC order: ${label}. Atlas page cap ${maxAtlasPages}. Signature page cap ${Number.isFinite(maxSignaturePages) ? maxSignaturePages : "none"}.${incremental ? " Incremental: newer signatures, then the older walk within the page cap." : ""}`,
  );

  try {
    const discovered = await discoverTokenAccounts(rpc);
    cache.tokenAccounts = discovered.accounts;
    cache.discovery = { at: now().toISOString() };
    cache.completeness = "partial";
    cache.partialReason = discovered.note ?? "The refresh has not finished this run.";
    const tracked = new Map(TRACKED_WALLETS.map((wallet) => [wallet.address, wallet.role]));

    for (const wallet of TRACKED_WALLETS) {
      await backfillAddress(rpc, cache, {
        address: wallet.address,
        role: wallet.role,
        kind: "wallet",
        mint: null,
        tracked,
        maxSignaturePages,
        incremental,
        forward,
      });
      cache.generatedAt = now().toISOString();
      saveCache(options.cachePath, cache);
    }
    for (const account of cache.tokenAccounts) {
      if (account.mint === ATLAS_MINT && account.role === "dao_treasury") continue;
      await backfillAddress(rpc, cache, {
        address: account.address,
        role: account.role,
        kind: "token",
        mint: account.mint,
        tracked,
        maxSignaturePages,
        incremental,
        forward,
      });
      cache.generatedAt = now().toISOString();
      saveCache(options.cachePath, cache);
    }

    cache.balances = await readBalances(rpc, cache, now().toISOString());
    reconcileParsed(cache);
    cache.generatedAt = now().toISOString();
    saveCache(options.cachePath, cache);
    const atlasScope = incremental
      ? await scanAtlasIncremental(rpc, cache, maxAtlasPages, forward)
      : null;
    if (!incremental) await scanAtlas(rpc, cache, maxAtlasPages, log, options.cachePath, now);
    await fillSnapshots(rpc, cache, atlasScope ? atlasScope.touched : null);
    await fillOpening(rpc, cache);
    await checkSamples(rpc, cache, tracked, atlasScope ? atlasScope.signatures : null);
    const reason = finishReason(cache, discovered.note, maxAtlasPages, incremental, forward);
    cache.completeness = reason ? "partial" : "complete";
    cache.partialReason = reason;
    cache.generatedAt = now().toISOString();
    saveCache(options.cachePath, cache);
    log(summaryLine(cache));
    return cache;
  } catch (error) {
    if (cacheHasRead(cache)) {
      cache.completeness = "partial";
      cache.partialReason = publicErrorMessage(error);
      cache.generatedAt = now().toISOString();
      saveCache(options.cachePath, cache);
      log(`Partial treasury cache saved. ${cache.partialReason}`);
    }
    throw error;
  }
}

function indexedLookupRefused(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /personal token|indexed request|getTokenAccountsByOwner|HTTP 403|HTTP 429|after retries|refused the read/i.test(message);
}

async function discoverTokenAccounts(rpc: SolanaReadRpc): Promise<{ accounts: TokenAccountRef[]; note: string | null }> {
  try {
    const found: TokenAccountRef[] = [];
    for (const wallet of TRACKED_WALLETS) {
      for (const mint of SCOPED_MINTS) {
        const accounts = await tokenAccountsForMint(rpc, wallet.address, mint);
        if (accounts.length > 1) {
          throw new SafeClientError(
            `More than one ${symbolForMint(mint) ?? mint} account for ${wallet.name}: ${accounts.map((item) => item.address).join(", ")}.`,
          );
        }
        const account = accounts[0];
        if (!account) continue;
        found.push({ role: wallet.role, wallet: wallet.address, mint, address: account.address, decimals: account.decimals });
      }
    }
    return { accounts: found, note: null };
  } catch (error) {
    if (!indexedLookupRefused(error)) throw error;
    const accounts = await standardTokenAccounts(rpc);
    const reason = publicErrorMessage(error);
    return {
      accounts,
      note: `Indexed token-account lookup was refused (${reason}). Only each wallet's standard associated token account was read with getAccountInfo.`,
    };
  }
}

async function standardTokenAccounts(rpc: SolanaReadRpc): Promise<TokenAccountRef[]> {
  const ata = requireDashboardScript("ata.js") as {
    associatedTokenAddress: (owner: string, mint: string) => Promise<string>;
  };
  const found: TokenAccountRef[] = [];
  for (const wallet of TRACKED_WALLETS) {
    for (const mint of SCOPED_MINTS) {
      const address = await ata.associatedTokenAddress(wallet.address, mint);
      const result = await rpc.call<{
        value?: { data?: { parsed?: { info?: { mint?: string; tokenAmount?: { decimals?: number } } } } } | null;
      }>("getAccountInfo", [address, { encoding: "jsonParsed", commitment: "confirmed" }]);
      const info = result?.value?.data?.parsed?.info;
      if (!info || info.mint !== mint || typeof info.tokenAmount?.decimals !== "number") continue;
      found.push({ role: wallet.role, wallet: wallet.address, mint, address, decimals: info.tokenAmount.decimals });
    }
  }
  return found;
}

async function tokenAccountsForMint(
  rpc: SolanaReadRpc,
  wallet: string,
  mint: string,
): Promise<{ address: string; decimals: number }[]> {
  const accounts: { address: string; decimals: number }[] = [];
  const filters: Record<string, string>[] = [{ mint }, { programId: TOKEN_PROGRAM }, { programId: TOKEN_2022_PROGRAM }];
  for (const filter of filters) {
    const result = await rpc.call<{ value?: RawTokenAccount[] }>("getTokenAccountsByOwner", [
      wallet,
      filter,
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
    for (const item of result?.value ?? []) {
      const info = item.account?.data?.parsed?.info;
      if (!info || info.mint !== mint || typeof item.pubkey !== "string") continue;
      const decimals = info.tokenAmount?.decimals;
      if (typeof decimals !== "number" || accounts.some((account) => account.address === item.pubkey)) continue;
      accounts.push({ address: item.pubkey, decimals });
    }
    if (filter.mint && accounts.length > 0) break;
  }
  return accounts;
}

async function backfillAddress(
  rpc: SolanaReadRpc,
  cache: TreasuryCache,
  job: {
    address: string;
    role: WalletRole;
    kind: "wallet" | "token";
    mint: string | null;
    tracked: Map<string, WalletRole>;
    maxSignaturePages: number;
    incremental: boolean;
    forward: ForwardFlags;
  },
): Promise<void> {
  let cursor = cache.cursors.find((item) => item.address === job.address && item.kind === job.kind && item.mint === job.mint);
  if (!cursor) {
    cursor = {
      address: job.address,
      role: job.role,
      kind: job.kind,
      mint: job.mint,
      newestSignature: null,
      oldestSignature: null,
      reachedEnd: false,
      gaps: [],
      reconciled: null,
    };
    cache.cursors.push(cursor);
  }
  if (job.incremental) {
    await backfillNewer(rpc, cache, cursor, job);
    return;
  }
  if (!cursor.reachedEnd) {
    const listed = await listSignatures(rpc, job.address, null, {
      maxPages: job.maxSignaturePages,
      before: cursor.oldestSignature,
    });
    await parseSignatures(rpc, cache, cursor, listed.signatures, job.tracked);
    cursor.reachedEnd = listed.reachedEnd;
    const newest = listed.signatures[0];
    const oldest = listed.signatures[listed.signatures.length - 1];
    if (!cursor.newestSignature && newest) cursor.newestSignature = newest.signature;
    if (oldest) cursor.oldestSignature = oldest.signature;
    if (job.kind === "wallet" && job.role === "dao_treasury") {
      const seen = new Set(cursor.signatures ?? []);
      cursor.signatures = [...(cursor.signatures ?? []), ...listed.signatures.map((item) => item.signature).filter((sig) => !seen.has(sig))];
    }
    return;
  }
  const fresh = await listSignatures(rpc, job.address, cursor.newestSignature);
  const retry = cursor.gaps.map((signature) => ({ signature, slot: 0, blockTime: null, err: null }));
  await parseSignatures(rpc, cache, cursor, [...fresh.signatures, ...retry], job.tracked);
  const tip = fresh.signatures[0];
  if (tip) cursor.newestSignature = tip.signature;
  if (job.kind === "wallet" && job.role === "dao_treasury") {
    const all = await listSignatures(rpc, job.address, null);
    cursor.signatures = all.signatures.map((item) => item.signature);
  }
}

function rememberTreasury(cursor: ParsedCursor, signatures: readonly SignatureInfo[], where: "prepend" | "append"): void {
  if (cursor.kind !== "wallet" || cursor.role !== "dao_treasury" || signatures.length === 0) return;
  const seen = new Set(cursor.signatures ?? []);
  const fresh = signatures.map((item) => item.signature).filter((signature) => !seen.has(signature));
  cursor.signatures = where === "prepend" ? [...fresh, ...(cursor.signatures ?? [])] : [...(cursor.signatures ?? []), ...fresh];
}

/**
 * Keep each unapplied forward window small enough that several of them still
 * fit under the workflow's 8MB cache commit cap. Newest rows are dropped
 * first. They stay on chain and are listed again after this window is applied.
 */
const MAX_PENDING_SIGNATURES = 10_000;

interface ForwardState {
  rows: PendingSignature[];
  joined: boolean;
  droppedTip: boolean;
}

function loadForward(source: ForwardResume): ForwardState {
  const rows: PendingSignature[] = [];
  for (const row of source.pendingNewer ?? []) {
    if (!Array.isArray(row) || typeof row[0] !== "string") continue;
    const blockTime = typeof row[1] === "number" || row[1] === null ? row[1] : null;
    const failed: 0 | 1 = row[2] === 1 ? 1 : 0;
    rows.push([row[0], blockTime, failed]);
  }
  return { rows, joined: source.pendingJoined === true, droppedTip: source.pendingDroppedTip === true };
}

function saveForward(target: ForwardResume, state: ForwardState): void {
  if (state.rows.length === 0) {
    delete target.pendingNewer;
    delete target.pendingJoined;
    delete target.pendingDroppedTip;
    return;
  }
  target.pendingNewer = state.rows;
  if (state.joined) target.pendingJoined = true;
  else delete target.pendingJoined;
  if (state.droppedTip) target.pendingDroppedTip = true;
  else delete target.pendingDroppedTip;
}

function pendingToSignature(row: PendingSignature): SignatureInfo {
  return {
    signature: row[0],
    slot: 0,
    blockTime: row[1],
    err: row[2] === 1 ? { failed: true } : null,
  };
}

function appendPending(rows: readonly PendingSignature[], extra: readonly SignatureInfo[], until: string): { rows: PendingSignature[]; droppedTip: boolean } {
  const seen = new Set(rows.map((row) => row[0]));
  const next = rows.slice();
  for (const item of extra) {
    if (item.signature === until || seen.has(item.signature)) continue;
    seen.add(item.signature);
    const failed: 0 | 1 = item.err ? 1 : 0;
    next.push([item.signature, item.blockTime, failed]);
  }
  if (next.length <= MAX_PENDING_SIGNATURES) return { rows: next, droppedTip: false };
  next.splice(0, next.length - MAX_PENDING_SIGNATURES);
  return { rows: next, droppedTip: true };
}

function chunkLimit(maxPages: number): number {
  if (!Number.isFinite(maxPages)) return Number.MAX_SAFE_INTEGER;
  return maxPages * SIGNATURE_PAGE_LIMIT;
}

/**
 * List signatures newer than `until` up to the page cap, continuing from the
 * oldest stored row. Once that list reaches the cursor, the oldest chunk is
 * the one to apply. The returned state is the window after that chunk is
 * removed. The caller persists it only after the chunk is applied.
 */
async function planForward(
  rpc: SolanaReadRpc,
  address: string,
  until: string,
  maxPages: number,
  state: ForwardState,
  flags: ForwardFlags,
): Promise<{ state: ForwardState; pages: number; chunk: SignatureInfo[] | null }> {
  let next = state;
  let pages = 0;
  if (!next.joined) {
    const before = next.rows.length > 0 ? next.rows[next.rows.length - 1]?.[0] : null;
    const listed = await listSignatures(rpc, address, until, { maxPages, before });
    pages = listed.pages;
    const appended = appendPending(next.rows, listed.signatures, until);
    next = {
      rows: appended.rows,
      joined: listed.reachedEnd,
      droppedTip: next.droppedTip || appended.droppedTip,
    };
    if (!listed.reachedEnd) flags.listing = true;
  }
  if (!next.joined || next.rows.length === 0) return { state: next, pages, chunk: null };
  const count = Math.min(next.rows.length, Math.max(1, chunkLimit(maxPages)));
  const start = next.rows.length - count;
  const chunk = next.rows.slice(start).map(pendingToSignature);
  const drained = start === 0;
  if (drained && next.droppedTip) flags.remainder = true;
  else if (!drained) flags.applied = true;
  return {
    state: {
      rows: next.rows.slice(0, start),
      joined: !drained,
      droppedTip: drained ? false : next.droppedTip,
    },
    pages,
    chunk,
  };
}

/**
 * Newer signatures first, oldest chunk first when they overflow the page cap.
 * Then, while this address has not reached its oldest signature, walk backward
 * from the oldest parsed signature. Each walk stops at the page cap.
 */
async function backfillNewer(
  rpc: SolanaReadRpc,
  cache: TreasuryCache,
  cursor: ParsedCursor,
  job: {
    address: string;
    role: WalletRole;
    kind: "wallet" | "token";
    tracked: Map<string, WalletRole>;
    maxSignaturePages: number;
    forward: ForwardFlags;
  },
): Promise<void> {
  if (cursor.newestSignature) {
    const planned = await planForward(rpc, job.address, cursor.newestSignature, job.maxSignaturePages, loadForward(cursor), job.forward);
    if (planned.chunk && planned.chunk.length > 0) {
      await parseSignatures(rpc, cache, cursor, planned.chunk, job.tracked);
      const tip = planned.chunk[0];
      if (tip && tip.signature !== cursor.newestSignature) cursor.newestSignature = tip.signature;
      rememberTreasury(cursor, planned.chunk, "prepend");
    }
    saveForward(cursor, planned.state);
  } else if (cursor.reachedEnd) {
    return;
  }

  if (cursor.reachedEnd) return;
  const listed = await listSignatures(rpc, job.address, null, {
    maxPages: job.maxSignaturePages,
    before: cursor.oldestSignature,
  });
  await parseSignatures(rpc, cache, cursor, listed.signatures, job.tracked);
  const newest = listed.signatures[0];
  const oldest = listed.signatures[listed.signatures.length - 1];
  if (!cursor.newestSignature && newest) cursor.newestSignature = newest.signature;
  if (oldest) cursor.oldestSignature = oldest.signature;
  cursor.reachedEnd = listed.reachedEnd;
  rememberTreasury(cursor, listed.signatures, "append");
}

async function parseSignatures(
  rpc: SolanaReadRpc,
  cache: TreasuryCache,
  cursor: ParsedCursor,
  signatures: SignatureInfo[],
  tracked: Map<string, WalletRole>,
): Promise<void> {
  const pending = signatures.filter((item, index) => signatures.findIndex((other) => other.signature === item.signature) === index);
  for (let index = 0; index < pending.length; index += 5) {
    const chunk = pending.slice(index, index + 5);
    const results = await rpc.batch(
      chunk.map((item) => ({ method: "getTransaction", params: [item.signature, TRANSACTION_OPTIONS] })),
    );
    chunk.forEach((item, offset) => {
      const tx = results[offset] as RpcParsedTransaction | null;
      if (!tx) {
        if (!cursor.gaps.includes(item.signature)) cursor.gaps.push(item.signature);
        return;
      }
      cursor.gaps = cursor.gaps.filter((signature) => signature !== item.signature);
      const parsed = parseTransaction(tx, item.signature, tracked);
      if (parsed.undated && !cursor.gaps.includes(item.signature)) cursor.gaps.push(item.signature);
      mergeMovements(cache, parsed.movements);
    });
  }
  if (cursor.kind === "wallet" && cursor.role === "dao_treasury" && !cursor.signatures) {
    cursor.signatures = signatures.map((item) => item.signature);
  }
}

function mergeMovements(cache: TreasuryCache, movements: CacheMovement[]): void {
  if (movements.length === 0) return;
  const index = new Map(cache.movements.map((movement) => [movementKey(movement), movement]));
  for (const movement of movements) index.set(movementKey(movement), movement);
  cache.movements = [...index.values()].sort(compareMovements);
}

function movementKey(movement: CacheMovement): string {
  return `${movement.signature}:${movement.wallet}:${movement.mint}`;
}

function compareMovements(left: CacheMovement, right: CacheMovement): number {
  return left.blockTime - right.blockTime || left.slot - right.slot || left.signature.localeCompare(right.signature) || left.mint.localeCompare(right.mint);
}

async function readBalances(rpc: SolanaReadRpc, cache: TreasuryCache, fetchedAt: string) {
  const balances = [];
  for (const wallet of TRACKED_WALLETS) {
    const sol = await rpc.call<{ value?: number }>("getBalance", [wallet.address, { commitment: "confirmed" }]);
    if (typeof sol.value !== "number" || !Number.isSafeInteger(sol.value)) {
      throw new SafeClientError(`SOL balance for ${wallet.name} was not a safe integer. No balance was invented.`);
    }
    balances.push({
      role: wallet.role,
      wallet: wallet.address,
      mint: "native",
      symbol: "SOL",
      tokenAccount: null,
      amountRaw: String(sol.value),
      decimals: 9,
      fetchedAt,
    });
    for (const mint of SCOPED_MINTS) {
      const account = cache.tokenAccounts.find((item) => item.role === wallet.role && item.mint === mint);
      if (!account) {
        balances.push({
          role: wallet.role,
          wallet: wallet.address,
          mint,
          symbol: symbolForMint(mint),
          tokenAccount: null,
          amountRaw: "0",
          decimals: mint === ATLAS_MINT ? 8 : 6,
          fetchedAt,
        });
        continue;
      }
      const token = await rpc.call<{ value?: { amount?: string; decimals?: number } }>("getTokenAccountBalance", [
        account.address,
        { commitment: "confirmed" },
      ]);
      const amount = token.value?.amount;
      const decimals = token.value?.decimals;
      if (typeof amount !== "string" || !/^\d+$/.test(amount) || typeof decimals !== "number") {
        throw new SafeClientError(`Token balance for ${wallet.name} ${symbolForMint(mint) ?? mint} was unreadable. No balance was invented.`);
      }
      balances.push({
        role: wallet.role,
        wallet: wallet.address,
        mint,
        symbol: symbolForMint(mint),
        tokenAccount: account.address,
        amountRaw: amount,
        decimals,
        fetchedAt,
      });
    }
  }
  return balances;
}

function reconcileParsed(cache: TreasuryCache): void {
  for (const cursor of cache.cursors) {
    if (cursor.kind === "wallet") {
      cursor.reconciled = reconcileMint(cache, cursor.role, "native", cursor);
      continue;
    }
    if (!cursor.mint || (cursor.mint === ATLAS_MINT && cursor.role === "dao_treasury")) {
      cursor.reconciled = null;
      continue;
    }
    cursor.reconciled = reconcileMint(cache, cursor.role, cursor.mint, cursor);
  }
}

function reconcileMint(cache: TreasuryCache, role: WalletRole, mint: string, cursor: ParsedCursor): boolean {
  if (!cursor.reachedEnd || cursor.gaps.length > 0) return false;
  const balance = cache.balances.find((item) => item.role === role && item.mint === mint);
  if (!balance) return false;
  const movements = cache.movements.filter((movement) => movement.role === role && movement.mint === mint).sort(compareMovements);
  if (movements.length === 0) return BigInt(balance.amountRaw) === 0n;
  let previous: bigint | null = null;
  for (const movement of movements) {
    const pre = BigInt(movement.preRaw);
    if (previous !== null && pre !== previous) return false;
    previous = BigInt(movement.postRaw);
  }
  return previous === BigInt(balance.amountRaw);
}

async function scanAtlasIncremental(
  rpc: SolanaReadRpc,
  cache: TreasuryCache,
  maxPages: number,
  forward: ForwardFlags,
): Promise<{ touched: Set<string>; signatures: Set<string> }> {
  const account = cache.tokenAccounts.find((item) => item.role === "dao_treasury" && item.mint === ATLAS_MINT);
  if (!account) throw new SafeClientError("The DAO Treasury has no ATLAS token account. The scan was not started.");
  if (!cache.atlasScan || cache.atlasScan.tokenAccount !== account.address) {
    cache.atlasScan = emptyScan(account.address, account.wallet);
  }
  const scan = cache.atlasScan;
  const walletSigs = new Set(cache.cursors.find((cursor) => cursor.role === "dao_treasury" && cursor.kind === "wallet")?.signatures ?? []);
  const touched = new Set<string>();
  const signatures = new Set<string>();
  const noteTouch = (before: ReadonlyMap<string, string>) => {
    for (const [day, bucket] of Object.entries(scan.days)) {
      if (before.get(day) !== bucket.signature) touched.add(day);
    }
  };

  if (scan.newestSignature) {
    const before = new Map(Object.entries(scan.days).map(([day, bucket]) => [day, bucket.signature]));
    const planned = await planForward(rpc, account.address, scan.newestSignature, maxPages, loadForward(scan), forward);
    if (planned.chunk && planned.chunk.length > 0) {
      absorb(scan, planned.chunk, "forward", walletSigs);
      const tip = planned.chunk[0];
      if (tip && tip.signature !== scan.newestSignature) scan.newestSignature = tip.signature;
      noteTouch(before);
      for (const item of planned.chunk) signatures.add(item.signature);
    }
    scan.pagesScanned += planned.pages;
    saveForward(scan, planned.state);
  }
  if (scan.reachedEnd) return { touched, signatures };

  const before = new Map(Object.entries(scan.days).map(([day, bucket]) => [day, bucket.signature]));
  const listed = await listSignatures(rpc, account.address, null, { maxPages, before: scan.oldestSignature });
  scan.pagesScanned += listed.pages;
  if (listed.signatures.length === 0) {
    if (listed.reachedEnd) scan.reachedEnd = true;
    return { touched, signatures };
  }
  if (!scan.newestSignature && listed.signatures[0]) scan.newestSignature = listed.signatures[0].signature;
  absorb(scan, listed.signatures, "backward", walletSigs);
  const oldest = listed.signatures[listed.signatures.length - 1];
  if (oldest) scan.oldestSignature = oldest.signature;
  scan.reachedEnd = listed.reachedEnd;
  noteTouch(before);
  for (const item of listed.signatures) signatures.add(item.signature);
  return { touched, signatures };
}

async function scanAtlas(
  rpc: SolanaReadRpc,
  cache: TreasuryCache,
  maxPages: number,
  log: (line: string) => void,
  cachePath: string,
  now: () => Date,
): Promise<void> {
  const account = cache.tokenAccounts.find((item) => item.role === "dao_treasury" && item.mint === ATLAS_MINT);
  if (!account) throw new SafeClientError("The DAO Treasury has no ATLAS token account. The scan was not started.");
  if (!cache.atlasScan || cache.atlasScan.tokenAccount !== account.address) {
    cache.atlasScan = emptyScan(account.address, account.wallet);
  }
  const scan = cache.atlasScan;
  const walletSigs = new Set(cache.cursors.find((cursor) => cursor.role === "dao_treasury" && cursor.kind === "wallet")?.signatures ?? []);
  if (scan.newestSignature) {
    const until = scan.newestSignature;
    let before: string | undefined;
    let firstPage = true;
    for (;;) {
      const config: Record<string, unknown> = { limit: SIGNATURE_PAGE_LIMIT, commitment: "confirmed", until };
      if (before) config.before = before;
      const page = signaturePage(await rpc.call<unknown>("getSignaturesForAddress", [account.address, config]));
      if (!page) throw new SafeClientError("getSignaturesForAddress returned an unexpected shape.");
      if (page.length === 0) break;
      if (firstPage && page[0]) scan.newestSignature = page[0].signature;
      firstPage = false;
      absorb(scan, page, "forward", walletSigs);
      if (page.length < SIGNATURE_PAGE_LIMIT) break;
      before = page[page.length - 1]?.signature;
    }
  }
  let pages = 0;
  while (!scan.reachedEnd && pages < maxPages) {
    const config: Record<string, unknown> = { limit: SIGNATURE_PAGE_LIMIT, commitment: "confirmed" };
    if (scan.oldestSignature) config.before = scan.oldestSignature;
    const page = signaturePage(await rpc.call<unknown>("getSignaturesForAddress", [account.address, config]));
    if (!page) throw new SafeClientError("getSignaturesForAddress returned an unexpected shape.");
    pages += 1;
    scan.pagesScanned += 1;
    if (page.length === 0) {
      scan.reachedEnd = true;
      break;
    }
    if (!scan.newestSignature && page[0]) scan.newestSignature = page[0].signature;
    absorb(scan, page, "backward", walletSigs);
    scan.oldestSignature = page[page.length - 1]?.signature ?? scan.oldestSignature;
    if (page.length < SIGNATURE_PAGE_LIMIT) scan.reachedEnd = true;
    if (pages % 25 === 0 || scan.reachedEnd) {
      cache.generatedAt = now().toISOString();
      saveCache(cachePath, cache);
      log(`atlas scan pages=${scan.pagesScanned} days=${Object.keys(scan.days).length} reachedEnd=${scan.reachedEnd}`);
    }
  }
}

function emptyScan(tokenAccount: string, wallet: string): AtlasScan {
  return {
    tokenAccount,
    wallet,
    newestSignature: null,
    oldestSignature: null,
    openDay: null,
    reachedEnd: false,
    pagesScanned: 0,
    days: {},
    snapshots: {},
    opening: null,
    samples: [],
    sampleSeen: {},
    undatedCount: 0,
    undatedSignatures: [],
    assumption: "unchecked",
    assumptionViolations: [],
  };
}

function absorb(scan: AtlasScan, page: SignatureInfo[], mode: "forward" | "backward", walletSigs: ReadonlySet<string>): void {
  let previous = mode === "backward" ? scan.openDay : null;
  const replaced = new Set<string>();
  for (const signature of page) {
    if (signature.blockTime == null) {
      scan.undatedCount += 1;
      if (scan.undatedSignatures.length < 20) scan.undatedSignatures.push(signature.signature);
      continue;
    }
    const day = utcDay(signature.blockTime);
    previous = day;
    let bucket = scan.days[day];
    if (!bucket) {
      bucket = { signature: signature.signature, blockTime: signature.blockTime, signatureCount: 0, failedCount: 0 };
      scan.days[day] = bucket;
      delete scan.snapshots[day];
    } else if (mode === "forward" && !replaced.has(day) && signature.blockTime >= bucket.blockTime) {
      if (bucket.signature !== signature.signature) {
        bucket.signature = signature.signature;
        bucket.blockTime = signature.blockTime;
        delete scan.snapshots[day];
      }
      replaced.add(day);
    }
    bucket.signatureCount += 1;
    if (signature.err) bucket.failedCount += 1;
    else considerSample(scan, signature, walletSigs);
    if (mode === "backward" && !signature.err) {
      scan.oldestSignature = signature.signature;
    }
  }
  if (mode === "backward") scan.openDay = previous;
}

function considerSample(scan: AtlasScan, signature: SignatureInfo, walletSigs: ReadonlySet<string>): void {
  if (signature.err || signature.blockTime == null || walletSigs.has(signature.signature)) return;
  const month = utcMonth(signature.blockTime);
  const seen = (scan.sampleSeen[month] ?? 0) + 1;
  scan.sampleSeen[month] = seen;
  const mine = scan.samples.filter((sample) => sample.month === month);
  if (mine.length < 3) {
    scan.samples.push({ signature: signature.signature, month, checked: false, deltaRaw: null });
    return;
  }
  if (Math.random() < 3 / seen) {
    const slot = mine[Math.floor(Math.random() * mine.length)];
    if (slot && !slot.checked) {
      slot.signature = signature.signature;
      slot.deltaRaw = null;
    }
  }
}

async function fillSnapshots(rpc: SolanaReadRpc, cache: TreasuryCache, onlyDays: ReadonlySet<string> | null): Promise<void> {
  const scan = cache.atlasScan;
  if (!scan) return;
  const missing = Object.entries(scan.days).filter(([day, bucket]) => {
    if (onlyDays && !onlyDays.has(day)) return false;
    return scan.snapshots[day]?.signature !== bucket.signature;
  });
  for (let index = 0; index < missing.length; index += 5) {
    const chunk = missing.slice(index, index + 5);
    const results = await rpc.batch(
      chunk.map(([, bucket]) => ({ method: "getTransaction", params: [bucket.signature, TRANSACTION_OPTIONS] })),
    );
    chunk.forEach(([day, bucket], offset) => {
      const tx = results[offset] as RpcParsedTransaction | null;
      const post = tx ? atlasPost(tx, DAO_TREASURY_ADDRESS, ATLAS_MINT) : null;
      if (!post) return;
      scan.snapshots[day] = {
        day,
        signature: bucket.signature,
        blockTime: bucket.blockTime,
        postRaw: post.raw.toString(),
        decimals: post.decimals,
      };
    });
  }
}

async function fillOpening(rpc: SolanaReadRpc, cache: TreasuryCache): Promise<void> {
  const scan = cache.atlasScan;
  if (!scan?.reachedEnd || scan.opening || !scan.oldestSignature) return;
  const tx = await rpc.call<RpcParsedTransaction | null>("getTransaction", [scan.oldestSignature, TRANSACTION_OPTIONS]);
  const pre = tx ? atlasPre(tx, DAO_TREASURY_ADDRESS, ATLAS_MINT) : null;
  if (!pre || !tx?.blockTime) return;
  scan.opening = {
    signature: scan.oldestSignature,
    preRaw: pre.raw.toString(),
    blockTime: tx.blockTime,
    decimals: pre.decimals,
  };
}

async function checkSamples(
  rpc: SolanaReadRpc,
  cache: TreasuryCache,
  tracked: Map<string, WalletRole>,
  onlySignatures: ReadonlySet<string> | null,
): Promise<void> {
  const scan = cache.atlasScan;
  if (!scan) return;
  const walletSigs = new Set(cache.cursors.find((cursor) => cursor.role === "dao_treasury" && cursor.kind === "wallet")?.signatures ?? []);
  const pending = scan.samples.filter(
    (sample) => !sample.checked && (onlySignatures === null || onlySignatures.has(sample.signature)),
  );
  for (let index = 0; index < pending.length; index += 5) {
    const chunk = pending.slice(index, index + 5);
    const results = await rpc.batch(
      chunk.map((sample) => ({ method: "getTransaction", params: [sample.signature, TRANSACTION_OPTIONS] })),
    );
    chunk.forEach((sample, offset) => {
      const tx = results[offset] as RpcParsedTransaction | null;
      if (!tx) return;
      const delta = atlasDelta(tx, DAO_TREASURY_ADDRESS, ATLAS_MINT);
      sample.checked = true;
      if (delta === null) {
        sample.deltaRaw = null;
        return;
      }
      sample.deltaRaw = delta.toString();
      if (delta < 0n && !walletSigs.has(sample.signature)) {
        mergeMovements(cache, parseTransaction(tx, sample.signature, tracked).movements);
      }
    });
  }
  scan.assumptionViolations = scan.samples.flatMap((sample) => {
    if (!sample.checked) return [];
    if (sample.deltaRaw === null) return [{ signature: sample.signature, deltaRaw: "missing" }];
    if (BigInt(sample.deltaRaw) < 0n && !walletSigs.has(sample.signature)) {
      return [{ signature: sample.signature, deltaRaw: sample.deltaRaw }];
    }
    return [];
  });
  if (scan.assumptionViolations.length > 0) scan.assumption = "failed";
  else if (scan.samples.length > 0 && scan.samples.every((sample) => sample.checked)) scan.assumption = "holds";
  else scan.assumption = "unchecked";
}

function summaryLine(cache: TreasuryCache): string {
  const scan = cache.atlasScan;
  return `treasury cache movements=${cache.movements.length} atlasDays=${scan ? Object.keys(scan.days).length : 0} atlasReachedEnd=${scan?.reachedEnd ?? false} assumption=${scan?.assumption ?? "none"}`;
}

export function balanceOf(cache: TreasuryCache, role: WalletRole, mint: string) {
  return cache.balances.find((balance) => balance.role === role && balance.mint === mint) ?? null;
}

export function walletRoleOrThrow(address: string): WalletRole {
  const role = roleOf(address);
  if (!role) throw new SafeClientError("That address is not one of the two published wallets.");
  return role;
}
