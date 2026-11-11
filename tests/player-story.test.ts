import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { HUB_PIN_MAX, HUB_PIN_TTL_MS, readHubUpdates, readStoryContext, withStoryConsent } from "../src/dao/hub.js";
import { createNodeHandler } from "../src/handler.js";
import { runAddUpdateCli } from "../src/hub/add-update-cli.js";
import { base58Encode } from "../src/hub/base58.js";
import { runKeygenCli } from "../src/hub/keygen-cli.js";
import { runStoreInitCli } from "../src/hub/store-init-cli.js";
import {
  NOT_AVAILABLE_STATUS,
  OPT_IN_EXPLANATION,
  STORY_UNAVAILABLE,
  matchStoryConsent,
  normalizeHubRepo,
  storyOptInConsent,
  parseStoryOptIn,
  storyAllowMessage,
  storyRevokeMessage,
  type StoryOptIn,
} from "../src/hub/story-optin.js";
import {
  HUB_APPROVAL_DOMAIN,
  canonicalHubPayload,
  hubUpdateHash,
  parseHubPayload,
  verifyHubUpdates,
  type HubUpdatePayload,
} from "../src/hub/update.js";
import { legacyCardShell, type LegacyActivity, type LegacyFleet, type LegacyProfile, type LegacySource, type PlayerLegacyCard } from "../src/legacy/card.js";
import {
  STORY_CACHE_MAX,
  STORY_TTL_MS,
  buildPlayerStory,
  createPlayerStoryReader,
  resolveStoryOptIn,
  storyShape,
  type BuiltStory,
  type StoryListingInput,
} from "../src/legacy/story.js";
import type { NodeDeps } from "../src/server.js";
import { stubDaoReaders } from "./dao-stubs.js";

const POISON = "ZorblaxUnique Buy now https://evil.example 50% ATH yield x402";
const FINANCIAL = /\b(price|prices|value|valued|valuation|ATH|percent(?:age)?s?|holdings?|yields?|x402)\b|%/i;
const CTA = /\b(buy|visit|click|subscribe|checkout|sign up|learn more)\b|https?:\/\//i;
const HUB = "https://github.com/example/story-hub";
const OTHER_HUB = "https://github.com/example/other-hub";
const TODAY = "2026-10-31";
const CLOCK = Date.parse(`${TODAY}T12:00:00.000Z`);
const AS_OF = "2026-10-31T00:00:00.000Z";

function bytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  out[0] = seed;
  out[length - 1] = 9;
  return out;
}

function addr(seed: number): string {
  return base58Encode(bytes(32, seed));
}

function tx(seed: number): string {
  return base58Encode(bytes(64, seed));
}

function playerWallet() {
  const pair = nacl.sign.keyPair();
  const wallet = base58Encode(pair.publicKey);
  return {
    wallet,
    sign(action: "allow" | "revoke", date: string, links: "yes" | "no" = "no", hubId = HUB) {
      const text = action === "revoke" ? storyRevokeMessage(wallet, date, hubId) : storyAllowMessage(wallet, date, hubId, links);
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

function document(author: ReturnType<typeof hubSigner>, body: HubUpdatePayload, approvers: ReturnType<typeof hubSigner>[] = [author]) {
  return {
    payload: body,
    signature: author.sign(body),
    approvals: approvers.map((approver) => ({ publicKey: approver.publicKey, signature: approver.approve(body) })),
  };
}

function optIn(
  player: ReturnType<typeof playerWallet>,
  action: "allow" | "revoke",
  date: string,
  links: "yes" | "no" = "no",
  hubId = HUB,
): StoryOptIn {
  return {
    action,
    wallet: player.wallet,
    date,
    signature: player.sign(action, date, links, hubId),
  };
}

function hubOf(
  updates: readonly { kind: string; hash: string; storyOptIn?: StoryOptIn }[],
  listings: readonly unknown[] = [],
  hubId = HUB,
) {
  return async () => ({ hubId, updates, listings });
}

function optPayload(
  author: string,
  player: ReturnType<typeof playerWallet>,
  action: "allow" | "revoke",
  date: string,
  over: Partial<HubUpdatePayload> = {},
  links: "yes" | "no" = "no",
  hubId = HUB,
): HubUpdatePayload {
  return {
    v: 1,
    id: over.id ?? (action === "revoke" ? "story-revoke" : "story-allow"),
    created_at: over.created_at ?? "2026-10-31T00:00:00.000Z",
    author,
    kind: "story-optin",
    body: over.body ?? (action === "revoke" ? "Revoke the story." : "Allow the story."),
    refs: over.refs ?? { pip: null, txs: [] },
    prev: over.prev ?? null,
    storyOptIn: optIn(player, action, date, links, hubId),
  };
}

function source(account: string, facts: { fact: string; signature: string | null }[]): LegacySource {
  return { account, facts };
}

function profile(address: string, over: Partial<LegacyProfile> = {}): LegacyProfile {
  return {
    address,
    name: POISON,
    faction: null,
    factionAccount: null,
    createdAt: null,
    creationSignature: null,
    ...over,
  };
}

function fleet(address: string, ownerProfile: string, over: Partial<LegacyFleet> = {}): LegacyFleet {
  return {
    address,
    name: POISON,
    program: "SAGE",
    ownerProfile,
    createdAt: null,
    creationSignature: null,
    ...over,
  };
}

function activity(address: string, over: Partial<LegacyActivity> = {}): LegacyActivity {
  return {
    address,
    band: "none",
    reachedEnd: true,
    firstSeen: null,
    lastSeen: null,
    firstSignature: null,
    lastSignature: null,
    ...over,
  };
}

function card(address: string, over: Partial<PlayerLegacyCard> = {}): PlayerLegacyCard {
  return {
    ...legacyCardShell(address, AS_OF),
    dataMode: "live",
    queried: { address, kind: "wallet" },
    ...over,
  };
}

function profileOnly(): PlayerLegacyCard {
  const wallet = addr(1);
  const profileAddress = addr(2);
  const created = tx(20);
  return card(wallet, {
    profiles: [profile(profileAddress, { createdAt: "2023-09-21T00:00:00.000Z", creationSignature: created })],
    sources: [source(profileAddress, [{ fact: "profile", signature: null }, { fact: "created", signature: created }])],
  });
}

function factionOnly(): PlayerLegacyCard {
  const wallet = addr(1);
  const profileAddress = addr(2);
  const factionAccount = addr(6);
  return card(wallet, {
    profiles: [profile(profileAddress, { faction: "ONI", factionAccount })],
    sources: [
      source(profileAddress, [{ fact: "profile", signature: null }]),
      source(factionAccount, [{ fact: "faction", signature: null }]),
    ],
  });
}

function fleetsOnly(): PlayerLegacyCard {
  const wallet = addr(1);
  const profileAddress = addr(2);
  const fleetAddress = addr(8);
  const created = tx(22);
  const first = tx(23);
  const last = tx(24);
  return card(wallet, {
    profiles: [profile(profileAddress)],
    fleets: [fleet(fleetAddress, profileAddress, { createdAt: "2024-02-02T00:00:00.000Z", creationSignature: created })],
    activity: activity(wallet, {
      band: "10\u201399",
      firstSeen: "2024-02-02T00:00:00.000Z",
      lastSeen: "2024-05-01T00:00:00.000Z",
      firstSignature: first,
      lastSignature: last,
    }),
    sources: [
      source(profileAddress, [{ fact: "profile", signature: null }]),
      source(fleetAddress, [{ fact: "fleet", signature: null }, { fact: "created", signature: created }]),
      source(wallet, [
        { fact: "first-activity", signature: first },
        { fact: "last-activity", signature: last },
      ]),
    ],
  });
}

function longActivity(): PlayerLegacyCard {
  const wallet = addr(1);
  const profileAddress = addr(2);
  const fleetAddress = addr(8);
  const first = tx(30);
  const last = tx(31);
  return card(wallet, {
    profiles: [profile(profileAddress)],
    fleets: [fleet(fleetAddress, profileAddress)],
    activity: activity(wallet, {
      band: "1,000\u20139,999",
      firstSeen: "2020-01-15T00:00:00.000Z",
      lastSeen: "2024-06-01T00:00:00.000Z",
      firstSignature: first,
      lastSignature: last,
    }),
    sources: [
      source(profileAddress, [{ fact: "profile", signature: null }]),
      source(fleetAddress, [{ fact: "fleet", signature: null }]),
      source(wallet, [
        { fact: "first-activity", signature: first },
        { fact: "last-activity", signature: last },
      ]),
    ],
  });
}

function thinCard(): PlayerLegacyCard {
  const wallet = addr(1);
  return card(wallet, {
    activity: activity(wallet),
    sources: [source(wallet, [{ fact: "first-activity", signature: null }, { fact: "last-activity", signature: null }])],
  });
}

const shop: StoryListingInput = {
  id: "shop-1",
  stream: "irl",
  category: "ip_and_business",
  status: "available",
  url: "https://example.com/shop",
  expiresAt: "2026-12-31",
};

function told(sample: PlayerLegacyCard, listings: StoryListingInput[] = []): BuiltStory {
  return buildPlayerStory(sample, { showLinks: false, listings, today: TODAY });
}

function expectCited(sample: PlayerLegacyCard, story: BuiltStory): void {
  if (story.claims.length > 0) expect(story.story).toBe(story.claims.map((claim) => claim.text).join(" "));
  for (const claim of story.claims) {
    const cited = sample.sources.find((item) => item.account === claim.account);
    expect(cited, claim.text).toBeTruthy();
    if (claim.signature) expect(cited?.facts.some((fact) => fact.signature === claim.signature)).toBe(true);
    expect(story.story).not.toContain(claim.account);
    if (claim.signature) expect(story.story).not.toContain(claim.signature);
  }
  for (const row of story.sources) {
    expect(sample.sources.some((item) => item.account === row.account)).toBe(true);
  }
}

describe("story opt-in", () => {
  it("verifies the fixed allow and revoke sentences with ed25519", () => {
    const player = playerWallet();
    const allow = optIn(player, "allow", "2026-10-31", "yes");
    const revoke = optIn(player, "revoke", "2026-10-31");
    expect(storyAllowMessage(player.wallet, "2026-10-31", HUB, "yes")).toBe(
      `I allow sa-ecosystem-node to tell my public Star Atlas story. Wallet: ${player.wallet}. Date: 2026-10-31. Hub: ${HUB}. Links: yes.`,
    );
    expect(matchStoryConsent(allow, HUB)).toEqual({ showLinks: true });
    expect(matchStoryConsent(optIn(player, "allow", "2026-10-31", "no"), HUB)).toEqual({ showLinks: false });
    expect(matchStoryConsent(revoke, HUB)).toEqual({ showLinks: false });
    expect(matchStoryConsent(allow, OTHER_HUB)).toBeNull();
    expect(matchStoryConsent({ ...allow, action: "revoke" }, HUB)).toBeNull();
    expect(matchStoryConsent({ ...allow, date: "2026-10-30" }, HUB)).toBeNull();
    expect(matchStoryConsent({ ...allow, signature: base58Encode(bytes(64, 4)) }, HUB)).toBeNull();
    expect(parseStoryOptIn({ ...revoke, showLinks: true })).toBeNull();
    expect(parseStoryOptIn({ ...allow, note: "extra" })).toBeNull();
    expect(parseHubPayload({ ...optPayload("11111111111111111111111111111111", player, "allow", "2026-10-31"), storyOptIn: undefined })).toBeNull();
    expect(parseHubPayload({ ...optPayload(player.wallet, player, "allow", "2026-10-31"), kind: "announcement" })).toBeNull();
    const parsed = parseHubPayload(optPayload(addr(9), player, "allow", "2026-10-31", {}, "no"));
    expect(parsed?.kind).toBe("story-optin");
    expect(parsed?.storyOptIn && "showLinks" in parsed.storyOptIn).toBe(false);
  });

  it("keeps a bad player signature in the chain without granting consent", () => {
    const author = hubSigner();
    const player = playerWallet();
    const bad = optPayload(author.publicKey, player, "allow", "2026-10-31");
    bad.storyOptIn = { ...optIn(player, "allow", "2026-10-31"), signature: base58Encode(bytes(64, 8)) };
    const after: HubUpdatePayload = {
      v: 1,
      id: "after-bad",
      created_at: "2026-10-31T05:00:00.000Z",
      author: author.publicKey,
      kind: "announcement",
      body: "The chain continues.",
      refs: { pip: null, txs: [] },
      prev: hubUpdateHash(bad),
    };
    const checked = verifyHubUpdates(
      [document(author, bad), document(author, after)],
      new Set([author.publicKey]),
      1,
      undefined,
    );
    expect(checked.rejected).toEqual([]);
    expect(checked.updates.map((update) => update.id)).toEqual(["story-allow", "after-bad"]);
    expect(resolveStoryOptIn(checked.updates, player.wallet, { hubId: HUB, today: TODAY }).optedIn).toBe(false);

    const foreign = optPayload(author.publicKey, player, "allow", "2026-10-31", { id: "foreign-hub" }, "no", OTHER_HUB);
    const wrongHub = verifyHubUpdates([document(author, foreign)], new Set([author.publicKey]), 1);
    expect(wrongHub.rejected).toEqual([]);
    expect(wrongHub.updates.map((update) => update.id)).toEqual(["foreign-hub"]);
    expect(resolveStoryOptIn(wrongHub.updates, player.wallet, { hubId: HUB, today: TODAY }).optedIn).toBe(false);

    const allow = optPayload(author.publicKey, player, "allow", "2026-10-31");
    const closed = verifyHubUpdates([document(author, allow)], new Set([author.publicKey]), 1, undefined, {
      revokedSigners: new Set([author.publicKey]),
    });
    expect(closed.updates).toEqual([]);
    expect(closed.rejected).toEqual([{ id: "story-allow", reason: "revoked_signer" }]);

    const short = verifyHubUpdates([document(author, allow, [])], new Set([author.publicKey]), 2);
    expect(short.rejected).toEqual([{ id: "story-allow", reason: "below_threshold" }]);
  });

  it("lets a later revoke replace an allow under the same hub rules", () => {
    const author = hubSigner();
    const player = playerWallet();
    const allow = optPayload(author.publicKey, player, "allow", "2026-10-30", { id: "allow-1" }, "yes");
    const revoke = optPayload(author.publicKey, player, "revoke", "2026-10-31", {
      id: "revoke-1",
      created_at: "2026-10-31T00:00:00.000Z",
      prev: hubUpdateHash(allow),
    });
    const checked = verifyHubUpdates(
      [document(author, revoke), document(author, allow)],
      new Set([author.publicKey]),
      1,
      undefined,
    );
    expect(checked.rejected).toEqual([]);
    expect(checked.updates.map((update) => update.id)).toEqual(["allow-1", "revoke-1"]);
    const reader = createPlayerStoryReader({
      now: () => CLOCK,
      playerLegacy: async () => {
        throw new Error("legacy was read");
      },
      hub: hubOf(checked.updates),
    });
    return expect(reader({ address: player.wallet })).resolves.toEqual({
      readOnly: true,
      status: "not opted in",
      explanation: OPT_IN_EXPLANATION,
    });
  });

  it("does not restore consent by replaying an old allow signature after a revoke", () => {
    const author = hubSigner();
    const player = playerWallet();
    const allow = optPayload(author.publicKey, player, "allow", "2026-10-20", { id: "allow-1" }, "yes");
    const revoke = optPayload(author.publicKey, player, "revoke", "2026-10-25", {
      id: "revoke-1",
      created_at: "2026-10-25T00:00:00.000Z",
      prev: hubUpdateHash(allow),
    });
    const replay = optPayload(author.publicKey, player, "allow", "2026-10-20", {
      id: "allow-replay",
      created_at: "2026-10-26T00:00:00.000Z",
      prev: hubUpdateHash(revoke),
    }, "yes");
    expect(replay.storyOptIn?.signature).toBe(allow.storyOptIn?.signature);
    const checked = verifyHubUpdates(
      [document(author, allow), document(author, revoke), document(author, replay)],
      new Set([author.publicKey]),
      1,
      undefined,
    );
    expect(checked.rejected).toEqual([]);
    expect(checked.updates.map((update) => update.id)).toEqual(["allow-1", "revoke-1", "allow-replay"]);
    const decision = resolveStoryOptIn(checked.updates, player.wallet, { hubId: HUB, today: TODAY });
    expect(decision.optedIn).toBe(false);
  });

  it("ignores an older allow published after a newer revoke", () => {
    const author = hubSigner();
    const player = playerWallet();
    const revoke = optPayload(author.publicKey, player, "revoke", "2026-10-20", { id: "revoke-1" });
    const older = optPayload(author.publicKey, player, "allow", "2026-10-01", {
      id: "allow-old",
      created_at: "2026-10-21T00:00:00.000Z",
      prev: hubUpdateHash(revoke),
    }, "yes");
    const checked = verifyHubUpdates(
      [document(author, revoke), document(author, older)],
      new Set([author.publicKey]),
      1,
      undefined,
    );
    expect(checked.rejected).toEqual([]);
    expect(resolveStoryOptIn(checked.updates, player.wallet, { hubId: HUB, today: TODAY }).optedIn).toBe(false);
  });

  it("gives a same-day tie to the revoke", () => {
    const author = hubSigner();
    const player = playerWallet();
    const allow = optPayload(author.publicKey, player, "allow", "2026-10-15", { id: "allow-1" }, "yes");
    const revoke = optPayload(author.publicKey, player, "revoke", "2026-10-15", {
      id: "revoke-1",
      created_at: "2026-10-15T01:00:00.000Z",
      prev: hubUpdateHash(allow),
    });
    const allowFirst = verifyHubUpdates(
      [document(author, allow), document(author, revoke)],
      new Set([author.publicKey]),
      1,
      undefined,
    );
    expect(resolveStoryOptIn(allowFirst.updates, player.wallet, { hubId: HUB, today: TODAY }).optedIn).toBe(false);

    const other = playerWallet();
    const revokeFirstBody = optPayload(author.publicKey, other, "revoke", "2026-10-15", { id: "revoke-first" });
    const allowLater = optPayload(author.publicKey, other, "allow", "2026-10-15", {
      id: "allow-later",
      created_at: "2026-10-15T02:00:00.000Z",
      prev: hubUpdateHash(revokeFirstBody),
    }, "no");
    const revokeFirst = verifyHubUpdates(
      [document(author, revokeFirstBody), document(author, allowLater)],
      new Set([author.publicKey]),
      1,
      undefined,
    );
    expect(resolveStoryOptIn(revokeFirst.updates, other.wallet, { hubId: HUB, today: TODAY }).optedIn).toBe(false);
  });

  it("keeps a future-dated allow in the chain and ignores it until that date", () => {
    const author = hubSigner();
    const player = playerWallet();
    const future = optPayload(author.publicKey, player, "allow", "2026-11-01", { id: "future-allow" }, "yes");
    const after: HubUpdatePayload = {
      v: 1,
      id: "after-future",
      created_at: "2026-10-31T04:00:00.000Z",
      author: author.publicKey,
      kind: "announcement",
      body: "The chain continues.",
      refs: { pip: null, txs: [] },
      prev: hubUpdateHash(future),
    };
    const checked = verifyHubUpdates(
      [document(author, future), document(author, after)],
      new Set([author.publicKey]),
      1,
      undefined,
    );
    expect(checked.rejected).toEqual([]);
    expect(checked.updates.map((update) => update.id)).toEqual(["future-allow", "after-future"]);
    expect(resolveStoryOptIn(checked.updates, player.wallet, { hubId: HUB, today: TODAY }).optedIn).toBe(false);
    expect(resolveStoryOptIn(checked.updates, player.wallet, { hubId: HUB, today: "2026-11-01" }).optedIn).toBe(true);
  });

  it("lets the latest-dated allow win over a later chain position", () => {
    const author = hubSigner();
    const player = playerWallet();
    const newer = optPayload(author.publicKey, player, "allow", "2026-10-20", { id: "allow-newer-date" }, "yes");
    const older = optPayload(author.publicKey, player, "allow", "2026-10-10", {
      id: "allow-older-date",
      created_at: "2026-10-21T00:00:00.000Z",
      prev: hubUpdateHash(newer),
    }, "no");
    const checked = verifyHubUpdates(
      [document(author, newer), document(author, older)],
      new Set([author.publicKey]),
      1,
      undefined,
    );
    expect(checked.rejected).toEqual([]);
    const decision = resolveStoryOptIn(checked.updates, player.wallet, { hubId: HUB, today: TODAY });
    expect(decision).toMatchObject({ optedIn: true, showLinks: true });
    expect(checked.updates.find((update) => update.hash === decision.hash)?.id).toBe("allow-newer-date");
  });

  it("rejects consent signed for another repository that uses the same manifest filename", () => {
    const author = hubSigner();
    const player = playerWallet();
    const allow = optPayload(author.publicKey, player, "allow", "2026-10-31", { id: "shared-name" }, "yes", HUB);
    const doc = document(author, allow);
    const onA = verifyHubUpdates([doc], new Set([author.publicKey]), 1);
    const onB = verifyHubUpdates([doc], new Set([author.publicKey]), 1);
    expect(onA.updates).toHaveLength(1);
    expect(onB.rejected).toEqual([]);
    expect(onB.updates.map((update) => update.id)).toEqual(["shared-name"]);
    expect(resolveStoryOptIn(onB.updates, player.wallet, { hubId: OTHER_HUB, today: TODAY }).optedIn).toBe(false);
    expect(normalizeHubRepo(HUB)).not.toBe("hub-manifest.json");
    expect(normalizeHubRepo(OTHER_HUB)).not.toBe("hub-manifest.json");
  });

  it("keeps later listings and signer updates when the pin is not an https repository", () => {
    const author = hubSigner();
    const approver = hubSigner();
    const added = hubSigner();
    const player = playerWallet();
    const bad = optPayload(author.publicKey, player, "allow", "2026-10-31", { id: "inert-optin" });
    bad.storyOptIn = { ...optIn(player, "allow", "2026-10-31"), signature: base58Encode(bytes(64, 9)) };
    const change: HubUpdatePayload = {
      v: 1,
      id: "add-signer",
      created_at: "2026-10-31T06:00:00.000Z",
      author: author.publicKey,
      kind: "signer-change",
      body: "Add a signer.",
      refs: { pip: null, txs: [] },
      prev: hubUpdateHash(bad),
      change: { op: "add", publicKey: added.publicKey, set: "default" },
    };
    const listing: HubUpdatePayload = {
      v: 1,
      id: "later-listing",
      created_at: "2026-10-31T07:00:00.000Z",
      author: added.publicKey,
      kind: "listing",
      body: "A shop.",
      refs: { pip: null, txs: [] },
      prev: hubUpdateHash(change),
      listing: {
        stream: "irl",
        category: "ip_and_business",
        title: "Shop",
        owner: "Owner",
        url: "https://example.com/shop",
        status: "available",
        asOf: "2026-10-01",
        expiresAt: "2026-12-30",
      },
    };
    const checked = verifyHubUpdates(
      [document(author, bad), document(author, change, [approver]), document(added, listing)],
      new Set([author.publicKey, approver.publicKey]),
      1,
      undefined,
    );
    expect(checked.rejected).toEqual([]);
    expect(checked.updates.map((update) => update.id)).toEqual(["inert-optin", "add-signer", "later-listing"]);
    expect(checked.updates[2]?.listing?.title).toBe("Shop");
    expect(resolveStoryOptIn(checked.updates, player.wallet, { hubId: HUB, today: TODAY }).optedIn).toBe(false);
  });

  it("marks story-optin consent from the player signature and this hub only", () => {
    const author = hubSigner();
    const player = playerWallet();
    const allow = optPayload(author.publicKey, player, "allow", "2026-10-31", { id: "signed-allow" }, "yes");
    const future = optPayload(author.publicKey, player, "allow", "2026-11-01", { id: "future-signed" }, "no");
    const note: HubUpdatePayload = {
      v: 1,
      id: "plain-note",
      created_at: "2026-10-31T08:00:00.000Z",
      author: author.publicKey,
      kind: "announcement",
      body: "Not an opt-in.",
      refs: { pip: null, txs: [] },
      prev: hubUpdateHash(allow),
    };
    const checked = verifyHubUpdates(
      [document(author, allow), document(author, note)],
      new Set([author.publicKey]),
      1,
    );
    const marked = withStoryConsent(checked.updates, HUB);
    const signed = marked.find((update) => update.id === "signed-allow");
    const plain = marked.find((update) => update.id === "plain-note");
    expect(signed?.consent).toBe("valid");
    expect(plain && "consent" in plain).toBe(false);
    expect(withStoryConsent(checked.updates, OTHER_HUB).find((update) => update.id === "signed-allow")?.consent).toBe("inert");
    expect(withStoryConsent(checked.updates, "").find((update) => update.id === "signed-allow")?.consent).toBe("inert");
    const later = verifyHubUpdates([document(author, future)], new Set([author.publicKey]), 1);
    expect(withStoryConsent(later.updates, HUB)[0]?.consent).toBe("valid");
    expect(resolveStoryOptIn(later.updates, player.wallet, { hubId: HUB, today: TODAY }).optedIn).toBe(false);
    expect(allow.storyOptIn && storyOptInConsent(allow.storyOptIn, HUB)).toBe("valid");
    const broken = { ...allow.storyOptIn!, signature: base58Encode(bytes(64, 3)) };
    expect(storyOptInConsent(broken, HUB)).toBe("inert");
  });
});

describe("hub repository URL", () => {
  it("normalizes case, a trailing slash, and .git, and rejects credentials and http", () => {
    expect(normalizeHubRepo("HTTPS://GitHub.com/Owner/Repo.git/")).toBe("https://github.com/owner/repo");
    expect(normalizeHubRepo("https://github.com/owner/repo/")).toBe("https://github.com/owner/repo");
    expect(normalizeHubRepo("https://github.com/owner/repo.git")).toBe("https://github.com/owner/repo");
    expect(normalizeHubRepo("https://user:pass@github.com/owner/repo")).toBeNull();
    expect(normalizeHubRepo("https://user@github.com/owner/repo")).toBeNull();
    expect(normalizeHubRepo("http://github.com/owner/repo")).toBeNull();
    expect(normalizeHubRepo("https://github.com/owner/repo?x=1")).toBeNull();
    expect(normalizeHubRepo("https://github.com/owner/repo#frag")).toBeNull();
    expect(normalizeHubRepo("")).toBeNull();
    expect(normalizeHubRepo("/tmp/hub-store")).toBeNull();
    expect(normalizeHubRepo("https://github/owner/repo")).toBeNull();
    for (const host of [
      "printer",
      "shop.local",
      "nas.internal",
      "box.home.arpa",
      "home.arpa",
      "router.lan",
      "host.localdomain",
      "app.test",
      "shop.example",
      "gone.invalid",
      "foo.localhost",
      "localhost",
      "api.localhost",
      "127.0.0.1",
      "[::1]",
      "10.1.2.3",
      "192.168.0.1",
      "172.16.0.1",
      "169.254.1.1",
      "8.8.8.8",
      "[2001:db8::1]",
      "[fe80::1]",
    ]) {
      expect(normalizeHubRepo(`https://${host}/owner/repo`), host).toBeNull();
    }
  });
});

describe("player story content", () => {
  const samples = [profileOnly(), factionOnly(), fleetsOnly(), longActivity(), thinCard()];

  it("cites a signature or account from the legacy card sources for every claim", () => {
    for (const sample of samples) expectCited(sample, told(sample, [shop]));
  });

  it("keeps prices, value, ATH, percentages, yields, and x402 out of the story", () => {
    for (const sample of samples) {
      const story = told(sample, [shop]);
      expect(story.story).not.toMatch(FINANCIAL);
      expect(story.claims.map((claim) => claim.text).join("\n")).not.toMatch(FINANCIAL);
      expect(JSON.stringify(story.story)).not.toContain("x402");
    }
  });

  it("keeps calls to action out of the story and returns listings beside it", () => {
    const story = told(fleetsOnly(), [
      shop,
      { ...shop, id: "paused-1", status: "paused" },
      { ...shop, id: "old-1", expiresAt: "2026-10-30" },
      { ...shop, id: "ask-1", status: "inquire_only", url: "https://example.com/ask" },
    ]);
    expect(story.story).not.toMatch(CTA);
    expect(story.story).not.toContain("example.com");
    expect(story.story).not.toContain("shop-1");
    expect(story.listings.map((listing) => listing.id)).toEqual(["shop-1", "ask-1"]);
    expect(story.listings.every((listing) => !("title" in listing))).toBe(true);
    expect(Object.keys(story)).toContain("listings");
  });

  it("keeps a thin record short", () => {
    const story = told(thinCard(), [shop]);
    expect(story.shape).toBe("thin");
    expect(story.claims).toHaveLength(1);
    expect(story.story.length).toBeLessThan(160);
    expect(story.story).toMatch(/No player profile was found/);
    expect(story.story).toMatch(/That's all for now/);
    expect(story.story).not.toMatch(/fleet|enlistment|band|First seen/i);
    expect(story.listings).toEqual([]);
    const empty = told(card(addr(1)));
    expect(empty.claims).toEqual([]);
    expect(empty.story).toBe("Here's what the public chain shows. That's all for now.");
    expect(empty.story.length).toBeLessThan(story.story.length + 80);
  });

  it("picks one deterministic template from the profile shape", () => {
    const profileStory = told(profileOnly());
    const factionStory = told(factionOnly());
    const fleetStory = told(fleetsOnly());
    const longStory = told(longActivity());
    expect(storyShape(profileOnly())).toBe("profile");
    expect(storyShape(factionOnly())).toBe("faction");
    expect(storyShape(fleetsOnly())).toBe("fleets");
    expect(storyShape(longActivity())).toBe("long-activity");
    expect(profileStory.story.startsWith("Public profile record.")).toBe(true);
    expect(factionStory.story.startsWith("Public faction record.")).toBe(true);
    expect(fleetStory.story.startsWith("Public fleet record.")).toBe(true);
    expect(longStory.story.startsWith("Public activity record.")).toBe(true);
    expect(new Set([profileStory.story, factionStory.story, fleetStory.story, longStory.story]).size).toBe(4);
    expect(profileStory).toEqual(told(profileOnly()));
    expect(factionStory.story).toContain("An enlistment with ONI is on the record.");
    expect(fleetStory.story).toContain("The record includes 1 SAGE fleet.");
    expect(fleetStory.story).toContain("First seen February 2024.");
    expect(longStory.story).toContain("The first and last signatures are far apart.");
    expect(longStory.story).toContain("The record includes 1 SAGE fleet.");
    expect(profileStory.story).toContain("A profile record starts in September 2023.");
  });

  it("does not copy user-controlled names into story sentences", () => {
    for (const sample of [profileOnly(), factionOnly(), fleetsOnly(), longActivity()]) {
      const story = told(sample, [shop]);
      const packed = JSON.stringify({ story: story.story, claims: story.claims });
      expect(packed).not.toContain("ZorblaxUnique");
      expect(packed).not.toContain("https://evil.example");
      expect(story.story).not.toContain(POISON);
    }
  });

  it("keeps addresses and transaction links out of the story text unless showLinks is set", () => {
    const sample = fleetsOnly();
    const quiet = told(sample);
    expect(quiet.links).toBeUndefined();
    expect(quiet.story).not.toContain("http");
    expect(quiet.story).not.toContain("explorer.solana.com");
    for (const row of sample.sources) {
      expect(quiet.story).not.toContain(row.account);
      for (const fact of row.facts) {
        if (fact.signature) expect(quiet.story).not.toContain(fact.signature);
      }
    }
    expect(quiet.sources.length).toBeGreaterThan(0);
    const linked = buildPlayerStory(sample, { showLinks: true, listings: [], today: TODAY });
    expect(linked.story).toBe(quiet.story);
    expect(linked.links?.some((link) => link.url.startsWith("https://explorer.solana.com/address/"))).toBe(true);
    expect(linked.links?.some((link) => link.url.startsWith("https://explorer.solana.com/tx/"))).toBe(true);
    expect(linked.story).not.toContain("explorer.solana.com");
    expect(linked.showLinks).toBe(true);
  });
});

describe("player_story reader", () => {
  it("returns only not opted in when there is no valid allow", async () => {
    let reads = 0;
    const player = playerWallet();
    const reader = createPlayerStoryReader({
      now: () => CLOCK,
      playerLegacy: async () => {
        reads += 1;
        throw new Error("legacy was read");
      },
      hub: hubOf([], [{ ...shop, title: POISON, owner: POISON }]),
    });
    const blocked = await reader({ address: player.wallet });
    expect(blocked).toEqual({ readOnly: true, status: "not opted in", explanation: OPT_IN_EXPLANATION });
    expect(Object.keys(blocked).sort()).toEqual(["explanation", "readOnly", "status"]);
    expect(JSON.stringify(blocked)).not.toMatch(/player profile|SAGE fleet|Zorblax|sources/);
    expect(reads).toBe(0);

    const forged = {
      kind: "story-optin",
      hash: "forged",
      storyOptIn: { ...optIn(player, "allow", "2026-10-31"), signature: base58Encode(bytes(64, 5)) },
    };
    const still = createPlayerStoryReader({
      now: () => CLOCK,
      playerLegacy: async () => {
        reads += 1;
        throw new Error("legacy was read");
      },
      hub: hubOf([forged]),
    });
    await expect(still({ address: player.wallet })).resolves.toMatchObject({ status: "not opted in" });
    expect(reads).toBe(0);
  });

  it("tells the story after an allow and stops after a revoke", async () => {
    const player = playerWallet();
    const sample = card(player.wallet, {
      profiles: [profile(addr(2), { createdAt: "2023-09-21T00:00:00.000Z", creationSignature: tx(40) })],
      sources: [source(addr(2), [{ fact: "profile", signature: null }, { fact: "created", signature: tx(40) }])],
    });
    let reads = 0;
    const updates = [
      { kind: "story-optin", hash: "allow", storyOptIn: optIn(player, "allow", "2026-10-30", "yes") },
    ];
    let hubCalls = 0;
    const reader = createPlayerStoryReader({
      now: () => CLOCK,
      playerLegacy: async ({ address }) => {
        reads += 1;
        expect(address).toBe(player.wallet);
        return sample;
      },
      hub: async () => {
        hubCalls += 1;
        return { hubId: HUB, updates, listings: [{ ...shop, title: "Buy now", offerText: "50% off" }] };
      },
    });
    const story = await reader({ address: player.wallet });
    expect(story.status).toBe("story");
    if (story.status !== "story") return;
    expect(story.fromCache).toBe(false);
    expect(story.showLinks).toBe(true);
    expect(story.links?.length).toBeGreaterThan(0);
    expect(story.story).not.toContain("Buy now");
    expect(JSON.stringify(story)).not.toContain("50%");
    expect(JSON.stringify(story)).not.toContain("Buy now");
    expect(story.listings).toEqual([
      { id: "shop-1", stream: "irl", category: "ip_and_business", status: "available", url: "https://example.com/shop" },
    ]);
    expect(reads).toBe(1);
    expect(hubCalls).toBe(1);

    updates.push({ kind: "story-optin", hash: "revoke", storyOptIn: optIn(player, "revoke", "2026-10-31") });
    const revoked = await reader({ address: player.wallet });
    expect(revoked).toMatchObject({ status: "not opted in" });
    expect(reads).toBe(1);
  });

  it("caches a story for up to 10 minutes and bounds the cache", async () => {
    expect(STORY_TTL_MS).toBe(10 * 60 * 1000);
    expect(STORY_CACHE_MAX).toBe(32);
    const players = Array.from({ length: STORY_CACHE_MAX + 1 }, () => playerWallet());
    const first = players[0];
    if (!first) throw new Error("missing wallet");
    const updates = players.map((player, index) => ({
      kind: "story-optin" as const,
      hash: `allow-${index}`,
      storyOptIn: optIn(player, "allow", "2026-10-31"),
    }));
    const reads: string[] = [];
    let now = CLOCK;
    const reader = createPlayerStoryReader({
      now: () => now,
      playerLegacy: async ({ address }) => {
        reads.push(address);
        return card(address, {
          activity: activity(address),
          sources: [source(address, [{ fact: "first-activity", signature: null }])],
        });
      },
      hub: hubOf(updates),
    });
    await reader({ address: first.wallet });
    await reader({ address: first.wallet });
    expect(reads).toEqual([first.wallet]);
    now += STORY_TTL_MS - 1;
    await reader({ address: first.wallet });
    expect(reads).toEqual([first.wallet]);
    now += 1;
    await reader({ address: first.wallet });
    expect(reads).toEqual([first.wallet, first.wallet]);

    const boundedReads: string[] = [];
    const bounded = createPlayerStoryReader({
      now: () => CLOCK,
      playerLegacy: async ({ address }) => {
        boundedReads.push(address);
        return card(address, {
          activity: activity(address),
          sources: [source(address, [{ fact: "first-activity", signature: null }])],
        });
      },
      hub: hubOf(updates),
    });
    for (const player of players) await bounded({ address: player.wallet });
    expect(boundedReads).toEqual(players.map((player) => player.wallet));
    const oldest = players[0];
    const newest = players[players.length - 1];
    if (!oldest || !newest) throw new Error("missing wallet");
    await bounded({ address: newest.wallet });
    await bounded({ address: oldest.wallet });
    expect(boundedReads.at(-1)).toBe(oldest.wallet);
    expect(boundedReads.filter((item) => item === newest.wallet)).toHaveLength(1);
  });

  it("serves not opted in from the MCP tool without reading a legacy card", async () => {
    let reads = 0;
    const deps: NodeDeps = {
      ...stubDaoReaders(),
      async playerLegacy() {
        reads += 1;
        return legacyCardShell(addr(1), AS_OF);
      },
      async listStarSystems() {
        return { total: 0, systems: [] };
      },
      async getFleet() {
        return [];
      },
      async auditProfile(profileAddress) {
        return { profileAddress, keyThreshold: 0, authKeyCount: 0, keyCount: 0, riskyKeyCount: 0, keys: [] };
      },
    };
    const handler = createNodeHandler(deps, loadConfig({}));
    const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp"), {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
    });
    const client = new Client({ name: "player-story-test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(transport);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("player_story");
      const result = await client.callTool({ name: "player_story", arguments: { address: addr(1) } });
      expect(result.isError).toBeFalsy();
      const body = result.structuredContent as { status: string; explanation: string; story?: string; profiles?: unknown };
      expect(body.status).toBe(NOT_AVAILABLE_STATUS);
      expect(body.explanation).toBe(STORY_UNAVAILABLE);
      expect(body.story).toBeUndefined();
      expect(body.profiles).toBeUndefined();
      expect(reads).toBe(0);
    } finally {
      await client.close();
      await handler.close();
    }
  });
});

describe("hub-add-update story-optin", () => {
  function git(cwd: string, args: string[]): void {
    const result = spawnSync("git", ["-c", "user.email=story@example.com", "-c", "user.name=story", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || "git failed");
  }

  it("embeds the player signature and follows the manifest pin", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "story-add-"));
    const store = path.join(root, "store");
    expect(runStoreInitCli(["--dir", store]).code).toBe(0);
    git(store, ["init", "-b", "main"]);
    git(store, ["config", "user.email", "story@example.com"]);
    git(store, ["config", "user.name", "story"]);
    git(store, ["add", "."]);
    git(store, ["commit", "-m", "Empty hub update store"]);
    const keyFile = path.join(root, "author.keypair.json");
    const made = runKeygenCli(["--label", "Phoenix Collective", "--out", keyFile]);
    expect(made.code, made.stderr).toBe(0);
    const publicKey = made.stdout.split("\n")[0] ?? "";
    const player = playerWallet();
    const allow = optIn(player, "allow", "2026-10-31", "yes");

    const wrongKind = runAddUpdateCli([
      "--store",
      store,
      "--id",
      "note-1",
      "--kind",
      "status",
      "--body",
      "No.",
      "--story-optin",
      JSON.stringify(allow),
      "--keypair",
      keyFile,
    ]);
    expect(wrongKind.code).toBe(1);
    expect(wrongKind.stderr).toMatch(/only valid when --kind is story-optin/);

    const missing = runAddUpdateCli([
      "--store",
      store,
      "--id",
      "story-allow",
      "--kind",
      "story-optin",
      "--body",
      "Allow.",
      "--keypair",
      keyFile,
      "--approve",
    ]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/Pass --story-optin/);

    const bad = runAddUpdateCli([
      "--store",
      store,
      "--id",
      "story-allow",
      "--kind",
      "story-optin",
      "--body",
      "Allow.",
      "--created-at",
      "2026-10-31T00:00:00.000Z",
      "--hub-repo",
      HUB,
      "--story-optin",
      JSON.stringify({ ...allow, signature: base58Encode(bytes(64, 6)) }),
      "--keypair",
      keyFile,
      "--approve",
    ]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/player signature did not verify/);

    const noRepo = runAddUpdateCli([
      "--store",
      store,
      "--id",
      "story-allow",
      "--kind",
      "story-optin",
      "--body",
      "Allow.",
      "--story-optin",
      JSON.stringify(allow),
      "--keypair",
      keyFile,
      "--approve",
    ]);
    expect(noRepo.code).toBe(1);
    expect(noRepo.stderr).toMatch(/https repository URL/);

    const wrote = runAddUpdateCli([
      "--store",
      store,
      "--id",
      "story-allow",
      "--kind",
      "story-optin",
      "--body",
      "Allow the story.",
      "--created-at",
      "2026-10-31T00:00:00.000Z",
      "--hub-repo",
      HUB,
      "--story-optin",
      JSON.stringify(allow),
      "--keypair",
      keyFile,
      "--approve",
    ]);
    expect(wrote.code, wrote.stderr).toBe(0);
    const report = JSON.parse(wrote.stdout) as { commit: string; manifestHash: string; path: string };
    const saved = JSON.parse(readFileSync(path.join(store, "updates", "story-allow.json"), "utf8")) as {
      payload: { storyOptIn: StoryOptIn };
    };
    expect(saved.payload.storyOptIn.signature).toBe(allow.signature);
    expect(saved.payload.storyOptIn.wallet).toBe(player.wallet);
    expect("showLinks" in saved.payload.storyOptIn).toBe(false);
    expect(matchStoryConsent(saved.payload.storyOptIn, HUB)).toEqual({ showLinks: true });

    const pinned = await readHubUpdates(
      { repo: store, commit: report.commit, manifestHash: report.manifestHash, manifestPath: "hub-manifest.json" },
      new Set([publicKey]),
      1,
      "story-optin",
    );
    expect(pinned.hubId).toBe("");
    expect(pinned.updates.map((update) => update.id)).toEqual(["story-allow"]);
    expect(pinned.updates[0]?.consent).toBe("inert");
    expect(pinned.rejected).toEqual([]);
    const savedDoc = JSON.parse(readFileSync(path.join(store, "updates", "story-allow.json"), "utf8")) as unknown;
    const onHub = verifyHubUpdates([savedDoc], new Set([publicKey]), 1);
    const onOther = verifyHubUpdates([savedDoc], new Set([publicKey]), 1);
    expect(onHub.updates.map((update) => update.id)).toEqual(["story-allow"]);
    expect(onOther.updates.map((update) => update.id)).toEqual(["story-allow"]);
    expect(resolveStoryOptIn(onOther.updates, player.wallet, { hubId: OTHER_HUB, today: TODAY }).optedIn).toBe(false);
    expect(HUB_PIN_TTL_MS).toBeLessThanOrEqual(60_000);
    expect(HUB_PIN_MAX).toBeLessThanOrEqual(8);
    const pin = { repo: store, commit: report.commit, manifestHash: report.manifestHash, manifestPath: "hub-manifest.json" };
    const aside = path.join(root, "store-aside");
    const firstRead = await readStoryContext(pin, new Set([publicKey]), 1);
    renameSync(store, aside);
    try {
      const cached = await readStoryContext(pin, new Set([publicKey]), 1);
      expect(cached.hubId).toBeNull();
      expect(cached.updates).toEqual(firstRead.updates);
    } finally {
      renameSync(aside, store);
    }
    await expect(
      readHubUpdates(
        { repo: store, commit: report.commit, manifestHash: "ab".repeat(32), manifestPath: "hub-manifest.json" },
        new Set([publicKey]),
        1,
      ),
    ).rejects.toThrow(/manifest hash did not match/);

    const revoke = optIn(player, "revoke", "2026-10-31");
    const revoked = runAddUpdateCli([
      "--store",
      store,
      "--id",
      "story-revoke",
      "--kind",
      "story-optin",
      "--body",
      "Revoke the story.",
      "--created-at",
      "2026-11-01T00:00:00.000Z",
      "--hub-repo",
      HUB,
      "--story-optin",
      JSON.stringify(revoke),
      "--keypair",
      keyFile,
      "--approve",
    ]);
    expect(revoked.code, revoked.stderr).toBe(0);
    const bothDocs = ["story-allow", "story-revoke"].map(
      (id) => JSON.parse(readFileSync(path.join(store, "updates", `${id}.json`), "utf8")) as unknown,
    );
    const both = verifyHubUpdates(bothDocs, new Set([publicKey]), 1);
    expect(both.updates.map((update) => update.kind)).toEqual(["story-optin", "story-optin"]);
    const reader = createPlayerStoryReader({
      now: () => CLOCK,
      playerLegacy: async () => {
        throw new Error("legacy was read");
      },
      hub: hubOf(both.updates),
    });
    await expect(reader({ address: player.wallet })).resolves.toMatchObject({ status: "not opted in" });
  });
});

describe("readme", () => {
  it("lists player_story and the opt-in sentences", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("| `player_story` |");
    expect(readme).toContain(storyAllowMessage("<address>", "<YYYY-MM-DD>", "<id>", "yes"));
    expect(readme).toContain(storyAllowMessage("<address>", "<YYYY-MM-DD>", "<id>", "no"));
    expect(readme).toContain(storyRevokeMessage("<address>", "<YYYY-MM-DD>", "<id>"));
    expect(readme).toContain("24 read-only tools");
    expect(readme).toContain("https://github.com/owner/repo");
    expect(readme).toContain("not the manifest file name");
  });
});
