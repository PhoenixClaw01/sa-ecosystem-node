import { base58Decode } from "./base58.js";
import { createTtlCache } from "../legacy/cache.js";
import { profileWalletKey } from "../legacy/decode.js";
import { createMissWindow } from "../legacy/gate.js";
import {
  PLAYER_PROFILE_PROGRAM_ID,
  PROFILE_KEY_OFFSET,
  PROFILE_KEY_SCAN_MAX,
  PROFILE_KEY_STRIDE,
} from "../legacy/programs.js";
import type { SolanaReadRpc } from "../dao/rpc.js";

/**
 * Read-only check that a wallet is a key on a Player Profile account.
 * The account owner must be the Player Profile program. A failed or
 * rate-limited read does not count as a match.
 */

export type ProfileKeyVerdict = "match" | "mismatch" | "unavailable";

export interface ProfileKeyChecker {
  walletIsProfileKey(wallet: string, profile: string, nowMs: number): Promise<ProfileKeyVerdict>;
}

const CACHE_TTL_MS = 10 * 60_000;
const UNAVAILABLE_TTL_MS = 30_000;
const CACHE_MAX = 128;
/** Distinct profile reads for claims. Separate from the player_legacy miss window. */
export const CLAIM_PROFILE_MISS_LIMIT = 30;
/** At most this many claim profile reads run at once. */
export const CLAIM_PROFILE_CONCURRENCY = 4;
const SLICE_LENGTH = PROFILE_KEY_OFFSET + PROFILE_KEY_STRIDE * PROFILE_KEY_SCAN_MAX;

const verdictCache = createTtlCache<ProfileKeyVerdict>(CACHE_TTL_MS, CACHE_MAX);
const unavailableCache = createTtlCache<ProfileKeyVerdict>(UNAVAILABLE_TTL_MS, CACHE_MAX);
let profileReads = 0;
const profileWaiters: Array<() => void> = [];
const claimMissWindow = createMissWindow(CLAIM_PROFILE_MISS_LIMIT, 60_000);
let cacheGeneration = 0;

/** Test hook. Production reads share one cache. */
export function resetProfileKeyCache(): void {
  cacheGeneration += 1;
}

export function profileVerdictFromAccount(
  owner: string,
  data: Uint8Array,
  wallet: string,
  nowMs: number,
): ProfileKeyVerdict {
  if (owner !== PLAYER_PROFILE_PROGRAM_ID) return "mismatch";
  let walletBytes: Uint8Array;
  try {
    walletBytes = base58Decode(wallet);
  } catch {
    return "mismatch";
  }
  if (walletBytes.length !== 32) return "mismatch";
  const verdict = profileWalletKey(data, wallet, BigInt(Math.floor(nowMs / 1000)), PROFILE_KEY_SCAN_MAX);
  if (verdict === "match") return "match";
  if (verdict === "truncated") return "unavailable";
  return "mismatch";
}

function acquireProfileRead(): Promise<void> {
  if (profileReads < CLAIM_PROFILE_CONCURRENCY) {
    profileReads += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    profileWaiters.push(() => {
      profileReads += 1;
      resolve();
    });
  });
}

function releaseProfileRead(): void {
  profileReads -= 1;
  const next = profileWaiters.shift();
  if (next) next();
}

function cacheKey(profile: string, wallet: string): string {
  return `${cacheGeneration}\n${profile}\n${wallet}`;
}

/**
 * Claim checks do not use the player_legacy gate, so a burst of claims
 * cannot spend that budget or wait out its spacing.
 * Cache hits do not call RPC. A verdict stays cached until the TTL.
 */
export function createProfileKeyChecker(rpc: SolanaReadRpc, now: () => number = Date.now): ProfileKeyChecker {
  return {
    async walletIsProfileKey(wallet, profile, nowMs) {
      const key = cacheKey(profile, wallet);
      const hit = verdictCache.get(key, now()) ?? unavailableCache.get(key, now());
      if (hit) return hit;
      if (!claimMissWindow.permit(profile, now())) return "unavailable";
      await acquireProfileRead();
      let verdict: ProfileKeyVerdict;
      try {
        const result = await rpc.call<unknown>("getAccountInfo", [
          profile,
          {
            encoding: "base64",
            commitment: "confirmed",
            dataSlice: { offset: 0, length: SLICE_LENGTH },
          },
        ]);
        verdict = verdictFromRpc(result, wallet, nowMs);
      } catch {
        verdict = "unavailable";
      } finally {
        releaseProfileRead();
      }
      if (verdict === "unavailable") unavailableCache.set(key, verdict, now());
      else verdictCache.set(key, verdict, now());
      return verdict;
    },
  };
}

function verdictFromRpc(result: unknown, wallet: string, nowMs: number): ProfileKeyVerdict {
  if (!result || typeof result !== "object" || !("value" in result)) return "unavailable";
  const value = (result as { value: unknown }).value;
  if (value === null) return "mismatch";
  if (!value || typeof value !== "object") return "unavailable";
  const owner = (value as { owner?: unknown }).owner;
  const data = (value as { data?: unknown }).data;
  if (typeof owner !== "string" || !Array.isArray(data) || typeof data[0] !== "string" || data[1] !== "base64") {
    return "unavailable";
  }
  return profileVerdictFromAccount(owner, Uint8Array.from(Buffer.from(data[0], "base64")), wallet, nowMs);
}
