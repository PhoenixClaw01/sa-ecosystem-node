/**
 * Turns GitHub issue and pull JSON into thread entries.
 * This module does not call the network. It copies body text and logins only.
 */
import { LIMITS, type LedgerError, type ThreadEntry } from "./types.ts";

export interface LoadedThread {
  entries: ThreadEntry[];
  errors: LedgerError[];
}

export function threadFromIssue(issue: unknown, comments: unknown): LoadedThread {
  return threadFrom("issue", issue, comments, []);
}

export function threadFromPull(pull: unknown, issueComments: unknown, reviewComments: unknown): LoadedThread {
  return threadFrom("pr", pull, issueComments, reviewComments);
}

function threadFrom(kind: "issue" | "pr", head: unknown, issueComments: unknown, reviewComments: unknown): LoadedThread {
  if (!isPlain(head)) return bad("The thread payload is not an object.");
  const bodyEntry: ThreadEntry = {
    source: "body",
    author: loginOf(head),
    body: textOf(own(head, "body")),
    createdAt: timeOf(own(head, "created_at")),
  };
  const comments = commentEntries(issueComments, "comment");
  if (!comments.ok) return bad("The comment list is not an array.");
  const reviews = kind === "pr" ? commentEntries(reviewComments, "review-comment") : { ok: true as const, entries: [], truncated: false };
  if (!reviews.ok) return bad("The review comment list is not an array.");

  const ordered = [...comments.entries, ...reviews.entries].sort((a, b) => compareTime(a.createdAt, b.createdAt));
  const entries = [bodyEntry, ...ordered];
  const errors: LedgerError[] = [];
  if (comments.truncated || reviews.truncated || entries.length > LIMITS.maxEntries) {
    errors.push({
      code: "too-many-comments",
      message: "The thread has more than 500 comments. Later comments were not read.",
      author: "",
      source: "comment",
    });
  }
  return { entries: entries.slice(0, LIMITS.maxEntries), errors };
}

function commentEntries(value: unknown, source: "comment" | "review-comment"): { ok: true; entries: ThreadEntry[]; truncated: boolean } | { ok: false } {
  if (!Array.isArray(value)) return { ok: false };
  const truncated = value.length > 500;
  const entries: ThreadEntry[] = [];
  for (const item of value.slice(0, 500)) {
    if (!isPlain(item)) continue;
    entries.push({
      source,
      author: loginOf(item),
      body: textOf(own(item, "body")),
      createdAt: timeOf(own(item, "created_at")),
    });
  }
  return { ok: true, entries, truncated };
}

function loginOf(value: Record<string, unknown>): string {
  const user = own(value, "user");
  if (!isPlain(user)) return "";
  return typeof user.login === "string" ? user.login : "";
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function timeOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > 40) return undefined;
  return value;
}

function compareTime(a: string | undefined, b: string | undefined): number {
  const left = a ?? "";
  const right = b ?? "";
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function bad(message: string): LoadedThread {
  return {
    entries: [],
    errors: [{ code: "bad-thread", message, author: "", source: "body" }],
  };
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}
