import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";

import { searchHub } from "../src/dao/hub.js";
import { UserInputError } from "../src/errors.js";
import { runAddUpdateCli } from "../src/hub/add-update-cli.js";
import { base58Encode } from "../src/hub/base58.js";
import { inspectGuild, isDiscordInvite } from "../src/hub/guild.js";
import { runKeygenCli } from "../src/hub/keygen-cli.js";
import { runStoreInitCli } from "../src/hub/store-init-cli.js";
import {
  guildSearchDocs,
  matchSearch,
  playerSearchDocs,
  selectOptedInWallets,
  type SearchDoc,
} from "../src/hub/search.js";
import { storyAllowMessage, storyRevokeMessage, type StoryOptIn } from "../src/hub/story-optin.js";
import {
  HUB_APPROVAL_DOMAIN,
  canonicalHubPayload,
  hubUpdateHash,
  parseHubPayload,
  verifyHubUpdates,
  type HubUpdatePayload,
} from "../src/hub/update.js";

const HUB = "https://github.com/example/guild-hub";
const TODAY = "2026-10-31";

function signer() {
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

function player() {
  const pair = nacl.sign.keyPair();
  const wallet = base58Encode(pair.publicKey);
  return {
    wallet,
    sign(action: "allow" | "revoke", date: string) {
      const text = action === "revoke" ? storyRevokeMessage(wallet, date, HUB) : storyAllowMessage(wallet, date, HUB, "no");
      return base58Encode(nacl.sign.detached(new TextEncoder().encode(text), pair.secretKey));
    },
  };
}

function guild(over: Record<string, unknown> = {}) {
  return {
    name: "Dawn Watch",
    description: "A morning group at the dock.",
    links: ["https://example.com/dawn"],
    tags: ["dock", "morning"],
    ...over,
  };
}

describe("guild listing schema", () => {
  it("accepts a guild with a logo and refuses members, wallets, prices, and svg", () => {
    const image = { url: "images/dawn.png", alt: "Dawn mark", link: "https://example.com/dawn" };
    const good = guild({
      image,
      site: "https://example.com/dawn",
      discord: "https://discord.gg/dawn-watch",
    });
    expect(inspectGuild(good)).toEqual({ ok: true, guild: good });
    const { tags: _tags, ...withoutTags } = guild();
    expect(inspectGuild(withoutTags).ok).toBe(true);
    expect(inspectGuild({ ...good, members: ["Ada"] })).toEqual({ ok: false, reason: "unknown_field" });
    expect(inspectGuild({ ...good, wallet: "1".repeat(32) })).toEqual({ ok: false, reason: "unknown_field" });
    expect(inspectGuild({ ...good, price: "9" })).toEqual({ ok: false, reason: "unknown_field" });
    expect(inspectGuild(guild({ description: "50% off today" }))).toEqual({ ok: false, reason: "price" });
    expect(inspectGuild(guild({ tags: ["price"] }))).toEqual({ ok: false, reason: "price" });
    expect(inspectGuild(guild({ name: "1".repeat(32) }))).toEqual({ ok: false, reason: "wallet" });
    expect(inspectGuild(guild({ tags: ["1".repeat(32)] }))).toEqual({ ok: false, reason: "wallet" });
    expect(inspectGuild(guild({ links: ["http://example.com/dawn"] }))).toEqual({ ok: false, reason: "malformed" });
    expect(inspectGuild(guild({ links: ["javascript:alert(1)"] }))).toEqual({ ok: false, reason: "malformed" });
    expect(inspectGuild(guild({ image: { url: "https://cdn.example.com/logo.svg", alt: "Mark" } }))).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(inspectGuild(guild({ image: { url: "data:image/svg+xml,<svg></svg>", alt: "Mark" } }))).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(inspectGuild(guild({ image: { url: "https://cdn.example.com/logo.png" } }))).toEqual({ ok: false, reason: "malformed" });
    const withLinks = guild({ site: "https://example.com/dawn", discord: "https://discord.gg/dawn-watch" });
    expect(inspectGuild(withLinks)).toEqual({ ok: true, guild: withLinks });
    expect(inspectGuild(guild({ discord: "https://discord.com/invite/dawn-watch" })).ok).toBe(true);
    for (const discord of [
      "http://discord.gg/dawn",
      "https://discord.gg/dawn?x=1",
      "https://discord.gg/dawn#frag",
      "https://discordapp.com/invite/dawn",
      "https://www.discord.com/invite/dawn",
      "https://discord.com/invite/dawn/extra",
      "https://discord.gg/dawn/more",
      "https://user:pass@discord.gg/dawn",
      "https://evil.example/discord.gg/dawn",
      "javascript:alert(1)",
      `https://discord.gg/${"a".repeat(70)}`,
    ]) {
      expect(isDiscordInvite(discord), discord).toBe(false);
      expect(inspectGuild(guild({ discord })).ok, discord).toBe(false);
    }
    expect(inspectGuild(guild({ site: "http://example.com/dawn" }))).toEqual({ ok: false, reason: "malformed" });
    expect(isDiscordInvite("https://discord.gg/dawn-watch")).toBe(true);
    expect(isDiscordInvite("https://discord.com/invite/dawn-watch")).toBe(true);

    const parsedGuild = inspectGuild(good);
    if (!parsedGuild.ok) throw new Error("guild");
    const author = signer();
    const body: HubUpdatePayload = {
      v: 1,
      id: "guild-1",
      created_at: "2026-10-31T00:00:00.000Z",
      author: author.publicKey,
      kind: "guild",
      body: "Dawn Watch.",
      refs: { pip: null, txs: [] },
      prev: null,
      guild: parsedGuild.guild,
    };
    const canonical = canonicalHubPayload(body);
    expect(canonical).toContain('"alt":"Dawn mark"');
    expect(canonical).toContain('"url":"images/dawn.png"');
    expect(canonical).toContain('"site":"https://example.com/dawn"');
    expect(canonical).toContain('"discord":"https://discord.gg/dawn-watch"');
    expect(canonical).toContain('"tags":["dock","morning"]');
    const document = {
      payload: body,
      signature: author.sign(body),
      approvals: [{ publicKey: author.publicKey, signature: author.approve(body) }],
    };
    const checked = verifyHubUpdates([document], new Set([author.publicKey]), 1);
    expect(checked.rejected).toEqual([]);
    expect(checked.updates[0]?.guild?.name).toBe("Dawn Watch");
    const tampered = {
      ...document,
      payload: { ...body, guild: { ...body.guild!, description: "A different group." } },
    };
    expect(verifyHubUpdates([tampered], new Set([author.publicKey]), 1).rejected).toEqual([
      { id: "guild-1", reason: "bad_signature" },
    ]);
    expect(parseHubPayload({ ...body, kind: "guild", guild: { ...good, members: [] }, body: "Dawn Watch." })).toBeNull();
    expect(parseHubPayload({ ...body, body: `See ${"1".repeat(32)}` })).toBeNull();
  });
});

describe("hub search", () => {
  it("matches listing and guild fields and never returns an opted-out player", async () => {
    const allowed = player();
    const revoked = player();
    const hidden = player();
    const forged = opt(hidden, "allow", "2026-10-04");
    forged.signature = opt(allowed, "allow", "2026-10-04").signature;
    const updates = [
      { kind: "story-optin", hash: "a".repeat(64), storyOptIn: opt(allowed, "allow", "2026-10-01") },
      { kind: "story-optin", hash: "b".repeat(64), storyOptIn: opt(revoked, "allow", "2026-10-02") },
      { kind: "story-optin", hash: "c".repeat(64), storyOptIn: opt(revoked, "revoke", "2026-10-03") },
      { kind: "story-optin", hash: "d".repeat(64), storyOptIn: forged },
    ];
    const wallets = selectOptedInWallets(updates, HUB, TODAY);
    expect(wallets).toEqual([allowed.wallet]);
    expect(wallets).not.toContain(revoked.wallet);
    expect(wallets).not.toContain(hidden.wallet);

    const seen: string[] = [];
    const players = await playerSearchDocs(wallets, async (wallet) => {
      seen.push(wallet);
      if (wallet === revoked.wallet) return "Hidden Hale";
      return "Shown Hale";
    });
    expect(seen).toEqual([allowed.wallet]);
    const docs: SearchDoc[] = [
      ...players.docs,
      {
        kind: "player",
        name: "Hidden Hale",
        link: `#player/${revoked.wallet}`,
        description: "Opted in to a public story.",
        haystack: "hidden hale",
        optedIn: false,
      },
      {
        kind: "listing",
        name: "Dock Bakery",
        link: "https://example.com/bakery",
        description: "Morning bread.",
        haystack: "dock bakery morning bread business hybrid guilds",
      },
      ...guildSearchDocs(
        [
          {
            name: "Old Watch",
            guild: { name: "Dawn Watch", description: "Old text.", links: ["https://example.com/old"], tags: ["stale"] },
          },
          {
            name: "Dawn Watch",
            guild: {
              name: "Dawn Watch",
              description: "A morning group at the dock.",
              links: ["https://example.com/dawn"],
              tags: ["dock", "morning"],
              image: { url: "https://cdn.example.com/dawn.png", alt: "Dawn mark" },
            },
          },
        ],
        null,
      ),
    ];
    expect(matchSearch("bakery", docs).map((hit) => hit.name)).toEqual(["Dock Bakery"]);
    expect(matchSearch("morning group", docs).map((hit) => hit.description)).toEqual(["A morning group at the dock."]);
    expect(matchSearch("stale", docs)).toEqual([]);
    expect(matchSearch("dock", docs).map((hit) => hit.kind).sort()).toEqual(["guild", "listing"]);
    const people = matchSearch("hale", docs);
    expect(people.map((hit) => hit.name)).toEqual(["Shown Hale"]);
    expect(JSON.stringify(people)).not.toContain(revoked.wallet);
    expect(JSON.stringify(people)).not.toContain(hidden.wallet);
    expect(people[0]?.link).toBe(`#player/${allowed.wallet}`);
    expect(matchSearch("dawn", docs)[0]?.image).toBeUndefined();

    const looked: string[] = [];
    const empty = await searchHub(
      { repo: "", commit: "", manifestHash: "" },
      new Set(),
      1,
      "<script>alert(1)</script>",
      undefined,
      undefined,
      new Map(),
      new Date("2026-10-31T00:00:00.000Z"),
      async (wallet) => {
        looked.push(wallet);
        return "Nope";
      },
    );
    expect(empty.pinned).toBe(false);
    expect(empty.results).toEqual([]);
    expect(empty.note).toMatch(/not set/);
    expect(empty.note).not.toContain("<script>");
    expect(looked).toEqual([]);
    await expect(
      searchHub({ repo: "", commit: "", manifestHash: "" }, new Set(), 1, "x".repeat(81)),
    ).rejects.toBeInstanceOf(UserInputError);
  });
});

describe("hub-add-update guild", () => {
  it("commits a guild listing from --guild", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guild-add-"));
    const store = path.join(root, "store");
    expect(runStoreInitCli(["--dir", store]).code).toBe(0);
    git(store, ["init", "-b", "main"]);
    git(store, ["config", "user.email", "listing@example.com"]);
    git(store, ["config", "user.name", "listing"]);
    git(store, ["add", "."]);
    git(store, ["commit", "-m", "Empty hub update store"]);
    const keyFile = path.join(root, "author.keypair.json");
    const made = runKeygenCli(["--label", "Phoenix Collective", "--out", keyFile]);
    expect(made.code, made.stderr).toBe(0);
    const wrote = runAddUpdateCli([
      "--store",
      store,
      "--id",
      "dawn-1",
      "--kind",
      "guild",
      "--body",
      "Dawn Watch.",
      "--created-at",
      "2026-10-31T00:00:00.000Z",
      "--guild",
      JSON.stringify(guild({ image: { url: "https://cdn.example.com/dawn.png", alt: "Dawn mark" } })),
      "--keypair",
      keyFile,
      "--approve",
    ]);
    expect(wrote.code, wrote.stderr).toBe(0);
    const priced = runAddUpdateCli([
      "--store",
      store,
      "--id",
      "priced-1",
      "--kind",
      "guild",
      "--body",
      "50% off",
      "--guild",
      JSON.stringify(guild()),
      "--keypair",
      keyFile,
    ]);
    expect(priced.code).toBe(1);
    expect(priced.stderr).toMatch(/price/);
    expect(priced.stderr).not.toContain("50% off");
  });
});

function opt(who: ReturnType<typeof player>, action: "allow" | "revoke", date: string): StoryOptIn {
  return { action, wallet: who.wallet, date, signature: who.sign(action, date) };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync(
    "git",
    ["-c", "user.email=listing@example.com", "-c", "user.name=listing", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "git failed");
  return (result.stdout ?? "").trim();
}
