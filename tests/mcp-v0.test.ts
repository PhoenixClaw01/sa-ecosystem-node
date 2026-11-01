import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readWalletBalances, walletBalancesFromCache } from "../src/dao/balances.js";
import { requireDashboardScript } from "../src/dao/browser-scripts.js";
import { probeDataHealth } from "../src/dao/health.js";
import { liveBalanceSlots } from "../src/dao/live-balance.js";
import { listCategories, readHubUpdates } from "../src/dao/hub.js";
import { parsePipTracker } from "../src/dao/pip-tracker.js";
import { decodeMultisigAccount, squadsModule } from "../src/dao/squads.js";
import type { SolanaReadRpc } from "../src/dao/rpc.js";
import type { TreasuryCache } from "../src/dao/types.js";
import { ATLAS_MINT, DAO_TREASURY_ADDRESS, ECOSYSTEM_FUND_ADDRESS, USDC_MINT } from "../src/dao/wallets.js";
import { summarizeGalaxyActivity } from "../src/game/summarize.js";

function multisigBytes(): Uint8Array {
  const data = new Uint8Array(90);
  const disc = [0x46, 0x76, 0x09, 0x6c, 0xfe, 0xd7, 0x1f, 0x78];
  data.set(disc, 0);
  data[8] = 2;
  data[54] = 1;
  data.fill(2, 58, 90);
  return data;
}

describe("shared Squads decoder", () => {
  it("evaluates inlined dashboard scripts without Node require()", () => {
    const ata = readFileSync("dashboard/ata.js", "utf8");
    const squads = readFileSync("dashboard/squads.js", "utf8").replace(
      "root.SA_SQUADS = api;",
      "root.SA_SQUADS = api; root.SA_SQUADS_FROM_INLINE = true;",
    );
    (globalThis as Record<string, unknown>).__SA_DASHBOARD_SCRIPTS = { "ata.js": ata, "squads.js": squads };
    try {
      requireDashboardScript("squads.js");
      expect((globalThis as Record<string, unknown>).SA_SQUADS_FROM_INLINE).toBe(true);
      expect(squadsModule().decodeMs(multisigBytes()).threshold).toBe(2);
    } finally {
      delete (globalThis as Record<string, unknown>).__SA_DASHBOARD_SCRIPTS;
      delete (globalThis as Record<string, unknown>).SA_SQUADS_FROM_INLINE;
    }
  });

  it("decodes a multisig account through the dashboard module", () => {
    const direct = squadsModule().decodeMs(multisigBytes());
    const wrapped = decodeMultisigAccount(multisigBytes());
    expect(wrapped).toEqual(direct);
    expect(wrapped.threshold).toBe(2);
    expect(wrapped.members).toHaveLength(1);
    expect(wrapped.transactionIndex).toBe(0);
  });
});

describe("pip tracker", () => {
  it("reads payments and milestones from the saved public sheet and leaves blanks null", () => {
    const csv = readFileSync("dashboard/tracker.csv", "utf8");
    const parsed = parsePipTracker(csv);
    expect(parsed.missingColumns).toEqual([]);
    const numbered = parsed.rows.filter((row) => /^PIP-\d+/i.test(row.pip) || /^\d+$/.test(row.pip));
    expect(numbered.length).toBeGreaterThan(0);
    expect(parsed.rows.some((row) => row.usdcPaid === null || row.atlasPaid === null)).toBe(true);
  });
});

describe("hub updates and categories", () => {
  it("does not invent updates when no store is configured", async () => {
    const result = await readHubUpdates({}, new Set(), 1);
    expect(result.updates).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.note).toMatch(/not set/);
    expect(listCategories().every((category) => category.members === "unknown")).toBe(true);
  });
});

describe("galaxy activity", () => {
  it("counts starbases separately from systems that have none", () => {
    const summary = summarizeGalaxyActivity([
      {
        address: "a",
        name: "One",
        systemId: 1,
        coordinates: { x: 0, y: 0 },
        regionId: null,
        starbase: { owner: "oni", level: "level-0" },
        connectionCount: 2,
        celestialBodyCount: 1,
      },
      {
        address: "b",
        name: "Two",
        systemId: 2,
        coordinates: { x: 1, y: 1 },
        regionId: null,
        starbase: null,
        connectionCount: 0,
        celestialBodyCount: 3,
      },
    ]);
    expect(summary.starbaseCount).toBe(1);
    expect(summary.connectionCount).toBe(2);
    expect(summary.celestialBodyCount).toBe(4);
    expect(summary.starbaseLevels).toEqual({ "level-0": 1 });
  });
});

describe("data health and balances", () => {
  it("reports a missing cache and a refused galaxy read without inventing numbers", async () => {
    const fetchImpl = async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("docs.google.com")) return new Response("PIP Name,PIP\n", { status: 200 });
      return new Response("no", { status: 503 });
    };
    const rpc: SolanaReadRpc = {
      call: (async () => ({ value: 5 })) as SolanaReadRpc["call"],
      async batch() {
        return [];
      },
    };
    const checks = await probeDataHealth({
      fetchImpl,
      galaxyBaseUrl: "https://galaxy.staratlas.com",
      cachePath: path.join(tmpdir(), "missing-cache-health.json"),
      rpc,
      now: "2026-10-24T00:00:00.000Z",
    });
    const byName = Object.fromEntries(checks.map((check) => [check.source, check]));
    expect(byName.treasury_cache?.ok).toBe(false);
    expect(byName.galaxy_proposals?.ok).toBe(false);
    expect(byName.council_sheet?.ok).toBe(true);
    expect(byName.council_sheet?.asOf).toBe("2026-10-24T00:00:00.000Z");
    expect(byName.solana_rpc?.ok).toBe(true);
    expect(byName.wallet_balances?.ok).toBe(false);
    expect(byName.wallet_balances?.error).toMatch(/No balance was invented/);
  });

  it("reads every wallet balance in one getMultipleAccounts call", async () => {
    requireDashboardScript("ata.js");
    const associatedTokenAddress = (globalThis as unknown as { SA_ATA: { associatedTokenAddress: (owner: string, mint: string) => Promise<string> } }).SA_ATA
      .associatedTokenAddress;
    const slots = await liveBalanceSlots(associatedTokenAddress);
    let calls = 0;
    const rpc: SolanaReadRpc = {
      call: (async (method: string, params: readonly unknown[]) => {
        calls += 1;
        expect(method).toBe("getMultipleAccounts");
        const addresses = params[0] as string[];
        expect(addresses).toEqual(slots.map((slot) => slot.address));
        return {
          value: slots.map((slot) => {
            if (slot.symbol === "SOL" && slot.wallet === DAO_TREASURY_ADDRESS) return { lamports: 42 };
            if (slot.symbol === "SOL") return { lamports: 0 };
            if (slot.symbol === "ATLAS" && slot.wallet === DAO_TREASURY_ADDRESS) {
              return { lamports: 1, data: { parsed: { info: { mint: ATLAS_MINT, tokenAmount: { amount: "100000000", decimals: 8 } } } } };
            }
            return null;
          }),
        };
      }) as SolanaReadRpc["call"],
      async batch() {
        return [];
      },
    };
    const wallets = await readWalletBalances(rpc, "2026-10-24T00:00:00.000Z");
    expect(calls).toBe(1);
    const treasury = wallets.find((wallet) => wallet.address === DAO_TREASURY_ADDRESS);
    expect(treasury?.sol.amount).toBe("0.000000042");
    expect(treasury?.tokens.find((token) => token.symbol === "ATLAS")).toMatchObject({ amount: "1", missing: false });
    expect(treasury?.tokens.find((token) => token.symbol === "USDC")?.missing).toBe(true);
  });

  it("reports cached balance freshness when the live read fails", async () => {
    const cachePath = path.join(tmpdir(), `balance-health-${Date.now()}.json`);
    const fetchedAt = "2026-10-24T12:00:00.000Z";
    const mints = [
      ["native", "0", 9],
      [ATLAS_MINT, "100000000", 8],
      [USDC_MINT, "0", 6],
    ] as const;
    const wallets = [DAO_TREASURY_ADDRESS, ECOSYSTEM_FUND_ADDRESS];
    writeFileSync(
      cachePath,
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: fetchedAt,
        rpc: "https://api.mainnet-beta.solana.com/",
        balances: wallets.flatMap((wallet) => mints.map(([mint, amountRaw, decimals]) => ({ wallet, mint, amountRaw, decimals, fetchedAt }))),
      }),
    );
    const rpc: SolanaReadRpc = {
      call: (async (method: string) => {
        if (method === "getBalance") return { value: 1 };
        throw new Error("live balance read refused");
      }) as SolanaReadRpc["call"],
      async batch() {
        return [];
      },
    };
    const fetchImpl = async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("docs.google.com")) return new Response("PIP Name,PIP\n", { status: 200 });
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    };
    const checks = await probeDataHealth({
      fetchImpl,
      galaxyBaseUrl: "https://galaxy.staratlas.com",
      cachePath,
      rpc,
      now: "2026-10-24T13:00:00.000Z",
    });
    const balance = checks.find((check) => check.source === "wallet_balances");
    expect(balance).toMatchObject({ ok: true, mode: "cached", asOf: fetchedAt });
    expect(walletBalancesFromCache(JSON.parse(readFileSync(cachePath, "utf8")) as TreasuryCache)?.asOf).toBe(fetchedAt);
  });
});
