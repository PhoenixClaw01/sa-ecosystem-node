import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";

import { withStoryConsent } from "../src/dao/hub.js";
import { runAddUpdateCli } from "../src/hub/add-update-cli.js";
import { base58Encode } from "../src/hub/base58.js";
import { runKeygenCli } from "../src/hub/keygen-cli.js";
import {
  REPUTATION_DEFAULT_SCOPE,
  REPUTATION_LINK_EXPLANATION,
  matchReputationLink,
  parseReputationLink,
  reputationLinkConsent,
  reputationLinkMessage,
  reputationUnlinkMessage,
  resolveReputationLink,
  type ReputationLink,
  type ReputationScope,
} from "../src/hub/reputation-link.js";
import { runStoreInitCli } from "../src/hub/store-init-cli.js";
import {
  HUB_APPROVAL_DOMAIN,
  HUB_UPDATE_KINDS,
  canonicalHubPayload,
  hubUpdateHash,
  parseHubPayload,
  verifyHubUpdates,
  type HubUpdatePayload,
} from "../src/hub/update.js";

const HUB = "https://github.com/example/reputation-hub";
const OTHER_HUB = "https://github.com/example/other-hub";
const TODAY = "2026-10-31";
const PROFILE = "Pilot";

function bytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  out[0] = seed;
  out[length - 1] = 9;
  return out;
}

function playerWallet() {
  const pair = nacl.sign.keyPair();
  const wallet = base58Encode(pair.publicKey);
  return {
    wallet,
    sign(action: "link" | "unlink", date: string, scope: ReputationScope = "legacy", profile = PROFILE, hubId = HUB) {
      const text =
        action === "unlink"
          ? reputationUnlinkMessage(wallet, profile, hubId, date)
          : reputationLinkMessage(wallet, profile, hubId, scope, date);
      return base58Encode(nacl.sign.detached(new TextEncoder().encode(text), pair.secretKey));
    },
  };
}

function hubSigner() {
  const pair = nacl.sign.keyPair();
  const publicKey = base58Encode(pair.publicKey);
  return {
    publicKey,
    sign(payload: HubUpdatePayload) {
      const message = new TextEncoder().encode(`sa-ecosystem-node:hub-update:v1\n${canonicalHubPayload(payload)}`);
      return base58Encode(nacl.sign.detached(message, pair.secretKey));
    },
    approve(body: HubUpdatePayload) {
      const message = new TextEncoder().encode(HUB_APPROVAL_DOMAIN + hubUpdateHash(body));
      return base58Encode(nacl.sign.detached(message, pair.secretKey));
    },
  };
}

function linkOf(
  player: ReturnType<typeof playerWallet>,
  action: "link" | "unlink",
  date: string,
  scope: ReputationScope = "legacy",
  profile = PROFILE,
  hubId = HUB,
): ReputationLink {
  return {
    action,
    wallet: player.wallet,
    profile,
    date,
    signature: player.sign(action, date, scope, profile, hubId),
  };
}

function payload(
  author: string,
  player: ReturnType<typeof playerWallet>,
  action: "link" | "unlink",
  date: string,
  over: Partial<HubUpdatePayload> = {},
  scope: ReputationScope = "legacy",
  profile = PROFILE,
  hubId = HUB,
): HubUpdatePayload {
  return {
    v: 1,
    id: over.id ?? `${action}-${date}-${scope}`,
    created_at: over.created_at ?? `${date}T00:00:00.000Z`,
    author,
    kind: "reputation-link",
    body: over.body ?? (action === "unlink" ? "Unlink the profile." : "Link the profile."),
    refs: over.refs ?? { pip: null, txs: [] },
    prev: over.prev ?? null,
    reputationLink: linkOf(player, action, date, scope, profile, hubId),
  };
}

function document(author: ReturnType<typeof hubSigner>, body: HubUpdatePayload) {
  return {
    payload: body,
    signature: author.sign(body),
    approvals: [{ publicKey: author.publicKey, signature: author.approve(body) }],
  };
}

function chain(author: ReturnType<typeof hubSigner>, bodies: HubUpdatePayload[]) {
  const docs = bodies.map((body) => document(author, body));
  const checked = verifyHubUpdates(docs, new Set([author.publicKey]), 1);
  expect(checked.rejected).toEqual([]);
  return withStoryConsent(checked.updates, HUB, TODAY);
}

describe("reputation-link kind", () => {
  it("accepts a valid link for the smallest scope and no other scope", () => {
    const author = hubSigner();
    const player = playerWallet();
    const body = payload(author.publicKey, player, "link", TODAY);
    const parsed = parseHubPayload(JSON.parse(JSON.stringify(body)));
    expect(parsed?.kind).toBe("reputation-link");
    expect(parsed?.reputationLink && "scope" in parsed.reputationLink).toBe(false);
    expect(matchReputationLink(body.reputationLink!, HUB)).toEqual({ action: "link", scope: "legacy" });
    expect(reputationLinkConsent(body.reputationLink!, HUB)).toBe("valid");
    expect(REPUTATION_DEFAULT_SCOPE).toBe("legacy");
    const shown = chain(author, [body]);
    expect(shown[0]?.consent).toBe("valid");
    expect(shown[0]?.linkShown).toBe(true);
    expect(resolveReputationLink(shown, player.wallet, { hubId: HUB, today: TODAY })).toEqual({
      linked: true,
      scopes: ["legacy"],
      profiles: [{ profile: PROFILE, scopes: ["legacy"] }],
    });
    const canonical = JSON.parse(canonicalHubPayload(body)) as { reputationLink: Record<string, string> };
    expect(canonical.reputationLink).not.toHaveProperty("scope");
  });

  it("adds a second scope on a later day and keeps the first", () => {
    const author = hubSigner();
    const player = playerWallet();
    const first = payload(author.publicKey, player, "link", "2026-10-30", { id: "link-legacy" }, "legacy");
    const second = payload(
      author.publicKey,
      player,
      "link",
      TODAY,
      { id: "link-fleets", prev: hubUpdateHash(first) },
      "fleets",
    );
    const shown = chain(author, [first, second]);
    expect(resolveReputationLink(shown, player.wallet, { hubId: HUB, today: TODAY }).scopes).toEqual(["legacy", "fleets"]);
    expect(shown.map((update) => update.linkShown)).toEqual([true, true]);
  });

  it("does not count a second link on the same day", () => {
    const author = hubSigner();
    const player = playerWallet();
    const first = payload(author.publicKey, player, "link", TODAY, { id: "link-legacy" }, "legacy");
    const second = payload(
      author.publicKey,
      player,
      "link",
      TODAY,
      { id: "link-fleets", created_at: "2026-10-31T01:00:00.000Z", prev: hubUpdateHash(first) },
      "fleets",
    );
    const shown = chain(author, [first, second]);
    expect(shown[1]?.consent).toBe("valid");
    expect(shown[1]?.linkShown).toBe(false);
    expect(resolveReputationLink(shown, player.wallet, { hubId: HUB, today: TODAY }).scopes).toEqual(["legacy"]);
  });

  it("treats an unlink as hiding the link, including a same-day link", () => {
    const author = hubSigner();
    const player = playerWallet();
    const link = payload(author.publicKey, player, "link", "2026-10-30", { id: "link-legacy" });
    const unlink = payload(author.publicKey, player, "unlink", TODAY, {
      id: "unlink-later",
      prev: hubUpdateHash(link),
    });
    const hidden = chain(author, [link, unlink]);
    expect(hidden[1]?.consent).toBe("valid");
    expect(hidden[1]?.linkShown).toBe(false);
    expect(resolveReputationLink(hidden, player.wallet, { hubId: HUB, today: TODAY }).linked).toBe(false);

    const sameDayLink = payload(author.publicKey, player, "link", TODAY, { id: "link-same" }, "fleets");
    const sameDayUnlink = payload(author.publicKey, player, "unlink", TODAY, {
      id: "unlink-same",
      created_at: "2026-10-31T02:00:00.000Z",
      prev: hubUpdateHash(sameDayLink),
    });
    const sameDay = chain(author, [sameDayLink, sameDayUnlink]);
    expect(resolveReputationLink(sameDay, player.wallet, { hubId: HUB, today: TODAY }).linked).toBe(false);

    const unlinkFirst = payload(author.publicKey, player, "unlink", TODAY, { id: "unlink-first" });
    const linkAfter = payload(author.publicKey, player, "link", TODAY, {
      id: "link-after",
      created_at: "2026-10-31T03:00:00.000Z",
      prev: hubUpdateHash(unlinkFirst),
    });
    const reversed = chain(author, [unlinkFirst, linkAfter]);
    expect(resolveReputationLink(reversed, player.wallet, { hubId: HUB, today: TODAY }).linked).toBe(false);

    const again = payload(author.publicKey, player, "link", "2026-11-01", {
      id: "link-again",
      prev: hubUpdateHash(unlink),
    });
    const restored = chain(author, [link, unlink, again]);
    expect(resolveReputationLink(restored, player.wallet, { hubId: HUB, today: "2026-11-01" }).scopes).toEqual(["legacy"]);
    expect(resolveReputationLink(restored, player.wallet, { hubId: HUB, today: TODAY }).linked).toBe(false);
  });

  it("leaves a bad signature, the wrong hub, and the wrong wallet inert", () => {
    const author = hubSigner();
    const player = playerWallet();
    const other = playerWallet();
    const forged = linkOf(player, "link", TODAY);
    forged.signature = base58Encode(bytes(64, 4));
    expect(reputationLinkConsent(forged, HUB)).toBe("inert");
    expect(matchReputationLink(forged, HUB)).toBeNull();

    const wrongHub = linkOf(player, "link", TODAY, "legacy", PROFILE, OTHER_HUB);
    expect(reputationLinkConsent(wrongHub, HUB)).toBe("inert");
    expect(reputationLinkConsent(wrongHub, OTHER_HUB)).toBe("valid");
    expect(resolveReputationLink([{ kind: "reputation-link", hash: "a".repeat(64), reputationLink: wrongHub }], player.wallet, {
      hubId: HUB,
      today: TODAY,
    }).linked).toBe(false);

    const wrongWallet = linkOf(other, "link", TODAY);
    expect(reputationLinkConsent(wrongWallet, HUB)).toBe("valid");
    expect(
      resolveReputationLink([{ kind: "reputation-link", hash: "b".repeat(64), reputationLink: wrongWallet }], player.wallet, {
        hubId: HUB,
        today: TODAY,
      }).linked,
    ).toBe(false);

    const mismatched = linkOf(player, "link", TODAY);
    mismatched.wallet = other.wallet;
    expect(reputationLinkConsent(mismatched, HUB)).toBe("inert");

    const body = payload(author.publicKey, player, "link", TODAY, { id: "inert-link" });
    body.reputationLink = forged;
    const next: HubUpdatePayload = {
      v: 1,
      id: "after-inert",
      created_at: "2026-10-31T04:00:00.000Z",
      author: author.publicKey,
      kind: "announcement",
      body: "Still in the chain.",
      refs: { pip: null, txs: [] },
      prev: hubUpdateHash(body),
    };
    const checked = verifyHubUpdates([document(author, body), document(author, next)], new Set([author.publicKey]), 1);
    expect(checked.rejected).toEqual([]);
    expect(checked.updates.map((update) => update.id)).toEqual(["inert-link", "after-inert"]);
    const marked = withStoryConsent(checked.updates, HUB, TODAY);
    expect(marked[0]?.consent).toBe("inert");
    expect(marked[0]?.linkShown).toBe(false);
    expect(resolveReputationLink(marked, player.wallet, { hubId: HUB, today: TODAY }).linked).toBe(false);
  });

  it("rejects an unsigned link and a scope stuffed into the payload", () => {
    const player = playerWallet();
    const link = linkOf(player, "link", TODAY);
    expect(parseReputationLink({ ...link, signature: undefined })).toBeNull();
    expect(parseReputationLink({ ...link, signature: "not-a-signature" })).toBeNull();
    expect(parseReputationLink({ ...link, scope: "fleets" })).toBeNull();
    expect(parseReputationLink({ ...link, profile: "has space" })).toBeNull();
    expect(parseReputationLink({ ...link, action: "allow" })).toBeNull();
    const author = hubSigner();
    const body = payload(author.publicKey, player, "link", TODAY);
    const extra = { ...body, reputationLink: { ...link, scope: "story" } };
    expect(parseHubPayload(extra)).toBeNull();
    expect(parseHubPayload({ ...body, kind: "reputation-link", reputationLink: undefined })).toBeNull();
  });

  it("does not put the kind on a live signer set", () => {
    expect(HUB_UPDATE_KINDS).toContain("reputation-link");
    for (const file of ["hub/signers.json", "hub/signers/agents.json", "dashboard/hub/signers.json", "dashboard/hub/signers/agents.json"]) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toContain("reputation-link");
      expect(text).not.toContain("kinds");
      expect(text).not.toContain("player-tools");
    }
    expect(existsSync("hub/signers/player-tools.json")).toBe(false);
    expect(existsSync("dashboard/hub/signers/player-tools.json")).toBe(false);
  });
});

describe("hub-add-update reputation-link", () => {
  function git(cwd: string, args: string[]): void {
    const result = spawnSync("git", ["-c", "user.email=link@example.com", "-c", "user.name=link", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || "git failed");
  }

  it("refuses an unsigned player sentence and writes a verified one", () => {
    const root = mkdtempSync(path.join(tmpdir(), "reputation-add-"));
    const store = path.join(root, "store");
    expect(runStoreInitCli(["--dir", store]).code).toBe(0);
    git(store, ["init", "-b", "main"]);
    git(store, ["config", "user.email", "link@example.com"]);
    git(store, ["config", "user.name", "link"]);
    git(store, ["add", "."]);
    git(store, ["commit", "-m", "Empty hub update store"]);
    const keyFile = path.join(root, "author.keypair.json");
    const made = runKeygenCli(["--label", "Phoenix Collective", "--out", keyFile]);
    expect(made.code, made.stderr).toBe(0);
    const player = playerWallet();
    const link = linkOf(player, "link", TODAY, "legacy");

    const wrongKind = runAddUpdateCli([
      "--store",
      store,
      "--id",
      "note-1",
      "--kind",
      "status",
      "--body",
      "No.",
      "--reputation-link",
      JSON.stringify(link),
      "--keypair",
      keyFile,
    ]);
    expect(wrongKind.code).toBe(1);
    expect(wrongKind.stderr).toMatch(/only valid when --kind is reputation-link/);

    const bad = runAddUpdateCli([
      "--store",
      store,
      "--id",
      "link-legacy",
      "--kind",
      "reputation-link",
      "--body",
      "Link the profile.",
      "--created-at",
      "2026-10-31T00:00:00.000Z",
      "--hub-repo",
      HUB,
      "--reputation-link",
      JSON.stringify({ ...link, signature: base58Encode(bytes(64, 7)) }),
      "--keypair",
      keyFile,
      "--approve",
    ]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/player signature did not verify/);

    const wrote = runAddUpdateCli([
      "--store",
      store,
      "--id",
      "link-legacy",
      "--kind",
      "reputation-link",
      "--body",
      "Link the profile.",
      "--created-at",
      "2026-10-31T00:00:00.000Z",
      "--hub-repo",
      HUB,
      "--reputation-link",
      JSON.stringify(link),
      "--keypair",
      keyFile,
      "--approve",
    ]);
    expect(wrote.code, wrote.stderr).toBe(0);
    const saved = JSON.parse(readFileSync(path.join(store, "updates", "link-legacy.json"), "utf8")) as {
      payload: { reputationLink: ReputationLink };
    };
    expect(saved.payload.reputationLink.wallet).toBe(player.wallet);
    expect("scope" in saved.payload.reputationLink).toBe(false);
    expect(matchReputationLink(saved.payload.reputationLink, HUB)).toEqual({ action: "link", scope: "legacy" });
    expect(readFileSync(path.join(store, "README.md"), "utf8")).toContain("reputation-link");
    expect(REPUTATION_LINK_EXPLANATION).toContain("Scope: legacy|fleets|guild|story");
  });
});
