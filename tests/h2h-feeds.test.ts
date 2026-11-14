import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";

import { H2H_CARD, H2H_COMMUNITY_TOOLS } from "../src/h2h/data.generated.js";
import { h2hCard, listC4Markers, listCommunityTools, parseCommunityCatalog, parseCommunityTools } from "../src/h2h/feeds.js";
import { h2hFeedFor, h2hFeedResponse } from "../src/h2h/routes.js";
import { loadSignerAllowlist } from "../src/hub/allowlist.js";
import { base58Encode } from "../src/hub/base58.js";
import { formatHubStoreManifest } from "../src/hub/store-init-cli.js";
import { HUB_APPROVAL_DOMAIN, canonicalHubPayload, hubUpdateHash, type HubUpdatePayload } from "../src/hub/update.js";

const NOW = new Date("2026-10-31T15:00:00.000Z");

function signer() {
  const pair = nacl.sign.keyPair();
  return {
    publicKey: base58Encode(pair.publicKey),
    sign: (body: HubUpdatePayload) =>
      base58Encode(nacl.sign.detached(new TextEncoder().encode(`sa-ecosystem-node:hub-update:v1\n${canonicalHubPayload(body)}`), pair.secretKey)),
    approve: (body: HubUpdatePayload) =>
      base58Encode(nacl.sign.detached(new TextEncoder().encode(HUB_APPROVAL_DOMAIN + hubUpdateHash(body)), pair.secretKey)),
  };
}

function doc(author: ReturnType<typeof signer>, body: HubUpdatePayload, approvers: ReturnType<typeof signer>[]) {
  return { payload: body, signature: author.sign(body), approvals: approvers.map((a) => ({ publicKey: a.publicKey, signature: a.approve(body) })) };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-c", "user.email=h2h@example.com", "-c", "user.name=h2h", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "git failed");
  return (result.stdout ?? "").trim();
}

function pin(files: Record<string, unknown>) {
  const repo = mkdtempSync(path.join(tmpdir(), "h2h-repo-"));
  git(repo, ["init", "-b", "main"]);
  const names = Object.keys(files);
  for (const name of names) {
    mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    writeFileSync(path.join(repo, name), `${JSON.stringify(files[name], null, 2)}\n`);
  }
  writeFileSync(path.join(repo, "hub-manifest.json"), formatHubStoreManifest(names));
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "pin"]);
  return {
    repo,
    commit: git(repo, ["rev-parse", "HEAD"]),
    manifestPath: "hub-manifest.json",
    manifestHash: createHash("sha256").update(readFileSync(path.join(repo, "hub-manifest.json"))).digest("hex"),
  };
}

function store() {
  const author = signer();
  const reviewer = signer();
  const listingBody: HubUpdatePayload = {
    v: 1, id: "listing-1", created_at: "2026-10-31T00:00:00.000Z", author: author.publicKey, kind: "listing", body: "Listing.",
    refs: { pip: null, txs: [] }, prev: null,
    listing: { stream: "hybrid", category: "ip_and_business", title: "Example shop", owner: "Example Owner", url: "https://example.com/shop", status: "available", asOf: "2026-10-01", expiresAt: "2026-12-30" },
  };
  const guildBody: HubUpdatePayload = {
    v: 1, id: "guild-1", created_at: "2026-10-31T00:01:00.000Z", author: author.publicKey, kind: "guild", body: "Guild listing.",
    refs: { pip: null, txs: [] }, prev: hubUpdateHash(listingBody),
    guild: { name: "Dawn Watch", description: "A morning group at the dock.", links: ["https://example.com/dawn"] },
  };
  const source = pin({
    "updates/listing-1.json": doc(author, listingBody, [author, reviewer]),
    "updates/guild-1.json": doc(author, guildBody, [author, reviewer]),
  });
  return { author, reviewer, source, listingBody, guildBody };
}

describe("H2H data files", () => {
  it("serves exactly protocol/h2h/card.json and community-tools.json (run npm run build:h2h-data after editing them)", () => {
    expect(H2H_CARD).toEqual(JSON.parse(readFileSync("protocol/h2h/card.json", "utf8")));
    expect(H2H_COMMUNITY_TOOLS).toEqual(JSON.parse(readFileSync("protocol/h2h/community-tools.json", "utf8")));
  });

  it("publishes a Phoenix card whose record keys are exactly the agents signer set and that holds no secret", () => {
    const card = h2hCard() as { recordKeys: { publicKey: string }[]; provides: { url?: string }[]; neverDoes: string[] };
    expect(card.recordKeys.map((key) => key.publicKey)).toEqual([...loadSignerAllowlist(path.resolve("hub/signers/agents.json"))]);
    expect(card.neverDoes).toContain("promise-money");
    const text = JSON.stringify(card);
    expect(text).not.toMatch(/secret|private|password|token/i);
    for (const entry of card.provides) if (entry.url) expect(entry.url.startsWith("https://")).toBe(true);
  });

  it("validates the community tools file and refuses unknown fields, non-https links, and price or referral words", () => {
    expect(parseCommunityTools(H2H_COMMUNITY_TOOLS).length).toBeGreaterThan(0);
    const base = (H2H_COMMUNITY_TOOLS as { tools: Record<string, unknown>[] }).tools[0];
    const withTool = (tool: Record<string, unknown>) => ({ schema: "h2h.community-tools.v1", tools: [tool] });
    expect(() => parseCommunityTools(withTool({ ...base, extra: 1 }))).toThrow(/unknown field/);
    expect(() => parseCommunityTools(withTool({ ...base, url: "http://example.com/" }))).toThrow(/https/);
    expect(() => parseCommunityTools(withTool({ ...base, what: "Get 20% off with our referral link" }))).toThrow(/price, referral/);
    expect(() => parseCommunityTools(withTool({ ...base, what: "Costs $5" }))).toThrow(/price, referral/);
    expect(() => parseCommunityTools({ schema: "h2h.community-tools.v1", tools: [base, base] })).toThrow(/repeated id/);
    const feed = listCommunityTools(NOW);
    expect(feed.schema).toBe("h2h.community-tools.v1");
    expect(feed.tools.every((tool) => tool.weOperateIt === true)).toBe(true);
    expect(() => parseCommunityTools({ schema: "h2h.community-tools.v1", tools: [base], extra: true })).toThrow(/unknown field/);
  });
});

describe("community developer categories", () => {
  const developer = (over: Record<string, unknown> = {}) => ({
    id: "sample-dev",
    handle: "sample",
    sites: ["https://example.com/sample"],
    credentials: [{ kind: "repo", name: "sample/kit", url: "https://example.com/sample" }],
    kits: [{ name: "Sample kit", url: "https://example.com/sample", license: "MIT", linkOnly: false }],
    dualUse: false,
    checkedAt: "2026-11-14",
    ...over,
  });
  const catalog = (entry: Record<string, unknown>) => ({
    schema: "h2h.community-tools.v1",
    tools: [],
    categories: [{ id: "community-developers", name: "Community developers", entries: [entry] }],
  });

  it("serves Community developers and Official from list_community_tools, with SPDX or none stated", () => {
    const feed = listCommunityTools(NOW);
    expect(feed.generatedAt).toBe(NOW.toISOString());
    expect(feed.categories.map((category) => category.name)).toEqual(["Community developers", "Official"]);
    const entries = feed.categories.flatMap((category) => category.entries);
    expect(entries).toHaveLength(8);
    expect(entries.map((entry) => entry.id)).toEqual([
      "atlas-kit",
      "siphaawal",
      "ttdonovan",
      "ryden-systems",
      "harlock-space-pirate",
      "zamsor",
      "staratlas-dev-sage",
      "star-atlas-decoders",
    ]);
    expect(entries.map((entry) => entry.handle)).toEqual([
      "Aephia",
      "Siphaawal",
      "ttdonovan",
      "ryden-systems",
      "Harlock-Space-Pirate",
      "Zamsor",
      "@staratlas",
      "staratlasmeta",
    ]);
    expect(entries.every((entry) => entry.dualUse === true)).toBe(true);
    const kits = entries.flatMap((entry) => entry.kits.map((kit) => ({ entry: entry.id, ...kit })));
    expect(kits).toHaveLength(10);
    const licenseOf = (entryId: string, kitName: string) => kits.find((kit) => kit.entry === entryId && kit.name === kitName);
    expect(licenseOf("atlas-kit", "Atlas Kit")).toMatchObject({ license: "Apache-2.0", linkOnly: false });
    expect(licenseOf("siphaawal", "agent-team-harness")).toMatchObject({ license: "MIT", linkOnly: false });
    expect(licenseOf("siphaawal", "C4 Live")).toMatchObject({ license: "none stated", linkOnly: true });
    expect(licenseOf("ttdonovan", "sa-forge-signer")).toMatchObject({ license: "Unlicense OR MIT", linkOnly: false });
    expect(licenseOf("ryden-systems", "dao-dashboard")).toMatchObject({ license: "none stated", linkOnly: true });
    expect(licenseOf("ryden-systems", "zxp-tracker")).toMatchObject({ license: "MIT", linkOnly: false });
    expect(licenseOf("harlock-space-pirate", "c4-sage-sdk")).toMatchObject({ license: "Apache-2.0", linkOnly: false });
    expect(licenseOf("zamsor", "zamsor-fleet")).toMatchObject({ license: "none stated", linkOnly: true });
    expect(licenseOf("staratlas-dev-sage", "@staratlas/dev-sage")).toMatchObject({ license: "Apache-2.0", linkOnly: false });
    expect(licenseOf("star-atlas-decoders", "star-atlas-decoders")).toMatchObject({ license: "Apache-2.0", linkOnly: false });
    for (const kit of kits) {
      expect(kit.url.startsWith("https://")).toBe(true);
      expect(kit.linkOnly).toBe(kit.license === "none stated");
    }
    const text = JSON.stringify(feed);
    expect(text).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    expect(text).not.toMatch(/private key|password|api[_-]?key|BEGIN [A-Z ]+KEY/i);
    expect(parseCommunityCatalog(H2H_COMMUNITY_TOOLS).categories).toEqual(feed.categories);
  });

  it("rejects a developer row that vendors an unlicensed kit, an unknown field, or a non-https listing", () => {
    expect(parseCommunityCatalog(catalog(developer())).categories[0]?.entries[0]?.dualUse).toBe(false);
    const unlicensed = developer({
      kits: [{ name: "Sample kit", url: "https://example.com/sample", license: "none stated", linkOnly: false }],
    });
    expect(() => parseCommunityCatalog(catalog(unlicensed))).toThrow(/link only/);
    const markedLinkOnly = developer({
      kits: [{ name: "Sample kit", url: "https://example.com/sample", license: "Apache-2.0", linkOnly: true }],
    });
    expect(() => parseCommunityCatalog(catalog(markedLinkOnly))).toThrow(/must not be link only/);
    expect(() => parseCommunityCatalog(catalog(developer({ sites: ["http://example.com/sample"] })))).toThrow(/https/);
    expect(() => parseCommunityCatalog(catalog(developer({ handle: "person@example.com" })))).toThrow(/handle/);
    expect(() => parseCommunityCatalog(catalog(developer({ extra: 1 })))).toThrow(/unknown field/);
    expect(() => parseCommunityCatalog(catalog(developer({ kits: [{ name: "Sample kit", url: "https://example.com/sample", license: "not a license", linkOnly: false }] })))).toThrow(/SPDX expression or "none stated"/);
    const repeated = {
      schema: "h2h.community-tools.v1",
      tools: [],
      categories: [
        { id: "community-developers", name: "Community developers", entries: [developer()] },
        { id: "official", name: "Official", entries: [developer({ id: "sample-dev" })] },
      ],
    };
    expect(() => parseCommunityCatalog(repeated)).toThrow(/repeated id/);
  });
});

describe("list_c4_markers", () => {
  it("returns no markers and says so when the hub is not pinned", async () => {
    const result = await listC4Markers({}, new Set(), 1, {}, undefined, undefined, new Map(), NOW);
    expect(result.markers).toEqual([]);
    expect(result.source).toBeNull();
    expect(result.note).toMatch(/none were invented/);
  });

  it("turns verified listings and guilds into orbit markers with no coordinates, and drops unverified ones", async () => {
    const { author, reviewer, source, listingBody } = store();
    const labels = new Map([[author.publicKey, "Test author"]]);
    const trusted = new Set([author.publicKey, reviewer.publicKey]);
    const all = await listC4Markers(source, trusted, 2, {}, undefined, { allowAuthorApproval: true }, labels, NOW);
    expect(all.markers.map((marker) => marker.id)).toEqual(["listing:listing-1", "guild:guild-1"]);
    for (const marker of all.markers) {
      expect(marker.placement).toBe("orbit");
      expect(marker.anchor).toEqual({ status: "none", how: null });
      expect(marker).not.toHaveProperty("x");
      expect(marker.approvedBy).toEqual([author.publicKey, reviewer.publicKey].sort());
    }
    expect(all.markers[0]?.recordHash).toBe(hubUpdateHash(listingBody));
    expect(all.markers[0]?.signedMeaning).toMatch(/^Signed by Test author/);
    expect(all.source?.hubCommit).toBe(source.commit);

    expect((await listC4Markers(source, trusted, 2, { kind: "guild" }, undefined, { allowAuthorApproval: true }, labels, NOW)).markers).toHaveLength(1);
    expect((await listC4Markers(source, trusted, 2, { stream: "hybrid" }, undefined, { allowAuthorApproval: true }, labels, NOW)).markers.map((m) => m.kind)).toEqual(["listing"]);
    expect((await listC4Markers(source, trusted, 2, { anchored: true }, undefined, { allowAuthorApproval: true }, labels, NOW)).markers).toEqual([]);

    const untrusted = await listC4Markers(source, new Set([author.publicKey]), 2, {}, undefined, { allowAuthorApproval: true }, labels, NOW);
    expect(untrusted.markers).toEqual([]);
    await expect(listC4Markers(source, trusted, 2, { kind: "fleet" })).rejects.toThrow(/Unknown marker kind/);
  });
});

describe("H2H GET routes", () => {
  const feeds = {
    c4Markers: async () => ({ schema: "h2h.c4-markers.v1", markers: [] }),
    communityTools: () => ({ schema: "h2h.community-tools.v1", tools: [] }),
    card: () => ({ schema: "h2h.card.v0" }),
  };

  it("answers the three paths and the rewritten query form with cacheable JSON, and nothing else", async () => {
    expect(h2hFeedFor(new Request("https://node.example/c4-markers.json"))).toBe("c4Markers");
    expect(h2hFeedFor(new Request("https://node.example/community-tools.json"))).toBe("communityTools");
    expect(h2hFeedFor(new Request("https://node.example/.well-known/h2h-card.json"))).toBe("card");
    expect(h2hFeedFor(new Request("https://node.example/api/mcp?h2h=card"))).toBe("card");
    expect(h2hFeedFor(new Request("https://node.example/api/mcp?h2h=__proto__"))).toBeNull();
    expect(h2hFeedFor(new Request("https://node.example/api/mcp"))).toBeNull();
    expect(h2hFeedFor(new Request("https://node.example/c4-markers.json", { method: "POST", body: "{}" }))).toBeNull();
    const response = await h2hFeedResponse(new Request("https://node.example/.well-known/h2h-card.json"), feeds);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=300");
    expect(await response?.json()).toEqual({ schema: "h2h.card.v0" });
  });
});

describe("H2H registry", () => {
  it("pins the sha256 of the exact card bytes the node serves", async () => {
    const registry = JSON.parse(readFileSync("protocol/h2h/registry.json", "utf8")) as { stacks: { stack: string; cardSha256: string }[] };
    const phoenix = registry.stacks.find((entry) => entry.stack === "phoenix-ecosystem-node");
    const served = await h2hFeedResponse(new Request("https://node.example/.well-known/h2h-card.json"), {
      c4Markers: async () => ({}),
      communityTools: () => ({}),
      card: () => h2hCard(),
    });
    const bytes = Buffer.from(await (served as Response).arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(phoenix?.cardSha256);
    expect(bytes.equals(readFileSync("protocol/h2h/card.json"))).toBe(true);
  });
});
