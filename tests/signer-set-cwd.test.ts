import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveSignerSetPath } from "../src/config.js";
import { formatHubStoreManifest } from "../src/hub/store-init-cli.js";

// Regression for the 2026-11-11 M5 rollback: on Vercel the function's working directory is not
// dashboard/, so relative HUB_SIGNER_SETS paths resolved against cwd missed the shipped copies and
// every hub tool answered "The signer allowlist could not be read".

const root = path.resolve(".");
const bundle = path.join(root, "dashboard/api/mcp.js");
const BOTH_SETS = JSON.stringify([
  { id: "default", path: "hub/signers.json", threshold: 2 },
  { id: "agents", path: "hub/signers/agents.json", threshold: 2 },
]);

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-c", "user.email=h2h@example.com", "-c", "user.name=h2h", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "git failed");
  return (result.stdout ?? "").trim();
}

/** A pinned local hub with no updates: enough to make the node load its signer sets. */
function emptyHub() {
  const repo = mkdtempSync(path.join(tmpdir(), "signer-cwd-hub-"));
  git(repo, ["init", "-b", "main"]);
  mkdirSync(path.join(repo, "updates"));
  writeFileSync(path.join(repo, "updates/.gitkeep"), "");
  writeFileSync(path.join(repo, "hub-manifest.json"), formatHubStoreManifest([]));
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "pin"]);
  return {
    HUB_GIT_REPO: repo,
    HUB_GIT_COMMIT: git(repo, ["rev-parse", "HEAD"]),
    HUB_STORE_MANIFEST_HASH: createHash("sha256").update(readFileSync(path.join(repo, "hub-manifest.json"))).digest("hex"),
  };
}

const PROBE = `
const m = (await import(process.env.PROBE_BUNDLE)).default;
const call = async (name) => {
  const res = await m.fetch(new Request("https://node.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }) }));
  const text = await res.text();
  const line = text.startsWith("{") ? text : text.split("\\n").find((l) => l.startsWith("data: ")).slice(6);
  const r = JSON.parse(line);
  if (r.result?.isError) return { error: r.result.content[0].text };
  const j = JSON.parse(r.result.content[0].text);
  return { updates: j.updates.length, rejected: j.rejected.length, approvedBy: [...new Set(j.updates.map((u) => JSON.stringify(u.approvedBy)))] };
};
const feed = await m.fetch(new Request("https://node.test/c4-markers.json"));
const feedBody = JSON.parse(await feed.text());
console.log(JSON.stringify({ hub: await call("hub_updates"), feed: { status: feed.status, markers: feedBody.markers?.length ?? null, error: feedBody.error ?? null } }));
`;

function probe(cwd: string, env: Record<string, string>) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", PROBE], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PROBE_BUNDLE: bundle, ...env },
    timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || "probe failed");
  const last = result.stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(last) as {
    hub: { updates?: number; rejected?: number; approvedBy?: string[]; error?: string };
    feed: { status: number; markers: number | null; error: { code: string; message: string } | null };
  };
}

describe("HUB_SIGNER_SETS path resolution", () => {
  it("finds a relative set path next to the code when cwd does not have it", () => {
    const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), "signer-cwd-")));
    expect(resolveSignerSetPath("hub/signers/agents.json", path.join(root, "dashboard/api"), elsewhere)).toBe(
      path.join(root, "dashboard/hub/signers/agents.json"),
    );
    expect(resolveSignerSetPath("hub/signers/agents.json", path.join(root, "dist"), elsewhere)).toBe(path.join(root, "hub/signers/agents.json"));
    expect(resolveSignerSetPath("hub/signers.json", path.join(root, "dashboard/api"), elsewhere)).toBe(path.join(root, "dashboard/hub/signers.json"));
  });

  it("prefers the cwd copy, keeps an absolute path as given, and falls back to the cwd path when nothing exists", () => {
    expect(resolveSignerSetPath("hub/signers/agents.json", path.join(root, "dashboard/api"), root)).toBe(path.join(root, "hub/signers/agents.json"));
    expect(resolveSignerSetPath("/abs/agents.json", path.join(root, "dashboard/api"), root)).toBe("/abs/agents.json");
    const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), "signer-cwd-")));
    expect(resolveSignerSetPath("hub/signers/missing.json", path.join(root, "dashboard/api"), elsewhere)).toBe(
      path.join(elsewhere, "hub/signers/missing.json"),
    );
  });

  const hub = emptyHub();
  const env = { ...hub, HUB_APPROVAL_THRESHOLD: "2", HUB_ALLOW_AUTHOR_APPROVAL: "true", HUB_SIGNER_SETS: BOTH_SETS };

  for (const [label, cwd] of [
    ["the repo root", root],
    ["a temp directory", realpathSync(tmpdir())],
  ] as const) {
    it(`loads both signer sets in the dashboard bundle from ${label}`, () => {
      const out = probe(cwd, env);
      expect(out.hub.error).toBeUndefined();
      expect(out.hub).toMatchObject({ updates: 0, rejected: 0 });
      expect(out.feed).toMatchObject({ status: 200, markers: 0, error: null });
    }, 120_000);
  }

  it("answers /c4-markers.json with a 503 JSON error, not a 500, when a signer set cannot be read", () => {
    const out = probe(realpathSync(tmpdir()), {
      ...env,
      HUB_SIGNER_SETS: JSON.stringify([{ id: "default", path: "hub/signers/missing.json", threshold: 2 }]),
    });
    expect(out.hub.error).toMatch(/signer allowlist could not be read/);
    expect(out.feed.status).toBe(503);
    expect(out.feed.error).toEqual({ code: "feed_unavailable", feed: "c4Markers", message: "The signer allowlist could not be read. No updates were returned." });
  }, 120_000);
});

// Live check against the public hub (network). Run with RUN_LIVE_HUB=1 npm test.
const live = process.env.RUN_LIVE_HUB === "1" ? describe : describe.skip;
live("both signer sets against public hub 08d3fa1e from other working directories", () => {
  const env = {
    HUB_GIT_REPO: "https://github.com/PhoenixClaw01/sa-ecosystem-hub",
    HUB_GIT_COMMIT: "08d3fa1e0f5756843d47595c6000abcac5e94bf5",
    HUB_STORE_MANIFEST_HASH: "1fd4536e3a5b4176beebc04c16c53834092f519d98c0e30172862a2f24ae24f2",
    HUB_APPROVAL_THRESHOLD: "2",
    HUB_ALLOW_AUTHOR_APPROVAL: "true",
    HUB_SIGNER_SETS: BOTH_SETS,
  };
  for (const [label, cwd] of [
    ["the repo root", root],
    ["/tmp", realpathSync(tmpdir())],
  ] as const) {
    it(`returns 55 / 0 approved by K2 + G2Ph from ${label}`, () => {
      const out = probe(cwd, env);
      expect(out.hub).toEqual({
        updates: 55,
        rejected: 0,
        approvedBy: [JSON.stringify(["AANzSFjMzGuKn5gC1YygMsZZGeLUiMM9HAmKH6n2YqgH", "G2PhCi6MApcuC6f5o2CDQBWDnJt9hRcozHuuN55PYisU"])],
      });
      expect(out.feed).toMatchObject({ status: 200, markers: 53, error: null });
    }, 180_000);
  }
});
