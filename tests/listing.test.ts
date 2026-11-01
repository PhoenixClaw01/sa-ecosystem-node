import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";

import { listListings } from "../src/dao/hub.js";
import { UserInputError } from "../src/errors.js";
import { runAddUpdateCli } from "../src/hub/add-update-cli.js";
import { base58Encode } from "../src/hub/base58.js";
import { runKeygenCli } from "../src/hub/keygen-cli.js";
import { inspectListing, projectListings, resolveImageUrl, signedMeaning, type Listing } from "../src/hub/listing.js";
import { runStoreInitCli, formatHubStoreManifest } from "../src/hub/store-init-cli.js";
import {
  HUB_APPROVAL_DOMAIN,
  canonicalHubPayload,
  hubUpdateHash,
  parseHubPayload,
  verifyHubUpdates,
  type HubUpdatePayload,
} from "../src/hub/update.js";

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

function document(author: ReturnType<typeof signer>, body: HubUpdatePayload, approvers: ReturnType<typeof signer>[] = [author]) {
  return {
    payload: body,
    signature: author.sign(body),
    approvals: approvers.map((approver) => ({ publicKey: approver.publicKey, signature: approver.approve(body) })),
  };
}

function listing(over: Partial<Listing> = {}): Listing {
  return {
    stream: "hybrid",
    category: "ip_and_business",
    title: "Example shop",
    owner: "Example Owner",
    url: "https://example.com/shop",
    status: "available",
    asOf: "2026-10-01",
    expiresAt: "2026-12-30",
    ...over,
  };
}

function payload(author: string, body: Listing, over: Partial<HubUpdatePayload> = {}): HubUpdatePayload {
  return {
    v: 1,
    id: over.id ?? "listing-1",
    created_at: over.created_at ?? "2026-10-31T00:00:00.000Z",
    author,
    kind: "listing",
    body: over.body ?? "Listing.",
    refs: over.refs ?? { pip: null, txs: [] },
    prev: over.prev ?? null,
    listing: body,
  };
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

function pin(files: Record<string, unknown>) {
  const repo = mkdtempSync(path.join(tmpdir(), "listing-repo-"));
  git(repo, ["init", "-b", "main"]);
  const names = Object.keys(files);
  for (const name of names) {
    const full = path.join(repo, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, `${JSON.stringify(files[name], null, 2)}\n`);
  }
  const manifest = formatHubStoreManifest(names.filter((name) => name.startsWith("updates/")));
  writeFileSync(path.join(repo, "hub-manifest.json"), manifest);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "pin"]);
  const commit = git(repo, ["rev-parse", "HEAD"]);
  const manifestHash = createHash("sha256").update(readFileSync(path.join(repo, "hub-manifest.json"))).digest("hex");
  return { repo, commit, manifestPath: "hub-manifest.json", manifestHash };
}

const NOW = new Date("2026-10-31T15:00:00.000Z");

describe("listing schema", () => {
  it("accepts a listing inside the 90-day window and rejects unknown fields, a missing referral disclosure, and a late expiry", () => {
    const referral = listing({
      stream: "referral",
      category: "creators",
      disclosure: "Referral link. I may earn a reward.",
      offerText: "Verify the live offer before you order.",
      verifyLiveNote: "Terms were not re-checked today.",
      ownershipProof: { method: "signer_review", evidenceRef: "review-2026-10-31" },
    });
    expect(inspectListing(referral)).toEqual({ ok: true, listing: referral });
    expect(inspectListing({ ...referral, price: "9" })).toEqual({ ok: false, reason: "unknown_field" });
    expect(inspectListing({ ...referral, ownershipProof: { method: "signer_review", evidenceRef: "review", note: "extra" } })).toEqual({
      ok: false,
      reason: "unknown_field",
    });

    const { disclosure: _disclosure, ...withoutDisclosure } = referral;
    expect(inspectListing(withoutDisclosure)).toEqual({ ok: false, reason: "referral_disclosure" });
    expect(inspectListing({ ...referral, disclosure: " " })).toEqual({ ok: false, reason: "referral_disclosure" });
    expect(inspectListing(listing({ stream: "irl", status: "sold_out" })).ok).toBe(true);
    expect(inspectListing(listing({ stream: "hybrid" })).ok).toBe(true);

    expect(inspectListing(listing({ asOf: "2026-01-01", expiresAt: "2026-04-01" })).ok).toBe(true);
    expect(inspectListing(listing({ asOf: "2026-01-01", expiresAt: "2026-04-02" }))).toEqual({ ok: false, reason: "expiry_window" });
    expect(inspectListing(listing({ asOf: "2024-02-01", expiresAt: "2024-05-01" })).ok).toBe(true);
    expect(inspectListing(listing({ asOf: "2024-02-01", expiresAt: "2024-05-02" }))).toEqual({ ok: false, reason: "expiry_window" });
    expect(inspectListing(listing({ asOf: "2026-10-31", expiresAt: "2026-10-31" })).ok).toBe(true);
    expect(inspectListing(listing({ asOf: "2026-10-31", expiresAt: "2026-10-30" }))).toEqual({ ok: false, reason: "expiry_window" });
    expect(inspectListing(listing({ asOf: "2026-02-31", expiresAt: "2026-03-01" }))).toEqual({ ok: false, reason: "malformed" });
    expect(inspectListing(listing({ category: "farms" as Listing["category"] }))).toEqual({ ok: false, reason: "malformed" });
    expect(inspectListing(listing({ url: "javascript:alert(1)" }))).toEqual({ ok: false, reason: "malformed" });
    expect(inspectListing(listing({ title: "Line\nbreak" }))).toEqual({ ok: false, reason: "malformed" });
    expect(inspectListing(listing({ url: "https://user:pass@example.com/shop" }))).toEqual({ ok: false, reason: "malformed" });
    for (const url of [
      "http://example.com/",
      "https://example.com\\@evil.com",
      "https:example.com",
      "https:///x",
      "https://example.com",
      "https://localhost/",
      "https://shop.localhost/",
      "https://127.0.0.1/",
      "https://[::1]/",
      "https://192.168.0.1/shop",
      "https://example/",
    ]) {
      expect(inspectListing(listing({ url })), url).toEqual({ ok: false, reason: "malformed" });
    }
    expect(inspectListing(listing({ url: "https://example.com/" })).ok).toBe(true);
    const hidden = ["\u0085", "\u2028", "\u2029", "\u202A", "\u202E", "\u2066", "\u2069", "\u200B", "\u200C", "\u200D", "\u200E", "\u200F", "\uFEFF"];
    for (const char of hidden) {
      expect(inspectListing(listing({ title: `Shop${char}` })), `title ${char.codePointAt(0)}`).toEqual({ ok: false, reason: "malformed" });
      expect(inspectListing(listing({ owner: `Owner${char}` })), `owner ${char.codePointAt(0)}`).toEqual({ ok: false, reason: "malformed" });
      expect(inspectListing(listing({ offerText: `Offer${char}` })), `offer ${char.codePointAt(0)}`).toEqual({ ok: false, reason: "malformed" });
      expect(inspectListing(listing({ verifyLiveNote: `Check${char}` })), `note ${char.codePointAt(0)}`).toEqual({
        ok: false,
        reason: "malformed",
      });
      expect(inspectListing(listing({ disclosure: `Note${char}` })), `disclosure ${char.codePointAt(0)}`).toEqual({
        ok: false,
        reason: "malformed",
      });
      expect(
        inspectListing(listing({ ownershipProof: { method: "site_code", evidenceRef: `ref${char}` } })),
        `evidence ${char.codePointAt(0)}`,
      ).toEqual({ ok: false, reason: "malformed" });
      expect(inspectListing(listing({ url: `https://example.com/shop${char}` })), `url ${char.codePointAt(0)}`).toEqual({
        ok: false,
        reason: "malformed",
      });
    }

    const author = "11111111111111111111111111111111";
    expect(parseHubPayload({ ...payload(author, referral), listing: undefined })).toBeNull();
    expect(parseHubPayload({ ...payload(author, listing()), kind: "announcement", listing: referral })).toBeNull();
    expect(parseHubPayload(payload(author, referral))?.listing).toEqual(referral);
    expect(canonicalHubPayload(payload(author, referral))).not.toMatch(/:\s|\s,|\n/);
    expect(canonicalHubPayload(payload(author, referral))).toContain('"disclosure":"Referral link. I may earn a reward."');
  });

  it("covers the listing fields in the author signature", () => {
    const author = signer();
    const body = payload(author.publicKey, listing({ stream: "referral", disclosure: "Referral link. I may earn a reward." }));
    const checked = verifyHubUpdates([document(author, body)], new Set([author.publicKey]), 1);
    expect(checked.rejected).toEqual([]);
    expect(checked.updates[0]?.listing?.title).toBe("Example shop");
    expect(checked.updates[0]?.approvedBy).toEqual([author.publicKey]);
    const tampered = document(author, body);
    const signedListing = body.listing;
    if (!signedListing) throw new Error("missing listing");
    tampered.payload = { ...body, listing: { ...signedListing, url: "https://example.com/other" } };
    const bad = verifyHubUpdates([tampered], new Set([author.publicKey]), 1);
    expect(bad.updates).toEqual([]);
    expect(bad.rejected).toEqual([{ id: "listing-1", reason: "bad_signature" }]);
  });

  it("accepts a png, jpeg, or webp logo and refuses svg, data, http, and a missing alt", () => {
    const png = { url: "https://cdn.example.com/logo.png", alt: "Shop mark" };
    const jpeg = { url: "https://cdn.example.com/logo.jpeg", alt: "Shop mark" };
    const jpg = { url: "https://cdn.example.com/logo.jpg", alt: "Shop mark" };
    const webp = { url: "https://cdn.example.com/logo.webp", alt: "Shop mark", link: "https://example.com/shop" };
    const relative = { url: "images/logo.png", alt: "Shop mark" };
    for (const image of [png, jpeg, jpg, webp, relative]) {
      expect(inspectListing(listing({ image })), image.url).toEqual({ ok: true, listing: listing({ image }) });
    }
    for (const stream of ["referral", "hybrid", "irl"] as const) {
      const image = { url: "https://cdn.example.com/mark.png", alt: "Mark" };
      const row = listing({
        stream,
        ...(stream === "referral" ? { disclosure: "A referral." } : {}),
        image,
      });
      expect(inspectListing(row).ok, stream).toBe(true);
    }
    const bad = [
      { url: "http://cdn.example.com/logo.png", alt: "Shop mark" },
      { url: "javascript:alert(1)", alt: "Shop mark" },
      { url: "data:image/svg+xml,<svg onload=alert(1)></svg>", alt: "Shop mark" },
      { url: "data:image/png;base64,aaaa", alt: "Shop mark" },
      { url: "https://cdn.example.com/logo.svg", alt: "Shop mark" },
      { url: "https://cdn.example.com/logo.svg.png", alt: "Shop mark" },
      { url: "https://cdn.example.com/logo.png.svg", alt: "Shop mark" },
      { url: "images/logo.svg", alt: "Shop mark" },
      { url: "../logo.png", alt: "Shop mark" },
      { url: "/images/logo.png", alt: "Shop mark" },
      { url: "https://cdn.example.com/logo.png" },
      { url: "https://cdn.example.com/logo.png", alt: "" },
      { url: "https://cdn.example.com/logo.png", alt: "Shop mark", src: "https://cdn.example.com/logo.png" },
    ];
    for (const image of bad) {
      const inspected = inspectListing(listing({ image: image as Listing["image"] }));
      expect(inspected.ok, JSON.stringify(image)).toBe(false);
    }
    expect(inspectListing(listing({ image: { url: "https://cdn.example.com/logo.png", alt: "Shop mark", extra: "no" } as Listing["image"] }))).toEqual({
      ok: false,
      reason: "unknown_field",
    });

    const commit = "a".repeat(40);
    expect(resolveImageUrl("images/logo.png", { repo: "https://github.com/Example/Demo.git", commit })).toBe(
      `https://raw.githubusercontent.com/Example/Demo/${commit}/images/logo.png`,
    );
    expect(resolveImageUrl("https://cdn.example.com/logo.jpg", { repo: "https://github.com/Example/Demo.git", commit })).toBeNull();
    expect(inspectListing(listing({ image: { url: "https://cdn.example.com/logo.jpg", alt: "Shop mark" } })).ok).toBe(true);
    expect(inspectListing(listing({ image: { url: "images/%2e%2e/logo.png", alt: "Shop mark" } })).ok).toBe(false);
    expect(inspectListing(listing({ image: { url: "images/../logo.png", alt: "Shop mark" } })).ok).toBe(false);
    expect(resolveImageUrl("images/logo.png", { repo: "/tmp/hub", commit })).toBeNull();
    expect(resolveImageUrl("https://cdn.example.com/logo.svg", null)).toBeNull();
  });

  it("covers the image in the author signature", () => {
    const author = signer();
    const image = { url: "images/logo.webp", alt: "Shop mark", link: "https://example.com/shop" };
    const body = payload(author.publicKey, listing({ image }));
    const canonical = canonicalHubPayload(body);
    expect(canonical).toContain('"image":{"alt":"Shop mark","link":"https://example.com/shop","url":"images/logo.webp"}');
    const checked = verifyHubUpdates([document(author, body)], new Set([author.publicKey]), 1);
    expect(checked.rejected).toEqual([]);
    expect(checked.updates[0]?.listing?.image).toEqual(image);
    const tampered = document(author, body);
    const signed = body.listing;
    if (!signed?.image) throw new Error("missing image");
    tampered.payload = { ...body, listing: { ...signed, image: { ...signed.image, alt: "Other mark" } } };
    expect(verifyHubUpdates([tampered], new Set([author.publicKey]), 1).rejected).toEqual([{ id: "listing-1", reason: "bad_signature" }]);
    const dropped = document(author, body);
    const { image: _image, ...without } = signed;
    dropped.payload = { ...body, listing: without };
    expect(verifyHubUpdates([dropped], new Set([author.publicKey]), 1).rejected).toEqual([{ id: "listing-1", reason: "bad_signature" }]);
  });
});

describe("list_listings", () => {
  function chain() {
    const author = signer();
    const outsider = signer();
    const referral = payload(
      author.publicKey,
      listing({
        stream: "referral",
        category: "creators",
        title: "Referral",
        status: "available",
        asOf: "2026-10-01",
        expiresAt: "2026-10-31",
        disclosure: "Referral link. I may earn a reward.",
        ownershipProof: { method: "site_code", evidenceRef: "page-footer" },
      }),
      { id: "ref-1" },
    );
    const note: HubUpdatePayload = {
      v: 1,
      id: "note-1",
      created_at: "2026-10-31T01:00:00.000Z",
      author: author.publicKey,
      kind: "announcement",
      body: "Not a listing.",
      refs: { pip: null, txs: [] },
      prev: hubUpdateHash(referral),
    };
    const sold = payload(
      author.publicKey,
      listing({
        stream: "irl",
        category: "ip_and_business",
        title: "Farm",
        status: "sold_out",
        asOf: "2026-10-01",
        expiresAt: "2026-10-30",
      }),
      { id: "irl-1", created_at: "2026-10-31T02:00:00.000Z", prev: hubUpdateHash(note) },
    );
    const inquire = payload(
      author.publicKey,
      listing({
        stream: "hybrid",
        category: "ip_and_business",
        title: "Merch",
        status: "inquire_only",
        asOf: "2026-10-15",
        expiresAt: "2026-12-01",
        offerText: "Inquire on the site.",
        verifyLiveNote: "Verify the live offer before you order.",
      }),
      { id: "hybrid-1", created_at: "2026-10-31T03:00:00.000Z", prev: hubUpdateHash(sold) },
    );
    const paused = payload(
      author.publicKey,
      listing({
        stream: "hybrid",
        category: "events",
        title: "Paused",
        status: "paused",
        asOf: "2026-10-20",
        expiresAt: "2026-11-20",
      }),
      { id: "paused-1", created_at: "2026-10-31T04:00:00.000Z", prev: hubUpdateHash(inquire) },
    );
    const foreign = payload(
      outsider.publicKey,
      listing({ title: "Foreign" }),
      { id: "foreign-1", created_at: "2026-10-31T05:00:00.000Z", prev: hubUpdateHash(paused) },
    );
    const pinned = pin({
      "updates/ref-1.json": document(author, referral),
      "updates/note-1.json": document(author, note),
      "updates/irl-1.json": document(author, sold),
      "updates/hybrid-1.json": document(author, inquire),
      "updates/paused-1.json": document(author, paused),
      "updates/foreign-1.json": document(outsider, foreign),
    });
    const labels = new Map([[author.publicKey, "Phoenix Collective"]]);
    const sets = [{ id: "default", threshold: 1, publicKeys: new Set([author.publicKey]) }];
    return { author, outsider, pinned, labels, sets };
  }

  async function read(extra: Parameters<typeof listListings>[3] = {}, clock = NOW) {
    const built = chain();
    const result = await listListings(
      built.pinned,
      new Set([built.author.publicKey]),
      1,
      extra,
      built.sets,
      undefined,
      built.labels,
      clock,
    );
    return { ...built, result };
  }

  it("hides expired listings unless includeExpired is set, and filters stream, category, and status", async () => {
    const shown = await read();
    expect(shown.result.listings.map((row) => row.id)).toEqual(["ref-1", "hybrid-1", "paused-1"]);
    expect(shown.result.listings.map((row) => row.expired)).toEqual([false, false, false]);
    expect(shown.result.listings.map((row) => row.id)).not.toContain("note-1");
    expect(shown.result.rejected).toEqual([{ id: "foreign-1", reason: "unknown_signer" }]);
    expect(shown.result.listings[0]).toMatchObject({
      signer: shown.author.publicKey,
      signerDisplayName: "Phoenix Collective",
      signedMeaning: signedMeaning("Phoenix Collective"),
      stream: "referral",
      disclosure: "Referral link. I may earn a reward.",
      ownershipProof: { method: "site_code", evidenceRef: "page-footer" },
    });
    expect(shown.result.listings[1]?.verifyLiveNote).toBe("Verify the live offer before you order.");
    expect(shown.result.note).toMatch(/does not take payment/);
    expect(shown.result.note).toMatch(/manifest hash matched the pin/);

    const expired = await read({ includeExpired: true });
    const sold = expired.result.listings.find((row) => row.id === "irl-1");
    expect(expired.result.listings.map((row) => row.id)).toEqual(["ref-1", "irl-1", "hybrid-1", "paused-1"]);
    expect(sold).toMatchObject({ expired: true, status: "sold_out", stream: "irl" });
    expect(expired.result.listings.filter((row) => row.id !== "irl-1").every((row) => row.expired === false)).toBe(true);

    expect((await read({ stream: "referral" })).result.listings.map((row) => row.id)).toEqual(["ref-1"]);
    expect((await read({ category: "ip_and_business" })).result.listings.map((row) => row.id)).toEqual(["hybrid-1"]);
    expect((await read({ category: "ip_and_business", includeExpired: true })).result.listings.map((row) => row.id)).toEqual([
      "irl-1",
      "hybrid-1",
    ]);
    expect((await read({ status: "sold_out" })).result.listings).toEqual([]);
    expect((await read({ status: "sold_out", includeExpired: true })).result.listings.map((row) => [row.id, row.expired])).toEqual([
      ["irl-1", true],
    ]);
    expect((await read({ status: "available" })).result.listings.map((row) => row.id)).toEqual(["ref-1"]);
    expect((await read({ stream: "hybrid", status: "paused" })).result.listings.map((row) => row.id)).toEqual(["paused-1"]);
    expect((await read({}, new Date("2026-10-30T00:00:00.000Z"))).result.listings.map((row) => row.id)).toEqual([
      "ref-1",
      "irl-1",
      "hybrid-1",
      "paused-1",
    ]);

    const unlabeled = projectListings(
      [
        {
          id: "one",
          created_at: "2026-10-31T00:00:00.000Z",
          hash: "ab".repeat(32),
          signer: "11111111111111111111111111111111",
          signedBy: ["11111111111111111111111111111111"],
          approvedBy: ["11111111111111111111111111111111"],
          selfApproved: true,
          listing: listing(),
        },
      ],
      { includeExpired: false },
      new Map(),
      "2026-10-31",
    );
    expect(unlabeled[0]?.signerDisplayName).toBeNull();
    expect(unlabeled[0]?.signedMeaning).toBe(signedMeaning(null));
    expect(signedMeaning(null)).toBe(
      "Signed by an allowlisted wallet. This signature means that signer published this listing. It does not move money, and this node never handles payment.",
    );

    const built = chain();
    await expect(listListings(built.pinned, new Set([built.author.publicKey]), 1, { stream: "farm" })).rejects.toBeInstanceOf(UserInputError);
  });

  it("applies the signer threshold, revocation, and manifest pin", async () => {
    const built = chain();
    const allowlist = new Set([built.author.publicKey]);
    const below = await listListings(
      built.pinned,
      allowlist,
      2,
      {},
      [{ id: "default", threshold: 2, publicKeys: allowlist }],
      undefined,
      built.labels,
      NOW,
    );
    expect(below.listings).toEqual([]);
    expect(below.rejected.map((item) => item.id).sort()).toEqual(["foreign-1", "hybrid-1", "irl-1", "paused-1", "ref-1"]);
    expect(below.rejected.find((item) => item.id === "ref-1")?.reason).toBe("below_threshold");
    expect(below.rejected.map((item) => item.id)).not.toContain("note-1");

    const revoked = await listListings(
      built.pinned,
      allowlist,
      1,
      {},
      built.sets,
      { revokedSigners: new Set([built.author.publicKey]) },
      built.labels,
      NOW,
    );
    expect(revoked.listings).toEqual([]);
    expect(revoked.rejected.map((item) => item.id).sort()).toEqual(["foreign-1", "hybrid-1", "irl-1", "paused-1", "ref-1"]);
    expect(revoked.rejected.find((item) => item.id === "ref-1")?.reason).toBe("revoked_signer");
    expect(revoked.rejected.map((item) => item.id)).not.toContain("note-1");

    await expect(
      listListings(
        { ...built.pinned, manifestHash: "ab".repeat(32) },
        allowlist,
        1,
        {},
        built.sets,
        undefined,
        built.labels,
        NOW,
      ),
    ).rejects.toThrow(/manifest hash did not match/);
  });
});

describe("hub-add-update listing", () => {
  it("commits a listing and refuses a referral without disclosure", () => {
    const root = mkdtempSync(path.join(tmpdir(), "listing-add-"));
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
    const publicKey = made.stdout.split("\n")[0] ?? "";
    const fields = {
      stream: "irl",
      category: "ip_and_business",
      title: "Example farm",
      owner: "Example Owner",
      url: "https://example.com/farm",
      status: "inquire_only",
      asOf: "2026-10-22",
      expiresAt: "2026-11-21",
      verifyLiveNote: "Inquire on the site.",
    };

    const missing = runAddUpdateCli([
      "--store",
      store,
      "--id",
      "ref-1",
      "--kind",
      "listing",
      "--body",
      "Referral.",
      "--created-at",
      "2026-10-31T00:00:00.000Z",
      "--listing",
      JSON.stringify({ ...fields, stream: "referral", status: "available" }),
      "--keypair",
      keyFile,
      "--approve",
    ]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/referral listing requires disclosure/i);
    expect(existsSync(path.join(store, "updates", "ref-1.json"))).toBe(false);

    const wrongKind = runAddUpdateCli([
      "--store",
      store,
      "--id",
      "note-1",
      "--kind",
      "status",
      "--body",
      "No.",
      "--listing",
      JSON.stringify(fields),
      "--keypair",
      keyFile,
    ]);
    expect(wrongKind.code).toBe(1);
    expect(wrongKind.stderr).toMatch(/only valid when --kind is listing/);

    const wrote = runAddUpdateCli([
      "--store",
      store,
      "--id",
      "farm-1",
      "--kind",
      "listing",
      "--body",
      "Example farm.",
      "--created-at",
      "2026-10-31T00:00:00.000Z",
      "--listing",
      JSON.stringify(fields),
      "--keypair",
      keyFile,
      "--approve",
    ]);
    expect(wrote.code, wrote.stderr).toBe(0);
    const report = JSON.parse(wrote.stdout) as { commit: string; manifestHash: string; selfApproved: boolean };
    expect(report.selfApproved).toBe(true);
    expect(report.commit).toMatch(/^[0-9a-f]{40}$/);

    return listListings(
      { repo: store, commit: report.commit, manifestPath: "hub-manifest.json", manifestHash: report.manifestHash },
      new Set([publicKey]),
      1,
      {},
      [{ id: "default", threshold: 1, publicKeys: new Set([publicKey]) }],
      undefined,
      new Map([[publicKey, "Phoenix Collective"]]),
      NOW,
    ).then((served) => {
      expect(served.rejected).toEqual([]);
      expect(served.listings).toHaveLength(1);
      expect(served.listings[0]).toMatchObject({
        id: "farm-1",
        stream: "irl",
        status: "inquire_only",
        url: "https://example.com/farm",
        signerDisplayName: "Phoenix Collective",
        signedMeaning: signedMeaning("Phoenix Collective"),
        expired: false,
      });
    });
  });
});
