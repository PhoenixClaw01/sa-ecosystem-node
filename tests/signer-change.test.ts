import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";

import { readHubUpdates } from "../src/dao/hub.js";
import { base58Encode } from "../src/hub/base58.js";
import { runSignCli } from "../src/hub/sign-cli.js";
import {
  HUB_APPROVAL_DOMAIN,
  HUB_UPDATE_DOMAIN,
  canonicalHubPayload,
  hubUpdateHash,
  verifyHubUpdates,
  type HubUpdatePayload,
  type SignerSet,
} from "../src/hub/update.js";

function signer() {
  const pair = nacl.sign.keyPair();
  const publicKey = base58Encode(pair.publicKey);
  return {
    publicKey,
    solanaKey: pair.secretKey,
    sign(body: HubUpdatePayload) {
      const message = new TextEncoder().encode(HUB_UPDATE_DOMAIN + canonicalHubPayload(body));
      return base58Encode(nacl.sign.detached(message, pair.secretKey));
    },
    approve(body: HubUpdatePayload) {
      const message = new TextEncoder().encode(HUB_APPROVAL_DOMAIN + hubUpdateHash(body));
      return base58Encode(nacl.sign.detached(message, pair.secretKey));
    },
  };
}

type Wallet = ReturnType<typeof signer>;

function changePayload(
  author: string,
  over: { id?: string; createdAt?: string; prev?: string | null; op?: "add" | "remove"; publicKey: string; set?: string; body?: string },
): HubUpdatePayload {
  return {
    v: 1,
    id: over.id ?? "change-1",
    created_at: over.createdAt ?? "2026-10-24T00:00:00.000Z",
    author,
    kind: "signer-change",
    body: over.body ?? "Change one signer.",
    refs: { pip: null, txs: [] },
    prev: over.prev ?? null,
    change: { op: over.op ?? "add", publicKey: over.publicKey, set: over.set ?? "default" },
  };
}

function note(author: Wallet, over: { id?: string; prev?: string | null; body?: string } = {}): HubUpdatePayload {
  return {
    v: 1,
    id: over.id ?? "note-1",
    created_at: "2026-10-24T02:00:00.000Z",
    author: author.publicKey,
    kind: "announcement",
    body: over.body ?? "Hello",
    refs: { pip: null, txs: [] },
    prev: over.prev ?? null,
  };
}

function document(author: Wallet, body: HubUpdatePayload, approvers: Wallet[]) {
  return {
    payload: body,
    signature: author.sign(body),
    approvals: approvers.map((approver) => ({ publicKey: approver.publicKey, signature: approver.approve(body) })),
  };
}

function setsOf(groups: { id: string; threshold: number; members: Wallet[] }[]): SignerSet[] {
  return groups.map((group) => ({
    id: group.id,
    threshold: group.threshold,
    publicKeys: new Set(group.members.map((member) => member.publicKey)),
  }));
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

describe("signer-change updates", () => {
  it("applies an add only when other current signers meet the threshold, and lists who signed", () => {
    const author = signer();
    const left = signer();
    const right = signer();
    const added = signer();
    const sets = setsOf([{ id: "default", threshold: 2, members: [author, left, right] }]);
    const body = changePayload(author.publicKey, { publicKey: added.publicKey });
    const short = verifyHubUpdates([document(author, body, [author, left])], new Set(), 2, sets);
    expect(short.updates).toEqual([]);
    expect(short.rejected).toEqual([{ id: "change-1", reason: "below_threshold" }]);

    const accepted = verifyHubUpdates([document(author, body, [left, right])], new Set(), 2, sets);
    expect(accepted.rejected).toEqual([]);
    expect(accepted.updates).toHaveLength(1);
    expect(accepted.updates[0]).toMatchObject({
      kind: "signer-change",
      approvalCount: 2,
      change: { op: "add", publicKey: added.publicKey, set: "default" },
    });
    expect(accepted.updates[0]?.signedBy).toEqual([author.publicKey, left.publicKey, right.publicKey].sort());

    const follow = note(added, { id: "after", prev: accepted.updates[0]?.hash });
    const next = verifyHubUpdates(
      [document(author, body, [left, right]), document(added, follow, [left, right])],
      new Set(),
      2,
      sets,
    );
    expect(next.rejected).toEqual([]);
    expect(next.updates.map((update) => update.id)).toEqual(["change-1", "after"]);
    expect(sets[0]?.publicKeys.has(added.publicKey)).toBe(false);
  });

  it("rejects a self-add, a replay, and a removal that drops below the threshold", () => {
    const author = signer();
    const left = signer();
    const right = signer();
    const added = signer();
    const sets = setsOf([{ id: "default", threshold: 2, members: [author, left, right] }]);

    const self = changePayload(author.publicKey, { publicKey: author.publicKey, id: "self" });
    const selfChecked = verifyHubUpdates([document(author, self, [left, right])], new Set(), 2, sets);
    expect(selfChecked.updates).toEqual([]);
    expect(selfChecked.rejected).toEqual([{ id: "self", reason: "self_add" }]);

    const add = changePayload(author.publicKey, { publicKey: added.publicKey, id: "add" });
    const again = changePayload(author.publicKey, {
      publicKey: added.publicKey,
      id: "add-again",
      createdAt: "2026-10-24T01:00:00.000Z",
      prev: hubUpdateHash(add),
    });
    const replayed = verifyHubUpdates(
      [document(author, add, [left, right]), document(author, again, [left, right])],
      new Set(),
      2,
      sets,
    );
    expect(replayed.updates.map((update) => update.id)).toEqual(["add"]);
    expect(replayed.rejected).toEqual([{ id: "add-again", reason: "replay" }]);

    const duplicate = { publicKey: left.publicKey, signature: left.approve(add) };
    const countedOnce = verifyHubUpdates(
      [{ payload: add, signature: author.sign(add), approvals: [duplicate, duplicate] }],
      new Set(),
      2,
      sets,
    );
    expect(countedOnce.rejected).toEqual([{ id: "add", reason: "below_threshold" }]);

    const pair = setsOf([{ id: "default", threshold: 2, members: [author, left] }]);
    const removal = changePayload(author.publicKey, { op: "remove", publicKey: left.publicKey, id: "drop" });
    const dropped = verifyHubUpdates([document(author, removal, [left])], new Set(), 2, pair);
    expect(dropped.updates).toEqual([]);
    expect(dropped.rejected).toEqual([{ id: "drop", reason: "drops_below_threshold" }]);
  });

  it("trusts only the configured signer sets and can remove a signer who is not adding themselves", () => {
    const alpha = signer();
    const beta = signer();
    const other = signer();
    const added = signer();
    const trusted = setsOf([
      { id: "alpha", threshold: 1, members: [alpha, other] },
      { id: "beta", threshold: 1, members: [beta, other] },
    ]);
    const addBeta = changePayload(beta.publicKey, { publicKey: added.publicKey, set: "beta", id: "beta-add" });
    const accepted = verifyHubUpdates([document(beta, addBeta, [other])], new Set(), 1, trusted);
    expect(accepted.rejected).toEqual([]);
    expect(accepted.updates[0]?.signedBy).toEqual([beta.publicKey, other.publicKey].sort());

    const alphaOnly = setsOf([{ id: "alpha", threshold: 1, members: [alpha, other] }]);
    const ignored = verifyHubUpdates([document(beta, addBeta, [other])], new Set(), 1, alphaOnly);
    expect(ignored.updates).toEqual([]);
    expect(ignored.rejected).toEqual([{ id: "beta-add", reason: "untrusted_set" }]);

    const removal = changePayload(alpha.publicKey, {
      op: "remove",
      publicKey: alpha.publicKey,
      set: "alpha",
      id: "leave",
      createdAt: "2026-10-24T03:00:00.000Z",
    });
    const left = verifyHubUpdates([document(alpha, removal, [other])], new Set(), 1, alphaOnly);
    expect(left.rejected).toEqual([]);
    const after = note(alpha, { prev: left.updates[0]?.hash });
    const gone = verifyHubUpdates(
      [document(alpha, removal, [other]), document(alpha, after, [alpha])],
      new Set(),
      1,
      alphaOnly,
    );
    expect(gone.updates.map((update) => update.id)).toEqual(["leave"]);
    expect(gone.rejected).toEqual([{ id: "note-1", reason: "unknown_signer" }]);
  });

  it("does not rewrite hub/signers.json and serves a pinned signer-change only for a set the node trusts", async () => {
    const before = readFileSync("hub/signers.json", "utf8");
    const author = signer();
    const approver = signer();
    const added = signer();
    const body = changePayload(author.publicKey, { publicKey: added.publicKey, set: "council" });
    const signed = document(author, body, [approver]);
    const repo = mkdtempSync(path.join(tmpdir(), "hub-signers-"));
    git(repo, ["init", "-b", "main"]);
    mkdirSync(path.join(repo, "updates"));
    writeFileSync(path.join(repo, "updates", "one.json"), JSON.stringify(signed));
    writeFileSync(path.join(repo, "hub-manifest.json"), JSON.stringify({ v: 1, updates: ["updates/one.json"] }));
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "pin"]);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const manifestHash = createHash("sha256").update(readFileSync(path.join(repo, "hub-manifest.json"))).digest("hex");
    const source = { repo, commit, manifestPath: "hub-manifest.json", manifestHash };
    const sets = setsOf([{ id: "council", threshold: 1, members: [author, approver] }]);
    const result = await readHubUpdates(source, new Set(), 1, undefined, sets);
    expect(result.updates.map((update) => update.kind)).toEqual(["signer-change"]);
    expect(result.updates[0]?.signedBy).toContain(approver.publicKey);
    expect(result.rejected).toEqual([]);
    expect(readFileSync("hub/signers.json", "utf8")).toBe(before);
  });

  it("signs a signer-change with the local key file and still needs another signer", () => {
    const author = signer();
    const added = signer();
    const directory = mkdtempSync(path.join(tmpdir(), "hub-sign-change-"));
    const keyPath = path.join(directory, "author.keypair.json");
    const payloadPath = path.join(directory, "update.json");
    const outPath = path.join(directory, "update.signed.json");
    writeFileSync(keyPath, JSON.stringify(Array.from(author.solanaKey)));
    writeFileSync(payloadPath, JSON.stringify(changePayload(author.publicKey, { publicKey: added.publicKey, id: "cli" })));
    const signed = runSignCli(["--keypair", keyPath, "--payload", payloadPath, "--out", outPath]);
    expect(signed.code, signed.stderr).toBe(0);
    expect(signed.stderr).not.toContain("[");
    const alone = verifyHubUpdates(
      [JSON.parse(readFileSync(outPath, "utf8")) as unknown],
      new Set([author.publicKey]),
      1,
    );
    expect(alone.updates).toEqual([]);
    expect(alone.rejected).toEqual([{ id: "cli", reason: "below_threshold" }]);
  });
});
