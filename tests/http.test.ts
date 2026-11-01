import http from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { startHttpServer } from "../src/http.js";
import type { NodeDeps } from "../src/server.js";
import { stubDaoReaders, stubPlayerLegacy } from "./dao-stubs.js";

const deps: NodeDeps = {
  ...stubDaoReaders(),
  ...stubPlayerLegacy(),
  async listStarSystems() {
    return { total: 0, systems: [] };
  },
  async getFleet() {
    return [];
  },
  async auditProfile(profileAddress) {
    return {
      profileAddress,
      keyThreshold: 0,
      authKeyCount: 0,
      keyCount: 0,
      riskyKeyCount: 0,
      keys: [],
    };
  },
};

async function request(
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: body === undefined ? "GET" : "POST", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (!closeServer) return;
  await closeServer();
  closeServer = undefined;
});

describe("local http server", () => {
  it("answers a read-only health check, then the placeholder limiter", async () => {
    const started = await startHttpServer({
      config: loadConfig({ HOST: "127.0.0.1", PORT: "0", RATE_LIMIT_MAX: "1", RATE_LIMIT_WINDOW_MS: "60000" }),
      deps,
    });
    closeServer = started.close;

    const first = await request(`${started.url}/`);
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toMatchObject({ name: "sa-ecosystem-node", readOnly: true, mcp: "/mcp" });

    const second = await request(`${started.url}/`);
    expect(second.status).toBe(429);
    expect(JSON.parse(second.body)).toMatchObject({ error: "rate_limited", placeholder: true });
  });

  it("refuses an MCP response that exceeds the size cap", async () => {
    const marker = "x".repeat(4_000);
    const started = await startHttpServer({
      config: loadConfig({
        HOST: "127.0.0.1",
        PORT: "0",
        MAX_RESPONSE_BYTES: "512",
      }),
      deps: {
        ...deps,
        async listStarSystems() {
          return {
            total: 1,
            systems: [
              {
                address: "Sys111",
                name: marker,
                systemId: 1,
                coordinates: { x: 0, y: 0 },
                regionId: null,
                starbase: null,
                connectionCount: 0,
                celestialBodyCount: 0,
              },
            ],
          };
        },
      },
    });
    closeServer = started.close;

    const headers = {
      host: "127.0.0.1",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const init = await request(
      `${started.url}/mcp`,
      headers,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "cap-test", version: "0" },
        },
      }),
    );
    expect(init.status).toBe(200);
    expect(init.body).not.toContain(marker);

    const called = await request(
      `${started.url}/mcp`,
      headers,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_star_systems", arguments: {} },
      }),
    );
    expect(called.status).toBe(413);
    expect(called.body).toMatch(/response exceeded the size cap/);
    expect(called.body).not.toContain(marker);
  });

  it("refuses an open public host list unless ALLOW_ANY_HOST is set", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      await expect(
        startHttpServer({
          config: loadConfig({ HOST: "127.0.0.1", PORT: "0", PUBLIC_NODE: "1" }),
          deps,
        }),
      ).rejects.toThrow(/PUBLIC_NODE=1 and allowedHosts is empty or '\*'/);
      await expect(
        startHttpServer({
          config: loadConfig({ HOST: "127.0.0.1", PORT: "0", PUBLIC_NODE: "1", ALLOWED_HOSTS: "*" }),
          deps,
        }),
      ).rejects.toThrow(/Refusing to start/);
      expect(errors.join("\n")).not.toMatch(/Host and Origin checks are off/);

      errors.length = 0;
      const open = await startHttpServer({
        config: loadConfig({ HOST: "127.0.0.1", PORT: "0", PUBLIC_NODE: "1", ALLOW_ANY_HOST: "1" }),
        deps,
      });
      closeServer = open.close;
      expect(errors.join("\n")).toMatch(/warning: PUBLIC_NODE=1 and allowedHosts is empty or '\*'/);
      expect(errors.join("\n")).toMatch(/Host and Origin checks are off/);
      const foreign = await request(`${open.url}/`, { host: "evil.example" });
      expect(foreign.status).toBe(200);
      await open.close();
      closeServer = undefined;

      errors.length = 0;
      const starred = await startHttpServer({
        config: loadConfig({
          HOST: "127.0.0.1",
          PORT: "0",
          PUBLIC_NODE: "1",
          ALLOWED_HOSTS: "*",
          ALLOW_ANY_HOST: "1",
        }),
        deps,
      });
      closeServer = starred.close;
      expect(errors.join("\n")).toMatch(/Host and Origin checks are off/);
      const starredForeign = await request(`${starred.url}/`, { host: "evil.example" });
      expect(starredForeign.status).toBe(200);
      await starred.close();
      closeServer = undefined;

      errors.length = 0;
      const named = await startHttpServer({
        config: loadConfig({
          HOST: "127.0.0.1",
          PORT: "0",
          PUBLIC_NODE: "1",
          ALLOWED_HOSTS: "node.example",
          ALLOW_ANY_HOST: "1",
        }),
        deps,
      });
      closeServer = named.close;
      expect(errors.join("\n")).not.toMatch(/Host and Origin checks are off/);
      const blocked = await request(`${named.url}/`, { host: "evil.example" });
      expect(blocked.status).toBe(403);
      const blockedOrigin = await request(`${named.url}/`, {
        host: "node.example",
        origin: "https://evil.example",
      });
      expect(blockedOrigin.status).toBe(403);
      const allowed = await request(`${named.url}/`, {
        host: "node.example",
        origin: "https://node.example",
      });
      expect(allowed.status).toBe(200);
      await named.close();
      closeServer = undefined;

      errors.length = 0;
      const local = await startHttpServer({
        config: loadConfig({ HOST: "127.0.0.1", PORT: "0" }),
        deps,
      });
      closeServer = local.close;
      expect(errors.join("\n")).not.toMatch(/Host and Origin checks are off/);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects a non-loopback Host header", async () => {
    const started = await startHttpServer({
      config: loadConfig({ HOST: "127.0.0.1", PORT: "0" }),
      deps,
    });
    closeServer = started.close;
    const blocked = await request(`${started.url}/`, { host: "evil.example" });
    expect(blocked.status).toBe(403);
  });
});
