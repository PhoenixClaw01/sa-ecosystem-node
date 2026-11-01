import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SafeClientError } from "../errors.js";
import { CACHE_SCHEMA_VERSION, type TreasuryCache } from "./types.js";

export function emptyCache(rpc: string, now = new Date().toISOString()): TreasuryCache {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    generatedAt: now,
    rpc,
    completeness: "partial",
    partialReason: "The refresh has not finished.",
    discovery: null,
    cursors: [],
    tokenAccounts: [],
    movements: [],
    balances: [],
    atlasScan: null,
  };
}

export function loadCache(file: string): TreasuryCache {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") {
      throw new SafeClientError(
        "No treasury cache file. Run npm run refresh-treasury. This tool does not invent balances.",
      );
    }
    throw new SafeClientError(`Could not read the treasury cache (${code || "read failed"}).`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new SafeClientError("The treasury cache is not valid JSON. Run npm run refresh-treasury again.");
  }
  if (!parsed || typeof parsed !== "object" || (parsed as TreasuryCache).schemaVersion !== CACHE_SCHEMA_VERSION) {
    throw new SafeClientError(
      "The treasury cache schema is not version 1. Delete it and run npm run refresh-treasury.",
    );
  }
  return parsed as TreasuryCache;
}

export function saveCache(file: string, cache: TreasuryCache): void {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cache)}\n`);
  renameSync(tmp, file);
}
