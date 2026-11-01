import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { monthlyIncome, proposalTableHtml, proposalVoteTable, revenueSectionHtml, revenueView } from "../src/dao/dashboard-view.js";
import { updatedAgo } from "../src/dao/freshness.js";
import { parseProposals } from "../src/dao/galaxy.js";
import { matchTrackerToPayments, parseTrackerMoney } from "../src/dao/payment-match.js";
import { buildRecordedMcp, RECORDED_AT } from "../src/dao/recorded-mcp.js";
import { approximateUsd, parseJupiterPrices } from "../src/dao/usd.js";
import { ATLAS_MINT, USDC_MINT } from "../src/dao/wallets.js";

const AS_OF = "2026-10-24T00:00:00.000Z";

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/dao/${name}`, import.meta.url), "utf8")) as unknown;
}

describe("galaxy vote columns", () => {
  it("shows yes, no, abstain, voting power, and unknown turnout", () => {
    const proposals = parseProposals(readJson("proposals.json"));
    const rows = proposalVoteTable(proposals);
    const pip4 = rows.find((row) => row.pipNumber === 4);
    const pip23 = rows.find((row) => row.pipNumber === 23);
    expect(pip4?.yes?.count).toBe("421");
    expect(pip4?.no?.count).toBe("33");
    expect(pip4?.abstain?.count).toBe("6");
    expect(pip23?.yes?.count).toBe("77");
    expect(pip4?.votingPower).toBeTruthy();
    expect(pip4?.turnout.status).toBe("unknown");
    const html = proposalTableHtml(proposals, AS_OF, "https://galaxy.staratlas.com/proposals");
    expect(html).toContain("81,843,902.5128978");
    expect(html).toContain("Turnout");
    expect(html).toContain("does not publish the electorate");
    expect(html).not.toMatch(/turnout[^<]{0,40}%/i);
  });

  it("does not declare a winner when a proposal allows more than one", () => {
    const [first] = parseProposals(readJson("proposals.json"));
    if (!first) throw new Error("fixture missing");
    const row = proposalVoteTable([{ ...first, voteWinners: 2 }])[0];
    expect(row?.winner.status).toBe("unknown");
  });
});

describe("monthly income", () => {
  it("sums published USDC value from May 2023 and skips empty months", () => {
    const income = monthlyIncome(readJson("revenue.json"));
    expect(income.may2023Present).toBe(true);
    expect(income.months.map((month) => month.period)).toEqual(["2023-05-01", "2026-08-01"]);
    expect(income.months[0]?.usdcValue).toBe("734285.77743772");
    const html = revenueSectionHtml(revenueView(readJson("revenue.json")), AS_OF);
    expect(html).toContain("2023-05-01");
    expect(html).toContain("<polyline");
    expect(html).toContain("omitted, not drawn as zero");
  });
});

describe("payment matching", () => {
  const sheet = [
    "PIP,PIP Name,Total Amount Paid (USDC),Total Amount Paid (ATLAS)",
    "PIP-2,Foundation,?,",
    "PIP-9,Example,\"1,000\",",
    "PIP-10,Other,1000,5",
  ].join("\n");

  it("keeps a question mark unknown and does not match it to a payment", () => {
    const parsed = parseTrackerMoney(readFileSync("dashboard/tracker.csv", "utf8"));
    const pip2 = parsed.rows.find((row) => row.pip === "PIP-2");
    expect(pip2?.usdcPaid).toBeNull();
    expect(parsed.unknownCells.some((cell) => cell.pip === "PIP-2" && cell.raw === "?")).toBe(true);
  });

  it("matches one equal amount and refuses a shared amount", () => {
    const parsed = parseTrackerMoney(sheet);
    const report = matchTrackerToPayments(
      parsed,
      [
        { signature: "only", mint: ATLAS_MINT, symbol: "ATLAS", amount: "5", time: AS_OF },
        { signature: "shared", mint: USDC_MINT, symbol: "USDC", amount: "1000", time: AS_OF },
      ],
      { chainRead: true, mintComplete: () => true },
    );
    expect(report.matches.map((match) => `${match.signature}:${match.confidence}`)).toEqual(["only:exact"]);
    expect(report.mismatches.some((item) => item.kind === "ambiguous_amount" && item.signature === "shared")).toBe(true);
    expect(report.matches.some((match) => match.pip === "PIP-2")).toBe(false);
  });

  it("does not call a sheet amount a mismatch when the cache was not read", () => {
    const report = matchTrackerToPayments(parseTrackerMoney(sheet), [], { chainRead: false, mintComplete: () => false });
    expect(report.matches).toEqual([]);
    expect(report.mismatches).toEqual([]);
    expect(report.unresolved[0]?.detail).toMatch(/not read/);
  });
});

describe("approximate USD", () => {
  it("uses a Jupiter usdPrice and leaves a missing mint unknown", () => {
    const parsed = parseJupiterPrices(
      {
        [ATLAS_MINT]: { usdPrice: 0.5, blockId: 1, decimals: 8 },
        [USDC_MINT]: { usdPrice: 0.9998, blockId: 1, decimals: 6 },
      },
      [ATLAS_MINT, USDC_MINT, "So11111111111111111111111111111111111111112"],
    );
    expect(parsed.prices[ATLAS_MINT]).toBe("0.5");
    expect(parsed.prices[USDC_MINT]).toBe("0.9998");
    expect(parsed.prices["So11111111111111111111111111111111111111112"]).toBeNull();
    expect(approximateUsd("2", parsed.prices[ATLAS_MINT] ?? "")).toBe("1");
    expect(approximateUsd("1", "1")).toBe("1");
  });

  it("rejects a price response that is not an object", () => {
    expect(() => parseJupiterPrices([], [USDC_MINT])).toThrow(/not an object/);
  });
});

describe("updated ago", () => {
  it("labels a fresh read and an older one", () => {
    const now = Date.parse(AS_OF);
    expect(updatedAgo(AS_OF, now)).toBe("updated just now");
    expect(updatedAgo(new Date(now - 5 * 60_000).toISOString(), now)).toBe("updated 5 minutes ago");
    expect(updatedAgo("not-a-date", now)).toBe("");
  });
});

describe("recorded MCP output", () => {
  it("runs the tool code on the checked-in sample and does not invent a balance", async () => {
    const recorded = await buildRecordedMcp({
      proposals: readJson("proposals.json"),
      votes: readJson("votes.json"),
      revenue: readJson("revenue.json"),
      trackerCsv: readFileSync("dashboard/tracker.csv", "utf8"),
      now: new Date(RECORDED_AT),
    });
    expect(recorded.label).toBe("recorded MCP output");
    expect(recorded.recordedAt).toBe(RECORDED_AT);
    expect(recorded.network).toBe(false);
    expect(recorded.panels.results?.ok).toBe(true);
    expect(JSON.stringify(recorded.panels.results?.output)).toContain("Star Atlas DAO Dashboard");
    expect(recorded.panels.votes?.ok).toBe(true);
    expect(recorded.panels.revenue?.ok).toBe(true);
    const paymentsError = recorded.panels.payments?.error ?? "";
    const cacheMissing = /does not invent balances/.test(paymentsError);
    expect(recorded.panels.history?.ok).toBe(true);
    expect(recorded.panels.limit?.ok).toBe(true);
    if (cacheMissing) {
      expect(recorded.panels.payments?.ok).toBe(false);
      expect(recorded.panels.payments?.output).toBeNull();
      expect(paymentsError).toMatch(/does not invent balances|is not available/);
      expect(recorded.panels.flows?.ok).toBe(false);
      expect(recorded.panels.flows?.output).toBeNull();
      expect(JSON.stringify(recorded.panels.history?.output)).toMatch(/not yet populated/);
      expect(JSON.stringify(recorded.panels.limit?.output)).not.toMatch(/amountRaw/);
    } else {
      expect(recorded.panels.payments?.ok).toBe(true);
      expect(recorded.panels.flows?.ok).toBe(true);
    }
    expect(recorded.panels.results?.registered).toBe(true);
    expect(recorded.panels.balances?.registered).toBe(false);
    expect(recorded.panels.balances?.ok).toBe(false);
    expect(recorded.panels.balances?.error).toMatch(/No balance was invented/);
    expect(recorded.panels.usd?.error).toMatch(/No price was invented/);
    expect(JSON.stringify(recorded)).not.toMatch(/\/workspace|\/home\/|\/tmp\/|\/Users\//);
  });
});
