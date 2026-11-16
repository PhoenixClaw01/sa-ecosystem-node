/**
 * Folds parsed blocks into the current claim list. Unverified blocks are
 * recorded and then ignored: they cannot open, release, or supersede a claim.
 */
import { isVerifiedLogin, normalizeLogin, roleOf } from "./accounts.ts";
import { parseComment } from "./parse.ts";
import {
  LEDGER_SCHEMA,
  LIMITS,
  type ClaimRecord,
  type DeliverableRecord,
  type EntrySource,
  type IgnoredRecord,
  type KnownAccounts,
  type Ledger,
  type LedgerError,
  type ParsedBlock,
  type ThreadEntry,
  type UnverifiedRecord,
  type VerifyRecord,
} from "./types.ts";

interface IdUse {
  kind: "claim" | "deliverable" | "verify";
}

export function buildLedger(entries: readonly ThreadEntry[], accounts: KnownAccounts, preamble: readonly LedgerError[] = []): Ledger {
  const claims: ClaimRecord[] = [];
  const deliverables: DeliverableRecord[] = [];
  const verifies: VerifyRecord[] = [];
  const unverified: UnverifiedRecord[] = [];
  const ignored: IgnoredRecord[] = [];
  const errors: LedgerError[] = [...preamble];
  const uses = new Map<string, IdUse>();
  const slice = entries.length > LIMITS.maxEntries ? entries.slice(0, LIMITS.maxEntries) : entries;
  if (entries.length > LIMITS.maxEntries) {
    errors.push({
      code: "too-many-comments",
      message: "The thread has more than 500 comments. Later comments were not read.",
      author: "",
      source: "comment",
    });
  }

  for (const entry of slice) {
    const source = entrySource(entry.source);
    const author = normalizeLogin(entry.author) ?? "";
    const known = author.length > 0 && isVerifiedLogin(accounts, author);
    const parsed = parseComment(entry.body);
    for (const item of parsed.errors) {
      errors.push({ code: item.code, message: item.message, author, source, blockIndex: item.blockIndex });
    }
    for (const item of parsed.ignored) {
      ignored.push({ author, kind: item.kind, id: item.id });
    }
    for (const block of parsed.blocks) {
      if (!known) {
        unverified.push({ author, kind: block.kind, id: block.id, scope: block.scope });
        continue;
      }
      applyBlock(block, author, accounts, claims, deliverables, verifies, uses, errors, source);
    }
  }

  const claimIds = new Set(claims.map((claim) => claim.id));
  for (const deliverable of deliverables) deliverable.unreferenced = !claimIds.has(deliverable.claim);

  const openByScope = new Map<string, ClaimRecord[]>();
  for (const claim of claims) {
    if (claim.status !== "open") continue;
    const group = openByScope.get(claim.scope) ?? [];
    group.push(claim);
    openByScope.set(claim.scope, group);
  }
  const conflicts = [...openByScope.entries()]
    .filter(([, group]) => group.length >= 2)
    .map(([scope, group]) => ({ scope, claims: group.map((claim) => ({ id: claim.id, author: claim.author })) }))
    .sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));

  return {
    schema: LEDGER_SCHEMA,
    claims,
    conflicts,
    released: claims.filter((claim) => claim.status === "released").map((claim) => claim.id),
    superseded: claims.filter((claim) => claim.status === "superseded").map((claim) => claim.id),
    deliverables,
    verifies,
    unverified,
    ignored,
    errors,
  };
}

function applyBlock(
  block: ParsedBlock,
  author: string,
  accounts: KnownAccounts,
  claims: ClaimRecord[],
  deliverables: DeliverableRecord[],
  verifies: VerifyRecord[],
  uses: Map<string, IdUse>,
  errors: LedgerError[],
  source: EntrySource,
): void {
  const used = uses.get(block.id);
  if (used && used.kind !== block.kind) {
    errors.push({ code: "id-reused", message: "This id is already used by a different block kind.", author, source });
    return;
  }

  if (block.kind === "claim") {
    applyClaim(block, author, accounts, claims, uses, errors, source);
    return;
  }
  if (block.kind === "deliverable") {
    const existing = deliverables.find((item) => item.id === block.id);
    if (existing && !mayRevise(accounts, author, existing.author)) {
      errors.push({
        code: "forbidden-revise",
        message: "Only the deliverable's original author, or a repo-owner, may change a deliverable.",
        author,
        source,
      });
      return;
    }
    const next: DeliverableRecord = {
      id: block.id,
      author,
      owner: block.owner,
      scope: block.scope,
      status: block.status,
      claim: block.claim,
      unreferenced: false,
    };
    if (block.pr) next.pr = block.pr;
    if (block.ref) next.ref = block.ref;
    if (existing) {
      const index = deliverables.indexOf(existing);
      deliverables[index] = next;
    } else {
      deliverables.push(next);
    }
    uses.set(block.id, { kind: "deliverable" });
    return;
  }

  const existing = verifies.find((item) => item.id === block.id);
  if (existing && !mayRevise(accounts, author, existing.author)) {
    errors.push({
      code: "forbidden-revise",
      message: "Only the verify row's original author, or a repo-owner, may change a verify row.",
      author,
      source,
    });
    return;
  }
  const next: VerifyRecord = {
    id: block.id,
    author,
    owner: block.owner,
    scope: block.scope,
    status: block.status,
    commands: block.commands,
    expected: block.expected,
  };
  if (existing) {
    const index = verifies.indexOf(existing);
    verifies[index] = next;
  } else {
    verifies.push(next);
  }
  uses.set(block.id, { kind: "verify" });
}

function applyClaim(
  block: Extract<ParsedBlock, { kind: "claim" }>,
  author: string,
  accounts: KnownAccounts,
  claims: ClaimRecord[],
  uses: Map<string, IdUse>,
  errors: LedgerError[],
  source: EntrySource,
): void {
  const existing = claims.find((claim) => claim.id === block.id);
  if (block.status === "released" || block.status === "superseded") {
    if (!existing) {
      errors.push({
        code: block.status === "released" ? "unknown-release" : "unknown-supersede",
        message: block.status === "released" ? "A release names no claim in this thread." : "A supersede names no claim in this thread.",
        author,
        source,
      });
      return;
    }
    if (!mayRevise(accounts, author, existing.author)) {
      errors.push({
        code: block.status === "released" ? "forbidden-release" : "forbidden-supersede",
        message: "Only the claim's original author, or a repo-owner, may release or supersede a claim.",
        author,
        source,
      });
      return;
    }
    existing.status = block.status;
    return;
  }

  if (existing && !mayRevise(accounts, author, existing.author)) {
    errors.push({
      code: "forbidden-revise",
      message: "Only the claim's original author, or a repo-owner, may change a claim.",
      author,
      source,
    });
    return;
  }

  if (block.supersedes) {
    const target = claims.find((claim) => claim.id === block.supersedes);
    if (!target) {
      errors.push({ code: "unknown-supersede", message: "supersedes names no claim in this thread.", author, source });
      return;
    }
    if (!mayRevise(accounts, author, target.author)) {
      errors.push({
        code: "forbidden-supersede",
        message: "Only the claim's original author, or a repo-owner, may release or supersede a claim.",
        author,
        source,
      });
      return;
    }
    target.status = "superseded";
  }

  if (existing) {
    existing.owner = block.owner;
    existing.scope = block.scope;
    existing.status = "open";
    if (block.supersedes) existing.supersedes = block.supersedes;
    else delete existing.supersedes;
    return;
  }

  const created: ClaimRecord = { id: block.id, author, owner: block.owner, scope: block.scope, status: "open" };
  if (block.supersedes) created.supersedes = block.supersedes;
  claims.push(created);
  uses.set(block.id, { kind: "claim" });
}

function mayRevise(accounts: KnownAccounts, actor: string, originalAuthor: string): boolean {
  if (!isVerifiedLogin(accounts, actor)) return false;
  if (roleOf(accounts, actor) === "repo-owner") return true;
  const actorLogin = normalizeLogin(actor);
  const authorLogin = normalizeLogin(originalAuthor);
  return actorLogin !== null && authorLogin !== null && actorLogin.toLowerCase() === authorLogin.toLowerCase();
}

function entrySource(value: string): EntrySource {
  if (value === "body" || value === "comment" || value === "review-comment") return value;
  return "comment";
}
