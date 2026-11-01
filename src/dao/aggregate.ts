import { dayBefore, formatRaw, isoFromUnix, monthEnd, utcDay, utcMonth } from "./amount.js";
import { SafeClientError, UserInputError } from "../errors.js";
import type { AtlasScan, CacheMovement, TreasuryCache } from "./types.js";
import {
  ATLAS_MINT,
  NATIVE_MINT,
  USDC_MINT,
  roleOf,
  solscanTx,
  symbolForMint,
  walletByRole,
  type WalletRole,
} from "./wallets.js";

const MONTH = /^\d{4}-\d{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface ReportQuery {
  wallet?: string;
  mint?: string;
  from?: string;
  to?: string;
  allowPartial?: boolean;
}

export interface PaymentQuery extends ReportQuery {
  direction?: "in" | "out" | "all";
  includeInternal?: boolean;
  includeFees?: boolean;
  limit?: number;
  offset?: number;
}

interface FlowBucket {
  externalInRaw: bigint;
  externalOutRaw: bigint;
  internalInRaw: bigint;
  internalOutRaw: bigint;
  unattributedRaw: bigint;
  feeRaw: bigint;
}

function emptyBucket(): FlowBucket {
  return {
    externalInRaw: 0n,
    externalOutRaw: 0n,
    internalInRaw: 0n,
    internalOutRaw: 0n,
    unattributedRaw: 0n,
    feeRaw: 0n,
  };
}

export function resolveRole(input: string | undefined): WalletRole | undefined {
  if (!input) return undefined;
  if (input === "dao_treasury" || input === "ecosystem_fund") return input;
  const role = roleOf(input);
  if (!role) {
    throw new UserInputError("wallet must be dao_treasury, ecosystem_fund, or one of those two published addresses.");
  }
  return role;
}

export function resolveMint(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const upper = input.toUpperCase();
  if (upper === "ATLAS") return ATLAS_MINT;
  if (upper === "USDC") return USDC_MINT;
  if (upper === "SOL" || input === NATIVE_MINT) return NATIVE_MINT;
  if (input === ATLAS_MINT || input === USDC_MINT) return input;
  throw new UserInputError("mint must be ATLAS, USDC, or SOL.");
}

function assertMonth(value: string | undefined, label: string): string | undefined {
  if (!value) return undefined;
  if (!MONTH.test(value)) throw new UserInputError(`${label} must be YYYY-MM.`);
  return value;
}

function assertDay(value: string | undefined, label: string): string | undefined {
  if (!value) return undefined;
  if (!DAY.test(value)) throw new UserInputError(`${label} must be YYYY-MM-DD.`);
  return value;
}

function cursorComplete(cache: TreasuryCache, role: WalletRole, mint: string): boolean {
  if (!cache.discovery) return false;
  if (mint === ATLAS_MINT && role === "dao_treasury") {
    const wallet = cache.cursors.find((cursor) => cursor.role === role && cursor.kind === "wallet");
    const sample = cache.atlasScan?.assumption === "holds" && (cache.atlasScan?.undatedCount ?? 1) === 0;
    return Boolean(wallet?.reachedEnd && wallet.gaps.length === 0 && sample);
  }
  if (mint === NATIVE_MINT) {
    const wallet = cache.cursors.find((cursor) => cursor.role === role && cursor.kind === "wallet");
    return Boolean(wallet?.reachedEnd && wallet.gaps.length === 0 && wallet.reconciled === true);
  }
  const token = cache.cursors.find((cursor) => cursor.role === role && cursor.kind === "token" && cursor.mint === mint);
  if (!token) return !cache.tokenAccounts.some((account) => account.role === role && account.mint === mint);
  return token.reachedEnd && token.gaps.length === 0 && token.reconciled === true;
}

function addAmount(bucket: FlowBucket, movement: CacheMovement, amount: bigint): void {
  if (amount === 0n) return;
  if (movement.attribution === "unattributed") {
    bucket.unattributedRaw += amount;
    return;
  }
  const inbound = amount > 0n;
  const abs = inbound ? amount : -amount;
  if (movement.internal) {
    if (inbound) bucket.internalInRaw += abs;
    else bucket.internalOutRaw += abs;
    return;
  }
  if (inbound) bucket.externalInRaw += abs;
  else bucket.externalOutRaw += abs;
}

function addMovement(bucket: FlowBucket, movement: CacheMovement): void {
  if (movement.mint === NATIVE_MINT) {
    const fee = BigInt(movement.feeRaw ?? "0");
    if (fee > 0n) bucket.feeRaw += fee;
    addAmount(bucket, movement, BigInt(movement.transferRaw ?? "0"));
    return;
  }
  addAmount(bucket, movement, BigInt(movement.deltaRaw));
}

function ui(raw: bigint, decimals: number): string {
  return formatRaw(raw, decimals);
}

function decimalsFor(cache: TreasuryCache, mint: string, movements: readonly CacheMovement[]): number {
  const movement = movements.find((item) => item.mint === mint);
  if (movement) return movement.decimals;
  const account = cache.tokenAccounts.find((item) => item.mint === mint);
  if (account) return account.decimals;
  if (mint === NATIVE_MINT) return 9;
  if (mint === ATLAS_MINT) return 8;
  if (mint === USDC_MINT) return 6;
  return 0;
}

function scanBounds(scan: AtlasScan): { minDay: string; maxDay: string } | null {
  const days = Object.keys(scan.days).sort();
  const minDay = days[0];
  const maxDay = days[days.length - 1];
  if (!minDay || !maxDay) return null;
  return { minDay, maxDay };
}

function balanceAtEndOf(scan: AtlasScan, day: string, minDay: string, maxDay: string): bigint | null {
  if (day < minDay || day > maxDay) return null;
  const activity = Object.keys(scan.days)
    .filter((item) => item >= minDay && item <= day)
    .sort();
  const latest = activity[activity.length - 1];
  if (!latest) return null;
  const snapshot = scan.snapshots[latest];
  if (!snapshot) return null;
  return BigInt(snapshot.postRaw);
}

interface InflowResult {
  status: "known" | "unknown";
  amountRaw?: bigint;
  reason?: string;
  through?: string;
  monthClosed?: boolean;
}

function treasuryAtlasInflow(cache: TreasuryCache, month: string, movements: readonly CacheMovement[]): InflowResult {
  const scan = cache.atlasScan;
  if (!scan) return { status: "unknown", reason: "The ATLAS token-account scan has not started." };
  if (scan.undatedCount > 0) {
    return { status: "unknown", reason: "The ATLAS scan has signatures with no block time, so a month cannot be closed." };
  }
  if (scan.assumption === "failed") {
    return {
      status: "unknown",
      reason: "A sampled ATLAS-account transaction decreased the treasury outside the vault-wallet set. Inflows are withheld.",
    };
  }
  if (scan.assumption !== "holds") {
    return { status: "unknown", reason: "The ATLAS outflow sample has not been checked yet. Inflows are withheld." };
  }
  const bounds = scanBounds(scan);
  if (!bounds) return { status: "unknown", reason: "The ATLAS scan has no dated signatures." };
  const startDay = `${month}-01`;
  const endDay = monthEnd(month);
  const through = endDay <= bounds.maxDay ? endDay : bounds.maxDay;
  if (through < startDay) return { status: "unknown", reason: "That month is outside the scanned ATLAS range." };

  let startRaw: bigint | null = null;
  if (bounds.minDay < startDay) {
    startRaw = balanceAtEndOf(scan, dayBefore(startDay), bounds.minDay, bounds.maxDay);
    if (startRaw === null) return { status: "unknown", reason: "The balance at the start of the month is not in the cache." };
  } else if (scan.reachedEnd && scan.opening && utcMonth(scan.opening.blockTime) === month) {
    startRaw = BigInt(scan.opening.preRaw);
  } else {
    return { status: "unknown", reason: "The ATLAS scan has not reached the start of this month." };
  }

  const endRaw = balanceAtEndOf(scan, through, bounds.minDay, bounds.maxDay);
  if (endRaw === null) return { status: "unknown", reason: "The balance at the end of the scanned window is missing." };

  const window = movements.filter((movement) => {
    const day = utcDay(movement.blockTime);
    return day >= startDay && day <= through;
  });
  let parsedNet = 0n;
  let parsedExternalIn = 0n;
  for (const movement of window) parsedNet += BigInt(movement.deltaRaw);
  for (const movement of window) {
    if (movement.direction === "in" && !movement.internal && movement.attribution === "counterparty") {
      parsedExternalIn += BigInt(movement.deltaRaw);
    }
  }
  const residual = endRaw - startRaw - parsedNet;
  if (residual < 0n) {
    return {
      status: "unknown",
      reason: "The balance rose by less than the parsed transactions. An outflow may be missing, so the inflow is withheld.",
    };
  }
  return {
    status: "known",
    amountRaw: parsedExternalIn + residual,
    through,
    monthClosed: through === endDay,
  };
}

const FLOW_MINTS = [ATLAS_MINT, USDC_MINT, NATIVE_MINT] as const;

export function buildFlows(cache: TreasuryCache, query: ReportQuery) {
  const roleFilter = resolveRole(query.wallet);
  const mintFilter = resolveMint(query.mint);
  const from = assertMonth(query.from, "from");
  const to = assertMonth(query.to, "to");
  const roles = roleFilter ? [roleFilter] : (["dao_treasury", "ecosystem_fund"] as const);
  const mints = mintFilter ? [mintFilter] : [...FLOW_MINTS];
  const rows = [];
  const omitted: { role: WalletRole; mint: string; reason: string }[] = [];

  for (const role of roles) {
    for (const mint of mints) {
      const movements = cache.movements.filter((movement) => movement.role === role && movement.mint === mint);
      const decimals = decimalsFor(cache, mint, movements);
      const months = new Set<string>();
      for (const movement of movements) months.add(utcMonth(movement.blockTime));
      if (mint === ATLAS_MINT && role === "dao_treasury" && cache.atlasScan) {
        for (const day of Object.keys(cache.atlasScan.days)) months.add(day.slice(0, 7));
        if (cache.atlasScan.opening) months.add(utcMonth(cache.atlasScan.opening.blockTime));
      }
      const ordered = [...months].filter((month) => (!from || month >= from) && (!to || month <= to)).sort();
      if (ordered.length === 0 && !cursorComplete(cache, role, mint)) {
        omitted.push({ role, mint, reason: coverageReason(cache, role, mint) });
        continue;
      }
      for (const month of ordered) {
        const monthMovements = movements.filter((movement) => utcMonth(movement.blockTime) === month);
        const bucket = emptyBucket();
        for (const movement of monthMovements) addMovement(bucket, movement);
        const parsedReady = cursorComplete(cache, role, mint) || query.allowPartial === true;
        if (!parsedReady && !(mint === ATLAS_MINT && role === "dao_treasury")) {
          omitted.push({ role, mint, reason: coverageReason(cache, role, mint) });
          break;
        }
        let externalIn: string | null = ui(bucket.externalInRaw, decimals);
        let externalInStatus: "known" | "unknown" = "known";
        let externalInReason: string | undefined;
        let method: "parsed" | "residual" = "parsed";
        let through: string | undefined;
        let monthClosed = true;
        let complete = cursorComplete(cache, role, mint);

        if (mint === ATLAS_MINT && role === "dao_treasury") {
          method = "residual";
          const inferred = treasuryAtlasInflow(cache, month, monthMovements);
          through = inferred.through;
          monthClosed = inferred.monthClosed ?? false;
          if (inferred.status === "known" && inferred.amountRaw !== undefined) {
            externalIn = ui(inferred.amountRaw, decimals);
            complete = true;
          } else {
            externalIn = null;
            externalInStatus = "unknown";
            externalInReason = inferred.reason;
            complete = false;
            if (!query.allowPartial) {
              if (!omitted.some((item) => item.role === role && item.mint === mint)) {
                omitted.push({ role, mint, reason: inferred.reason ?? "ATLAS inflow is unknown." });
              }
              continue;
            }
          }
        }

        rows.push({
          month,
          through: through ?? monthEnd(month),
          monthClosed,
          wallet: walletByRole(role).address,
          role,
          mint,
          symbol: symbolForMint(mint),
          decimals,
          method,
          complete,
          externalIn,
          externalInStatus,
          externalInReason: externalInReason ?? null,
          externalOut: ui(bucket.externalOutRaw, decimals),
          internalIn: ui(bucket.internalInRaw, decimals),
          internalOut: ui(bucket.internalOutRaw, decimals),
          unattributed: ui(bucket.unattributedRaw, decimals),
          fees: mint === NATIVE_MINT ? ui(bucket.feeRaw, decimals) : "0",
        });
      }
    }
  }

  if (!query.allowPartial) {
    const kept = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row.complete) {
        const key = `${row.role}:${row.mint}`;
        if (!seen.has(key)) {
          seen.add(key);
          omitted.push({ role: row.role, mint: row.mint, reason: row.externalInReason ?? coverageReason(cache, row.role, row.mint) });
        }
        continue;
      }
      kept.push(row);
    }
    return { rows: kept, omitted, notes: FLOW_NOTES };
  }
  return { rows, omitted, notes: FLOW_NOTES };
}

function coverageReason(cache: TreasuryCache, role: WalletRole, mint: string): string {
  if (!cache.discovery) return "Token accounts have not been discovered. Run npm run refresh-treasury.";
  if (mint === ATLAS_MINT && role === "dao_treasury") {
    if (cache.atlasScan?.assumption === "failed") return "The ATLAS sample found an outflow outside the vault-wallet transactions.";
    if (cache.atlasScan?.assumption !== "holds") return "The ATLAS account sample is not checked, so treasury ATLAS coverage is incomplete.";
    return "The DAO Treasury wallet signature backfill is incomplete.";
  }
  return `The ${symbolForMint(mint) ?? mint} backfill for ${role} is incomplete or did not reconcile to the RPC balance.`;
}

const FLOW_NOTES = [
  "USDC, Ecosystem Fund ATLAS, and SOL are sums of parsed balance changes.",
  "DAO Treasury ATLAS inflows are the balance change minus parsed treasury ATLAS movements. That residual is published only when a sample of the other ATLAS-account signatures did not decrease the balance.",
  "Internal means the counterparty is the other published wallet. Unattributed means the counterparty amounts did not add up, and those amounts are not folded into inflows or outflows.",
];

export function buildPayments(cache: TreasuryCache, query: PaymentQuery) {
  const roleFilter = resolveRole(query.wallet);
  const mintFilter = resolveMint(query.mint);
  const from = assertMonth(query.from, "from");
  const to = assertMonth(query.to, "to");
  const direction = query.direction ?? "out";
  const limit = query.limit ?? 100;
  const offset = query.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new UserInputError("limit must be from 1 to 500.");
  if (!Number.isInteger(offset) || offset < 0) throw new UserInputError("offset must be a non-negative integer.");

  const omitted: { role: WalletRole; mint: string; reason: string }[] = [];
  const selected = cache.movements.filter((movement) => {
    if (roleFilter && movement.role !== roleFilter) return false;
    if (mintFilter && movement.mint !== mintFilter) return false;
    if (!mintFilter && movement.mint !== ATLAS_MINT && movement.mint !== USDC_MINT && movement.mint !== NATIVE_MINT) {
      return false;
    }
    const month = utcMonth(movement.blockTime);
    if (from && month < from) return false;
    if (to && month > to) return false;
    if (direction !== "all" && movement.direction !== direction) return false;
    if (!query.includeInternal && movement.internal) return false;
    if (!query.includeFees && movement.attribution === "fee") return false;
    return true;
  });

  const visible = selected.filter((movement) => {
    const ready = cursorComplete(cache, movement.role, movement.mint);
    if (!ready && !query.allowPartial) {
      const key = `${movement.role}:${movement.mint}`;
      if (!omitted.some((item) => `${item.role}:${item.mint}` === key)) {
        omitted.push({ role: movement.role, mint: movement.mint, reason: coverageReason(cache, movement.role, movement.mint) });
      }
      return false;
    }
    return true;
  });

  visible.sort((left, right) => right.blockTime - left.blockTime || right.slot - left.slot || left.signature.localeCompare(right.signature));
  const page = visible.slice(offset, offset + limit);
  return {
    total: visible.length,
    offset,
    limit,
    truncated: offset + page.length < visible.length,
    omitted,
    payments: page.map((movement) => ({
      signature: movement.signature,
      solscanUrl: solscanTx(movement.signature),
      blockTime: movement.blockTime,
      time: isoFromUnix(movement.blockTime),
      wallet: movement.wallet,
      role: movement.role,
      mint: movement.mint,
      symbol: movement.symbol,
      amountRaw: (movement.mint === NATIVE_MINT ? BigInt(movement.transferRaw ?? movement.deltaRaw) : BigInt(movement.deltaRaw)).toString().replace(/^-/, ""),
      amount: formatRaw(
        movement.mint === NATIVE_MINT
          ? abs(BigInt(movement.transferRaw ?? movement.deltaRaw))
          : abs(BigInt(movement.deltaRaw)),
        movement.decimals,
      ),
      direction: movement.direction,
      internal: movement.internal,
      attribution: movement.attribution,
      counterparties: movement.counterparties,
      complete: cursorComplete(cache, movement.role, movement.mint),
    })),
    notes: [
      "Payments default to external outflows. Internal vault-to-vault transfers and SOL network fees are omitted unless requested.",
      "DAO Treasury ATLAS rows are complete only after the vault-wallet backfill and the ATLAS-account outflow sample both pass. The sample is not a fetch of every fee drip.",
    ],
  };
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

export function buildHistory(cache: TreasuryCache, query: ReportQuery & { granularity?: "day" | "month" }) {
  const roleFilter = resolveRole(query.wallet);
  const mintFilter = resolveMint(query.mint);
  const from = assertDay(query.from, "from");
  const to = assertDay(query.to, "to");
  const granularity = query.granularity ?? "month";
  if (granularity !== "day" && granularity !== "month") throw new UserInputError("granularity must be day or month.");
  const roles = roleFilter ? [roleFilter] : (["dao_treasury", "ecosystem_fund"] as const);
  const mints = mintFilter ? [mintFilter] : [...FLOW_MINTS];
  const series = [];
  const omitted: { role: WalletRole; mint: string; reason: string }[] = [];

  for (const role of roles) {
    for (const mint of mints) {
      if (mint === ATLAS_MINT && role === "dao_treasury") {
        const built = atlasSnapshotSeries(cache, granularity, from, to);
        if (built.status === "unknown") {
          if (query.allowPartial) {
            series.push({ role, wallet: walletByRole(role).address, mint, symbol: "ATLAS", ...built });
          } else omitted.push({ role, mint, reason: built.reason });
          continue;
        }
        series.push({ role, wallet: walletByRole(role).address, mint, symbol: "ATLAS", method: "end_of_day_snapshot", ...built });
        continue;
      }
      if (!cursorComplete(cache, role, mint) && !query.allowPartial) {
        omitted.push({ role, mint, reason: coverageReason(cache, role, mint) });
        continue;
      }
      const points = replaySeries(
        cache.movements.filter((movement) => movement.role === role && movement.mint === mint),
        granularity,
        from,
        to,
      );
      series.push({
        role,
        wallet: walletByRole(role).address,
        mint,
        symbol: symbolForMint(mint),
        method: "replay",
        status: "known" as const,
        complete: cursorComplete(cache, role, mint),
        points,
      });
    }
  }
  return {
    granularity,
    series,
    omitted,
    notes: [
      "DAO Treasury ATLAS is the end-of-day post-balance of the last signature that day, carried across days with no signatures.",
      "Other series replay parsed post-balances. A series is omitted when its backfill is incomplete unless allowPartial is set.",
    ],
  };
}

function replaySeries(
  movements: readonly CacheMovement[],
  granularity: "day" | "month",
  from?: string,
  to?: string,
): { day: string; amount: string; amountRaw: string }[] {
  const sorted = [...movements].sort((left, right) => left.blockTime - right.blockTime || left.slot - right.slot);
  if (sorted.length === 0) return [];
  const decimals = sorted[0]?.decimals ?? 0;
  const byDay = new Map<string, bigint>();
  for (const movement of sorted) {
    byDay.set(utcDay(movement.blockTime), BigInt(movement.postRaw));
  }
  const days = [...byDay.keys()].sort();
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return [];
  const points: { day: string; amount: string; amountRaw: string }[] = [];
  let cursor = first;
  let balance = byDay.get(first) ?? 0n;
  while (cursor <= last) {
    const next = byDay.get(cursor);
    if (next !== undefined) balance = next;
    const emit = granularity === "day" || cursor === last || cursor === monthEnd(cursor.slice(0, 7));
    if (emit && (!from || cursor >= from) && (!to || cursor <= to)) {
      points.push({ day: cursor, amount: formatRaw(balance, decimals), amountRaw: balance.toString() });
    }
    cursor = utcDay(Math.floor(Date.parse(`${cursor}T00:00:00Z`) / 1000) + 86_400);
  }
  return points;
}

function atlasSnapshotSeries(
  cache: TreasuryCache,
  granularity: "day" | "month",
  from?: string,
  to?: string,
):
  | { status: "unknown"; reason: string; complete: false }
  | { status: "known"; complete: boolean; points: { day: string; amount: string; amountRaw: string }[] } {
  const scan = cache.atlasScan;
  if (!scan || scan.assumption !== "holds" || scan.undatedCount > 0) {
    return {
      status: "unknown",
      complete: false,
      reason: scan
        ? coverageReason(cache, "dao_treasury", ATLAS_MINT)
        : "The ATLAS token-account scan has not started.",
    };
  }
  const bounds = scanBounds(scan);
  if (!bounds) return { status: "unknown", complete: false, reason: "The ATLAS scan has no dated signatures." };
  const decimals = Object.values(scan.snapshots)[0]?.decimals ?? 8;
  const points: { day: string; amount: string; amountRaw: string }[] = [];
  let cursor = bounds.minDay;
  let balance: bigint | null = null;
  while (cursor <= bounds.maxDay) {
    const activity = scan.days[cursor];
    if (activity) {
      const snapshot = scan.snapshots[cursor];
      if (!snapshot) {
        return { status: "unknown", complete: false, reason: `The ${cursor} ATLAS snapshot transaction was not read.` };
      }
      balance = BigInt(snapshot.postRaw);
    }
    if (balance !== null && (!from || cursor >= from) && (!to || cursor <= to)) {
      const emit = granularity === "day" || cursor === bounds.maxDay || cursor === monthEnd(cursor.slice(0, 7));
      if (emit) points.push({ day: cursor, amount: formatRaw(balance, decimals), amountRaw: balance.toString() });
    }
    cursor = utcDay(Math.floor(Date.parse(`${cursor}T00:00:00Z`) / 1000) + 86_400);
  }
  return { status: "known", complete: scan.reachedEnd, points };
}

export function requireRows<T>(rows: readonly T[], omitted: readonly { reason: string }[], label: string): void {
  if (rows.length > 0) return;
  const reason = omitted[0]?.reason ?? "No cached treasury data matched.";
  throw new SafeClientError(`${label} is not available. ${reason}`);
}
