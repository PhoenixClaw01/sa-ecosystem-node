import type { WalletRole } from "./wallets.js";

export const CACHE_SCHEMA_VERSION = 1;

export type Direction = "in" | "out";
export type Attribution = "counterparty" | "unattributed" | "fee";

export interface CacheMovement {
  signature: string;
  slot: number;
  blockTime: number;
  wallet: string;
  role: WalletRole;
  mint: string;
  symbol: string | null;
  decimals: number;
  /** Signed raw amount. For SOL this is the lamport change, fee included. */
  deltaRaw: string;
  preRaw: string;
  postRaw: string;
  direction: Direction;
  internal: boolean;
  counterparties: string[];
  attribution: Attribution;
  /** Lamports of transfer excluding the network fee. SOL only. */
  transferRaw?: string;
  feeRaw?: string;
}

/**
 * One signature newer than the cached cursor, not applied yet.
 * `[signature, blockTime or null, failed flag]`. Failed flag is 1 when the
 * signature failed and 0 otherwise. Newest signature first.
 */
export type PendingSignature = [string, number | null, 0 | 1];

/** Unapplied signatures ahead of a cached cursor. Absent once that window is drained. */
export interface ForwardResume {
  pendingNewer?: PendingSignature[];
  /** The pending list reaches the cached cursor with no hole on its older side. */
  pendingJoined?: boolean;
  /**
   * The chain tip was dropped so the cache stays small. Those signatures stay
   * on chain and are listed again after this window is applied.
   */
  pendingDroppedTip?: boolean;
}

export interface ParsedCursor extends ForwardResume {
  address: string;
  role: WalletRole;
  kind: "wallet" | "token";
  /** Set for a token-account cursor. Null for the wallet signature cursor. */
  mint: string | null;
  newestSignature: string | null;
  /** Set when a page cap stops the walk, so the next run continues older than this signature. */
  oldestSignature?: string | null;
  reachedEnd: boolean;
  gaps: string[];
  /** Present after a balance check. Null when that check does not apply. */
  reconciled: boolean | null;
  /** Treasury wallet signatures, used to separate vault transactions from ATLAS drips. */
  signatures?: string[];
}

export interface TokenAccountRef {
  role: WalletRole;
  wallet: string;
  mint: string;
  address: string;
  decimals: number;
}

export interface DayBucket {
  /** Newest successful-or-any signature seen for this UTC day. */
  signature: string;
  blockTime: number;
  signatureCount: number;
  failedCount: number;
}

export interface BalanceSnapshot {
  day: string;
  signature: string;
  blockTime: number;
  postRaw: string;
  decimals: number;
}

export interface RpcBalance {
  role: WalletRole;
  wallet: string;
  mint: string;
  symbol: string | null;
  tokenAccount: string | null;
  amountRaw: string;
  decimals: number;
  fetchedAt: string;
}

export interface AtlasSample {
  signature: string;
  month: string;
  checked: boolean;
  /** Null until the sample transaction has been read. */
  deltaRaw: string | null;
}

export interface AtlasScan extends ForwardResume {
  tokenAccount: string;
  wallet: string;
  newestSignature: string | null;
  oldestSignature: string | null;
  /** Day currently being paged backward. Its signature count may still grow. */
  openDay: string | null;
  reachedEnd: boolean;
  pagesScanned: number;
  days: Record<string, DayBucket>;
  snapshots: Record<string, BalanceSnapshot>;
  opening: { signature: string; preRaw: string; blockTime: number; decimals: number } | null;
  samples: AtlasSample[];
  sampleSeen: Record<string, number>;
  undatedCount: number;
  undatedSignatures: string[];
  assumption: "unchecked" | "holds" | "failed";
  assumptionViolations: { signature: string; deltaRaw: string }[];
}

export interface TreasuryCache {
  schemaVersion: typeof CACHE_SCHEMA_VERSION;
  generatedAt: string;
  /** Redacted public RPC URL. */
  rpc: string;
  /**
   * `partial` when a run stopped early, hit a page cap, or could not list every token account.
   * Absent on caches written before this field existed.
   */
  completeness?: "partial" | "complete";
  /** Why the cache is partial. Null when the refresh finished. */
  partialReason?: string | null;
  /** Set once mint discovery has been read from RPC. */
  discovery: { at: string } | null;
  cursors: ParsedCursor[];
  tokenAccounts: TokenAccountRef[];
  movements: CacheMovement[];
  balances: RpcBalance[];
  atlasScan: AtlasScan | null;
}

export interface SourceLink {
  url: string;
  note: string;
}

export interface ToolEnvelope {
  dataMode: "live" | "cached";
  asOf: string;
  sources: SourceLink[];
}
