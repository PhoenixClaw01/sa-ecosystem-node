import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";

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
  type SignerSet,
} from "../src/hub/update.js";

function signer() {
  const pair = nacl.sign.keyPair();
  const publicKey = base58Encode(pair.publicKey);
  return {
    publicKey,
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

function payload(author: string, over: Partial<HubUpdatePayload> = {}): HubUpdatePayload {
  return {
    v: 1,
    id: over.id ?? "update-1",
    created_at: over.created_at ?? "2026-10-24T00:00:00.000Z",
    author,
    kind: over.kind ?? "announcement",
    body: over.body ?? "Hello hub",
    refs: over.refs ?? { pip: null, txs: [] },
    prev: over.prev ?? null,
    ...(over.change ? { change: over.change } : {}),
  };
}

function document(author: Wallet, body: HubUpdatePayload, approvers: Wallet[]) {
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

describe("self-approval", () => {
  it("allows the author as the only approver at threshold 1 and reports selfApproved", () => {
    const author = signer();
    const other = signer();
    const body = payload(author.publicKey);
    const allowlist = new Set([author.publicKey, other.publicKey]);

    const alone = verifyHubUpdates([document(author, body, [author])], allowlist, 1);
    expect(alone.rejected).toEqual([]);
    expect(alone.updates.map((update) => [update.approvalCount, update.selfApproved])).toEqual([[1, true]]);

    const otherOnly = verifyHubUpdates([document(author, body, [other])], allowlist, 1);
    expect(otherOnly.updates.map((update) => update.selfApproved)).toEqual([false]);

    const both = verifyHubUpdates([document(author, body, [author, other])], allowlist, 1);
    expect(both.updates.map((update) => [update.approvalCount, update.selfApproved])).toEqual([[2, false]]);
  });

  it("does not count the author at threshold 2 unless the node allows it", () => {
    const author = signer();
    const left = signer();
    const right = signer();
    const body = payload(author.publicKey);
    const allowlist = new Set([author.publicKey, left.publicKey, right.publicKey]);

    const authorAndOne = verifyHubUpdates([document(author, body, [author, left])], allowlist, 2);
    expect(authorAndOne.updates).toEqual([]);
    expect(authorAndOne.rejected).toEqual([{ id: "update-1", reason: "below_threshold" }]);

    const authorAlone = verifyHubUpdates([document(author, body, [author])], allowlist, 2, undefined, {
      allowAuthorApproval: true,
    });
    expect(authorAlone.rejected).toEqual([{ id: "update-1", reason: "below_threshold" }]);

    const allowed = verifyHubUpdates([document(author, body, [author, left])], allowlist, 2, undefined, {
      allowAuthorApproval: true,
    });
    expect(allowed.rejected).toEqual([]);
    expect(allowed.updates.map((update) => [update.approvalCount, update.selfApproved])).toEqual([[2, false]]);

    const twoOthers = verifyHubUpdates([document(author, body, [left, right])], allowlist, 2);
    expect(twoOthers.rejected).toEqual([]);
    expect(twoOthers.updates.map((update) => [update.approvalCount, update.selfApproved])).toEqual([[2, false]]);
  });

  it("puts only counted approvers in approvedBy and still lists the author in signedBy", () => {
    const author = signer();
    const left = signer();
    const right = signer();
    const outsider = signer();
    const body = payload(author.publicKey);
    const allowlist = new Set([author.publicKey, left.publicKey, right.publicKey]);
    const sorted = (...keys: string[]) => [...keys].sort();

    const twoOthers = verifyHubUpdates([document(author, body, [left, right])], allowlist, 2);
    expect(twoOthers.rejected).toEqual([]);
    expect(twoOthers.updates[0]?.signedBy).toEqual(sorted(author.publicKey, left.publicKey, right.publicKey));
    expect(twoOthers.updates[0]?.approvedBy).toEqual(sorted(left.publicKey, right.publicKey));

    const authorAndTwo = verifyHubUpdates([document(author, body, [author, left, right])], allowlist, 2);
    expect(authorAndTwo.updates[0]?.signedBy).toEqual(sorted(author.publicKey, left.publicKey, right.publicKey));
    expect(authorAndTwo.updates[0]?.approvedBy).toEqual(sorted(left.publicKey, right.publicKey));
    expect(authorAndTwo.updates[0]?.approvedBy).not.toContain(author.publicKey);

    const countedAuthor = verifyHubUpdates([document(author, body, [author, left])], allowlist, 2, undefined, {
      allowAuthorApproval: true,
    });
    expect(countedAuthor.updates[0]?.approvedBy).toEqual(sorted(author.publicKey, left.publicKey));

    const alone = verifyHubUpdates([document(author, body, [author])], allowlist, 1);
    expect(alone.updates[0]?.approvedBy).toEqual([author.publicKey]);
    expect(alone.updates[0]?.signedBy).toEqual([author.publicKey]);

    const withOutsider = verifyHubUpdates([document(author, body, [left, right, outsider])], allowlist, 2);
    expect(withOutsider.updates[0]?.signedBy).toEqual(
      sorted(author.publicKey, left.publicKey, right.publicKey, outsider.publicKey),
    );
    expect(withOutsider.updates[0]?.approvedBy).toEqual(sorted(left.publicKey, right.publicKey));

    const revoked = verifyHubUpdates([document(author, body, [left, right])], allowlist, 1, undefined, {
      revokedSigners: new Set([right.publicKey]),
    });
    expect(revoked.updates[0]?.approvalCount).toBe(1);
    expect(revoked.updates[0]?.approvedBy).toEqual([left.publicKey]);
    expect(revoked.updates[0]?.signedBy).toContain(right.publicKey);

    const change = payload(author.publicKey, {
      id: "change-1",
      kind: "signer-change",
      change: { op: "add", publicKey: outsider.publicKey, set: "default" },
    });
    const sets: SignerSet[] = [{ id: "default", threshold: 2, publicKeys: allowlist }];
    const changed = verifyHubUpdates([document(author, change, [author, left, right])], allowlist, 2, sets);
    expect(changed.rejected).toEqual([]);
    expect(changed.updates[0]?.signedBy).toContain(author.publicKey);
    expect(changed.updates[0]?.approvedBy).toEqual(sorted(left.publicKey, right.publicKey));
  });
});

describe("revoked signers", () => {
  it("rejects a revoked key as revoked_signer while the key is still on the allowlist", () => {
    const author = signer();
    const body = payload(author.publicKey);
    const allowlist = new Set([author.publicKey]);
    const signed = document(author, body, [author]);

    const open = verifyHubUpdates([signed], allowlist, 1);
    expect(open.updates).toHaveLength(1);
    expect(open.updates[0]?.selfApproved).toBe(true);

    const closed = verifyHubUpdates([signed], allowlist, 1, undefined, { revokedSigners: new Set([author.publicKey]) });
    expect(closed.updates).toEqual([]);
    expect(closed.rejected).toEqual([{ id: "update-1", reason: "revoked_signer" }]);
  });

  it("still requires a second valid approval when one co-signer is not revoked", () => {
    const author = signer();
    const revoked = signer();
    const good = signer();
    const second = signer();
    const body = payload(author.publicKey);
    const allowlist = new Set([author.publicKey, revoked.publicKey, good.publicKey, second.publicKey]);
    const revokedSigners = new Set([revoked.publicKey]);

    const oneGood = verifyHubUpdates([document(author, body, [revoked, good])], allowlist, 2, undefined, { revokedSigners });
    expect(oneGood.updates).toEqual([]);
    expect(oneGood.rejected).toEqual([{ id: "update-1", reason: "below_threshold" }]);

    const onlyRevoked = verifyHubUpdates([document(author, body, [revoked])], allowlist, 1, undefined, { revokedSigners });
    expect(onlyRevoked.updates).toEqual([]);
    expect(onlyRevoked.rejected).toEqual([{ id: "update-1", reason: "revoked_signer" }]);

    const enough = verifyHubUpdates([document(author, body, [revoked, good, second])], allowlist, 2, undefined, {
      revokedSigners,
    });
    expect(enough.rejected).toEqual([]);
    expect(enough.updates.map((update) => [update.approvalCount, update.selfApproved])).toEqual([[2, false]]);
  });

  it("keeps unknown_signer for an author who is not on the allowlist", () => {
    const author = signer();
    const approver = signer();
    const body = payload(author.publicKey);
    const checked = verifyHubUpdates([document(author, body, [approver])], new Set([approver.publicKey]), 1, undefined, {
      revokedSigners: new Set([author.publicKey, approver.publicKey]),
    });
    expect(checked.rejected).toEqual([{ id: "update-1", reason: "unknown_signer" }]);
  });

  it("applies a revoked co-signer to a signer-change without revoking the whole set", () => {
    const author = signer();
    const revoked = signer();
    const good = signer();
    const added = signer();
    const sets: SignerSet[] = [
      { id: "default", threshold: 1, publicKeys: new Set([author.publicKey, revoked.publicKey, good.publicKey]) },
    ];
    const body = payload(author.publicKey, {
      id: "change-1",
      kind: "signer-change",
      change: { op: "add", publicKey: added.publicKey, set: "default" },
    });
    const revokedOnly = verifyHubUpdates([document(author, body, [revoked])], new Set(), 1, sets, {
      revokedSigners: new Set([revoked.publicKey]),
    });
    expect(revokedOnly.rejected).toEqual([{ id: "change-1", reason: "revoked_signer" }]);
    const accepted = verifyHubUpdates([document(author, body, [revoked, good])], new Set(), 1, sets, {
      revokedSigners: new Set([revoked.publicKey]),
    });
    expect(accepted.rejected).toEqual([]);
    expect(accepted.updates[0]?.approvalCount).toBe(1);
    expect(sets[0]?.publicKeys.has(added.publicKey)).toBe(false);
  });

  it("serves the same pinned file until the local revoked list is passed", async () => {
    const before = readFileSync("hub/signers.json", "utf8");
    const author = signer();
    const body = payload(author.publicKey, { body: "Pinned" });
    const signed = document(author, body, [author]);
    const repo = mkdtempSync(path.join(tmpdir(), "hub-revoked-"));
    git(repo, ["init", "-b", "main"]);
    mkdirSync(path.join(repo, "updates"));
    writeFileSync(path.join(repo, "updates", "one.json"), JSON.stringify(signed));
    writeFileSync(path.join(repo, "hub-manifest.json"), JSON.stringify({ v: 1, updates: ["updates/one.json"] }));
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "pin"]);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const manifestHash = createHash("sha256").update(readFileSync(path.join(repo, "hub-manifest.json"))).digest("hex");
    const source = { repo, commit, manifestPath: "hub-manifest.json", manifestHash };
    const allowlist = new Set([author.publicKey]);

    const open = await readHubUpdates(source, allowlist, 1);
    expect(open.updates.map((update) => update.selfApproved)).toEqual([true]);

    const closed = await readHubUpdates(source, allowlist, 1, undefined, undefined, {
      revokedSigners: new Set([author.publicKey]),
    });
    expect(closed.updates).toEqual([]);
    expect(closed.rejected).toEqual([{ id: "update-1", reason: "revoked_signer" }]);
    expect(loadConfig({}).hubApprovalThreshold).toBe(1);
    expect(loadConfig({}).hubRevokedSigners).toEqual([]);
    expect(readFileSync("hub/signers.json", "utf8")).toBe(before);
  });
});
