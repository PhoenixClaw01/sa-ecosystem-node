export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /**
   * In-memory per instance. Buckets are not shared with other instances
   * and are discarded when the process restarts.
   */
  placeholder: true;
}

export interface RateLimiter {
  check(key: string): RateLimitDecision;
}

const RATE_LIMIT_SWEEP_AT = 1_000;
const RATE_LIMIT_MAX_BUCKETS = 10_000;

export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
  now?: () => number;
  /** Distinct client keys kept at once. New keys are refused once this is full. */
  maxBuckets?: number;
}): RateLimiter {
  const buckets = new Map<string, { windowStart: number; count: number }>();
  const now = options.now ?? Date.now;
  const maxBuckets = options.maxBuckets ?? RATE_LIMIT_MAX_BUCKETS;

  function pruneExpired(time: number): void {
    for (const [bucketKey, bucket] of buckets) {
      if (time - bucket.windowStart >= options.windowMs) buckets.delete(bucketKey);
    }
  }

  return {
    check(key: string): RateLimitDecision {
      const time = now();
      // Expired entries are removed once the map is large. A hard cap refuses
      // new keys so distinct clients cannot grow the map without bound.
      if (buckets.size >= RATE_LIMIT_SWEEP_AT) pruneExpired(time);
      const existing = buckets.get(key);
      const expired = !existing || time - existing.windowStart >= options.windowMs;
      if (expired) {
        if (!existing && buckets.size >= maxBuckets) {
          pruneExpired(time);
          if (buckets.size >= maxBuckets) {
            return { allowed: false, limit: options.limit, remaining: 0, placeholder: true };
          }
        }
        buckets.set(key, { windowStart: time, count: 1 });
        return {
          allowed: true,
          limit: options.limit,
          remaining: Math.max(0, options.limit - 1),
          placeholder: true,
        };
      }
      if (existing.count >= options.limit) {
        return { allowed: false, limit: options.limit, remaining: 0, placeholder: true };
      }
      existing.count += 1;
      return {
        allowed: true,
        limit: options.limit,
        remaining: Math.max(0, options.limit - existing.count),
        placeholder: true,
      };
    },
  };
}

function firstForwardedHop(value: string | undefined): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first || undefined;
}

function headerText(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * One client on this instance.
 * A forwarded address counts only when TRUST_PROXY is on.
 * Otherwise the key is the socket address. A request with neither shares
 * `local` with other unidentified requests. That name is not taken from a header.
 */
export function rateLimitClientKey(input: {
  forwardedFor?: string | null;
  remoteAddress?: string | null;
  trustProxy: boolean;
}): string {
  if (input.trustProxy) {
    const forwarded = firstForwardedHop(input.forwardedFor ?? undefined);
    if (forwarded) return forwarded;
  }
  const remote = input.remoteAddress?.trim();
  if (remote) return remote;
  return "local";
}

export function clientKeyFromRequest(request: Request, trustProxy: boolean): string {
  const socket = (request as Request & { socket?: { remoteAddress?: string | null } }).socket;
  return rateLimitClientKey({
    forwardedFor: request.headers.get("x-forwarded-for"),
    remoteAddress: socket?.remoteAddress,
    trustProxy,
  });
}

/** Socket address, or the first forwarded hop when the operator trusts the proxy. */
export function clientKeyFromNode(
  request: {
    headers: { [key: string]: string | string[] | undefined };
    socket: { remoteAddress?: string | null };
  },
  trustProxy: boolean,
): string {
  return rateLimitClientKey({
    forwardedFor: headerText(request.headers["x-forwarded-for"]),
    remoteAddress: request.socket.remoteAddress,
    trustProxy,
  });
}
