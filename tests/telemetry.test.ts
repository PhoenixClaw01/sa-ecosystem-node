import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { LISTING_STATUSES, LISTING_STREAMS } from "../src/hub/listing.js";
import { HUB_UPDATE_KINDS } from "../src/hub/update.js";
import type { NodeHandler } from "../src/handler.js";
import { createPublicMcpFetch } from "../src/public-mcp.js";
import { ECOSYSTEM_CATEGORIES } from "../src/stubs/hub-update.js";
import { READ_ONLY_TOOLS } from "../src/tool-names.js";
import { argumentMeta, clientFamily, createToolTelemetry, TELEMETRY_FIELDS, TELEMETRY_META_FIELDS, type ToolTelemetry } from "../src/telemetry.js";

const WALLET = "LeakWallet1111111111111111111111111111111";
const QUERY = "unique-search-phrase-qq";
const IP = "203.0.113.44";
const UA_TOKEN = "leak-ua-token";
const IDENTITY = "guild:leak-identity-name";
const PROFILE = "LeakProfile11111111111111111111111111111";
const FLEET = "LeakFleet11111111111111111111111111111111";
const PROPOSAL = "leak-proposal-uuid";
const ERROR_TOKEN = "leak-error-detail";
const SECRETS = [WALLET, QUERY, IP, UA_TOKEN, IDENTITY, PROFILE, FLEET, PROPOSAL, ERROR_TOKEN];

const savedEnv = {
  url: process.env.MCP_TELEMETRY_URL,
  key: process.env.MCP_TELEMETRY_KEY,
  env: process.env.MCP_TELEMETRY_ENV,
  timeout: process.env.MCP_TELEMETRY_TIMEOUT_MS,
};

afterEach(() => {
  restore("MCP_TELEMETRY_URL", savedEnv.url);
  restore("MCP_TELEMETRY_KEY", savedEnv.key);
  restore("MCP_TELEMETRY_ENV", savedEnv.env);
  restore("MCP_TELEMETRY_TIMEOUT_MS", savedEnv.timeout);
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function clearTelemetryEnv() {
  delete process.env.MCP_TELEMETRY_URL;
  delete process.env.MCP_TELEMETRY_KEY;
  delete process.env.MCP_TELEMETRY_ENV;
  delete process.env.MCP_TELEMETRY_TIMEOUT_MS;
}

function handler(reply: (body: Record<string, unknown>) => unknown): NodeHandler {
  return {
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      return new Response(JSON.stringify(reply(body)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async close() {},
  };
}

function okResult(id: unknown, data: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data,
    },
  };
}

function errorResult(id: unknown, message: string) {
  return {
    jsonrpc: "2.0",
    id,
    result: { isError: true, content: [{ type: "text", text: message }] },
  };
}

interface Captured {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function collectingTelemetry(options?: { hangMs?: number; throwSync?: boolean; rest?: boolean; timeoutMs?: string }) {
  const sent: Captured[] = [];
  let aborted = false;
  const telemetry = createToolTelemetry({
    env: {
      MCP_TELEMETRY_URL: options?.rest
        ? "https://telemetry.example/rest/v1/mcp_tool_calls"
        : "https://telemetry.example/mcp-tool-calls",
      MCP_TELEMETRY_KEY: "telemetry-key",
      MCP_TELEMETRY_ENV: "test",
      MCP_TELEMETRY_TIMEOUT_MS: options?.timeoutMs ?? "1500",
    },
    fetch: (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers });
      if (options?.throwSync) throw new Error(`sink down ${ERROR_TOKEN}`);
      if (options?.hangMs) {
        return new Promise((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("hung")), options.hangMs);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            aborted = true;
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        });
      }
      return Promise.resolve(new Response(null, { status: 201 }));
    },
  });
  return { telemetry, sent, aborted: () => aborted };
}

async function call(
  telemetry: ToolTelemetry | null,
  body: unknown,
  headers?: Record<string, string>,
  reply?: (request: Record<string, unknown>) => unknown,
) {
  const fetchMcp = createPublicMcpFetch(
    handler((request) => (reply ? reply(request) : okResult(request.id, { categories: ["ip_and_business"] }))),
    { telemetry },
  );
  return fetchMcp(
    new Request("http://127.0.0.1/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function toolCall(name: string, args: Record<string, unknown>, id = 1) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

describe("telemetry configuration", () => {
  it("stays disabled and does not call fetch when the sink URL is unset", async () => {
    clearTelemetryEnv();
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      throw new Error("network");
    }) as typeof fetch;
    try {
      const disabled = createToolTelemetry();
      expect(disabled.enabled).toBe(false);
      const response = await call(null, toolCall("search_hub", { query: QUERY, address: WALLET }), {
        "user-agent": `SomeClient/1 ${UA_TOKEN}`,
        "x-forwarded-for": IP,
        "cf-connecting-ip": IP,
      });
      expect(response.status).toBe(200);
      expect(calls).toEqual([]);
      const fromEnv = createPublicMcpFetch(handler(() => okResult(1, { results: [] })));
      const second = await fromEnv(
        new Request("http://127.0.0.1/api/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": IP },
          body: JSON.stringify(toolCall("search_hub", { query: QUERY })),
        }),
      );
      expect(second.status).toBe(200);
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects a non-local http URL, a URL with a password, and a newline in the key", () => {
    const fetchImpl = (() => {
      throw new Error("network");
    }) as typeof fetch;
    expect(createToolTelemetry({ env: { MCP_TELEMETRY_URL: "http://telemetry.example/hook" }, fetch: fetchImpl }).enabled).toBe(false);
    expect(createToolTelemetry({ env: { MCP_TELEMETRY_URL: "https://user:secret@telemetry.example/hook" }, fetch: fetchImpl }).enabled).toBe(false);
    expect(createToolTelemetry({ env: {}, fetch: fetchImpl }).enabled).toBe(false);
    const local = createToolTelemetry({
      env: { MCP_TELEMETRY_URL: "http://127.0.0.1:9/hook", MCP_TELEMETRY_KEY: "bad\nkey" },
      fetch: fetchImpl,
    });
    expect(local.enabled).toBe(true);
  });
});

describe("safe argument metadata", () => {
  it("keeps fixed enums and drops free text, wallets, and unknown strings", () => {
    for (const stream of LISTING_STREAMS) expect(argumentMeta("list_listings", { stream }).stream).toBe(stream);
    for (const category of ECOSYSTEM_CATEGORIES) expect(argumentMeta("list_listings", { category }).category).toBe(category);
    for (const status of LISTING_STATUSES) expect(argumentMeta("list_listings", { status }).status).toBe(status);
    for (const kind of HUB_UPDATE_KINDS) expect(argumentMeta("hub_updates", { kind }).kind).toBe(kind);
    expect(argumentMeta("list_c4_markers", { kind: "all" }).kind).toBe("all");
    expect(argumentMeta("dao_payments", { direction: "out", mint: "ATLAS", wallet: "dao_treasury" })).toMatchObject({
      direction: "out",
      mint: "ATLAS",
      wallet_role: "dao_treasury",
    });
    expect(argumentMeta("dao_payments", { wallet: "ecosystem_fund" }).wallet_role).toBe("ecosystem_fund");
    expect(argumentMeta("treasury_history", { granularity: "day" }).granularity).toBe("day");
    expect(argumentMeta("list_listings", { includeExpired: true }).include_expired).toBe(true);
    expect(argumentMeta("list_c4_markers", { anchored: false }).anchored).toBe(false);

    const dropped = argumentMeta("search_hub", {
      query: QUERY,
      stream: "not-a-stream",
      status: "Voting_Complete_Measure_Passes",
      wallet: WALLET,
      address: PROFILE,
      identity: IDENTITY,
      includeExpired: "true",
      kind: "secret-kind",
    });
    expect(dropped).toEqual({});
    expect(JSON.stringify(dropped)).not.toContain(QUERY);
    expect(JSON.stringify(dropped)).not.toContain(WALLET);
  });

  it("maps the user agent to a coarse family and does not keep the raw string", () => {
    expect(clientFamily(`Cursor/2.4 ${UA_TOKEN}`)).toBe("cursor");
    expect(clientFamily("claude-cli/1.0")).toBe("claude");
    expect(clientFamily("Visual Studio Code/1.90")).toBe("vscode");
    expect(clientFamily("ChatGPT-User/1.0")).toBe("chatgpt");
    expect(clientFamily(`Mozilla/5.0 ${UA_TOKEN}`)).toBe("browser");
    expect(clientFamily("node")).toBe("node");
    expect(clientFamily(null)).toBe("unknown");
    expect(clientFamily(`Cursor/2.4 ${UA_TOKEN}`)).not.toContain(UA_TOKEN);
  });
});

describe("public MCP telemetry", () => {
  it("emits ok, empty, unmatched, invalid_args, and error", async () => {
    const { telemetry, sent } = collectingTelemetry();
    const cases: { name: string; args: Record<string, unknown>; result: unknown; outcome: string; count: number | null; error: string | null }[] = [
      {
        name: "list_categories",
        args: {},
        result: okResult(1, { categories: [{ id: "creators", note: WALLET }] }),
        outcome: "ok",
        count: 1,
        error: null,
      },
      {
        name: "search_hub",
        args: { query: QUERY },
        result: okResult(2, { results: [] }),
        outcome: "empty",
        count: 0,
        error: null,
      },
      {
        name: "get_fleet",
        args: { fleetAddress: FLEET },
        result: okResult(3, { fleets: [] }),
        outcome: "unmatched",
        count: 0,
        error: null,
      },
      {
        name: "list_proposals",
        args: { limit: 0 },
        result: errorResult(4, `limit must be from 1 to 100. ${ERROR_TOKEN}`),
        outcome: "invalid_args",
        count: null,
        error: "invalid_args",
      },
      {
        name: "treasury_balances",
        args: {},
        result: errorResult(5, `Request failed ${ERROR_TOKEN}`),
        outcome: "error",
        count: null,
        error: "upstream",
      },
    ];
    for (const item of cases) {
      const response = await call(telemetry, toolCall(item.name, item.args, cases.indexOf(item) + 1), undefined, () => item.result);
      expect(response.status).toBe(200);
    }
    await telemetry.settled();
    expect(sent.map((item) => item.body.outcome)).toEqual(["ok", "empty", "unmatched", "invalid_args", "error"]);
    expect(sent.map((item) => item.body.tool)).toEqual(cases.map((item) => item.name));
    expect(sent.map((item) => item.body.result_count)).toEqual(cases.map((item) => item.count));
    expect(sent.map((item) => item.body.error_class)).toEqual(cases.map((item) => item.error));
    const allowed = new Set<string>([...TELEMETRY_FIELDS, ...TELEMETRY_META_FIELDS]);
    for (const item of sent) {
      expect(item.body.env).toBe("test");
      expect(item.body.client_family).toBe("unknown");
      expect(item.body.called_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(item.body.latency_ms).toEqual(expect.any(Number));
      for (const key of Object.keys(item.body)) expect(allowed.has(key)).toBe(true);
      const encoded = JSON.stringify(item.body);
      for (const secret of SECRETS) expect(encoded).not.toContain(secret);
    }
  });

  it("strips wallets, search text, and IP addresses from the sink body", async () => {
    const { telemetry, sent } = collectingTelemetry();
    const response = await call(
      telemetry,
      toolCall("search_hub", {
        query: QUERY,
        address: WALLET,
        profileAddress: PROFILE,
        fleetAddress: FLEET,
        identity: IDENTITY,
        proposalId: PROPOSAL,
        wallet: WALLET,
      }),
      {
        "user-agent": `SomeClient/9 ${UA_TOKEN}`,
        "x-forwarded-for": IP,
        "cf-connecting-ip": IP,
      },
      (request) => {
        const id = request.id;
        return okResult(id, {
          results: [],
          queried: { address: WALLET },
          note: `${QUERY} ${IP} ${IDENTITY}`,
        });
      },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("telemetry.example");
    await telemetry.settled();
    expect(sent).toHaveLength(1);
    const encoded = JSON.stringify(sent[0]);
    for (const secret of SECRETS) expect(encoded).not.toContain(secret);
    expect(sent[0]?.body.tool).toBe("search_hub");
    expect(sent[0]?.body.outcome).toBe("empty");
    expect(sent[0]?.headers.authorization).toBe("Bearer telemetry-key");
    expect(sent[0]?.headers.apikey).toBeUndefined();
    expect(JSON.stringify(sent[0]?.body)).not.toContain("telemetry-key");
  });

  it("does not echo an unknown tool name that contains a wallet", async () => {
    const { telemetry, sent } = collectingTelemetry();
    const response = await call(telemetry, toolCall(WALLET, { query: QUERY }), undefined, (request) =>
      errorResult(request.id, `Invalid tool ${WALLET}`),
    );
    expect(response.status).toBe(200);
    await telemetry.settled();
    expect(sent[0]?.body.tool).toBe("unknown");
    expect(sent[0]?.body.outcome).toBe("invalid_args");
    expect(JSON.stringify(sent[0]?.body)).not.toContain(WALLET);
    expect(JSON.stringify(sent[0]?.body)).not.toContain(QUERY);
  });

  it("records safe enums and story, claim, and player outcomes", async () => {
    const { telemetry, sent } = collectingTelemetry();
    const calls = [
      toolCall("list_listings", { stream: "hybrid", category: "creators", status: "available", includeExpired: true }, 1),
      toolCall("player_story", { address: WALLET }, 2),
      toolCall("claim_status", { identity: IDENTITY }, 3),
      toolCall("claim_status", {}, 4),
      toolCall("player_legacy", { address: WALLET }, 5),
      toolCall("treasury_history", { wallet: "dao_treasury" }, 6),
    ];
    const replies = [
      okResult(1, { listings: [{ owner: WALLET }] }),
      okResult(2, { status: "not opted in", explanation: QUERY }),
      okResult(3, { claims: [] }),
      okResult(4, { claims: [] }),
      okResult(5, { profiles: [], fleets: [], activity: null, queried: { address: WALLET } }),
      okResult(6, { populated: false, note: `not yet populated ${WALLET}` }),
    ];
    for (let index = 0; index < calls.length; index += 1) {
      const response = await call(telemetry, calls[index], { "user-agent": `Cursor/1 ${UA_TOKEN}` }, () => replies[index]);
      expect(response.status).toBe(200);
    }
    await telemetry.settled();
    expect(sent[0]?.body).toMatchObject({
      tool: "list_listings",
      outcome: "ok",
      result_count: 1,
      stream: "hybrid",
      category: "creators",
      status: "available",
      include_expired: true,
      client_family: "cursor",
    });
    expect(sent[1]?.body).toMatchObject({ tool: "player_story", outcome: "unmatched", result_count: 0, story_status: "not_opted_in" });
    expect(sent[2]?.body).toMatchObject({ tool: "claim_status", outcome: "unmatched", result_count: 0 });
    expect(sent[3]?.body).toMatchObject({ tool: "claim_status", outcome: "empty", result_count: 0 });
    expect(sent[4]?.body).toMatchObject({ tool: "player_legacy", outcome: "unmatched", result_count: 0 });
    expect(sent[5]?.body).toMatchObject({ tool: "treasury_history", outcome: "empty", result_count: 0, wallet_role: "dao_treasury" });
    const encoded = JSON.stringify(sent);
    for (const secret of SECRETS) expect(encoded).not.toContain(secret);
  });

  it("does not emit for tools/list", async () => {
    const { telemetry, sent } = collectingTelemetry();
    const response = await call(telemetry, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, undefined, (request) => ({
      jsonrpc: "2.0",
      id: request.id,
      result: { tools: READ_ONLY_TOOLS.map((name) => ({ name })) },
    }));
    expect(response.status).toBe(200);
    await telemetry.settled();
    expect(sent).toEqual([]);
  });

  it("returns the MCP response when the sink throws or times out", async () => {
    const failing = collectingTelemetry({ throwSync: true });
    const started = Date.now();
    const failed = await call(failing.telemetry, toolCall("list_categories", {}), undefined, () => okResult(1, { categories: ["events"] }));
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({ result: { structuredContent: { categories: ["events"] } } });
    await failing.telemetry.settled();
    expect(Date.now() - started).toBeLessThan(500);
    expect(failing.sent[0]?.body.outcome).toBe("ok");

    const hanging = collectingTelemetry({ hangMs: 5_000, timeoutMs: "2000" });
    const t0 = Date.now();
    const hung = await call(hanging.telemetry, toolCall("search_hub", { query: QUERY }), { "x-forwarded-for": IP }, () =>
      okResult(1, { results: [{ name: QUERY }] }),
    );
    const elapsed = Date.now() - t0;
    expect(hung.status).toBe(200);
    expect(elapsed).toBeLessThan(400);
    await hanging.telemetry.settled();
    expect(hanging.aborted()).toBe(true);
    expect(JSON.stringify(hanging.sent[0]?.body)).not.toContain(QUERY);
    expect(JSON.stringify(hanging.sent[0]?.body)).not.toContain(IP);
  });

  it("sends a bearer token and the REST table headers without putting the key in the body", async () => {
    const { telemetry, sent } = collectingTelemetry({ rest: true });
    const response = await call(telemetry, toolCall("list_categories", {}), undefined, () => okResult(1, { categories: ["events"] }));
    expect(response.status).toBe(200);
    await telemetry.settled();
    expect(sent[0]?.url).toBe("https://telemetry.example/rest/v1/mcp_tool_calls");
    expect(sent[0]?.headers.authorization).toBe("Bearer telemetry-key");
    expect(sent[0]?.headers.apikey).toBe("telemetry-key");
    expect(sent[0]?.headers.prefer).toBe("return=minimal");
    expect(JSON.stringify(sent[0]?.body)).not.toContain("telemetry-key");
  });

  it("keeps the handler response when observe and finish throw", async () => {
    const telemetry: ToolTelemetry = {
      enabled: true,
      async observe() {
        throw new Error(`observe ${WALLET}`);
      },
      finish() {
        throw new Error(`finish ${QUERY}`);
      },
      settled: () => Promise.resolve(),
    };
    const response = await call(telemetry, toolCall("list_categories", { query: QUERY }));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(WALLET);
    expect(text).not.toContain("observe");
  });
});

describe("telemetry source", () => {
  it("has no sink host and does not read forwarding headers", () => {
    const source = readFileSync(new URL("../src/telemetry.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/supabase\.co/i);
    expect(source).not.toMatch(/x-forwarded-for/i);
    expect(source).not.toMatch(/cf-connecting-ip/i);
    expect(source).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}/);
    const sql = readFileSync("sql/optional_mcp_tool_calls.sql", "utf8");
    for (const field of [...TELEMETRY_FIELDS, ...TELEMETRY_META_FIELDS]) expect(sql).toContain(field);
    expect(sql.toLowerCase()).toContain("wallet");
    expect(sql.toLowerCase()).toMatch(/off|nothing until/);
  });
});
