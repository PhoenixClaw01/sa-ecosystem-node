import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readHubUpdates } from "../src/dao/hub.js";
import { loadSignerAllowlist } from "../src/hub/allowlist.js";
import { runAddUpdateCli } from "../src/hub/add-update-cli.js";
import { runKeygenCli } from "../src/hub/keygen-cli.js";
import { runSignCli } from "../src/hub/sign-cli.js";
import { formatHubStoreManifest, runStoreInitCli } from "../src/hub/store-init-cli.js";
import { hubUpdateHash, type HubUpdatePayload } from "../src/hub/update.js";

function git(cwd: string, args: string[]): string {
  const result = spawnSync(
    "git",
    ["-c", "user.email=hub-add@example.com", "-c", "user.name=hub-add", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "git failed");
  return (result.stdout ?? "").trim();
}

function initStore(root: string): string {
  const store = path.join(root, "store");
  const init = runStoreInitCli(["--dir", store]);
  expect(init.code, init.stderr).toBe(0);
  git(store, ["init", "-b", "main"]);
  git(store, ["config", "user.email", "hub-add@example.com"]);
  git(store, ["config", "user.name", "hub-add"]);
  git(store, ["add", "."]);
  git(store, ["commit", "-m", "Empty hub update store"]);
  return store;
}

function keygen(root: string, label: string): { file: string; publicKey: string; secretText: string } {
  const file = path.join(root, `${label.replace(/\s+/g, "-").toLowerCase()}.keypair.json`);
  const result = runKeygenCli(["--label", label, "--out", file]);
  expect(result.code, result.stderr).toBe(0);
  const publicKey = result.stdout.split("\n")[0] ?? "";
  return { file, publicKey, secretText: readFileSync(file, "utf8") };
}

interface Report {
  dryRun: boolean;
  path: string;
  payloadSha256: string;
  manifestHash: string;
  commit: string | null;
  selfApproved: boolean;
  document?: { payload: HubUpdatePayload; approvals: { publicKey: string }[] };
  manifest?: { v: 1; updates: string[] };
}

describe("hub-add-update", () => {
  it("dry-run prints the pin and does not write, then a real run commits", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "hub-add-"));
    const store = initStore(root);
    const author = keygen(root, "Author");
    const payloadPath = path.join(root, "update.json");
    const payload = {
      v: 1,
      id: "note-1",
      created_at: "2026-10-31T00:00:00.000Z",
      author: author.publicKey,
      kind: "status",
      body: "First note.",
      refs: { pip: null, txs: [] },
      prev: null,
    };
    writeFileSync(payloadPath, JSON.stringify(payload));
    const headBefore = git(store, ["rev-parse", "HEAD"]);

    const dry = runAddUpdateCli([
      "--store",
      store,
      "--payload",
      payloadPath,
      "--keypair",
      author.file,
      "--approve",
      "--dry-run",
    ]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stderr).toMatch(/no funds/);
    expect(dry.stderr).toMatch(/self-approved/);
    expect(dry.stdout.includes(author.secretText.trim())).toBe(false);
    expect(dry.stderr.includes(author.secretText.trim())).toBe(false);
    expect(dry.stdout.includes(author.secretText.slice(0, 24))).toBe(false);
    const dryReport = JSON.parse(dry.stdout) as Report;
    expect(dryReport.dryRun).toBe(true);
    expect(dryReport.commit).toBeNull();
    expect(dryReport.selfApproved).toBe(true);
    expect(dryReport.path).toBe("updates/note-1.json");
    expect(dryReport.payloadSha256).toHaveLength(64);
    expect(dryReport.manifestHash).toBe(
      createHash("sha256").update(formatHubStoreManifest(["updates/note-1.json"])).digest("hex"),
    );
    expect(dryReport.document?.payload.id).toBe("note-1");
    expect(existsSync(path.join(store, "updates", "note-1.json"))).toBe(false);
    expect(git(store, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(store, ["status", "--porcelain"])).toBe("");

    const wrote = runAddUpdateCli(["--store", store, "--payload", payloadPath, "--keypair", author.file, "--approve"]);
    expect(wrote.code, wrote.stderr).toBe(0);
    expect(wrote.stderr).toMatch(/self-approved/);
    expect(wrote.stdout.includes(author.secretText.trim())).toBe(false);
    expect(wrote.stderr.includes(author.secretText.slice(0, 24))).toBe(false);
    const report = JSON.parse(wrote.stdout) as Report;
    expect(report.dryRun).toBe(false);
    expect(report.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(report.commit).toBe(git(store, ["rev-parse", "HEAD"]));
    expect(report.manifestHash).toBe(
      createHash("sha256").update(readFileSync(path.join(store, "hub-manifest.json"))).digest("hex"),
    );
    expect(report.payloadSha256).toBe(dryReport.payloadSha256);
    expect(git(store, ["status", "--porcelain"])).toBe("");
    const saved = JSON.parse(readFileSync(path.join(store, "updates", "note-1.json"), "utf8")) as {
      payload: HubUpdatePayload;
    };
    expect(hubUpdateHash(saved.payload)).toBe(report.payloadSha256);

    const signers = path.join(root, "signers.json");
    writeFileSync(
      signers,
      JSON.stringify({ v: 1, signers: [{ label: "Author", publicKey: author.publicKey }] }),
    );
    const served = await readHubUpdates(
      { repo: store, commit: report.commit ?? "", manifestPath: "hub-manifest.json", manifestHash: report.manifestHash },
      loadSignerAllowlist(signers),
      1,
    );
    expect(served.rejected).toEqual([]);
    expect(served.updates.map((update) => [update.id, update.selfApproved, update.approvalCount])).toEqual([
      ["note-1", true, 1],
    ]);

    const approver = keygen(root, "Approver");
    const chained = runAddUpdateCli([
      "--store",
      store,
      "--id",
      "note-2",
      "--kind",
      "announcement",
      "--body",
      "Second note.",
      "--created-at",
      "2026-10-31T01:00:00.000Z",
      "--keypair",
      approver.file,
      "--author",
      approver.publicKey,
    ]);
    expect(chained.code, chained.stderr).toBe(0);
    expect(chained.stderr).not.toMatch(/self-approved/);
    expect(chained.stderr).toMatch(/no funds/);
    const chainReport = JSON.parse(chained.stdout) as Report;
    expect(chainReport.selfApproved).toBe(false);
    expect(chainReport.commit).not.toBe(report.commit);
    const second = JSON.parse(readFileSync(path.join(store, "updates", "note-2.json"), "utf8")) as {
      payload: HubUpdatePayload;
      approvals: unknown[];
    };
    expect(second.payload.prev).toBe(report.payloadSha256);
    expect(second.approvals).toEqual([]);
    expect(chainReport.manifest?.updates).toBeUndefined();

    const mismatch = runAddUpdateCli([
      "--store",
      store,
      "--id",
      "note-3",
      "--kind",
      "status",
      "--body",
      "Wrong pointer.",
      "--created-at",
      "2026-10-31T02:00:00.000Z",
      "--prev",
      "ab".repeat(32),
      "--keypair",
      author.file,
      "--author",
      author.publicKey,
    ]);
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toMatch(/store tip/);
    expect(mismatch.stdout).toBe("");
    expect(existsSync(path.join(store, "updates", "note-3.json"))).toBe(false);
    expect(git(store, ["rev-parse", "HEAD"])).toBe(chainReport.commit);
  });

  it("refuses the node repository, a key inside the store, and a bad payload", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hub-add-refuse-"));
    const store = initStore(root);
    const inside = runAddUpdateCli(["--store", path.resolve("."), "--id", "x", "--kind", "announcement", "--body", "no"]);
    expect(inside.code).toBe(1);
    expect(inside.stdout).toBe("");
    expect(inside.stderr).toMatch(/inside this repository/);

    const author = keygen(root, "Author");
    const planted = path.join(store, "planted.keypair.json");
    writeFileSync(planted, author.secretText);
    const plantedRun = runAddUpdateCli([
      "--store",
      store,
      "--id",
      "x",
      "--kind",
      "announcement",
      "--body",
      "no",
      "--keypair",
      planted,
      "--created-at",
      "2026-10-31T00:00:00.000Z",
    ]);
    expect(plantedRun.code).toBe(1);
    expect(plantedRun.stderr).toMatch(/hub store/);
    expect(plantedRun.stdout.includes(author.secretText.trim())).toBe(false);
    expect(plantedRun.stderr.includes(author.secretText.trim())).toBe(false);
    unlinkSync(planted);

    const bad = path.join(root, "bad.json");
    writeFileSync(bad, JSON.stringify({ v: 1, id: "nope" }));
    const rejected = runAddUpdateCli(["--store", store, "--payload", bad]);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toMatch(/schema|author signature/);
    expect(git(store, ["status", "--porcelain"])).toBe("");
  });

  it("signs one approval with a different key file and does not print that secret", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hub-add-approve-"));
    const store = initStore(root);
    const author = keygen(root, "Author");
    const approver = keygen(root, "Approver");
    const payloadPath = path.join(root, "update.json");
    const signedPath = path.join(root, "update.signed.json");
    writeFileSync(
      payloadPath,
      JSON.stringify({
        v: 1,
        id: "note-1",
        created_at: "2026-10-31T00:00:00.000Z",
        author: author.publicKey,
        kind: "announcement",
        body: "Needs another signer.",
        refs: { pip: null, txs: [] },
        prev: null,
      }),
    );
    const signed = runSignCli(["--keypair", author.file, "--payload", payloadPath, "--out", signedPath]);
    expect(signed.code, signed.stderr).toBe(0);
    const dry = runAddUpdateCli(["--store", store, "--payload", signedPath, "--keypair", approver.file, "--dry-run"]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stderr).toMatch(/no funds/);
    expect(dry.stderr).not.toMatch(/self-approved/);
    expect(dry.stdout.includes(approver.secretText.trim())).toBe(false);
    expect(dry.stderr.includes(author.secretText.slice(0, 24))).toBe(false);
    const report = JSON.parse(dry.stdout) as Report;
    expect(report.selfApproved).toBe(false);
    expect(report.document?.approvals.map((approval) => approval.publicKey)).toEqual([approver.publicKey]);
    expect(existsSync(path.join(store, "updates", "note-1.json"))).toBe(false);
  });

  it("refuses a symlinked manifest, update file, or updates directory before writing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hub-add-symlink-"));
    const store = initStore(root);
    const author = keygen(root, "Author");
    const payload = path.join(root, "note.json");
    writeFileSync(
      payload,
      JSON.stringify({
        v: 1,
        id: "note-1",
        created_at: "2026-10-31T00:00:00.000Z",
        author: author.publicKey,
        kind: "status",
        body: "Do not follow links.",
        refs: { pip: null, txs: [] },
        prev: null,
      }),
    );
    const args = ["--store", store, "--payload", payload, "--keypair", author.file, "--approve"];
    const outside = path.join(root, "outside.txt");
    writeFileSync(outside, "keep");

    unlinkSync(path.join(store, "hub-manifest.json"));
    symlinkSync(outside, path.join(store, "hub-manifest.json"));
    const linkedManifest = runAddUpdateCli(args);
    expect(linkedManifest.code).toBe(1);
    expect(linkedManifest.stderr).toMatch(/symlink/);
    expect(linkedManifest.stdout).toBe("");
    expect(readFileSync(outside, "utf8")).toBe("keep");
    expect(lstatSync(path.join(store, "hub-manifest.json")).isSymbolicLink()).toBe(true);

    rmSync(path.join(store, "hub-manifest.json"));
    writeFileSync(path.join(store, "hub-manifest.json"), formatHubStoreManifest([]));
    symlinkSync(outside, path.join(store, "updates", "note-1.json"));
    const linkedFile = runAddUpdateCli(args);
    expect(linkedFile.code).toBe(1);
    expect(linkedFile.stderr).toMatch(/symlink/);
    expect(readFileSync(outside, "utf8")).toBe("keep");
    expect(lstatSync(path.join(store, "updates", "note-1.json")).isSymbolicLink()).toBe(true);
    expect(linkedFile.stdout.includes(author.secretText.trim())).toBe(false);
    expect(linkedFile.stderr.includes(author.secretText.trim())).toBe(false);

    unlinkSync(path.join(store, "updates", "note-1.json"));
    rmSync(path.join(store, "updates"), { recursive: true });
    const outsideDir = path.join(root, "outside-updates");
    mkdirSync(outsideDir);
    symlinkSync(outsideDir, path.join(store, "updates"));
    const linkedDir = runAddUpdateCli(args);
    expect(linkedDir.code).toBe(1);
    expect(linkedDir.stderr).toMatch(/symlink/);
    expect(existsSync(path.join(outsideDir, "note-1.json"))).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("keep");
  });

  it("refuses a .git symlink and a gitdir file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hub-add-gitdir-"));
    const store = initStore(root);
    const author = keygen(root, "Author");
    const other = path.join(root, "other");
    mkdirSync(other);
    git(other, ["init", "-b", "main"]);
    git(other, ["config", "user.email", "hub-add@example.com"]);
    git(other, ["config", "user.name", "hub-add"]);
    writeFileSync(path.join(other, "README.md"), "other\n");
    git(other, ["add", "README.md"]);
    git(other, ["commit", "-m", "other"]);
    const otherHead = git(other, ["rev-parse", "HEAD"]);
    const payload = path.join(root, "note.json");
    writeFileSync(
      payload,
      JSON.stringify({
        v: 1,
        id: "note-1",
        created_at: "2026-10-31T00:00:00.000Z",
        author: author.publicKey,
        kind: "status",
        body: "Stay in this store.",
        refs: { pip: null, txs: [] },
        prev: null,
      }),
    );
    const args = ["--store", store, "--payload", payload, "--keypair", author.file, "--approve"];

    rmSync(path.join(store, ".git"), { recursive: true });
    symlinkSync(path.join(other, ".git"), path.join(store, ".git"));
    const linked = runAddUpdateCli(args);
    expect(linked.code).toBe(1);
    expect(linked.stderr).toMatch(/symlink/);
    expect(git(other, ["rev-parse", "HEAD"])).toBe(otherHead);
    expect(git(other, ["status", "--porcelain"])).toBe("");
    expect(existsSync(path.join(store, "updates", "note-1.json"))).toBe(false);

    unlinkSync(path.join(store, ".git"));
    writeFileSync(path.join(store, ".git"), `gitdir: ${path.join(other, ".git")}\n`);
    const gitdir = runAddUpdateCli(args);
    expect(gitdir.code).toBe(1);
    expect(gitdir.stderr).toMatch(/not a git repository/);
    expect(git(other, ["rev-parse", "HEAD"])).toBe(otherHead);
    expect(git(other, ["status", "--porcelain"])).toBe("");
    expect(existsSync(path.join(other, "updates", "note-1.json"))).toBe(false);
  });

  it("locks out an overlapping add and aborts when the tip changes before commit", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hub-add-race-"));
    const store = initStore(root);
    const author = keygen(root, "Author");
    const note = (id: string) => {
      const file = path.join(root, `${id}.json`);
      writeFileSync(
        file,
        JSON.stringify({
          v: 1,
          id,
          created_at: "2026-10-31T00:00:00.000Z",
          author: author.publicKey,
          kind: "status",
          body: id,
          refs: { pip: null, txs: [] },
          prev: null,
        }),
      );
      return ["--store", store, "--payload", file, "--keypair", author.file, "--approve"];
    };

    writeFileSync(path.join(store, ".git", "hub-add-update.lock"), "");
    const blocked = runAddUpdateCli(note("blocked"));
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toMatch(/locked/);
    expect(existsSync(path.join(store, "updates", "blocked.json"))).toBe(false);
    unlinkSync(path.join(store, ".git", "hub-add-update.lock"));

    const nested = { code: 0, stderr: "" };
    const first = runAddUpdateCli(note("note-1"), {
      beforeCommit() {
        const second = runAddUpdateCli(note("note-2"));
        nested.code = second.code;
        nested.stderr = second.stderr;
      },
    });
    expect(first.code, first.stderr).toBe(0);
    expect(nested.code).toBe(1);
    expect(nested.stderr).toMatch(/locked/);
    expect(nested.stderr.includes(author.secretText.trim())).toBe(false);
    expect(JSON.parse(readFileSync(path.join(store, "hub-manifest.json"), "utf8"))).toEqual({
      v: 1,
      updates: ["updates/note-1.json"],
    });
    expect(existsSync(path.join(store, "updates", "note-2.json"))).toBe(false);
    const tip = (JSON.parse(first.stdout) as Report).payloadSha256;

    const head = git(store, ["rev-parse", "HEAD"]);
    const marker = `${JSON.stringify({ v: 1, updates: ["updates/other.json"] })}\n`;
    const changed = runAddUpdateCli(
      ["--store", store, "--id", "note-3", "--kind", "status", "--body", "note-3", "--created-at", "2026-10-31T03:00:00.000Z", "--prev", tip, "--keypair", author.file, "--author", author.publicKey],
      {
        beforeCommit(dir) {
          writeFileSync(path.join(dir, "hub-manifest.json"), marker);
        },
      },
    );
    expect(changed.code).toBe(1);
    expect(changed.stderr).toMatch(/changed before the commit/);
    expect(existsSync(path.join(store, "updates", "note-3.json"))).toBe(false);
    expect(readFileSync(path.join(store, "hub-manifest.json"), "utf8")).toBe(marker);
    expect(git(store, ["rev-parse", "HEAD"])).toBe(head);

    writeFileSync(path.join(store, "hub-manifest.json"), formatHubStoreManifest(["updates/note-1.json"]));
    const moved = runAddUpdateCli(
      ["--store", store, "--id", "note-4", "--kind", "status", "--body", "note-4", "--created-at", "2026-10-31T04:00:00.000Z", "--prev", tip, "--keypair", author.file, "--author", author.publicKey],
      {
        beforeCommit(dir) {
          git(dir, ["commit", "--allow-empty", "-m", "interleave"]);
        },
      },
    );
    expect(moved.code).toBe(1);
    expect(moved.stderr).toMatch(/changed before the commit/);
    expect(existsSync(path.join(store, "updates", "note-4.json"))).toBe(false);
    expect(git(store, ["rev-parse", "HEAD"])).not.toBe(head);
  });

  it("commits when updates stays a real directory inside the store", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hub-add-stable-"));
    const store = initStore(root);
    const author = keygen(root, "Author");
    const updates = path.join(store, "updates");
    const before = lstatSync(updates);
    expect(before.isSymbolicLink()).toBe(false);
    expect(before.isDirectory()).toBe(true);
    const payload = path.join(root, "note.json");
    writeFileSync(
      payload,
      JSON.stringify({
        v: 1,
        id: "note-stable",
        created_at: "2026-10-31T00:00:00.000Z",
        author: author.publicKey,
        kind: "status",
        body: "Stay inside the store.",
        refs: { pip: null, txs: [] },
        prev: null,
      }),
    );
    let checks = 0;
    const wrote = runAddUpdateCli(["--store", store, "--payload", payload, "--keypair", author.file, "--approve"], {
      beforeRename(storeDir, dir) {
        if (path.basename(dir) !== "updates") return;
        checks += 1;
        expect(realpathSync(storeDir)).toBe(realpathSync(store));
        const info = lstatSync(dir);
        expect(info.isSymbolicLink()).toBe(false);
        expect(info.isDirectory()).toBe(true);
        expect(info.dev).toBe(before.dev);
        expect(info.ino).toBe(before.ino);
      },
    });
    expect(wrote.code, wrote.stderr).toBe(0);
    expect(checks).toBe(1);
    expect(wrote.stdout.includes(author.secretText.trim())).toBe(false);
    expect(wrote.stderr.includes(author.secretText.trim())).toBe(false);
    const report = JSON.parse(wrote.stdout) as Report;
    expect(report.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(report.commit).toBe(git(store, ["rev-parse", "HEAD"]));
    expect(report.path).toBe("updates/note-stable.json");
    const file = path.join(store, "updates", "note-stable.json");
    const saved = lstatSync(file);
    expect(saved.isSymbolicLink()).toBe(false);
    expect(saved.isFile()).toBe(true);
    expect(path.relative(realpathSync(store), realpathSync(file))).toBe(path.join("updates", "note-stable.json"));
    const after = lstatSync(updates);
    expect(after.isSymbolicLink()).toBe(false);
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(git(store, ["status", "--porcelain"])).toBe("");
    expect(JSON.parse(readFileSync(path.join(store, "hub-manifest.json"), "utf8"))).toEqual({
      v: 1,
      updates: ["updates/note-stable.json"],
    });
  });

  it("removes the written file and aborts when updates is swapped for a symlink before rename", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hub-add-swap-"));
    const store = initStore(root);
    const author = keygen(root, "Author");
    const outside = path.join(root, "outside-updates");
    const payload = path.join(root, "note.json");
    const body = "Do not leave this note outside.";
    writeFileSync(
      payload,
      JSON.stringify({
        v: 1,
        id: "note-swap",
        created_at: "2026-10-31T00:00:00.000Z",
        author: author.publicKey,
        kind: "status",
        body,
        refs: { pip: null, txs: [] },
        prev: null,
      }),
    );
    const head = git(store, ["rev-parse", "HEAD"]);
    const manifest = readFileSync(path.join(store, "hub-manifest.json"), "utf8");
    let swaps = 0;
    const swapped = runAddUpdateCli(["--store", store, "--payload", payload, "--keypair", author.file, "--approve"], {
      beforeRename(_storeDir, dir) {
        if (path.basename(dir) !== "updates") return;
        swaps += 1;
        renameSync(dir, outside);
        symlinkSync(outside, dir);
      },
    });
    expect(swaps).toBe(1);
    expect(swapped.code).toBe(1);
    expect(swapped.stdout).toBe("");
    expect(swapped.stderr).toBe(
      "The hub store directory changed during the write. The file was removed. Nothing was committed.\n",
    );
    expect(swapped.stderr.includes(author.secretText.trim())).toBe(false);
    expect(swapped.stdout.includes(author.secretText.trim())).toBe(false);
    expect(readdirSync(outside).sort()).toEqual([".gitkeep"]);
    expect(existsSync(path.join(outside, "note-swap.json"))).toBe(false);
    const leaked = readdirSync(outside)
      .map((name) => readFileSync(path.join(outside, name), "utf8"))
      .join("\n");
    expect(leaked.includes(body)).toBe(false);
    expect(leaked.includes(author.secretText.trim())).toBe(false);
    expect(readFileSync(path.join(store, "hub-manifest.json"), "utf8")).toBe(manifest);
    expect(git(store, ["rev-parse", "HEAD"])).toBe(head);
    expect(lstatSync(path.join(realpathSync(store), "updates")).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(store, ".git", "hub-add-update.lock"))).toBe(false);
  });

  it("warns when a withdraw matches nothing and when a listing omits listingId", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hub-add-withdraw-"));
    const store = initStore(root);
    const author = keygen(root, "Author");
    const listing = (over: Record<string, unknown> = {}) =>
      JSON.stringify({
        stream: "hybrid",
        category: "ip_and_business",
        title: "Example shop",
        owner: "Example Owner",
        url: "https://example.com/shop",
        status: "available",
        asOf: "2026-10-01",
        expiresAt: "2026-12-30",
        ...over,
      });
    const add = (id: string, kind: string, extra: string[], dryRun = false) =>
      runAddUpdateCli([
        "--store",
        store,
        "--id",
        id,
        "--kind",
        kind,
        "--body",
        "Note.",
        "--created-at",
        "2026-10-31T00:00:00.000Z",
        ...extra,
        "--keypair",
        author.file,
        "--approve",
        ...(dryRun ? ["--dry-run"] : []),
      ]);

    const named = add("shop-1", "listing", ["--listing", listing({ listingId: "shop-1" })]);
    expect(named.code, named.stderr).toBe(0);
    expect(named.stderr).not.toMatch(/set listingId/);
    expect(named.stderr).not.toMatch(/does not match/);

    const unnamed = add("shop-2", "listing", ["--listing", listing()]);
    expect(unnamed.code, unnamed.stderr).toBe(0);
    expect(unnamed.stderr).toMatch(/set listingId/);

    const otherId = add("shop-3", "listing", ["--listing", listing({ listingId: "missing", status: "withdrawn" })], true);
    expect(otherId.code, otherId.stderr).toBe(0);
    expect(otherId.stderr).toMatch(/does not match a current listing/);
    expect(otherId.stderr).toMatch(/same listingId/);
    expect(existsSync(path.join(store, "updates", "shop-3.json"))).toBe(false);

    const sameId = add("shop-4", "listing", ["--listing", listing({ listingId: "shop-1", status: "withdrawn", title: "Renamed" })], true);
    expect(sameId.code, sameId.stderr).toBe(0);
    expect(sameId.stderr).not.toMatch(/does not match a current listing/);

    const sameFallback = add("shop-5", "listing", ["--listing", listing({ status: "withdrawn" })], true);
    expect(sameFallback.code, sameFallback.stderr).toBe(0);
    expect(sameFallback.stderr).not.toMatch(/does not match a current listing/);

    const otherTitle = add("shop-6", "listing", ["--listing", listing({ status: "withdrawn", title: "Other shop" })], true);
    expect(otherTitle.code, otherTitle.stderr).toBe(0);
    expect(otherTitle.stderr).toMatch(/does not match a current listing/);

    const guild = JSON.stringify({
      name: "Dawn Watch",
      description: "A morning group.",
      links: ["https://example.com/dawn"],
    });
    const published = add("guild-1", "guild", ["--guild", guild]);
    expect(published.code, published.stderr).toBe(0);
    const otherGuild = add(
      "guild-2",
      "guild",
      ["--guild", JSON.stringify({ name: "Other Watch", description: "Gone.", links: [], withdrawn: true })],
      true,
    );
    expect(otherGuild.code, otherGuild.stderr).toBe(0);
    expect(otherGuild.stderr).toMatch(/does not match a current guild/);
    const sameGuild = add(
      "guild-3",
      "guild",
      ["--guild", JSON.stringify({ name: "dawn watch", description: "Gone.", links: ["https://example.com/dawn"], withdrawn: true })],
      true,
    );
    expect(sameGuild.code, sameGuild.stderr).toBe(0);
    expect(sameGuild.stderr).not.toMatch(/does not match a current guild/);
  });
});
