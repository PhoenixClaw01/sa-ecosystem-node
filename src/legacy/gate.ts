/** At most this many legacy RPC calls run at once, process-wide. */
export const LEGACY_MAX_IN_FLIGHT = 4;

/** Start times of legacy RPC calls stay at least this far apart. */
export const LEGACY_RPC_SPACING_MS = 200;

/** Distinct cache-miss lookups allowed per minute on one process. */
export const LEGACY_MISS_LIMIT = 30;
export const LEGACY_MISS_WINDOW_MS = 60_000;

export interface RpcGate {
  run<T>(task: () => Promise<T>): Promise<T>;
}

export function createRpcGate(options?: {
  maxInFlight?: number;
  spacingMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): RpcGate {
  const maxInFlight = options?.maxInFlight ?? LEGACY_MAX_IN_FLIGHT;
  const spacingMs = options?.spacingMs ?? LEGACY_RPC_SPACING_MS;
  const now = options?.now ?? Date.now;
  const sleep =
    options?.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let inFlight = 0;
  let nextStart = 0;
  const waiters: Array<() => void> = [];

  function acquire(): Promise<void> {
    return new Promise((resolve) => {
      const tryStart = () => {
        if (inFlight >= maxInFlight) {
          waiters.push(tryStart);
          return;
        }
        const time = now();
        const delay = Math.max(0, nextStart - time);
        nextStart = Math.max(nextStart, time) + spacingMs;
        inFlight += 1;
        if (delay === 0) resolve();
        else void sleep(delay).then(resolve);
      };
      tryStart();
    });
  }

  function release(): void {
    inFlight -= 1;
    const next = waiters.shift();
    if (next) next();
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

/** One queue for every legacy reader in this process. */
export const sharedLegacyGate = createRpcGate();

export interface MissWindow {
  permit(address: string, now: number): boolean;
}

export function createMissWindow(limit = LEGACY_MISS_LIMIT, windowMs = LEGACY_MISS_WINDOW_MS): MissWindow {
  const hits: { address: string; at: number }[] = [];
  return {
    permit(address: string, now: number): boolean {
      const cutoff = now - windowMs;
      for (let index = hits.length - 1; index >= 0; index -= 1) {
        const hit = hits[index];
        if (hit && hit.at < cutoff) hits.splice(index, 1);
      }
      if (hits.some((hit) => hit.address === address)) return true;
      if (hits.length >= limit) return false;
      hits.push({ address, at: now });
      return true;
    },
  };
}

/** Distinct new lookups for this process. Cache hits do not ask. */
export const sharedMissWindow = createMissWindow();
