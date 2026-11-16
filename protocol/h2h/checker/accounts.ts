/**
 * Checked-in allowlist of GitHub logins. A login that is absent is unverified.
 */
import { fileURLToPath } from "node:url";

import type { KnownAccounts } from "./types.ts";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const ROLES = new Set(["repo-owner", "example"]);

export function defaultAccountsPath(): string {
  return fileURLToPath(new URL("../known-accounts.json", import.meta.url));
}

export function normalizeLogin(login: string): string | null {
  if (typeof login !== "string" || !LOGIN.test(login)) return null;
  return login;
}

export function isKnownLogin(accounts: KnownAccounts, login: string): boolean {
  const normal = normalizeLogin(login);
  if (!normal) return false;
  return accounts.logins.has(normal.toLowerCase());
}

export function loadKnownAccounts(value: unknown): { ok: true; accounts: KnownAccounts } | { ok: false; message: string } {
  if (!isPlain(value)) return { ok: false, message: "known-accounts.json is not a JSON object." };
  const keys = Object.getOwnPropertyNames(value);
  for (const key of keys) {
    if (key !== "v" && key !== "note" && key !== "accounts") {
      return { ok: false, message: "known-accounts.json has an unexpected field." };
    }
  }
  if (value.v !== 0) return { ok: false, message: "known-accounts.json v must be 0." };
  if (value.note !== undefined && (typeof value.note !== "string" || value.note.length > 500)) {
    return { ok: false, message: "known-accounts.json note is not valid." };
  }
  if (!Array.isArray(value.accounts)) return { ok: false, message: "known-accounts.json accounts must be a list." };
  if (value.accounts.length > 100) return { ok: false, message: "known-accounts.json has too many accounts." };

  const logins = new Set<string>();
  for (const entry of value.accounts) {
    if (!isPlain(entry)) return { ok: false, message: "An allowlist entry is not an object." };
    const entryKeys = Object.getOwnPropertyNames(entry);
    for (const key of entryKeys) {
      if (key !== "login" && key !== "role") return { ok: false, message: "An allowlist entry has an unexpected field." };
    }
    if (typeof entry.login !== "string" || normalizeLogin(entry.login) === null) {
      return { ok: false, message: "An allowlist login is not a GitHub login." };
    }
    if (typeof entry.role !== "string" || !ROLES.has(entry.role)) {
      return { ok: false, message: "An allowlist role must be repo-owner or example." };
    }
    const folded = entry.login.toLowerCase();
    if (logins.has(folded)) return { ok: false, message: "An allowlist login is duplicated." };
    logins.add(folded);
  }
  return { ok: true, accounts: { logins } };
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
