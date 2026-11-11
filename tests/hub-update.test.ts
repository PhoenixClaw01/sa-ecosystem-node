import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { readHubUpdates } from "../src/dao/hub.js";
import { loadSignerAllowlist, parseHubSigners } from "../src/hub/allowlist.js";
import { base58Decode, base58Encode } from "../src/hub/base58.js";
import { runSignCli } from "../src/hub/sign-cli.js";
import { runStoreInitCli } from "../src/hub/store-init-cli.js";
import {
  HUB_APPROVAL_DOMAIN,
  HUB_UPDATE_DOMAIN,
  canonicalHubPayload,
  hubUpdateHash,
  hubUpdateSigningMessage,
  verifyHubUpdates,
  type HubUpdatePayload,
} from "../src/hub/update.js";

function signer() {
  const pair = nacl.sign.keyPair();
  const publicKey = base58Encode(pair.publicKey);
  return {
    publicKey,
    solanaKey: pair.secretKey,
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

function approvalsOf(body: HubUpdatePayload, approvers: ReturnType<typeof signer>[]) {
  return approvers.map((approver) => ({ publicKey: approver.publicKey, signature: approver.approve(body) }));
}

function payload(author: string, over: Partial<Omit<HubUpdatePayload, "refs" | "v">> & { refs?: Partial<HubUpdatePayload["refs"]> } = {}): HubUpdatePayload {
  return {
    v: 1,
    id: over.id ?? "update-1",
    created_at: over.created_at ?? "2026-10-24T00:00:00.000Z",
    author,
    kind: over.kind ?? "announcement",
    body: over.body ?? 'Hello "hub"\nsecond line',
    refs: { pip: over.refs?.pip ?? null, txs: over.refs?.txs ?? [] },
    prev: over.prev ?? null,
  };
}

function document(
  author: ReturnType<typeof signer>,
  body: HubUpdatePayload,
  approvers: ReturnType<typeof signer>[] = [author],
  domain?: string,
) {
  return { payload: body, signature: author.sign(body, domain), approvals: approvalsOf(body, approvers) };
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

function pinnedStore(files: Record<string, string>) {
  const repo = mkdtempSync(path.join(tmpdir(), "hub-repo-"));
  git(repo, ["init", "-b", "main"]);
  for (const [name, text] of Object.entries(files)) {
    const full = path.join(repo, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "pin"]);
  const commit = git(repo, ["rev-parse", "HEAD"]);
  const manifestHash = createHash("sha256").update(readFileSync(path.join(repo, "hub-manifest.json"))).digest("hex");
  return { repo, commit, manifestPath: "hub-manifest.json", manifestHash };
}

describe("base58", () => {
  it("round-trips a Solana address and the all-zero address", () => {
    expect(base58Encode(new Uint8Array(32))).toBe("11111111111111111111111111111111");
    const bytes = base58Decode("CuwnarNh7FEqZMmffFjRyWj54RecyS7zwFg1CxfzNudi");
    expect(bytes).toHaveLength(32);
    expect(base58Encode(bytes)).toBe("CuwnarNh7FEqZMmffFjRyWj54RecyS7zwFg1CxfzNudi");
  });
});

describe("signed hub updates", () => {
  it("accepts a valid signature and a two-update chain", () => {
    const author = signer();
    const first = payload(author.publicKey);
    const second = payload(author.publicKey, {
      id: "update-2",
      created_at: "2026-10-24T01:00:00.000Z",
      kind: "payment-note",
      body: "Paid.",
      prev: hubUpdateHash(first),
      refs: { pip: "PIP-23", txs: ["5".repeat(87)] },
    });
    const checked = verifyHubUpdates([document(author, second), document(author, first)], new Set([author.publicKey]), 1);
    expect(checked.rejected).toEqual([]);
    expect(checked.updates.map((update) => update.id)).toEqual(["update-1", "update-2"]);
    expect(checked.updates[0]).toMatchObject({
      verified: true,
      signer: author.publicKey,
      signerAllowlist: "allowed",
      approvalCount: 1,
      selfApproved: true,
    });
    expect(checked.updates[1]?.prev).toBe(checked.updates[0]?.hash);
    expect(new TextDecoder().decode(hubUpdateSigningMessage(first)).startsWith(HUB_UPDATE_DOMAIN)).toBe(true);
    expect(canonicalHubPayload(first).startsWith('{"author":')).toBe(true);
    expect(canonicalHubPayload(first)).not.toMatch(/:\s|\s,|\n/);
  });

  it("rejects a tampered body", () => {
    const author = signer();
    const body = payload(author.publicKey);
    const signed = document(author, body);
    signed.payload = { ...body, body: "Tampered" };
    const checked = verifyHubUpdates([signed], new Set([author.publicKey]), 1);
    expect(checked.updates).toEqual([]);
    expect(checked.rejected).toEqual([{ id: "update-1", reason: "bad_signature" }]);
  });

  it("rejects a signature over the wrong domain prefix", () => {
    const author = signer();
    const body = payload(author.publicKey);
    const signed = document(author, body, [author], "sa-ecosystem-node:hub-update:v0\n");
    const checked = verifyHubUpdates([signed], new Set([author.publicKey]), 1);
    expect(checked.updates).toEqual([]);
    expect(checked.rejected).toEqual([{ id: "update-1", reason: "bad_signature" }]);
  });

  it("keeps the first update when the next link is broken", () => {
    const author = signer();
    const first = payload(author.publicKey);
    const broken = payload(author.publicKey, {
      id: "update-2",
      created_at: "2026-10-24T01:00:00.000Z",
      prev: "0".repeat(64),
    });
    const checked = verifyHubUpdates([document(author, first), document(author, broken)], new Set([author.publicKey]), 1);
    expect(checked.updates.map((update) => update.id)).toEqual(["update-1"]);
    expect(checked.rejected).toEqual([{ id: "update-2", reason: "broken_chain" }]);
  });

  it("rejects an unknown signer even when allowlisted keys approved the hash", () => {
    const author = signer();
    const approverA = signer();
    const approverB = signer();
    const body = payload(author.publicKey);
    const checked = verifyHubUpdates(
      [document(author, body, [approverA, approverB])],
      new Set([approverA.publicKey, approverB.publicKey]),
      2,
    );
    expect(checked.updates).toEqual([]);
    expect(checked.rejected).toEqual([{ id: "update-1", reason: "unknown_signer" }]);
  });

  it("rejects an update below the approval threshold", () => {
    const author = signer();
    const approver = signer();
    const extra = signer();
    const body = payload(author.publicKey);
    const checked = verifyHubUpdates(
      [document(author, body, [approver])],
      new Set([author.publicKey, approver.publicKey, extra.publicKey]),
      2,
    );
    expect(checked.updates).toEqual([]);
    expect(checked.rejected).toEqual([{ id: "update-1", reason: "below_threshold" }]);
  });

  it("counts a duplicate approver once and stays below threshold", () => {
    const author = signer();
    const approver = signer();
    const body = payload(author.publicKey);
    const approval = { publicKey: approver.publicKey, signature: approver.approve(body) };
    const checked = verifyHubUpdates(
      [{ payload: body, signature: author.sign(body), approvals: [approval, approval] }],
      new Set([author.publicKey, approver.publicKey]),
      2,
    );
    expect(checked.updates).toEqual([]);
    expect(checked.rejected).toEqual([{ id: "update-1", reason: "below_threshold" }]);
  });

  it("accepts a valid 2-of-3 approval set", () => {
    const author = signer();
    const approverB = signer();
    const approverC = signer();
    const unused = signer();
    const body = payload(author.publicKey);
    const checked = verifyHubUpdates(
      [document(author, body, [approverB, approverC])],
      new Set([author.publicKey, approverB.publicKey, approverC.publicKey, unused.publicKey]),
      2,
    );
    expect(checked.rejected).toEqual([]);
    expect(checked.updates.map((update) => [update.id, update.signerAllowlist, update.approvalCount])).toEqual([
      ["update-1", "allowed", 2],
    ]);
  });

  it("rejects every update when the allowlist is empty", () => {
    const author = signer();
    const body = payload(author.publicKey);
    const checked = verifyHubUpdates([document(author, body)], new Set(), 1);
    expect(checked.updates).toEqual([]);
    expect(checked.rejected).toEqual([{ id: "update-1", reason: "unknown_signer" }]);
  });

  it("rejects a replayed id and keeps the first link", () => {
    const author = signer();
    const first = payload(author.publicKey, { id: "same", body: "Original" });
    const replay = payload(author.publicKey, {
      id: "same",
      body: "Replay",
      created_at: "2026-10-24T01:00:00.000Z",
      prev: hubUpdateHash(first),
    });
    const checked = verifyHubUpdates([document(author, first), document(author, replay)], new Set([author.publicKey]), 1);
    expect(checked.updates.map((update) => update.body)).toEqual(["Original"]);
    expect(checked.rejected).toEqual([{ id: "same", reason: "replayed_id" }]);
  });

  it("parses hub/signers.json as three distinct testnet public keys", () => {
    const parsed = JSON.parse(readFileSync(path.resolve("hub/signers.json"), "utf8")) as {
      v: number;
      signers: { label: string; publicKey: string }[];
    };
    expect(Object.keys(parsed)).toEqual(["v", "signers"]);
    expect(parsed.v).toBe(1);
    expect(parsed.signers).toHaveLength(3);
    for (const entry of parsed.signers) {
      expect(Object.keys(entry)).toEqual(["label", "publicKey"]);
      const bytes = base58Decode(entry.publicKey);
      expect(bytes).toHaveLength(32);
      expect(base58Encode(bytes)).toBe(entry.publicKey);
    }
    expect(new Set(parsed.signers.map((entry) => entry.publicKey)).size).toBe(3);
    expect(new Set(parsed.signers.map((entry) => entry.label)).size).toBe(3);
    expect(parsed.signers.map((entry) => entry.label)).not.toContain("Phoenix bus");
    expect(parseHubSigners(parsed)).toEqual([
      { label: "Falkor", publicKey: "FC1eRr99GGJZuc4KZeUivBpbSMGvjcBB839KaEfAuhcq" },
      { label: "GaliaMeta DAC", publicKey: "EU7zwmY8QP7B9FFUUyMu1eTNkrwuj27NQkgEmNMWreq1" },
      { label: "Phoenix Collective (Falkor's team)", publicKey: "G2PhCi6MApcuC6f5o2CDQBWDnJt9hRcozHuuN55PYisU" },
    ]);
    expect(loadSignerAllowlist(path.resolve("hub/signers.json")).size).toBe(3);
  });

  it("requires a label on each allowlisted wallet", () => {
    const wallet = signer();
    const file = path.join(mkdtempSync(path.join(tmpdir(), "hub-signers-")), "signers.json");
    writeFileSync(file, JSON.stringify({ v: 1, signers: [{ label: "Falkor", publicKey: wallet.publicKey }] }));
    expect([...loadSignerAllowlist(file)]).toEqual([wallet.publicKey]);
    writeFileSync(file, JSON.stringify({ v: 1, publicKeys: [wallet.publicKey] }));
    expect(() => loadSignerAllowlist(file)).toThrow(/schema v1/);
    writeFileSync(file, JSON.stringify({ v: 1, signers: [{ publicKey: wallet.publicKey }] }));
    expect(() => loadSignerAllowlist(file)).toThrow(/labeled Solana address/);
    const other = signer();
    writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        signers: [
          { label: "Falkor", publicKey: wallet.publicKey },
          { label: "Falkor", publicKey: other.publicKey },
        ],
      }),
    );
    expect(() => loadSignerAllowlist(file)).toThrow(/repeats a label/);
  });

  it("rejects a partial git pin", async () => {
    await expect(readHubUpdates({ repo: "https://example.com/hub.git" }, new Set(), 1)).rejects.toThrow(/together/);
  });

  it("serves a pinned commit only when the manifest hash matches and approvals reach N-of-M", async () => {
    const author = signer();
    const approver = signer();
    const second = signer();
    const body = payload(author.publicKey, { kind: "status" });
    const signed = document(author, body, [approver, second]);
    const pinned = pinnedStore({
      "hub-manifest.json": JSON.stringify({ v: 1, updates: ["updates/one.json"] }),
      "updates/one.json": JSON.stringify(signed),
    });
    const allowlist = new Set([author.publicKey, approver.publicKey, second.publicKey]);
    const result = await readHubUpdates(pinned, allowlist, 2);
    expect(result.updates.map((update) => [update.kind, update.approvalCount, update.selfApproved])).toEqual([
      ["status", 2, false],
    ]);
    expect(result.sourceUrl).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/\/tmp\/|\/workspace/);

    const emptyAllowlist = await readHubUpdates(pinned, new Set(), 2);
    expect(emptyAllowlist.updates).toEqual([]);
    expect(emptyAllowlist.rejected).toEqual([{ id: "update-1", reason: "unknown_signer" }]);

    await expect(
      readHubUpdates({ ...pinned, manifestHash: "0".repeat(64) }, allowlist, 2),
    ).rejects.toThrow(/manifest hash did not match/);
    await expect(
      readHubUpdates({ ...pinned, commit: "a".repeat(40) }, allowlist, 2),
    ).rejects.toThrow(/could not be read|did not match/);
  });
});

describe("sign-hub-update CLI", () => {
  it("signs a payload file with a local key file", () => {
    const author = signer();
    const directory = mkdtempSync(path.join(tmpdir(), "hub-sign-"));
    const keyPath = path.join(directory, "author.keypair.json");
    const payloadPath = path.join(directory, "update.json");
    const outPath = path.join(directory, "update.signed.json");
    writeFileSync(keyPath, JSON.stringify(Array.from(author.solanaKey)));
    writeFileSync(payloadPath, JSON.stringify(payload(author.publicKey, { id: "cli-1", body: "Signed locally." })));
    const result = runSignCli(["--keypair", keyPath, "--payload", payloadPath, "--out", outPath]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe(`Signed cli-1 as ${author.publicKey}\n`);
    const signed = JSON.parse(readFileSync(outPath, "utf8")) as unknown;
    const alone = verifyHubUpdates([signed], new Set([author.publicKey]), 1);
    expect(alone.updates).toEqual([]);
    expect(alone.rejected).toEqual([{ id: "cli-1", reason: "below_threshold" }]);

    const approver = signer();
    const approverKey = path.join(directory, "approver.keypair.json");
    const approvedPath = path.join(directory, "update.approved.json");
    writeFileSync(approverKey, JSON.stringify(Array.from(approver.solanaKey)));
    const approved = runSignCli(["--keypair", approverKey, "--approve", outPath, "--out", approvedPath]);
    expect(approved.code, approved.stderr).toBe(0);
    const withApproval = JSON.parse(readFileSync(approvedPath, "utf8")) as unknown;
    const checked = verifyHubUpdates([withApproval], new Set([author.publicKey, approver.publicKey]), 1);
    expect(checked.updates.map((update) => update.id)).toEqual(["cli-1"]);
    expect(checked.rejected).toEqual([]);

    const duplicate = runSignCli(["--keypair", approverKey, "--approve", approvedPath, "--out", path.join(directory, "again.json")]);
    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr).toMatch(/already approved/);
  });
});

describe("sign-hub-update --drop-approval", () => {
  it("removes one approval by key and keeps the payload, the author signature, and the other approvals", () => {
    const author = signer();
    const old = signer();
    const next = signer();
    const directory = mkdtempSync(path.join(tmpdir(), "hub-drop-"));
    const body = payload(author.publicKey, { id: "drop-1" });
    const doc = document(author, body, [author, old]);
    const inPath = path.join(directory, "in.json");
    const outPath = path.join(directory, "out.json");
    writeFileSync(inPath, JSON.stringify(doc));

    const dropped = runSignCli(["--drop-approval", inPath, "--public-key", old.publicKey, "--out", outPath]);
    expect(dropped.code, dropped.stderr).toBe(0);
    expect(dropped.stderr).toBe(`Dropped the approval by ${old.publicKey} from drop-1\n`);
    const written = JSON.parse(readFileSync(outPath, "utf8")) as typeof doc;
    expect(written.payload).toEqual(doc.payload);
    expect(written.signature).toBe(doc.signature);
    expect(written.approvals).toEqual([doc.approvals[0]]);

    // Below threshold until the replacement approval is attached; then it verifies with the new key only.
    const trusted = new Set([author.publicKey, next.publicKey]);
    expect(verifyHubUpdates([written], trusted, 2, undefined, { allowAuthorApproval: true }).updates).toEqual([]);
    written.approvals.push({ publicKey: next.publicKey, signature: next.approve(body) });
    const checked = verifyHubUpdates([written], trusted, 2, undefined, { allowAuthorApproval: true });
    expect(checked.updates.map((update) => update.approvedBy)).toEqual([[author.publicKey, next.publicKey].sort()]);

    const again = runSignCli(["--drop-approval", outPath, "--public-key", old.publicKey]);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/no approval/);
    expect(runSignCli(["--drop-approval", inPath]).code).toBe(1);
    expect(runSignCli(["--drop-approval", inPath, "--public-key", old.publicKey, "--signature", "x"]).code).toBe(1);
  });

  it("refuses a document whose author signature does not verify", () => {
    const author = signer();
    const old = signer();
    const directory = mkdtempSync(path.join(tmpdir(), "hub-drop-bad-"));
    const doc = document(author, payload(author.publicKey, { id: "drop-2" }), [author, old]);
    doc.payload.body = "changed";
    const inPath = path.join(directory, "in.json");
    writeFileSync(inPath, JSON.stringify(doc));
    const result = runSignCli(["--drop-approval", inPath, "--public-key", old.publicKey]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/could not be verified/);
  });
});

describe("agents signer set", () => {
  it("ships hub/signers/agents.json with the two Phoenix agent record keys", () => {
    const keys = loadSignerAllowlist(path.resolve("hub/signers/agents.json"));
    expect([...keys]).toEqual(["G2PhCi6MApcuC6f5o2CDQBWDnJt9hRcozHuuN55PYisU", "AANzSFjMzGuKn5gC1YygMsZZGeLUiMM9HAmKH6n2YqgH"]);
    const labels = parseHubSigners(JSON.parse(readFileSync("hub/signers/agents.json", "utf8"))).map((entry) => entry.label);
    expect(labels).toEqual(["Phoenix Collective (Falkor's team)", "Phoenix reviewer"]);
  });
});

describe("hub manifest filename", () => {
  it("writes hub-manifest.json and reads manifest.json only when that default is missing", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "hub-manifest-name-"));
    const skeleton = path.join(scratch, "skeleton");
    const init = runStoreInitCli(["--dir", skeleton]);
    expect(init.code, init.stderr).toBe(0);
    expect(init.stdout).toBe("Wrote README.md, hub-manifest.json, and updates/.\n");
    expect(existsSync(path.join(skeleton, "hub-manifest.json"))).toBe(true);
    expect(existsSync(path.join(skeleton, "manifest.json"))).toBe(false);

    const author = signer();
    const body = payload(author.publicKey, { body: "Legacy manifest" });
    const signed = document(author, body, [author]);
    const legacyText = `${JSON.stringify({ v: 1, updates: ["updates/one.json"] })}\n`;
    const defaultText = JSON.stringify({ v: 1, updates: ["updates/one.json"] });
    const repo = path.join(scratch, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    mkdirSync(path.join(repo, "updates"));
    writeFileSync(path.join(repo, "updates", "one.json"), JSON.stringify(signed));
    writeFileSync(path.join(repo, "manifest.json"), legacyText);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "legacy"]);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const legacyHash = createHash("sha256").update(legacyText).digest("hex");
    const defaultHash = createHash("sha256").update(defaultText).digest("hex");
    expect(defaultHash).not.toBe(legacyHash);
    const allowlist = new Set([author.publicKey]);

    const unset = loadConfig({
      HUB_GIT_REPO: repo,
      HUB_GIT_COMMIT: commit,
      HUB_STORE_MANIFEST_HASH: legacyHash,
    });
    expect(unset.hubStoreManifest).toBe("hub-manifest.json");
    expect(unset.hubStoreManifestFallback).toBe(true);
    const served = await readHubUpdates(
      {
        repo: unset.hubGitRepo,
        commit: unset.hubGitCommit,
        manifestPath: unset.hubStoreManifest,
        manifestHash: unset.hubStoreManifestHash,
        manifestFallback: unset.hubStoreManifestFallback,
      },
      allowlist,
      1,
    );
    expect(served.updates.map((update) => update.body)).toEqual(["Legacy manifest"]);
    expect(served.updates[0]?.approvedBy).toEqual([author.publicKey]);

    const pinnedDefault = loadConfig({
      HUB_GIT_REPO: repo,
      HUB_GIT_COMMIT: commit,
      HUB_STORE_MANIFEST: "hub-manifest.json",
      HUB_STORE_MANIFEST_HASH: legacyHash,
    });
    expect(pinnedDefault.hubStoreManifestFallback).toBe(false);
    await expect(
      readHubUpdates(
        {
          repo: pinnedDefault.hubGitRepo,
          commit: pinnedDefault.hubGitCommit,
          manifestPath: pinnedDefault.hubStoreManifest,
          manifestHash: pinnedDefault.hubStoreManifestHash,
          manifestFallback: pinnedDefault.hubStoreManifestFallback,
        },
        allowlist,
        1,
      ),
    ).rejects.toThrow(/manifest is not valid/);

    await expect(
      readHubUpdates(
        {
          repo,
          commit,
          manifestPath: "hub-manifest.json",
          manifestHash: "0".repeat(64),
          manifestFallback: true,
        },
        allowlist,
        1,
      ),
    ).rejects.toThrow(/manifest hash did not match/);

    writeFileSync(path.join(repo, "hub-manifest.json"), defaultText);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "both"]);
    const bothCommit = git(repo, ["rev-parse", "HEAD"]);
    await expect(
      readHubUpdates(
        {
          repo,
          commit: bothCommit,
          manifestPath: "hub-manifest.json",
          manifestHash: legacyHash,
          manifestFallback: true,
        },
        allowlist,
        1,
      ),
    ).rejects.toThrow(/manifest hash did not match/);
    const fromDefault = await readHubUpdates(
      {
        repo,
        commit: bothCommit,
        manifestPath: "hub-manifest.json",
        manifestHash: defaultHash,
        manifestFallback: true,
      },
      allowlist,
      1,
    );
    expect(fromDefault.updates.map((update) => update.body)).toEqual(["Legacy manifest"]);

    const outside = path.join(scratch, "outside.json");
    writeFileSync(outside, legacyText);
    const linked = path.join(scratch, "linked");
    mkdirSync(linked);
    git(linked, ["init", "-b", "main"]);
    mkdirSync(path.join(linked, "updates"));
    writeFileSync(path.join(linked, "updates", "one.json"), JSON.stringify(signed));
    symlinkSync(outside, path.join(linked, "manifest.json"));
    git(linked, ["add", "."]);
    git(linked, ["commit", "-m", "link"]);
    const linkCommit = git(linked, ["rev-parse", "HEAD"]);
    await expect(
      readHubUpdates(
        {
          repo: linked,
          commit: linkCommit,
          manifestPath: "hub-manifest.json",
          manifestHash: legacyHash,
          manifestFallback: true,
        },
        allowlist,
        1,
      ),
    ).rejects.toThrow(/manifest is not valid/);
  });
});
