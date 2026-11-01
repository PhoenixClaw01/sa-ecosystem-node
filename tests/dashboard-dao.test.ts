import { readFileSync } from "node:fs";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import {
  chartPath,
  ecofundReport,
  ecofundSectionHtml,
  flowsSectionHtml,
  historySectionHtml,
  paymentsSectionHtml,
  proposalTableHtml,
  revenueSectionHtml,
  revenueView,
  treasuryReport,
  voteDetailHtml,
} from "../src/dao/dashboard-view.js";
import { parseProposals, parseVotes } from "../src/dao/galaxy.js";
import type { TreasuryCache } from "../src/dao/types.js";
import { ATLAS_MINT, DAO_TREASURY_ADDRESS, ECOSYSTEM_FUND_ADDRESS, USDC_MINT } from "../src/dao/wallets.js";

const AS_OF = "2026-10-24T00:00:00.000Z";

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/dao/${name}`, import.meta.url), "utf8")) as unknown;
}

function bundleApi(): {
  treasuryReport: typeof treasuryReport;
  ecofundSectionHtml: typeof ecofundSectionHtml;
} {
  const context: { SA_DAO?: { treasuryReport: typeof treasuryReport; ecofundSectionHtml: typeof ecofundSectionHtml } } = {};
  vm.createContext(context);
  vm.runInContext(readFileSync("dashboard/dao.js", "utf8"), context);
  if (!context.SA_DAO) throw new Error("dashboard/dao.js did not set SA_DAO.");
  return context.SA_DAO;
}

function usdcCache(): TreasuryCache {
  return {
    schemaVersion: 1,
    generatedAt: AS_OF,
    rpc: "https://api.mainnet-beta.solana.com/",
    discovery: { at: AS_OF },
    cursors: [
      {
        address: "usdc-ata",
        role: "dao_treasury",
        kind: "token",
        mint: USDC_MINT,
        newestSignature: "pay",
        reachedEnd: true,
        gaps: [],
        reconciled: true,
      },
    ],
    tokenAccounts: [
      { role: "dao_treasury", wallet: DAO_TREASURY_ADDRESS, mint: USDC_MINT, address: "usdc-ata", decimals: 6 },
    ],
    movements: [
      {
        signature: "pay",
        slot: 2,
        blockTime: 1728000000,
        wallet: DAO_TREASURY_ADDRESS,
        role: "dao_treasury",
        mint: USDC_MINT,
        symbol: "USDC",
        decimals: 6,
        deltaRaw: "-1000000",
        preRaw: "2000000",
        postRaw: "1000000",
        direction: "out",
        internal: false,
        counterparties: ["ExtWallet1111111111111111111111111111111111"],
        attribution: "counterparty",
      },
    ],
    balances: [
      {
        role: "dao_treasury",
        wallet: DAO_TREASURY_ADDRESS,
        mint: USDC_MINT,
        symbol: "USDC",
        tokenAccount: "usdc-ata",
        amountRaw: "1000000",
        decimals: 6,
        fetchedAt: AS_OF,
      },
    ],
    atlasScan: null,
  };
}

function refillCache(): TreasuryCache {
  const base = usdcCache();
  base.cursors.push({
    address: "fund-atlas",
    role: "ecosystem_fund",
    kind: "token",
    mint: ATLAS_MINT,
    newestSignature: "refill",
    reachedEnd: true,
    gaps: [],
    reconciled: true,
  });
  base.movements.push({
    signature: "refill",
    slot: 3,
    blockTime: 1751583549,
    wallet: ECOSYSTEM_FUND_ADDRESS,
    role: "ecosystem_fund",
    mint: ATLAS_MINT,
    symbol: "ATLAS",
    decimals: 8,
    deltaRaw: "8755123900000000",
    preRaw: "13654309100000000",
    postRaw: "22409433000000000",
    direction: "in",
    internal: true,
    counterparties: [DAO_TREASURY_ADDRESS],
    attribution: "counterparty",
  });
  base.balances.push(
    {
      role: "dao_treasury",
      wallet: DAO_TREASURY_ADDRESS,
      mint: ATLAS_MINT,
      symbol: "ATLAS",
      tokenAccount: "treasury-atlas",
      amountRaw: "80000000000000000",
      decimals: 8,
      fetchedAt: AS_OF,
    },
    {
      role: "ecosystem_fund",
      wallet: ECOSYSTEM_FUND_ADDRESS,
      mint: ATLAS_MINT,
      symbol: "ATLAS",
      tokenAccount: "fund-atlas",
      amountRaw: "22409433000000000",
      decimals: 8,
      fetchedAt: AS_OF,
    },
  );
  return base;
}

describe("dashboard treasury view", () => {
  it("labels cached flows and does not turn a missing ATLAS inflow into zero", () => {
    const html = flowsSectionHtml(treasuryReport(usdcCache()));
    expect(html).toContain("Cached as of 2026-10-24T00:00:00.000Z");
    expect(html).toContain("USDC");
    expect(html).toContain("1");
    expect(html).not.toMatch(/dao_treasury<\/td><td>ATLAS<\/td><td class="num">0</);
    expect(html).toContain("Withheld, not shown as zero");
  });

  it("lists the external USDC outflow in the payment ledger", () => {
    const html = paymentsSectionHtml(treasuryReport(usdcCache()));
    expect(html).toContain("solscan.io/tx/pay");
    expect(html).toContain(">1<");
    expect(html).toContain("Cached as of");
    const history = historySectionHtml(treasuryReport(usdcCache()));
    expect(history).toContain("Cached as of");
    expect(history).toContain("USDC");
    expect(history).not.toContain("dao_treasury ATLAS</td><td class=\"num\">0");
  });

  it("computes the PIP-23 5% limit and leaves unpaid PIPs unknown", () => {
    const report = ecofundReport(refillCache());
    const html = ecofundSectionHtml(report);
    expect(html).toContain("11,204,716.5");
    expect(html).toContain("After unpaid PIPs");
    expect(html).toContain("unknown");
    expect(html).toContain("Cached as of");
    expect(report.remainingAfterUnpaidPips.status).toBe("unknown");
  });

  it("shows a Council override beside the computed limit", () => {
    const html = ecofundSectionHtml(
      ecofundReport(refillCache(), {
        label: "config.js",
        perPipLimitAtlas: "13992734",
      }),
    );
    expect(html).toContain("11,204,716.5");
    expect(html).toContain("13,992,734");
    expect(html).toContain("config.js");
    expect(html).toContain("council_override");
  });

  it("rejects a cache that is not schema version 1", () => {
    expect(() => treasuryReport({ schemaVersion: 2, generatedAt: AS_OF })).toThrow(/version 1/);
  });
});

describe("dashboard galaxy view", () => {
  it("prints published vote counts and escapes a title", () => {
    const proposals = parseProposals(readJson("proposals.json"));
    proposals[0] = { ...proposals[0]!, title: `<script>alert("x")</script>` };
    const html = proposalTableHtml(proposals, AS_OF, "https://galaxy.staratlas.com/proposals");
    expect(html).toContain("Live as of 2026-10-24T00:00:00.000Z");
    expect(html).toMatch(/updated (just now|\d+ (minute|hour|day)s? ago)/);
    expect(html).toContain("PIP-23");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });

  it("does not declare a ranked winner from the votes file", () => {
    const votes = parseVotes(readJson("votes.json"));
    const html = voteDetailHtml(votes, AS_OF, "https://galaxy.staratlas.com/proposals/votes/pip.json");
    expect(html).toContain("5 vote records");
    expect(html).toContain("Ranked winner: unknown");
  });

  it("sums revenue by source from the recorded galaxy rows", () => {
    const html = revenueSectionHtml(revenueView(readJson("revenue.json")), AS_OF);
    expect(html).toContain("Game Activity");
    expect(html).toContain("Marketplace Fees");
    expect(html).toContain("Live as of 2026-10-24T00:00:00.000Z");
    expect(html).toMatch(/updated (just now|\d+ (minute|hour|day)s? ago)/);
    expect(html).toContain("https://galaxy.staratlas.com/dao/treasury");
  });
});

describe("chart geometry", () => {
  it("draws from the lowest amount to the highest and refuses a non-decimal", () => {
    const chart = chartPath([
      { day: "2024-01-31", amount: "1" },
      { day: "2024-02-29", amount: "3" },
    ]);
    expect(chart?.min).toBe("1");
    expect(chart?.max).toBe("3");
    expect(chart?.points.split(" ")).toHaveLength(2);
    expect(chartPath([])).toBeNull();
    expect(chartPath([{ day: "2024-01-31", amount: "1e2" }])).toBeNull();
  });
});

describe("browser bundle", () => {
  it("matches the TypeScript treasury report and does not include filesystem or signing calls", () => {
    const source = readFileSync("dashboard/dao.js", "utf8");
    expect(source).not.toMatch(/readFileSync|node:fs|sendTransaction|secretKey|signTransaction/);
    const cache = usdcCache();
    const bundled = bundleApi().treasuryReport(cache);
    expect(bundled.flows.rows).toEqual(treasuryReport(cache).flows.rows);
    expect(bundled.payments.payments).toEqual(treasuryReport(cache).payments.payments);
    expect(bundleApi().ecofundSectionHtml(ecofundReport(refillCache()))).toContain("11,204,716.5");
  });
});
