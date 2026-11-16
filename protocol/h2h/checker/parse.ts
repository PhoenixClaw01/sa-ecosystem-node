/**
 * Pure parser for fenced h2h blocks. No network, no process, no eval.
 * A malformed block becomes an error. It is never dropped.
 */
import {
  CLAIM_STATUSES,
  DELIVERABLE_STATUSES,
  LIMITS,
  MESSAGE_SCHEMA,
  VERIFY_STATUSES,
  type IgnoredMessage,
  type ParseIssue,
  type ParseResult,
  type ParsedBlock,
  type ParsedClaim,
  type ParsedDeliverable,
  type ParsedVerify,
} from "./types.ts";

const OTHER_KINDS = new Set([
  "hello",
  "request",
  "accept",
  "decline",
  "progress",
  "review",
  "blocked",
  "close",
  "retract",
]);

const BANNED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MESSAGE_ID = /^[a-z0-9][a-z0-9-]{2,47}:[0-9]{4}-[0-9]{2}-[0-9]{2}:[0-9]{1,6}$/;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,47}$/;
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]{0,9}$/;
const REF = /^(?:refs\/heads\/|refs\/tags\/)?[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$/;

interface OpenFence {
  char: "`" | "~";
  len: number;
}

export function parseComment(body: string): ParseResult {
  if (typeof body !== "string") {
    return fail("bad-field", "Comment body is not text.");
  }
  if (body.length > LIMITS.commentChars) {
    return fail("oversized-comment", "Comment body exceeds 256 KiB and was not read.");
  }

  const lines = body.split(/\r\n|\n|\r/);
  const errors: ParseIssue[] = [];
  const blocks: ParsedBlock[] = [];
  const ignored: IgnoredMessage[] = [];
  let seen = 0;
  let blockIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const opened = matchOpen(lines[i] ?? "");
    if (!opened) continue;
    if (seen >= LIMITS.maxBlocksPerComment) {
      errors.push(issue("too-many-blocks", "This comment has more than 8 h2h fences. Later fences were not read.", blockIndex));
      break;
    }
    seen += 1;
    const index = blockIndex;
    blockIndex += 1;
    if (opened === "bad-info") {
      errors.push(issue("bad-fence-info", "A fence info string starts with h2h but is not exactly h2h.", index));
      continue;
    }

    const end = findClose(lines, i + 1, opened);
    if (end < 0) {
      errors.push(issue("unclosed-block", "An h2h fence has no closing fence.", index));
      break;
    }
    const interior = lines.slice(i + 1, end).join("\n");
    i = end;
    const parsed = parseInterior(interior, index);
    if (parsed.error) errors.push(parsed.error);
    if (parsed.block) blocks.push(parsed.block);
    if (parsed.ignored) ignored.push(parsed.ignored);
  }

  if (seen > 1) {
    errors.push(issue("multiple-blocks", "A comment has more than one h2h fence. Each fence that was read is still reported.", 0));
  }
  return { blocks, ignored, errors };
}

function fail(code: string, message: string): ParseResult {
  return { blocks: [], ignored: [], errors: [issue(code, message)] };
}

function issue(code: string, message: string, blockIndex?: number): ParseIssue {
  return blockIndex === undefined ? { code, message } : { code, message, blockIndex };
}

function matchOpen(line: string): OpenFence | "bad-info" | null {
  const matched = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!matched) return null;
  const fence = matched[2] ?? "";
  const info = (matched[3] ?? "").trim();
  if (info === "h2h") {
    const char = fence[0];
    if (char !== "`" && char !== "~") return null;
    return { char, len: fence.length };
  }
  if (info.length > 0 && info.toLowerCase().startsWith("h2h")) return "bad-info";
  return null;
}

function findClose(lines: readonly string[], from: number, open: OpenFence): number {
  for (let i = from; i < lines.length; i++) {
    const matched = /^( {0,3})(`+|~+)[ \t]*$/.exec(lines[i] ?? "");
    if (!matched) continue;
    const fence = matched[2] ?? "";
    if (fence[0] === open.char && fence.length >= open.len) return i;
  }
  return -1;
}

function parseInterior(text: string, blockIndex: number): { block?: ParsedBlock; ignored?: IgnoredMessage; error?: ParseIssue } {
  if (text.trim() === "") return { error: issue("empty-block", "An h2h fence is empty.", blockIndex) };
  if (Buffer.byteLength(text, "utf8") > LIMITS.blockBytes) {
    return { error: issue("oversized-block", "An h2h block exceeds 16 KiB and was not parsed.", blockIndex) };
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { error: issue("invalid-json", "The h2h block is not JSON.", blockIndex) };
  }
  if (!isPlain(value)) return { error: issue("not-object", "The h2h block is not a JSON object.", blockIndex) };
  if (hasBanned(value)) return { error: issue("bad-field", "The h2h block uses a forbidden key.", blockIndex) };
  if (own(value, "schema") !== MESSAGE_SCHEMA) {
    return { error: issue("bad-field", "schema must be h2h.message.v0.", blockIndex) };
  }
  if (own(value, "speaksFor") !== "harness") {
    return { error: issue("bad-speaks-for", "speaksFor must be harness.", blockIndex) };
  }

  const kindRaw = own(value, "kind");
  if (typeof kindRaw !== "string" || kindRaw.length === 0) {
    return { error: issue("missing-field", "kind is missing.", blockIndex) };
  }
  const id = readId(own(value, "id"));
  if (OTHER_KINDS.has(kindRaw)) {
    if (own(value, "id") !== undefined && id === null) {
      return { error: issue("bad-field", "id does not match <stack>:<YYYY-MM-DD>:<seq>.", blockIndex) };
    }
    return { ignored: { kind: kindRaw, id } };
  }
  if (kindRaw !== "claim" && kindRaw !== "deliverable" && kindRaw !== "verify") {
    return { error: issue("unknown-kind", "kind is not a claim, deliverable, or verify block.", blockIndex) };
  }
  if (id === null) return { error: issue(own(value, "id") === undefined ? "missing-field" : "bad-field", "id does not match <stack>:<YYYY-MM-DD>:<seq>.", blockIndex) };

  const body = own(value, "body");
  if (!isPlain(body)) return { error: issue("missing-field", "body is missing.", blockIndex) };
  if (hasBanned(body)) return { error: issue("bad-field", "body uses a forbidden key.", blockIndex) };

  const owner = readToken(own(body, "owner"), OWNER, false);
  if (owner === null) return { error: fieldIssue(own(body, "owner"), "owner", blockIndex) };
  const scope = readToken(own(body, "scope"), SCOPE, true);
  if (scope === null) return { error: fieldIssue(own(body, "scope"), "scope", blockIndex) };

  if (kindRaw === "claim") return parseClaim(body, id, owner, scope, blockIndex);
  if (kindRaw === "deliverable") return parseDeliverable(body, id, owner, scope, blockIndex);
  return parseVerify(body, id, owner, scope, blockIndex);
}

function parseClaim(body: Record<string, unknown>, id: string, owner: string, scope: string, blockIndex: number): { block?: ParsedClaim; error?: ParseIssue } {
  const status = readStatus(own(body, "status"), CLAIM_STATUSES);
  if (status === null) return { error: fieldIssue(own(body, "status"), "status", blockIndex) };
  const supersedesRaw = own(body, "supersedes");
  if (status !== "open" && supersedesRaw !== undefined) {
    return { error: issue("bad-field", "supersedes is only allowed when status is open.", blockIndex) };
  }
  let supersedes: string | undefined;
  if (supersedesRaw !== undefined) {
    if (typeof supersedesRaw !== "string" || !isMessageId(supersedesRaw) || supersedesRaw === id) {
      return { error: issue("bad-field", "supersedes must be a different claim id.", blockIndex) };
    }
    supersedes = supersedesRaw;
  }
  const block: ParsedClaim = { kind: "claim", id, owner, scope, status };
  if (supersedes) block.supersedes = supersedes;
  return { block };
}

function parseDeliverable(body: Record<string, unknown>, id: string, owner: string, scope: string, blockIndex: number): { block?: ParsedDeliverable; error?: ParseIssue } {
  const status = readStatus(own(body, "status"), DELIVERABLE_STATUSES);
  if (status === null) return { error: fieldIssue(own(body, "status"), "status", blockIndex) };
  const claim = readId(own(body, "claim"));
  if (claim === null) return { error: fieldIssue(own(body, "claim"), "claim", blockIndex) };
  const prRaw = own(body, "pr");
  const refRaw = own(body, "ref");
  if (prRaw === undefined && refRaw === undefined) {
    return { error: issue("missing-field", "A deliverable needs pr or ref.", blockIndex) };
  }
  let pr: string | undefined;
  let ref: string | undefined;
  if (prRaw !== undefined) {
    if (typeof prRaw !== "string" || prRaw.length > LIMITS.fieldChars || !PR_URL.test(prRaw)) {
      return { error: issue("bad-field", "pr must be an https GitHub pull URL with no userinfo, query, or fragment.", blockIndex) };
    }
    pr = prRaw;
  }
  if (refRaw !== undefined) {
    const refToken = readToken(refRaw, REF, true);
    if (refToken === null) return { error: issue("bad-field", "ref must be a branch or tag name.", blockIndex) };
    ref = refToken;
  }
  const block: ParsedDeliverable = { kind: "deliverable", id, owner, scope, status, claim };
  if (pr) block.pr = pr;
  if (ref) block.ref = ref;
  return { block };
}

function parseVerify(body: Record<string, unknown>, id: string, owner: string, scope: string, blockIndex: number): { block?: ParsedVerify; error?: ParseIssue } {
  const status = readStatus(own(body, "status"), VERIFY_STATUSES);
  if (status === null) return { error: fieldIssue(own(body, "status"), "status", blockIndex) };
  const commands = readCommands(own(body, "commands"));
  if (typeof commands === "string") return { error: issue(commands === "missing" ? "missing-field" : "bad-field", "commands must be 1 to 20 single-line strings.", blockIndex) };
  const expectedRaw = own(body, "expected");
  if (typeof expectedRaw !== "string") return { error: fieldIssue(expectedRaw, "expected", blockIndex) };
  if (expectedRaw.length < 1 || expectedRaw.length > LIMITS.fieldChars || expectedRaw.includes("\0")) {
    return { error: issue("bad-field", "expected must be a string of at most 2000 characters.", blockIndex) };
  }
  return { block: { kind: "verify", id, owner, scope, status, commands, expected: expectedRaw } };
}

function readCommands(value: unknown): string[] | "missing" | "bad" {
  if (value === undefined) return "missing";
  if (!Array.isArray(value) || value.length < 1 || value.length > LIMITS.maxCommands) return "bad";
  const commands: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length < 1 || item.length > LIMITS.fieldChars) return "bad";
    if (item.includes("\n") || item.includes("\r") || item.includes("\0")) return "bad";
    commands.push(item);
  }
  return commands;
}

function readStatus<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  if (typeof value !== "string") return null;
  return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function readId(value: unknown): string | null {
  if (typeof value !== "string" || value.length > LIMITS.fieldChars) return null;
  return isMessageId(value) ? value : null;
}

function isMessageId(value: string): boolean {
  if (!MESSAGE_ID.test(value)) return false;
  const date = value.split(":")[1] ?? "";
  const [yearRaw, monthRaw, dayRaw] = date.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

function readToken(value: unknown, pattern: RegExp, pathLike: boolean): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > LIMITS.fieldChars) return null;
  if (!pattern.test(value)) return null;
  if (pathLike && (value.includes("..") || value.includes("//") || value.includes("\\") || value.includes("@"))) return null;
  return value;
}

function fieldIssue(value: unknown, name: string, blockIndex: number): ParseIssue {
  if (value === undefined) return issue("missing-field", `${name} is missing.`, blockIndex);
  return issue("bad-field", `${name} is not valid.`, blockIndex);
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasBanned(value: Record<string, unknown>): boolean {
  return Object.getOwnPropertyNames(value).some((key) => BANNED_KEYS.has(key));
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}
