import { SafeClientError } from "../errors.js";
import { assertProgramAccountsParams } from "../legacy/programs.js";

/**
 * Solana's public HTTP API uses POST for every method, including reads.
 * This client refuses anything that is not an allow-listed get* read.
 */

const ALLOWED_METHODS = new Set([
  "getSignaturesForAddress",
  "getTransaction",
  "getTokenAccountsByOwner",
  "getTokenAccountBalance",
  "getBalance",
  "getAccountInfo",
  "getMultipleAccounts",
  "getProgramAccounts",
]);

export function assertReadMethod(method: string): void {
  if (!method.startsWith("get") || !ALLOWED_METHODS.has(method)) {
    throw new SafeClientError(`Refusing Solana RPC method ${method}. This node only sends read methods.`);
  }
}

export interface RpcRequest {
  method: string;
  params: readonly unknown[];
}

export interface RpcCallOptions {
  /** Abort this call, including retries, after this many milliseconds. */
  timeoutMs?: number;
}

export interface SolanaReadRpc {
  call<T>(method: string, params: readonly unknown[], options?: RpcCallOptions): Promise<T>;
  batch(requests: readonly RpcRequest[]): Promise<unknown[]>;
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

const TX_ENCODING = {
  encoding: "jsonParsed",
  maxSupportedTransactionVersion: 0,
  commitment: "confirmed",
} as const;

export const TRANSACTION_OPTIONS = TX_ENCODING;

function isRateLimitedMessage(message: string): boolean {
  return /too many requests|rate limit/i.test(message);
}

function isRateLimitedPayload(payload: unknown): boolean {
  const items = Array.isArray(payload) ? payload : [payload];
  return items.some((item) => {
    if (!item || typeof item !== "object" || !("error" in item)) return false;
    const message = String((item as JsonRpcResponse).error?.message ?? "");
    return isRateLimitedMessage(message);
  });
}

/** Free public hosts only. No paid endpoint and no API key. */
function isOfficialPublicRpc(url: string): boolean {
  return rpcHost(url) === "api.mainnet-beta.solana.com";
}

/**
 * A signature page is an array, or a `{ signatures }` object.
 * A removed `filtered` list is not a page. Callers must not read it.
 */
export function signaturePage(result: unknown): SignatureInfo[] | undefined {
  if (Array.isArray(result)) return result as SignatureInfo[];
  if (!result || typeof result !== "object") return undefined;
  const signatures = (result as { signatures?: unknown }).signatures;
  if (Array.isArray(signatures)) return signatures as SignatureInfo[];
  return undefined;
}

function beforeCursor(method: string, params: readonly unknown[]): string | null {
  if (method !== "getSignaturesForAddress") return null;
  const config = params[1];
  if (!config || typeof config !== "object") return null;
  const before = (config as { before?: unknown }).before;
  return typeof before === "string" && before.length > 0 ? before : null;
}

async function readHttpFailure(response: Response): Promise<{ message: string; rateLimited: boolean; indexedRefusal: boolean }> {
  const text = await response.text();
  let message = `HTTP ${response.status}`;
  try {
    const payload = JSON.parse(text) as JsonRpcResponse;
    if (payload.error?.message) message = payload.error.message;
  } catch {
    if (text.trim()) message = `HTTP ${response.status}`;
  }
  return {
    message,
    rateLimited: isRateLimitedMessage(message),
    indexedRefusal: /personal token|indexed request/i.test(message),
  };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const PUBLIC_SOLANA_RPC_URLS = [
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
] as const;

export function rpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "rpc";
  }
}

/** Primary URL first, then configured fallbacks, then the two public endpoints. Duplicates dropped. */
export function solanaRpcUrls(primary: string, extra?: string): string[] {
  const raw = [primary, ...(extra ? extra.split(",") : []), ...PUBLIC_SOLANA_RPC_URLS];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const item of raw) {
    const trimmed = item.trim().replace(/\/$/, "");
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    urls.push(trimmed);
  }
  return urls;
}

export interface RpcClientOptions {
  minIntervalMs?: number;
  attempts?: number;
  /** Per-attempt abort. The default stays long enough for a treasury page. */
  timeoutMs?: number;
}

function nextWait(wait: number): number {
  if (wait <= 0) return 0;
  return Math.min(wait * 2, 20_000);
}

export function createRpcClient(
  url: string,
  fetchImpl: typeof fetch = fetch,
  options?: RpcClientOptions,
): SolanaReadRpc {
  const host = rpcHost(url);
  let gap = options?.minIntervalMs ?? 200;
  const attempts = options?.attempts ?? 4;

  async function post(body: unknown, timeoutMs?: number): Promise<unknown> {
    const capped = timeoutMs !== undefined;
    const budget = timeoutMs ?? options?.timeoutMs ?? 45_000;
    if (!(budget > 0)) {
      throw new SafeClientError("Solana RPC read stopped because the time budget ran out.");
    }
    const started = Date.now();
    let wait = gap;
    let lastDetail = "no response";
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const left = capped ? budget - (Date.now() - started) : budget;
      if (left <= 0) {
        throw new SafeClientError("Solana RPC read stopped because the time budget ran out.");
      }
      await sleep(wait);
      const signalMs = capped ? budget - (Date.now() - started) : budget;
      if (signalMs <= 0) {
        throw new SafeClientError("Solana RPC read stopped because the time budget ran out.");
      }
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(signalMs),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "network error";
        lastDetail = message.replace(/https?:\/\/\S+/g, "[rpc]");
        wait = nextWait(wait);
        continue;
      }
      if (!response.ok) {
        const failure = await readHttpFailure(response);
        if (failure.indexedRefusal) {
          throw new SafeClientError(`Solana RPC refused an indexed read (${host}).`);
        }
        if (
          response.status === 403 ||
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500 ||
          failure.rateLimited
        ) {
          lastDetail = failure.message || `HTTP ${response.status}`;
          wait = gap <= 0 ? 0 : nextWait(Math.max(wait, gap));
          gap = Math.max(gap, wait);
          continue;
        }
        throw new SafeClientError(`Solana RPC HTTP ${response.status} from ${host}.`);
      }
      const payload = (await response.json()) as unknown;
      if (isRateLimitedPayload(payload)) {
        lastDetail = "JSON-RPC rate limit";
        wait = gap <= 0 ? 0 : nextWait(Math.max(wait, gap));
        gap = Math.max(gap, wait);
        continue;
      }
      gap = Math.max(options?.minIntervalMs ?? 200, Math.floor(gap * 0.8));
      return payload;
    }
    throw new SafeClientError(`Solana RPC read failed after retries (${host}: ${lastDetail}).`);
  }

  function unwrap(payload: unknown, id: number): unknown {
    if (!payload || typeof payload !== "object") {
      throw new SafeClientError("Solana RPC returned an unexpected payload.");
    }
    const body = payload as JsonRpcResponse;
    if (body.error) {
      throw new SafeClientError(`Solana RPC error: ${body.error.message ?? "request failed"}.`);
    }
    if (body.id !== undefined && body.id !== id) {
      throw new SafeClientError("Solana RPC response id did not match the request.");
    }
    return body.result;
  }

  function assertCall(method: string, params: readonly unknown[]): void {
    assertReadMethod(method);
    if (method !== "getProgramAccounts") return;
    if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
      throw new SafeClientError("getProgramAccounts runs on the server. The public mainnet RPC refuses browser calls.");
    }
    if (!isOfficialPublicRpc(url)) {
      throw new SafeClientError("getProgramAccounts is sent only to the public mainnet RPC.");
    }
    assertProgramAccountsParams(params);
  }

  return {
    async call<T>(method: string, params: readonly unknown[], callOptions?: RpcCallOptions): Promise<T> {
      assertCall(method, params);
      const payload = await post({ jsonrpc: "2.0", id: 1, method, params }, callOptions?.timeoutMs);
      return unwrap(payload, 1) as T;
    },
    async batch(requests: readonly RpcRequest[]): Promise<unknown[]> {
      if (requests.length === 0) return [];
      for (const request of requests) assertCall(request.method, request.params);
      const payload = await post(
        requests.map((request, index) => ({
          jsonrpc: "2.0",
          id: index,
          method: request.method,
          params: request.params,
        })),
      );
      if (!Array.isArray(payload)) {
        throw new SafeClientError("Solana RPC batch did not return a list.");
      }
      const byId = new Map<number, JsonRpcResponse>();
      for (const item of payload) {
        if (!item || typeof item !== "object" || typeof (item as JsonRpcResponse).id !== "number") {
          throw new SafeClientError("Solana RPC batch item had no id.");
        }
        byId.set((item as JsonRpcResponse).id as number, item as JsonRpcResponse);
      }
      return requests.map((_, index) => {
        const item = byId.get(index);
        if (!item) throw new SafeClientError("Solana RPC batch omitted a response.");
        return unwrap(item, index);
      });
    },
  };
}

/**
 * Try each free public RPC in the configured order. Every call starts at the first URL.
 * A null getTransaction means that host has no copy, so the next free host is asked
 * before the walker records a gap. An empty getSignaturesForAddress page with `before`
 * set is the same kind of miss. It is not the end of history until the official public
 * host says so. The thrown error names every host that refused the read.
 */
export function createFallbackRpc(
  urls: readonly string[],
  fetchImpl: typeof fetch = fetch,
  options?: RpcClientOptions,
): SolanaReadRpc {
  if (urls.length === 0) {
    throw new SafeClientError("No public Solana RPC URL was configured.");
  }
  const clients = urls.map((url) => ({ url, rpc: createRpcClient(url, fetchImpl, options) }));

  async function attempt<T>(method: string, params: readonly unknown[], run: (rpc: SolanaReadRpc) => Promise<T>): Promise<T> {
    const errors: string[] = [];
    const before = beforeCursor(method, params);
    let emptyBeforePages = 0;
    for (const client of clients) {
      try {
        const result = await run(client.rpc);
        if (method === "getSignaturesForAddress") {
          const rows = signaturePage(result);
          if (!rows) {
            errors.push(`Solana RPC error: getSignaturesForAddress returned an unexpected shape (${rpcHost(client.url)}).`);
            continue;
          }
          if (before && rows.length === 0) {
            emptyBeforePages += 1;
            if (isOfficialPublicRpc(client.url)) return rows as T;
            continue;
          }
          return rows as T;
        }
        if (method === "getTransaction" && result === null) continue;
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : "request failed";
        errors.push(message);
      }
    }
    if (method === "getTransaction" && errors.length === 0) return null as T;
    if (before && emptyBeforePages === clients.length && errors.length === 0) return [] as T;
    throw new SafeClientError(
      errors.length > 0
        ? `Public Solana RPC refused the read. ${errors.join(" | ")}`
        : "Public Solana RPC refused the read.",
    );
  }

  return {
    call<T>(method: string, params: readonly unknown[], callOptions?: RpcCallOptions): Promise<T> {
      return attempt(method, params, (rpc) => rpc.call<T>(method, params, callOptions));
    },
    async batch(requests: readonly RpcRequest[]): Promise<unknown[]> {
      // One HTTP call at a time. solana-rpc.publicnode.com answers a single
      // getTransaction and rejects a batch of them with HTTP 400.
      const results: unknown[] = [];
      for (const request of requests) {
        results.push(await attempt(request.method, request.params, (rpc) => rpc.call(request.method, request.params)));
      }
      return results;
    },
  };
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

/**
 * Free public RPCs drop or reject a 1,000-signature page more often than a short one.
 * The walker resumes from the cached oldest signature, so a short page still makes progress.
 */
export const SIGNATURE_PAGE_LIMIT = 100;

function isDeadlineStop(error: unknown): boolean {
  if (error instanceof SafeClientError && /time budget/i.test(error.message)) return true;
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name?: unknown }).name) : "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  const message = error instanceof Error ? error.message : "";
  return /timeout|aborted|time budget/i.test(message);
}

export async function listSignatures(
  rpc: SolanaReadRpc,
  address: string,
  until?: string | null,
  options?: { maxPages?: number; before?: string | null; deadlineMs?: number; now?: () => number },
): Promise<{ signatures: SignatureInfo[]; reachedEnd: boolean; pages: number }> {
  const collected: SignatureInfo[] = [];
  const maxPages = options?.maxPages ?? Number.POSITIVE_INFINITY;
  const limit = SIGNATURE_PAGE_LIMIT;
  const clock = options?.now ?? Date.now;
  let before = options?.before ?? undefined;
  let pages = 0;
  for (;;) {
    if (pages >= maxPages) return { signatures: collected, reachedEnd: false, pages };
    if (options?.deadlineMs !== undefined && clock() >= options.deadlineMs) {
      return { signatures: collected, reachedEnd: false, pages };
    }
    const config: Record<string, unknown> = { limit, commitment: "confirmed" };
    if (before) config.before = before;
    if (until) config.until = until;
    const remaining = options?.deadlineMs !== undefined ? options.deadlineMs - clock() : undefined;
    const timeoutMs = remaining === undefined ? undefined : Math.min(4_000, remaining);
    let page: SignatureInfo[] | undefined;
    try {
      page = signaturePage(
        await rpc.call<unknown>(
          "getSignaturesForAddress",
          [address, config],
          timeoutMs === undefined ? undefined : { timeoutMs },
        ),
      );
    } catch (error) {
      if (pages > 0 && options?.deadlineMs !== undefined && isDeadlineStop(error)) {
        return { signatures: collected, reachedEnd: false, pages };
      }
      throw error;
    }
    if (!page) {
      throw new SafeClientError("getSignaturesForAddress returned an unexpected shape.");
    }
    pages += 1;
    collected.push(...page);
    if (page.length < limit) return { signatures: collected, reachedEnd: true, pages };
    const last = page[page.length - 1];
    if (!last) return { signatures: collected, reachedEnd: true, pages };
    before = last.signature;
  }
}
