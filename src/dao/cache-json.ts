import { SafeClientError } from "../errors.js";
import { CACHE_SCHEMA_VERSION, type TreasuryCache } from "./types.js";

/** Accept a treasury cache document. Does not read the filesystem. */
export function parseTreasuryCache(parsed: unknown): TreasuryCache {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SafeClientError("The treasury cache was not an object. No balances were invented.");
  }
  const cache = parsed as TreasuryCache;
  if (cache.schemaVersion !== CACHE_SCHEMA_VERSION) {
    throw new SafeClientError("The treasury cache schema is not version 1. No balances were invented.");
  }
  if (typeof cache.generatedAt !== "string" || cache.generatedAt.length < 4) {
    throw new SafeClientError("The treasury cache has no generatedAt timestamp.");
  }
  if (!Array.isArray(cache.movements) || !Array.isArray(cache.balances) || !Array.isArray(cache.cursors)) {
    throw new SafeClientError("The treasury cache is missing movements, balances, or cursors.");
  }
  if (!Array.isArray(cache.tokenAccounts)) {
    throw new SafeClientError("The treasury cache is missing token account discovery.");
  }
  return cache;
}
