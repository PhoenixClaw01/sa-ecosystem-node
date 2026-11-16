/**
 * Checker v0 types. Comment text is data. Nothing in this module
 * executes, fetches, or interpolates a block (SPEC §7.7, §8.5).
 */

export const LIMITS = {
  commentChars: 256 * 1024,
  blockBytes: 16 * 1024,
  fieldChars: 2000,
  maxBlocksPerComment: 8,
  maxCommands: 20,
  maxEntries: 501,
  maxFileBytes: 2_000_000,
  summaryChars: 200_000,
} as const;

export const MESSAGE_SCHEMA = "h2h.message.v0";
export const LEDGER_SCHEMA = "h2h.ledger.v0";

export const CLAIM_STATUSES = ["open", "released", "superseded"] as const;
export const DELIVERABLE_STATUSES = ["open", "submitted"] as const;
export const VERIFY_STATUSES = ["open", "passed", "failed"] as const;

export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];
export type VerifyStatus = (typeof VERIFY_STATUSES)[number];
export type BlockKind = "claim" | "deliverable" | "verify";
export type EntrySource = "body" | "comment" | "review-comment";

export interface ThreadEntry {
  source: EntrySource;
  author: string;
  body: string;
  createdAt?: string;
}

export interface ParseIssue {
  code: string;
  message: string;
  blockIndex?: number;
}

export interface IgnoredMessage {
  kind: string;
  id: string | null;
}

export interface ParsedClaim {
  kind: "claim";
  id: string;
  owner: string;
  scope: string;
  status: ClaimStatus;
  supersedes?: string;
}

export interface ParsedDeliverable {
  kind: "deliverable";
  id: string;
  owner: string;
  scope: string;
  status: DeliverableStatus;
  claim: string;
  pr?: string;
  ref?: string;
}

export interface ParsedVerify {
  kind: "verify";
  id: string;
  owner: string;
  scope: string;
  status: VerifyStatus;
  commands: string[];
  expected: string;
}

export type ParsedBlock = ParsedClaim | ParsedDeliverable | ParsedVerify;

export interface ParseResult {
  blocks: ParsedBlock[];
  ignored: IgnoredMessage[];
  errors: ParseIssue[];
}

export type AccountRole = "repo-owner" | "example";

export interface KnownAccounts {
  /** Lowercased login → role. Example rows are listed and never verify. */
  roles: ReadonlyMap<string, AccountRole>;
}

export interface LedgerError {
  code: string;
  message: string;
  author: string;
  source: EntrySource;
  blockIndex?: number;
}

export interface ClaimRecord {
  id: string;
  author: string;
  owner: string;
  scope: string;
  status: ClaimStatus;
  supersedes?: string;
}

export interface ConflictRecord {
  scope: string;
  claims: { id: string; author: string }[];
}

export interface DeliverableRecord {
  id: string;
  author: string;
  owner: string;
  scope: string;
  status: DeliverableStatus;
  claim: string;
  pr?: string;
  ref?: string;
  unreferenced: boolean;
}

export interface VerifyRecord {
  id: string;
  author: string;
  owner: string;
  scope: string;
  status: VerifyStatus;
  commands: string[];
  expected: string;
}

export interface UnverifiedRecord {
  author: string;
  kind: BlockKind;
  id: string;
  scope: string;
}

export interface IgnoredRecord {
  author: string;
  kind: string;
  id: string | null;
}

export interface Ledger {
  schema: typeof LEDGER_SCHEMA;
  claims: ClaimRecord[];
  conflicts: ConflictRecord[];
  released: string[];
  superseded: string[];
  deliverables: DeliverableRecord[];
  verifies: VerifyRecord[];
  unverified: UnverifiedRecord[];
  ignored: IgnoredRecord[];
  errors: LedgerError[];
}
