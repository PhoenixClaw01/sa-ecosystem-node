import { spawnSync } from "node:child_process";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import nacl from "tweetnacl";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { readHubUpdates } from "../src/dao/hub.js";
import { base58Encode } from "../src/hub/base58.js";
import {
  HUB_APPROVAL_DOMAIN,
  HUB_UPDATE_DOMAIN,
  canonicalHubPayload,
  hubUpdateHash,
  verifyHubUpdates,
  type HubUpdatePayload,
} from "../src/hub/update.js";
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

function request(
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

describe("abuse limits", () => {
  it("refuses an oversize request body and an oversize response", async () => {
    const marker = `OVERSIZE${"x".repeat(180)}`;
    const cappedRequest = await startHttpServer({
      config: loadConfig({
        HOST: "127.0.0.1",
        PORT: "0",
        MAX_REQUEST_BYTES: "64",
        RATE_LIMIT_MAX: "20",
      }),
      deps,
    });
    closeServer = cappedRequest.close;
    const headers = {
      host: "127.0.0.1",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };

    const declared = await request(
      `${cappedRequest.url}/mcp`,
      { ...headers, "content-length": String(marker.length) },
      marker,
    );
    expect(declared.status).toBe(413);
    expect(declared.body).not.toContain("OVERSIZE");

    const chunked = await request(`${cappedRequest.url}/mcp`, headers, marker);
    expect(chunked.status).toBe(413);
    expect(chunked.body).not.toContain("OVERSIZE");
    await cappedRequest.close();
    closeServer = undefined;

    const started = await startHttpServer({
      config: loadConfig({
        HOST: "127.0.0.1",
        PORT: "0",
        MAX_RESPONSE_BYTES: "512",
        RATE_LIMIT_MAX: "20",
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
          clientInfo: { name: "abuse-test", version: "0" },
        },
      }),
    );
    expect(init.status).toBe(200);
    expect(init.body).not.toContain("OVERSIZE");

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
    expect(called.body).not.toContain("OVERSIZE");
  });

  it("returns 429 once a client bursts past the limit", async () => {
    const started = await startHttpServer({
      config: loadConfig({ HOST: "127.0.0.1", PORT: "0", RATE_LIMIT_MAX: "2", RATE_LIMIT_WINDOW_MS: "60000" }),
      deps,
    });
    closeServer = started.close;
    const first = await request(`${started.url}/`);
    const second = await request(`${started.url}/`, { "x-forwarded-for": "203.0.113.10" });
    const third = await request(`${started.url}/`, { "x-forwarded-for": "203.0.113.11" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(JSON.parse(third.body)).toMatchObject({ error: "rate_limited" });
    await started.close();
    closeServer = undefined;

    const proxied = await startHttpServer({
      config: loadConfig({
        HOST: "127.0.0.1",
        PORT: "0",
        TRUST_PROXY: "1",
        RATE_LIMIT_MAX: "1",
        RATE_LIMIT_WINDOW_MS: "60000",
      }),
      deps,
    });
    closeServer = proxied.close;
    const hop = await request(`${proxied.url}/`, { "x-forwarded-for": "203.0.113.20" });
    const repeat = await request(`${proxied.url}/`, { "x-forwarded-for": "203.0.113.20, 10.0.0.1" });
    const other = await request(`${proxied.url}/`, { "x-forwarded-for": "203.0.113.21" });
    expect(hop.status).toBe(200);
    expect(repeat.status).toBe(429);
    expect(other.status).toBe(200);
  });

  it("rejects a bad Host and a bad Origin when an allowlist is set", async () => {
    const started = await startHttpServer({
      config: loadConfig({
        HOST: "127.0.0.1",
        PORT: "0",
        PUBLIC_NODE: "1",
        ALLOWED_HOSTS: "node.example",
      }),
      deps,
    });
    closeServer = started.close;
    const badHost = await request(`${started.url}/`, { host: "evil.example" });
    expect(badHost.status).toBe(403);
    expect(badHost.body).toMatch(/Host/i);

    const badOrigin = await request(`${started.url}/`, {
      host: "node.example",
      origin: "https://evil.example",
    });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.body).toMatch(/Origin/i);

    const allowed = await request(`${started.url}/`, {
      host: "node.example",
      origin: "https://node.example",
    });
    expect(allowed.status).toBe(200);

    const noOrigin = await request(`${started.url}/`, { host: "node.example" });
    expect(noOrigin.status).toBe(200);
  });
});

function signer() {
  const pair = nacl.sign.keyPair();
  const publicKey = base58Encode(pair.publicKey);
  return {
    publicKey,
    sign(payload: HubUpdatePayload, domain = HUB_UPDATE_DOMAIN) {
      const message = new TextEncoder().encode(domain + canonicalHubPayload(payload));
      return base58Encode(nacl.sign.detached(message, pair.secretKey));
    },
    approve(body: HubUpdatePayload) {
      const message = new TextEncoder().encode(HUB_APPROVAL_DOMAIN + hubUpdateHash(body));
      return base58Encode(nacl.sign.detached(message, pair.secretKey));
    },
  };
}

function payload(author: string, body = "Hello hub"): HubUpdatePayload {
  return {
    v: 1,
    id: "update-1",
    created_at: "2026-10-24T00:00:00.000Z",
    author,
    kind: "announcement",
    body,
    refs: { pip: null, txs: [] },
    prev: null,
  };
}

function document(author: ReturnType<typeof signer>, body: HubUpdatePayload, approvers: ReturnType<typeof signer>[]) {
  return {
    payload: body,
    signature: author.sign(body),
    approvals: approvers.map((approver) => ({ publicKey: approver.publicKey, signature: approver.approve(body) })),
  };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync(
    "git",
    ["-c", "user.email=hub-test@example.com", "-c", "user.name=hub-test", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "git failed");
  return (result.stdout ?? "").trim();
}

describe("abuse hub updates", () => {
  it("rejects a tampered update, a repeated approver, and a non-allowlisted approval", () => {
    const author = signer();
    const other = signer();
    const outsider = signer();
    const body = payload(author.publicKey);
    const allowlist = new Set([author.publicKey, other.publicKey]);

    const tampered = document(author, body, [author]);
    tampered.payload = { ...body, body: "Tampered" };
    const bad = verifyHubUpdates([tampered], allowlist, 1);
    expect(bad.updates).toEqual([]);
    expect(bad.rejected).toEqual([{ id: "update-1", reason: "bad_signature" }]);

    const approval = { publicKey: other.publicKey, signature: other.approve(body) };
    const duplicated = verifyHubUpdates(
      [{ payload: body, signature: author.sign(body), approvals: [approval, { ...approval }] }],
      allowlist,
      2,
    );
    expect(duplicated.updates).toEqual([]);
    expect(duplicated.rejected).toEqual([{ id: "update-1", reason: "below_threshold" }]);

    const ignored = verifyHubUpdates([document(author, body, [author, outsider])], allowlist, 2);
    expect(ignored.updates).toEqual([]);
    expect(ignored.rejected).toEqual([{ id: "update-1", reason: "below_threshold" }]);

    const counted = verifyHubUpdates([document(author, body, [author, outsider])], new Set([author.publicKey]), 1);
    expect(counted.rejected).toEqual([]);
    expect(counted.updates.map((update) => update.approvalCount)).toEqual([1]);
  });

  it("fails closed when the manifest hash does not match", async () => {
    const author = signer();
    const body = payload(author.publicKey, "Pinned");
    const signed = document(author, body, [author]);
    const repo = mkdtempSync(path.join(tmpdir(), "hub-abuse-"));
    git(repo, ["init", "-b", "main"]);
    mkdirSync(path.join(repo, "updates"));
    writeFileSync(path.join(repo, "hub-manifest.json"), JSON.stringify({ v: 1, updates: ["updates/one.json"] }));
    writeFileSync(path.join(repo, "updates", "one.json"), JSON.stringify(signed));
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "pin"]);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const manifestHash = createHash("sha256").update(readFileSync(path.join(repo, "hub-manifest.json"))).digest("hex");
    const allowlist = new Set([author.publicKey]);
    const pin = { repo, commit, manifestPath: "hub-manifest.json", manifestHash };

    const served = await readHubUpdates(pin, allowlist, 1);
    expect(served.updates.map((update) => update.body)).toEqual(["Pinned"]);

    await expect(readHubUpdates({ ...pin, manifestHash: "0".repeat(64) }, allowlist, 1)).rejects.toThrow(
      /manifest hash did not match/,
    );
    await expect(readHubUpdates({ ...pin, manifestHash: "0".repeat(64) }, allowlist, 1)).rejects.toThrow(
      /No updates were returned/,
    );

    const tampered = document(author, body, [author]);
    tampered.payload = { ...body, body: "Tampered in the store" };
    writeFileSync(path.join(repo, "updates", "one.json"), JSON.stringify(tampered));
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "tamper"]);
    const tamperedCommit = git(repo, ["rev-parse", "HEAD"]);
    const sameListHash = createHash("sha256").update(readFileSync(path.join(repo, "hub-manifest.json"))).digest("hex");
    expect(sameListHash).toBe(manifestHash);
    const rejected = await readHubUpdates({ ...pin, commit: tamperedCommit }, allowlist, 1);
    expect(rejected.updates).toEqual([]);
    expect(rejected.rejected).toEqual([{ id: "update-1", reason: "bad_signature" }]);
    expect(JSON.stringify(rejected)).not.toContain("Tampered in the store");
  });
});

describe("threshold 2 readiness", () => {
  it("keeps the shipped threshold at 1", () => {
    expect(loadConfig({}).hubApprovalThreshold).toBe(1);
    const example = JSON.parse(readFileSync("node.config.example.json", "utf8")) as {
      hub: { approvalThreshold: number; signerSets: { threshold: number }[] };
    };
    expect(example.hub.approvalThreshold).toBe(1);
    expect(example.hub.signerSets[0]?.threshold).toBe(1);
  });

  it("does not trust the author's own approval alone, and does trust two distinct allowlisted approvals", () => {
    const author = signer();
    const other = signer();
    const body = payload(author.publicKey);
    const allowlist = new Set([author.publicKey, other.publicKey]);

    const alone = verifyHubUpdates([document(author, body, [author])], allowlist, 2);
    expect(alone.updates).toEqual([]);
    expect(alone.rejected).toEqual([{ id: "update-1", reason: "below_threshold" }]);

    const pair = verifyHubUpdates([document(author, body, [author, other])], allowlist, 2);
    expect(pair.updates).toEqual([]);
    expect(pair.rejected).toEqual([{ id: "update-1", reason: "below_threshold" }]);

    const third = signer();
    const twoOthers = verifyHubUpdates(
      [document(author, body, [other, third])],
      new Set([author.publicKey, other.publicKey, third.publicKey]),
      2,
    );
    expect(twoOthers.rejected).toEqual([]);
    expect(twoOthers.updates.map((update) => [update.id, update.approvalCount, update.selfApproved])).toEqual([
      ["update-1", 2, false],
    ]);

    const allowed = verifyHubUpdates([document(author, body, [author, other])], allowlist, 2, undefined, {
      allowAuthorApproval: true,
    });
    expect(allowed.rejected).toEqual([]);
    expect(allowed.updates.map((update) => [update.approvalCount, update.selfApproved])).toEqual([[2, false]]);

    const shipped = verifyHubUpdates([document(author, body, [author])], new Set([author.publicKey]), 1);
    expect(shipped.rejected).toEqual([]);
    expect(shipped.updates).toHaveLength(1);
    expect(shipped.updates[0]?.selfApproved).toBe(true);
  });
});
