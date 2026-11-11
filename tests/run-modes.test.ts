import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { READ_ONLY_TOOLS } from "../src/server.js";
import { SERVER_NAME } from "../src/version.js";

const children: ChildProcess[] = [];

function track(child: ChildProcess): ChildProcess {
  children.push(child);
  return child;
}

beforeAll(async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], {
    cwd: process.cwd(),
  });
}, 60_000);

afterEach(() => {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  children.length = 0;
});

function once(child: ChildProcess, stream: "stdout" | "stderr"): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const source = child[stream];
    source?.setEncoding("utf8");
    source?.on("data", (chunk: string) => {
      text += chunk;
      if (text.includes("listening on")) resolve(text);
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`exited ${code} before listening: ${text}`)));
  });
}

function request(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: options.method ?? "GET", headers: options.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return { ...env, ...extra };
}

async function connectStdio(args: string[], extra: Record<string, string>): Promise<{ client: Client; stderr: { text: string } }> {
  const stderr = { text: "" };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    cwd: process.cwd(),
    stderr: "pipe",
    env: childEnv(extra),
  });
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderr.text += chunk.toString();
  });
  const client = new Client({ name: "run-mode-test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(transport);
  return { client, stderr };
}

describe("run mode boot", () => {
  it("boots the plain Node HTTP server from a config file", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "node-http-"));
    const file = path.join(root, "node.config.json");
    writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        host: "127.0.0.1",
        port: 0,
        publicNode: true,
        allowAnyHost: true,
        trustProxy: true,
        rateLimitMax: 1,
        rateLimitWindowMs: 60000,
        maxRequestBytes: 64,
        hub: { signersPath: "hub/signers.json" },
      }),
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_CONFIG: file,
      SOLANA_RPC_URL: "https://rpc.example/path?api-key=supersecret",
    };
    delete env.PORT;
    delete env.HOST;
    delete env.PUBLIC_NODE;
    delete env.TRUST_PROXY;
    const child = track(spawn(process.execPath, ["dist/http.js"], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }));
    const logged = await once(child, "stderr");
    expect(logged).toMatch(/listening on http:\/\/127\.0\.0\.1:\d+\/mcp/);
    expect(logged).toMatch(/Host and Origin checks are off/);
    expect(logged).not.toMatch(/supersecret|api-key/);
    const url = logged.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    expect(url).toBeTruthy();
    const headers = (forwarded: string): Record<string, string> => ({ host: "node.example", "x-forwarded-for": forwarded });
    const health = await request(`${url}/`, { headers: headers("203.0.113.10") });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ name: SERVER_NAME, readOnly: true, writes: false, mcp: "/mcp" });
    const limited = await request(`${url}/`, { headers: headers("203.0.113.10") });
    expect(limited.status).toBe(429);
    const other = await request(`${url}/`, { headers: headers("203.0.113.11") });
    expect(other.status).toBe(200);
    const missing = await request(`${url}/submit`, { method: "POST", headers: headers("203.0.113.13"), body: "{}" });
    expect(missing.status).toBe(404);
    const oversized = await request(`${url}/mcp`, {
      method: "POST",
      headers: {
        ...headers("203.0.113.12"),
        "content-type": "application/json",
        "content-length": "128",
      },
      body: "x".repeat(128),
    });
    expect(oversized.status).toBe(413);
    expect(oversized.body).not.toMatch(/supersecret/);
  });

  it("boots stdio and the npx bin with the same 24 read-only tools", async () => {
    const env = { SOLANA_RPC_URL: "https://rpc.example/path?api-key=supersecret" };
    for (const args of [["dist/stdio.js"], ["bin/sa-ecosystem-node.js"]]) {
      const { client, stderr } = await connectStdio(args, env);
      try {
        const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
        expect(names).toEqual([...READ_ONLY_TOOLS].sort());
        expect(names).toHaveLength(24);
        expect(names).not.toContain("submit_hub_update");
        expect(stderr.text).toMatch(/listening on stdio/);
        expect(stderr.text).not.toMatch(/supersecret|api-key/);
      } finally {
        await client.close();
      }
    }
  });

  it("boots the Vercel fetch entry without adding a submit tool", async () => {
    const handler = (await import("../api/mcp.js")).default;
    const response = await handler.fetch(new Request("https://example.com/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "boot", version: "0" },
        },
      }),
    }));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain(SERVER_NAME);
    expect(text).not.toContain("submit_hub_update");
    expect(loadConfig({}).publicNode).toBe(false);
    expect(loadConfig({}).hubSignerSets[0]?.path).toMatch(/hub\/signers\.json$/);
  });
});
