import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createDaoReaders } from "../src/dao/readers.js";
import { createNodeHandler, type NodeHandler } from "../src/handler.js";
import { auditProfileKeys } from "../src/profile/audit.js";
import { createPublicMcpFetch, jsonRpcError } from "../src/public-mcp.js";
import { createRateLimiter } from "../src/rate-limit.js";
import { READ_ONLY_TOOLS, type NodeDeps } from "../src/server.js";
import { stubPlayerLegacy } from "./dao-stubs.js";
import { PIP23_ID } from "../src/dao/wallets.js";

const PROPOSAL = {
  id: PIP23_ID,
  pipNumber: 23,
  title: "PIP-23",
  brief: "",
  categories: [],
  status: "Voting_Complete_Measure_Passes",
  authorPublicKey: "author",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  votingStartsAt: "2026-01-01T00:00:00.000Z",
  votingEndsAt: "2026-01-02T00:00:00.000Z",
  voteOptionsMaxChoices: 1,
  voteWinners: 1,
  voteData: null,
};

const rpcMethods: string[] = [];

const mockFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init?.method ?? (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET")).toUpperCase();
  if (method === "POST") {
    const payload = JSON.parse(String(init?.body ?? "{}")) as { id?: number; method?: string; params?: unknown[] } | { id?: number; method?: string; params?: unknown[] }[];
    const reply = (item: { id?: number; method?: string; params?: unknown[] }) => {
      rpcMethods.push(item.method ?? "");
      if (item.method === "getMultipleAccounts") {
        const addresses = (item.params?.[0] as unknown[]) ?? [];
        return { jsonrpc: "2.0", id: item.id ?? 1, result: { value: addresses.map(() => null) } };
      }
      if (item.method === "getBalance") return { jsonrpc: "2.0", id: item.id ?? 1, result: { value: 0 } };
      if (item.method === "getAccountInfo" || item.method === "getTokenAccountsByOwner") {
        return { jsonrpc: "2.0", id: item.id ?? 1, result: { value: item.method === "getTokenAccountsByOwner" ? [] : null } };
      }
      return { jsonrpc: "2.0", id: item.id ?? 1, error: { message: "method not in the mock" } };
    };
    const body = Array.isArray(payload) ? payload.map(reply) : reply(payload);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.endsWith("/proposals")) return json(Array(1).fill(PROPOSAL));
  if (url.includes("/proposals/votes/")) {
    return json([
      {
        id: "vote-1",
        proposalId: PIP23_ID,
        walletPublicKey: "voter",
        voteResult: "For",
        votingPower: "1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  }
  if (url.endsWith("/dao/treasury")) {
    return json([
      { segmentation: "Game Activity", recorded_period: "2023-05-01", mint: "ATLAS", amount: "1", usdc_value: "1" },
    ]);
  }
  if (url.includes("docs.google.com")) return new Response("PIP Name,PIP\nPIP-23,23\n", { status: 200 });
  return new Response("not in the mock", { status: 404 });
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function deps(): NodeDeps {
  const config = loadConfig({
    TREASURY_CACHE_PATH: path.join(tmpdir(), "missing-public-mcp-cache.json"),
  });
  return {
    ...createDaoReaders(config, mockFetch, () => new Date("2026-10-24T00:00:00.000Z")),
    async listStarSystems(limit) {
      return { total: 1, systems: [{ address: "Sys111", name: "One", systemId: 1, coordinates: { x: 0, y: 0 }, regionId: null, starbase: null, connectionCount: 0, celestialBodyCount: 0 }].slice(0, limit) };
    },
    async getFleet(query) {
      if (!query.fleetAddress && !query.profileAddress) throw new Error("missing address");
      return [{ address: query.fleetAddress ?? "Fleet111", name: "Ravager", ownerProfile: query.profileAddress ?? "Profile111", stateKind: "idle", state: { kind: "idle" }, ships: [] }];
    },
    async auditProfile(profileAddress) {
      return auditProfileKeys({
        profileAddress,
        keyThreshold: 1,
        authKeyCount: 1,
        keys: [{ address: "Key111", scope: profileAddress, expiresAtRaw: -1n, permissionsRaw: 1n, permissions: ["authenticate"] }],
      });
    },
    ...stubPlayerLegacy(),
  };
}

const CACHE_ERROR_TOOLS = new Set(["dao_treasury_flows", "dao_payments"]);
const CACHE_EMPTY_TOOLS = new Set(["treasury_history", "ecofund_limit"]);

function argumentsFor(name: string): Record<string, unknown> {
  if (name === "list_star_systems" || name === "list_proposals") return { limit: 1 };
  if (name === "get_fleet") return { fleetAddress: "Fleet111" };
  if (name === "profile_key_audit") return { profileAddress: "Profile111" };
  if (name === "get_proposal_votes") return { proposalId: PIP23_ID };
  if (name === "player_legacy" || name === "player_story") return { address: "11111111111111111111111111111111" };
  if (name === "search_hub") return { query: "dock" };
  return {};
}

let open: { client: Client; handler: NodeHandler } | undefined;

afterEach(async () => {
  if (!open) return;
  await open.client.close();
  await open.handler.close();
  open = undefined;
});

async function connect(): Promise<Client> {
  const config = loadConfig({});
  const handler = createNodeHandler(deps(), config, createRateLimiter({ limit: 100, windowMs: 60_000 }));
  const fetchMcp = createPublicMcpFetch(handler);
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1/api/mcp"), {
    fetch: (input, init) => fetchMcp(new Request(input, init)),
  });
  const client = new Client({ name: "public-mcp-test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(transport);
  open = { client, handler };
  return client;
}

function toolText(result: { content?: { type: string; text?: string }[] }): string {
  return (result.content ?? []).map((item) => item.text ?? "").join("\n");
}

describe("public MCP endpoint", () => {
  it("calls every read-only tool through the HTTP handler against the mocked RPC", async () => {
    const client = await connect();
    const listed = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(listed).toEqual([...READ_ONLY_TOOLS].sort());
    for (const name of READ_ONLY_TOOLS) {
      const result = await client.callTool({ name, arguments: argumentsFor(name) });
      const text = toolText(result);
      expect(text).not.toMatch(/api-key|secretKey|privateKey|\n\s*at\s+/);
      if (CACHE_ERROR_TOOLS.has(name)) {
        expect(result.isError).toBe(true);
        expect(text).toMatch(/refresh-treasury|not available|not invent/i);
      } else if (CACHE_EMPTY_TOOLS.has(name)) {
        expect(result.isError, text).toBeFalsy();
        expect(text).toMatch(/not yet populated/);
        expect(text).not.toMatch(/amountRaw/);
      } else {
        expect(result.isError, text).toBeFalsy();
      }
    }
    expect(rpcMethods).toContain("getMultipleAccounts");
    expect(rpcMethods.every((method) => method.startsWith("get"))).toBe(true);
  });

  it("rejects an invalid tool input without a stack", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "list_proposals", arguments: { limit: 0 } });
    expect(result.isError).toBe(true);
    expect(toolText(result)).not.toMatch(/\n\s*at\s+/);
  });

  it("answers CORS, caps the body, times out, and rate limits", async () => {
    const preflight = await createPublicMcpFetch({
      async fetch() {
        return new Response("ok");
      },
      async close() {},
    })(new Request("http://127.0.0.1/api/mcp", { method: "OPTIONS" }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");

    const capped = await createPublicMcpFetch(
      {
        async fetch() {
          return new Response("x".repeat(64));
        },
        async close() {},
      },
      { maxBytes: 8 },
    )(new Request("http://127.0.0.1/api/mcp", { method: "POST" }));
    expect(capped.status).toBe(413);
    expect(await capped.text()).toMatch(/size cap/);
    expect(capped.headers.get("access-control-allow-origin")).toBe("*");

    let requestSeen = false;
    const tooLarge = await createPublicMcpFetch(
      {
        async fetch() {
          requestSeen = true;
          return new Response("ok");
        },
        async close() {},
      },
      { maxRequestBytes: 16 },
    )(new Request("http://127.0.0.1/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "64" },
      body: "x".repeat(64),
    }));
    expect(requestSeen).toBe(false);
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.text()).toMatch(/The request exceeded the size cap/);
    expect(tooLarge.headers.get("access-control-allow-origin")).toBe("*");

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("0123456789abcdef"));
        controller.enqueue(encoder.encode("0123456789abcdef"));
        controller.close();
      },
    });
    const streamed = await createPublicMcpFetch(
      {
        async fetch() {
          requestSeen = true;
          return new Response("ok");
        },
        async close() {},
      },
      { maxRequestBytes: 16 },
    )(new Request("http://127.0.0.1/api/mcp", { method: "POST", body: stream, duplex: "half" }));
    expect(requestSeen).toBe(false);
    expect(streamed.status).toBe(413);

    let echoed = "";
    const accepted = await createPublicMcpFetch(
      {
        async fetch(incoming) {
          echoed = await incoming.text();
          return new Response("ok");
        },
        async close() {},
      },
      { maxRequestBytes: 32 },
    )(new Request("http://127.0.0.1/api/mcp", { method: "POST", body: "hello" }));
    expect(accepted.status).toBe(200);
    expect(echoed).toBe("hello");

    const timed = await createPublicMcpFetch(
      {
        fetch: () => new Promise<Response>((resolve) => { setTimeout(() => resolve(new Response("late")), 500); }),
        async close() {},
      },
      { timeoutMs: 20 },
    )(new Request("http://127.0.0.1/api/mcp", { method: "POST" }));
    expect(timed.status).toBe(504);
    expect(await timed.text()).toMatch(/timed out/);

    const limited = createNodeHandler(
      deps(),
      loadConfig({ TRUST_PROXY: "1" }),
      createRateLimiter({ limit: 1, windowMs: 60_000 }),
    );
    const fetchLimited = createPublicMcpFetch(limited);
    const first = await fetchLimited(new Request("http://127.0.0.1/api/mcp", { method: "POST", headers: { "x-forwarded-for": "203.0.113.5" }, body: "{}" }));
    const second = await fetchLimited(new Request("http://127.0.0.1/api/mcp", { method: "POST", headers: { "x-forwarded-for": "203.0.113.5" }, body: "{}" }));
    const otherAddress = await fetchLimited(new Request("http://127.0.0.1/api/mcp", { method: "POST", headers: { "x-forwarded-for": "203.0.113.6" }, body: "{}" }));
    expect(first.status).not.toBe(429);
    expect(second.status).toBe(429);
    expect(otherAddress.status).not.toBe(429);
    expect(second.headers.get("access-control-allow-origin")).toBe("*");
    await limited.close();

    const untrusted = createNodeHandler(deps(), loadConfig({}), createRateLimiter({ limit: 1, windowMs: 60_000 }));
    const fetchUntrusted = createPublicMcpFetch(untrusted);
    const spoofed = await fetchUntrusted(new Request("http://127.0.0.1/api/mcp", { method: "POST", headers: { "x-forwarded-for": "203.0.113.7" }, body: "{}" }));
    const spoofedAgain = await fetchUntrusted(new Request("http://127.0.0.1/api/mcp", { method: "POST", headers: { "x-forwarded-for": "198.51.100.8" }, body: "{}" }));
    expect(spoofed.status).not.toBe(429);
    expect(spoofedAgain.status).toBe(429);
    await untrusted.close();
  });

  it("hides upstream URLs and stack frames", async () => {
    const response = await createPublicMcpFetch({
      async fetch() {
        throw new Error("upstream failed https://rpc.example/path?api-key=secret\n    at secret.ts:1:1");
      },
      async close() {},
    })(new Request("http://127.0.0.1/api/mcp", { method: "POST" }));
    const text = await response.text();
    expect(text).toContain("[rpc]");
    expect(text).not.toContain("api-key");
    expect(text).not.toContain("secret.ts");
    expect(jsonRpcError("x").status).toBe(500);
  });
});
