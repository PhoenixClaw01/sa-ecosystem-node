import { describe, expect, it } from "vitest";

import { inspectGuild } from "../src/hub/guild.js";
import { inspectListing, listingIdentity, pinnedHubLogoUrl, projectListings, resolveImageUrl, type Listing } from "../src/hub/listing.js";
import {
  SEARCH_NAME_BATCH,
  cleanDisplayName,
  guildSearchDocs,
  playerSearchDocs,
  resetPlayerNameCache,
} from "../src/hub/search.js";

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

function guild(over: Record<string, unknown> = {}) {
  return {
    name: "Dawn Watch",
    description: "A morning group at the dock.",
    links: ["https://example.com/dawn"],
    ...over,
  };
}

const COMMIT = "a".repeat(40);
const PIN = { repo: "https://github.com/Example/Demo.git", commit: COMMIT };

describe("hub-relative logos", () => {
  it("accepts a safe relative path and refuses percent encoding and dot segments", () => {
    expect(inspectListing(listing({ image: { url: "images/logo.png", alt: "Mark" } })).ok).toBe(true);
    expect(inspectListing(listing({ image: { url: "logo.png", alt: "Mark" } })).ok).toBe(true);
    for (const url of ["images/%2e%2e/logo.png", "images/../logo.png", "images/./logo.png", "../logo.png", "images//logo.png"]) {
      expect(inspectListing(listing({ image: { url, alt: "Mark" } })).ok, url).toBe(false);
    }
    expect(resolveImageUrl("images/logo.png", PIN)).toBe(
      `https://raw.githubusercontent.com/Example/Demo/${COMMIT}/images/logo.png`,
    );
    expect(resolveImageUrl("https://cdn.example.com/logo.png", PIN)).toBeNull();
  });
});

function chainRow(id: string, row: Listing) {
  return {
    id,
    created_at: "2099-01-01T00:00:00.000Z",
    hash: id.padEnd(64, "a"),
    signer: "11111111111111111111111111111111",
    signedBy: [] as string[],
    approvedBy: [] as string[],
    selfApproved: false,
    listing: row,
  };
}

describe("withdrawn tombstones", () => {
  it("drops an identity when the newest chain update is withdrawn, then shows a later republish", () => {
    expect(inspectListing(listing({ status: "withdrawn", listingId: "shop-1" })).ok).toBe(true);
    const available = listing({ listingId: "shop-1", title: "First title" });
    const tombstone = listing({ listingId: "shop-1", status: "withdrawn", title: "Different title" });
    const again = listing({ listingId: "shop-1", title: "Back again" });
    expect(projectListings([chainRow("a", available), chainRow("b", tombstone)], { includeExpired: true }, new Map(), "2026-10-31").map((row) => row.title)).toEqual([]);
    expect(projectListings([chainRow("a", available), chainRow("b", tombstone), chainRow("c", again)], { includeExpired: true }, new Map(), "2026-10-31").map((row) => row.title)).toEqual(["Back again"]);
    expect(listingIdentity(available)).toBe("id:shop-1");
    expect(listingIdentity(listing({ title: "Dock  Bakery", owner: "Ada" }))).toBe(
      listingIdentity(listing({ title: "dock bakery", owner: "ada" })),
    );
  });

  it("uses hub chain order, so a future created_at cannot outlive a later tombstone", () => {
    const future = guild({ name: "Dawn Watch", description: "Still up." });
    const later = guild({ name: "Dawn Watch", description: "Removed.", withdrawn: true, links: [] });
    expect(inspectGuild(later).ok).toBe(true);
    const shown = guildSearchDocs(
      [
        { name: "Dawn Watch", guild: future },
        { name: "Dawn Watch", guild: later },
      ],
      null,
    );
    expect(shown).toEqual([]);
    const republished = guildSearchDocs(
      [
        { name: "Dawn Watch", guild: future },
        { name: "Dawn Watch", guild: later },
        { name: "Dawn Watch", guild: guild({ name: "Dawn Watch", description: "Open again." }) },
      ],
      null,
    );
    expect(republished.map((row) => row.description)).toEqual(["Open again."]);
  });
});

describe("pinned logo src", () => {
  it("accepts only the raw url for this owner, repository, and commit", () => {
    const src = resolveImageUrl("images/logo.png", PIN);
    expect(src).toBe(`https://raw.githubusercontent.com/Example/Demo/${COMMIT}/images/logo.png`);
    expect(pinnedHubLogoUrl(src ?? "", PIN)).toBe(src);
    expect(pinnedHubLogoUrl(src ?? "", { repo: PIN.repo, commit: "b".repeat(40) })).toBeNull();
    expect(pinnedHubLogoUrl(src ?? "", { repo: "https://github.com/Example/Other.git", commit: COMMIT })).toBeNull();
    expect(pinnedHubLogoUrl(`https://raw.githubusercontent.com/other/Demo/${COMMIT}/images/logo.png`, PIN)).toBeNull();
    expect(pinnedHubLogoUrl("https://cdn.example.com/logo.png", PIN)).toBeNull();
  });
});

describe("guild url checks", () => {
  it("requires site or links and applies the wallet check only to urls", () => {
    expect(inspectGuild(guild({ links: [] })).ok).toBe(false);
    expect(inspectGuild(guild({ links: [], withdrawn: true })).ok).toBe(true);
    expect(inspectGuild(guild({ links: [], site: "https://example.com/price" })).ok).toBe(true);
    expect(inspectGuild(guild({ site: "https://example.com/50%25-off" })).ok).toBe(true);
    expect(inspectGuild(guild({ links: [`https://example.com/${"1".repeat(32)}`] }))).toEqual({
      ok: false,
      reason: "wallet",
    });
    expect(inspectGuild(guild({ description: "50% off" }))).toEqual({ ok: false, reason: "price" });
  });
});

describe("player search names", () => {
  const wallets = ["1", "2", "3", "4", "5", "6", "7", "8"].map((digit) => digit.repeat(32));

  it("strips control and bidi characters and keeps case", () => {
    expect(cleanDisplayName("Shown \u202EHale")).toBe("Shown Hale");
    expect(cleanDisplayName("shown hale")).toBe("shown hale");
    expect(cleanDisplayName("A\u0001B")).toBe("AB");
  });

  it("starts at most one batch, rotates the cursor, caches late names, and skips a negative miss", async () => {
    resetPlayerNameCache();
    const calls: string[] = [];
    const names = async (wallet: string) => {
      calls.push(wallet);
      if (wallet.startsWith("1")) return "One \u202EName";
      if (wallet.startsWith("2")) throw new Error("miss");
      return `Name ${wallet[0]}`;
    };
    const first = await playerSearchDocs(wallets, names, { budgetMs: 50 });
    expect(calls).toHaveLength(SEARCH_NAME_BATCH);
    expect(calls[0]).toBe(wallets[0]);
    expect(first.docs.some((doc) => doc.name === "One Name")).toBe(true);
    expect(first.truncated).toBe(true);
    const marked = calls.length;
    const second = await playerSearchDocs(wallets, names, { budgetMs: 50 });
    const secondCalls = calls.slice(marked);
    expect(secondCalls).not.toContain(wallets[0]);
    expect(secondCalls).not.toContain(wallets[1]);
    expect(secondCalls[0]).toBe(wallets[SEARCH_NAME_BATCH]);
    expect(second.docs.some((doc) => doc.name === "One Name")).toBe(true);
    expect(second.truncated).toBe(false);

    resetPlayerNameCache();
    let finish = (_name: string) => {};
    const lateCalls: string[] = [];
    const partial = await playerSearchDocs(
      [wallets[0] ?? ""],
      async (wallet) => {
        lateCalls.push(wallet);
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      },
      { budgetMs: 20 },
    );
    expect(partial.truncated).toBe(true);
    expect(partial.docs).toEqual([]);
    finish("Late \u202EName");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cached = await playerSearchDocs([wallets[0] ?? ""], async () => {
      throw new Error("should use the cache");
    }, { budgetMs: 20 });
    expect(cached.docs.map((doc) => doc.name)).toEqual(["Late Name"]);
    expect(cached.truncated).toBe(false);
    expect(lateCalls).toEqual([wallets[0]]);

    resetPlayerNameCache();
    let concurrent = 0;
    const parallelNames = () => {
      concurrent += 1;
      return new Promise<string>((resolve) => setTimeout(() => resolve("Same"), 30));
    };
    const [left, right] = await Promise.all([
      playerSearchDocs([wallets[0] ?? ""], parallelNames, { budgetMs: 80 }),
      playerSearchDocs([wallets[0] ?? ""], parallelNames, { budgetMs: 80 }),
    ]);
    expect(concurrent).toBe(1);
    expect(left.docs[0]?.name).toBe("Same");
    expect(right.docs[0]?.name).toBe("Same");
  });
});
