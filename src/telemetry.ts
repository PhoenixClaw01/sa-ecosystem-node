import { READ_ONLY_TOOLS } from "./tool-names.js";

/**
 * Vendor-neutral tool-outcome telemetry. The default sink writes one JSON
 * line to stdout, which works on Vercel, Cloudflare, Fly, Docker, or a
 * local process. An HTTP POST or a custom callback is optional and off
 * until configured. A sink error never changes the MCP response.
 * The event is a fixed set of fields. Wallets, player ids, search text,
 * IP addresses, raw User-Agent or client names, auth headers, and raw
 * request bodies are not fields of that event.
 */

export const TOOL_OUTCOMES = ["ok", "empty", "unmatched", "invalid_args", "error"] as const;
export type ToolOutcome = (typeof TOOL_OUTCOMES)[number];

export const CLIENT_FAMILIES = ["cursor", "claude", "vscode", "chatgpt", "browser", "node", "unknown"] as const;
export type ClientFamily = (typeof CLIENT_FAMILIES)[number];

export const ERROR_CLASSES = ["invalid_args", "timeout", "unavailable", "upstream", "rate_limited", "internal"] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

export const TELEMETRY_FIELDS = [
  "tool",
  "called_at",
  "env",
  "client_family",
  "self_traffic",
  "outcome",
  "result_count",
  "latency_ms",
  "error_class",
] as const;

/** Marks operator or smoke traffic. The header value is never copied into the event. */
export const SELF_TRAFFIC_AGENT_HEADER = "x-phoenix-agent";
export const SELF_TRAFFIC_SWEEP_HEADER = "x-phoenix-sweep";
const SELF_USER_AGENT = /phoenixcollectiveagent|phoenix-mcp-smoke/i;

export const TELEMETRY_SINK_KINDS = ["off", "stdout", "http", "both", "custom"] as const;
export type TelemetrySinkKind = (typeof TELEMETRY_SINK_KINDS)[number];

/** A custom sink. It must not throw into the MCP response; the caller still fail-opens. */
export type TelemetrySink = (event: Record<string, unknown>) => void | Promise<void>;

export const TELEMETRY_META_FIELDS = [
  "stream",
  "category",
  "status",
  "kind",
  "direction",
  "mint",
  "wallet_role",
  "granularity",
  "include_expired",
  "include_internal",
  "include_fees",
  "allow_partial",
  "anchored",
  "story_status",
] as const;

const DEFAULT_TIMEOUT_MS = 1_500;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 3_000;
const MAX_LATENCY_MS = 120_000;
const MAX_RESULT_COUNT = 1_000_000;
const MAX_KEY_LENGTH = 4_096;

const ENV_PATTERN = /^[a-z0-9_-]{1,24}$/;
const CALLED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const TOOL_NAMES = new Set<string>(READ_ONLY_TOOLS);
const OUTCOMES = new Set<string>(TOOL_OUTCOMES);
const FAMILIES = new Set<string>(CLIENT_FAMILIES);
const CLASSES = new Set<string>(ERROR_CLASSES);

const STREAMS = new Set(["referral", "hybrid", "irl", "player"]);
const CATEGORIES = new Set(["ip_and_business", "creators", "developers_and_tools", "guilds_and_dacs", "events"]);
const LISTING_STATUS = new Set(["available", "sold_out", "inquire_only", "paused", "withdrawn"]);
const KINDS = new Set([
  "announcement",
  "proposal-note",
  "payment-note",
  "status",
  "signer-change",
  "listing",
  "guild",
  "story-optin",
  "claim",
  "attestation",
  "reputation-link",
  "all",
]);
const DIRECTIONS = new Set(["in", "out", "all"]);
const MINTS = new Set(["ATLAS", "USDC", "SOL"]);
const WALLET_ROLES = new Set(["dao_treasury", "ecosystem_fund"]);
const GRANULARITY = new Set(["day", "month"]);
const STORY_STATUS = new Set(["story", "not_opted_in", "not_available"]);

const BOOL_ARGS: Readonly<Record<string, (typeof TELEMETRY_META_FIELDS)[number]>> = {
  includeExpired: "include_expired",
  includeInternal: "include_internal",
  includeFees: "include_fees",
  allowPartial: "allow_partial",
  anchored: "anchored",
};

const COUNT_FIELD: Readonly<Record<string, { kind: "array" | "number"; field: string }>> = {
  list_star_systems: { kind: "array", field: "systems" },
  galaxy_overview: { kind: "array", field: "systems" },
  get_fleet: { kind: "array", field: "fleets" },
  profile_key_audit: { kind: "array", field: "keys" },
  list_categories: { kind: "array", field: "categories" },
  hub_updates: { kind: "array", field: "updates" },
  list_listings: { kind: "array", field: "listings" },
  search_hub: { kind: "array", field: "results" },
  claim_status: { kind: "array", field: "claims" },
  list_c4_markers: { kind: "array", field: "markers" },
  list_community_tools: { kind: "array", field: "tools" },
  data_health: { kind: "array", field: "checks" },
  list_proposals: { kind: "array", field: "proposals" },
  get_proposal_votes: { kind: "number", field: "voterCount" },
  dao_revenue: { kind: "number", field: "rowCount" },
  dao_treasury_flows: { kind: "array", field: "rows" },
  dao_payments: { kind: "array", field: "payments" },
  treasury_history: { kind: "array", field: "series" },
  treasury_balances: { kind: "array", field: "wallets" },
  pip_tracker: { kind: "number", field: "rowCount" },
};

export type WaitUntil = (promise: Promise<unknown>) => void;

export interface ToolTelemetry {
  readonly enabled: boolean;
  readonly sinkKind: TelemetrySinkKind;
  observe(request: Request, userAgent: string | null): Promise<ObservedCall | null>;
  finish(observed: ObservedCall | null, body: Uint8Array, status: number, startedAtMs: number): void;
  /** Record an HTTP denial, such as a Node rate limit, without reading a body or an address. */
  noteStatus(userAgent: string | null, status: number, headers?: Headers | null): void;
  settled(): Promise<void>;
}

interface ObservedCall {
  calls: PendingCall[];
}

interface PendingCall {
  id: unknown;
  tool: string;
  meta: Record<string, string | boolean>;
  clientFamily: ClientFamily;
  selfTraffic: boolean;
  lookupFiltered: boolean;
}

interface TelemetryConfig {
  kind: Exclude<TelemetrySinkKind, "off">;
  url: string | null;
  key: string | null;
  env: string;
  timeoutMs: number;
  rest: boolean;
  fetch: typeof fetch;
  sink?: TelemetrySink;
  write: (line: string) => void;
  waitUntil?: () => WaitUntil | undefined;
}

interface Classified {
  outcome: ToolOutcome;
  result_count: number | null;
  error_class: ErrorClass | null;
  story_status?: "story" | "not_opted_in" | "not_available";
}

/**
 * Read operator env and optional hooks. A custom `sink` always wins.
 * Otherwise: `MCP_TELEMETRY_SINK=off` disables; `stdout` writes JSON lines;
 * a valid `MCP_TELEMETRY_URL` enables the optional HTTP POST (off until set);
 * `both` writes stdout and HTTP. In a test process the default is off so
 * unit tests stay quiet unless a sink is set explicitly.
 * The URL and key are not written into the event.
 */
export function readTelemetryConfig(
  env: NodeJS.ProcessEnv = process.env,
  options?: {
    fetch?: typeof fetch;
    sink?: TelemetrySink;
    write?: (line: string) => void;
    waitUntil?: () => WaitUntil | undefined;
  },
): TelemetryConfig | null {
  const write = options?.write ?? defaultStdoutWrite;
  if (options?.sink) {
    return {
      kind: "custom",
      url: null,
      key: null,
      env: coarseEnv(env),
      timeoutMs: timeoutMs(env.MCP_TELEMETRY_TIMEOUT_MS),
      rest: false,
      fetch: options.fetch ?? globalThis.fetch,
      sink: options.sink,
      write,
      waitUntil: options.waitUntil,
    };
  }
  const mode = sinkMode(env.MCP_TELEMETRY_SINK);
  if (mode === "off") return null;
  const url = sinkUrl(env.MCP_TELEMETRY_URL);
  if (mode === "http") {
    if (!url) return null;
    return httpConfig(env, url, "http", options, write);
  }
  if (mode === "both") {
    if (url) return httpConfig(env, url, "both", options, write);
    return stdoutConfig(env, options, write);
  }
  if (mode === "stdout") return stdoutConfig(env, options, write);
  if (url) return httpConfig(env, url, "http", options, write);
  if (isTestEnv(env)) return null;
  return stdoutConfig(env, options, write);
}

export function createToolTelemetry(options?: {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  sink?: TelemetrySink;
  write?: (line: string) => void;
  /** Called when a sink promise starts. The public entry passes the Vercel request context. */
  waitUntil?: () => WaitUntil | undefined;
}): ToolTelemetry {
  const config = readTelemetryConfig(options?.env ?? process.env, options);
  if (!config) return disabledTelemetry();

  let chain: Promise<void> = Promise.resolve();
  const telemetry: ToolTelemetry = {
    enabled: true,
    sinkKind: config.kind,
    observe,
    finish(observed, body, status, startedAtMs) {
      try {
        if (!observed || observed.calls.length === 0) return;
        let payload: unknown;
        try {
          payload = parseRpcBody(body);
        } catch {
          payload = null;
        }
        const calledAt = new Date(startedAtMs).toISOString();
        const latencyMs = Math.max(0, Date.now() - startedAtMs);
        const only = observed.calls.length === 1;
        for (const call of observed.calls) {
          try {
            const message = messageFor(payload, call.id, only);
            const classified = classifyCall(call, message, status);
            const event = sealEvent(call, classified, config.env, calledAt, latencyMs);
            if (event) send(config, event, (work) => {
              chain = chain.then(() => work).catch(() => undefined);
            });
          } catch {
            // A bad event never affects the MCP response.
          }
        }
      } catch {
        // Building an event must not throw into the MCP response.
      }
    },
    noteStatus(userAgent, status, headers) {
      try {
        telemetry.finish(
          {
            calls: [
              {
                id: null,
                tool: "unknown",
                meta: {},
                clientFamily: clientFamily(userAgent),
                selfTraffic: isSelfTraffic(headers ?? null, userAgent),
                lookupFiltered: false,
              },
            ],
          },
          new Uint8Array(),
          status,
          Date.now(),
        );
      } catch {
        // A telemetry failure must not affect the response.
      }
    },
    settled: () => chain,
  };
  return telemetry;
}

/**
 * Vercel Node stores `waitUntil` on the request context, not on `globalThis`.
 * Call this while the request is still on the stack. Never await the promise it receives.
 */
export function resolveRequestWaitUntil(): WaitUntil | undefined {
  try {
    const carrier = (globalThis as typeof globalThis & Record<symbol, { get?: () => { waitUntil?: WaitUntil } | undefined } | undefined>)[
      Symbol.for("@vercel/request-context")
    ];
    const current = carrier?.get?.();
    const waitUntil = current?.waitUntil;
    if (typeof waitUntil === "function") {
      return (promise) => {
        waitUntil.call(current, promise);
      };
    }
  } catch {
    // This host has no request context.
  }
  const fallback = (globalThis as typeof globalThis & { waitUntil?: WaitUntil }).waitUntil;
  return typeof fallback === "function" ? fallback : undefined;
}

export function argumentMeta(tool: string, args: unknown): Record<string, string | boolean> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  if (tool !== "unknown" && !TOOL_NAMES.has(tool)) return {};
  const record = args as Record<string, unknown>;
  const meta: Record<string, string | boolean> = {};
  const stream = enumValue(record.stream, STREAMS);
  const category = enumValue(record.category, CATEGORIES);
  const status = enumValue(record.status, LISTING_STATUS);
  const kind = enumValue(record.kind, KINDS);
  const direction = enumValue(record.direction, DIRECTIONS);
  const mint = enumValue(record.mint, MINTS);
  const walletRole = enumValue(record.wallet, WALLET_ROLES);
  const granularity = enumValue(record.granularity, GRANULARITY);
  if (stream) meta.stream = stream;
  if (category) meta.category = category;
  if (status) meta.status = status;
  if (kind) meta.kind = kind;
  if (direction) meta.direction = direction;
  if (mint) meta.mint = mint;
  if (walletRole) meta.wallet_role = walletRole;
  if (granularity) meta.granularity = granularity;
  for (const [name, field] of Object.entries(BOOL_ARGS)) {
    if (typeof record[name] === "boolean") meta[field] = record[name];
  }
  return meta;
}

export function clientFamily(userAgent: string | null): ClientFamily {
  const text = (userAgent ?? "").slice(0, 300).toLowerCase();
  if (text.includes("cursor")) return "cursor";
  if (text.includes("claude")) return "claude";
  if (text.includes("vscode") || text.includes("visual studio code")) return "vscode";
  if (text.includes("chatgpt") || text.includes("openai")) return "chatgpt";
  if (text.includes("mozilla") || text.includes("chrome") || text.includes("safari") || text.includes("firefox")) return "browser";
  if (text.includes("node")) return "node";
  return "unknown";
}

function disabledTelemetry(): ToolTelemetry {
  return {
    enabled: false,
    sinkKind: "off",
    async observe() {
      return null;
    },
    finish() {},
    noteStatus() {},
    settled: () => Promise.resolve(),
  };
}

function stdoutConfig(
  env: NodeJS.ProcessEnv,
  options: { fetch?: typeof fetch; waitUntil?: () => WaitUntil | undefined } | undefined,
  write: (line: string) => void,
): TelemetryConfig {
  return {
    kind: "stdout",
    url: null,
    key: null,
    env: coarseEnv(env),
    timeoutMs: timeoutMs(env.MCP_TELEMETRY_TIMEOUT_MS),
    rest: false,
    fetch: options?.fetch ?? globalThis.fetch,
    write,
    waitUntil: options?.waitUntil,
  };
}

function httpConfig(
  env: NodeJS.ProcessEnv,
  url: string,
  kind: "http" | "both",
  options: { fetch?: typeof fetch; waitUntil?: () => WaitUntil | undefined } | undefined,
  write: (line: string) => void,
): TelemetryConfig {
  return {
    kind,
    url,
    key: sinkKey(env.MCP_TELEMETRY_KEY),
    env: coarseEnv(env),
    timeoutMs: timeoutMs(env.MCP_TELEMETRY_TIMEOUT_MS),
    rest: restTable(url),
    fetch: options?.fetch ?? globalThis.fetch,
    write,
    waitUntil: options?.waitUntil,
  };
}

/**
 * Listener for the default stdout sink. `stdout.write` reports a closed pipe
 * as an async `error` event, not a throw. Without a listener that event
 * becomes an uncaught exception and ends the process.
 */
export function ignoreTelemetryStdoutError(_error: unknown): void {
  void _error;
}

function ensureStdoutErrorGuard(): void {
  if (process.stdout.listeners("error").includes(ignoreTelemetryStdoutError)) return;
  process.stdout.on("error", ignoreTelemetryStdoutError);
}

function defaultStdoutWrite(line: string): void {
  try {
    ensureStdoutErrorGuard();
    process.stdout.write(`${line}\n`);
  } catch {
    // A full or closed stdout must not affect the MCP response.
  }
}

export function isSelfTraffic(
  headers: { get(name: string): string | null } | null | undefined,
  userAgent: string | null,
): boolean {
  try {
    const marker = headers?.get(SELF_TRAFFIC_AGENT_HEADER);
    if (marker !== null && marker !== undefined && marker.trim() !== "") return true;
    const sweep = headers?.get(SELF_TRAFFIC_SWEEP_HEADER);
    if (sweep !== null && sweep !== undefined && sweep.trim() !== "") return true;
    const ua = userAgent ?? headers?.get("user-agent") ?? "";
    return SELF_USER_AGENT.test(ua);
  } catch {
    return false;
  }
}

function sinkMode(value: string | undefined): "off" | "stdout" | "http" | "both" | null {
  const raw = value?.trim().toLowerCase() ?? "";
  if (!raw) return null;
  if (raw === "off" || raw === "noop" || raw === "false" || raw === "0") return "off";
  if (raw === "stdout" || raw === "log") return "stdout";
  if (raw === "http") return "http";
  if (raw === "both") return "both";
  return null;
}

function isTestEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.VITEST) || env.NODE_ENV === "test";
}

async function observe(request: Request, userAgent: string | null): Promise<ObservedCall | null> {
  if (request.method !== "POST") return null;
  let payload: unknown;
  try {
    payload = JSON.parse(await request.text()) as unknown;
  } catch {
    return null;
  }
  const family = clientFamily(userAgent);
  const selfTraffic = isSelfTraffic(request.headers, userAgent);
  const calls: PendingCall[] = [];
  for (const message of rpcMessages(payload)) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const record = message as Record<string, unknown>;
    if (record.method !== "tools/call") continue;
    const params = record.params;
    const paramRecord = params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
    const name = typeof paramRecord.name === "string" && TOOL_NAMES.has(paramRecord.name) ? paramRecord.name : "unknown";
    const args = paramRecord.arguments;
    calls.push({
      id: record.id ?? null,
      tool: name,
      meta: argumentMeta(name, args),
      clientFamily: family,
      selfTraffic,
      lookupFiltered: name === "claim_status" && identityPresent(args),
    });
  }
  return calls.length > 0 ? { calls } : null;
}

function identityPresent(args: unknown): boolean {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const identity = (args as Record<string, unknown>).identity;
  return typeof identity === "string" && identity.trim().length > 0;
}

function send(config: TelemetryConfig, event: Record<string, unknown>, track: (work: Promise<void>) => void): void {
  let body: string;
  try {
    body = JSON.stringify(event);
  } catch {
    return;
  }
  if (config.kind === "stdout" || config.kind === "both" || config.kind === "custom") {
    try {
      if (config.kind === "custom" && config.sink) {
        const result = config.sink(event);
        if (result && typeof result.then === "function") {
          const work = Promise.resolve(result).then(() => undefined).catch(() => undefined);
          track(work);
          attachWaitUntil(config, work);
        }
      } else {
        config.write(body);
      }
    } catch {
      // A sink throw never affects the MCP response.
    }
    if (config.kind !== "both") return;
  }
  const url = config.url;
  if (!url) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") timer.unref();
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (config.key) {
    headers.authorization = `Bearer ${config.key}`;
    if (config.rest) {
      headers.apikey = config.key;
      headers.prefer = "return=minimal";
    }
  }
  const work = Promise.resolve()
    .then(() =>
      config.fetch(url, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: controller.signal,
      }),
    )
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => clearTimeout(timer));
  track(work);
  attachWaitUntil(config, work);
}

function attachWaitUntil(config: TelemetryConfig, work: Promise<void>): void {
  const waitUntil = config.waitUntil?.() ?? resolveRequestWaitUntil();
  if (typeof waitUntil === "function") {
    try {
      waitUntil(work);
    } catch {
      // The host did not accept the background handle. The send still has its own timeout.
    }
  }
}

function sealEvent(
  call: PendingCall,
  classified: Classified,
  env: string,
  calledAt: string,
  latencyMs: number,
): Record<string, unknown> | null {
  if (call.tool !== "unknown" && !TOOL_NAMES.has(call.tool)) return null;
  if (!FAMILIES.has(call.clientFamily) || !OUTCOMES.has(classified.outcome) || !ENV_PATTERN.test(env)) return null;
  if (!CALLED_AT_PATTERN.test(calledAt)) return null;
  if (classified.error_class !== null && !CLASSES.has(classified.error_class)) return null;
  const latency = Number.isFinite(latencyMs) ? Math.min(MAX_LATENCY_MS, Math.max(0, Math.round(latencyMs))) : 0;
  const event: Record<string, unknown> = {
    tool: call.tool,
    called_at: calledAt,
    env,
    client_family: call.clientFamily,
    self_traffic: call.selfTraffic === true,
    outcome: classified.outcome,
    result_count: sanitizeCount(classified.result_count),
    latency_ms: latency,
    error_class: classified.error_class,
  };
  const meta = { ...call.meta };
  if (classified.story_status && STORY_STATUS.has(classified.story_status)) meta.story_status = classified.story_status;
  const boolFields = new Set<string>(["include_expired", "include_internal", "include_fees", "allow_partial", "anchored"]);
  for (const field of TELEMETRY_META_FIELDS) {
    const value = meta[field];
    if (typeof value === "boolean") {
      if (boolFields.has(field)) event[field] = value;
      continue;
    }
    if (typeof value !== "string") continue;
    if (field === "stream" && STREAMS.has(value)) event[field] = value;
    else if (field === "category" && CATEGORIES.has(value)) event[field] = value;
    else if (field === "status" && LISTING_STATUS.has(value)) event[field] = value;
    else if (field === "kind" && KINDS.has(value)) event[field] = value;
    else if (field === "direction" && DIRECTIONS.has(value)) event[field] = value;
    else if (field === "mint" && MINTS.has(value)) event[field] = value;
    else if (field === "wallet_role" && WALLET_ROLES.has(value)) event[field] = value;
    else if (field === "granularity" && GRANULARITY.has(value)) event[field] = value;
    else if (field === "story_status" && STORY_STATUS.has(value)) event[field] = value;
  }
  return event;
}

function classifyCall(call: PendingCall, message: unknown, status: number): Classified {
  if (status === 413) return sizeCap();
  if (!message || typeof message !== "object" || Array.isArray(message)) return fromStatus(status);
  const record = message as Record<string, unknown>;
  if (record.error && typeof record.error === "object") {
    const error = record.error as Record<string, unknown>;
    if (error.code === -32602 || error.code === -32600) {
      return { outcome: "invalid_args", result_count: null, error_class: "invalid_args" };
    }
    return classifyFailure(typeof error.message === "string" ? error.message : "");
  }
  if (!record.result || typeof record.result !== "object" || Array.isArray(record.result)) return fromStatus(status);
  const result = record.result as Record<string, unknown>;
  if (result.isError === true) {
    const failed = classifyFailure(textContent(result.content));
    return failed.outcome === "unmatched" ? failed : { ...failed, result_count: null };
  }
  return classifySuccess(call.tool, structuredData(result), call.lookupFiltered);
}

function classifyFailure(message: string): Classified {
  const text = message.toLowerCase();
  if (text.includes("timed out") || text.includes("timeout")) {
    return { outcome: "error", result_count: null, error_class: "timeout" };
  }
  if (text.includes("rate limit") || text.includes("rate_limited")) {
    return { outcome: "error", result_count: null, error_class: "rate_limited" };
  }
  if (
    text.includes("not yet populated") ||
    text.includes("not available") ||
    text.includes("unavailable") ||
    text.includes("refresh-treasury")
  ) {
    return { outcome: "error", result_count: null, error_class: "unavailable" };
  }
  if (
    text.includes("no galaxy proposal") ||
    text.includes("not found") ||
    text.includes("does not exist") ||
    text.includes("no matching")
  ) {
    return { outcome: "unmatched", result_count: 0, error_class: null };
  }
  if (
    text.includes("size cap") ||
    text.includes("payload too large") ||
    text.includes("entity too large") ||
    text.includes("invalid") ||
    text.includes("must be") ||
    text.includes("provide ") ||
    text.includes("expected") ||
    text.includes("too small") ||
    text.includes("too big") ||
    text.includes("unrecognized") ||
    text.includes("required")
  ) {
    return { outcome: "invalid_args", result_count: null, error_class: "invalid_args" };
  }
  return { outcome: "error", result_count: null, error_class: "upstream" };
}

function classifySuccess(tool: string, data: Record<string, unknown>, lookupFiltered: boolean): Classified {
  if (data.populated === false) return { outcome: "empty", result_count: 0, error_class: null };
  if (tool === "player_story") return classifyStory(data);
  if (tool === "player_legacy") return classifyLegacy(data);
  if (tool === "dao_overview") return classifyOverview(data);
  if (tool === "ecofund_limit") return { outcome: "ok", result_count: 1, error_class: null };
  const spec = COUNT_FIELD[tool];
  if (!spec) return { outcome: "ok", result_count: null, error_class: null };
  const count = spec.kind === "number" ? numberCount(data[spec.field]) : arrayCount(data[spec.field]);
  if (count === null) return { outcome: "ok", result_count: null, error_class: null };
  if (count === 0 && (tool === "get_fleet" || (tool === "claim_status" && lookupFiltered))) {
    return { outcome: "unmatched", result_count: 0, error_class: null };
  }
  if (count === 0) return { outcome: "empty", result_count: 0, error_class: null };
  return { outcome: "ok", result_count: count, error_class: null };
}

function classifyStory(data: Record<string, unknown>): Classified {
  if (data.status === "not opted in") {
    return { outcome: "unmatched", result_count: 0, error_class: null, story_status: "not_opted_in" };
  }
  if (data.status === "not available") {
    return { outcome: "empty", result_count: 0, error_class: null, story_status: "not_available" };
  }
  if (data.status === "story") {
    const claims = arrayCount(data.claims);
    const count = claims ?? 1;
    return {
      outcome: count === 0 ? "empty" : "ok",
      result_count: count,
      error_class: null,
      story_status: "story",
    };
  }
  return { outcome: "ok", result_count: null, error_class: null };
}

function classifyLegacy(data: Record<string, unknown>): Classified {
  const profiles = arrayCount(data.profiles) ?? 0;
  const fleets = arrayCount(data.fleets) ?? 0;
  const activity = data.activity && typeof data.activity === "object" ? 1 : 0;
  if (profiles === 0 && fleets === 0 && activity === 0) {
    return { outcome: "unmatched", result_count: 0, error_class: null };
  }
  return { outcome: "ok", result_count: profiles + fleets + activity, error_class: null };
}

function classifyOverview(data: Record<string, unknown>): Classified {
  if (!Array.isArray(data.sections)) return { outcome: "ok", result_count: null, error_class: null };
  if (data.sections.length === 0) return { outcome: "empty", result_count: 0, error_class: null };
  let ok = 0;
  for (const section of data.sections) {
    if (section && typeof section === "object" && (section as { ok?: unknown }).ok === true) ok += 1;
  }
  if (ok === 0) return { outcome: "error", result_count: 0, error_class: "upstream" };
  return { outcome: "ok", result_count: ok, error_class: null };
}

function sizeCap(): Classified {
  return { outcome: "invalid_args", result_count: null, error_class: "invalid_args" };
}

function fromStatus(status: number): Classified {
  if (status === 429) return { outcome: "error", result_count: null, error_class: "rate_limited" };
  if (status === 504) return { outcome: "error", result_count: null, error_class: "timeout" };
  if (status === 413) return sizeCap();
  return { outcome: "error", result_count: null, error_class: status >= 500 ? "upstream" : "internal" };
}

function structuredData(result: Record<string, unknown>): Record<string, unknown> {
  const structured = result.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    return structured as Record<string, unknown>;
  }
  const text = textContent(result.content).trim();
  if (!text.startsWith("{")) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
  return {};
}

function textContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const value = (item as { text?: unknown }).text;
    if (typeof value !== "string") continue;
    text += value;
    if (text.length >= 500) return text.slice(0, 500);
  }
  return text;
}

function arrayCount(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function numberCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_RESULT_COUNT ? value : null;
}

function sanitizeCount(value: number | null): number | null {
  if (value === null || !Number.isInteger(value) || value < 0 || value > MAX_RESULT_COUNT) return null;
  return value;
}

function enumValue(value: unknown, allowed: ReadonlySet<string>): string | null {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

function rpcMessages(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") return [payload];
  return [];
}

function messageFor(payload: unknown, id: unknown, only: boolean): unknown {
  const messages = rpcMessages(payload);
  if (only && messages.length === 1) return messages[0];
  const key = idKey(id);
  return (
    messages.find((message) => {
      if (!message || typeof message !== "object") return false;
      return idKey((message as { id?: unknown }).id) === key;
    }) ?? null
  );
}

function idKey(id: unknown): string {
  if (typeof id === "string" || typeof id === "number") return `${typeof id}:${id}`;
  if (id === null) return "null";
  return "other";
}

function parseRpcBody(body: Uint8Array): unknown {
  const text = new TextDecoder().decode(body).trim();
  if (!text) return null;
  if (text.startsWith("{") || text.startsWith("[")) return JSON.parse(text) as unknown;
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0 && line !== "[DONE]");
  const last = data[data.length - 1];
  return last ? (JSON.parse(last) as unknown) : null;
}

function sinkUrl(value: string | undefined): string | null {
  const raw = value?.trim() ?? "";
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  if (parsed.protocol === "https:") return parsed.toString();
  if (parsed.protocol === "http:" && isTelemetryLoopbackHost(parsed.hostname)) return parsed.toString();
  return null;
}

/** Node reports `[::1]` today. Some URL implementations report `::1`. Both are loopback. */
export function isTelemetryLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function sinkKey(value: string | undefined): string | null {
  const raw = value?.trim() ?? "";
  if (!raw || raw.length > MAX_KEY_LENGTH || /[\r\n]/.test(raw)) return null;
  return raw;
}

function coarseEnv(env: NodeJS.ProcessEnv): string {
  const explicit = env.MCP_TELEMETRY_ENV?.trim().toLowerCase() ?? "";
  if (ENV_PATTERN.test(explicit)) return explicit;
  const vercel = env.VERCEL_ENV?.trim().toLowerCase() ?? "";
  if (vercel === "production" || vercel === "preview" || vercel === "development") return vercel;
  return "local";
}

function timeoutMs(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, parsed));
}

function restTable(url: string): boolean {
  try {
    return new URL(url).pathname.includes("/rest/v1/");
  } catch {
    return false;
  }
}
