import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { formatRaw, formatScaled } from "../src/dao/amount.js";
import { buildFlows, buildPayments } from "../src/dao/aggregate.js";
import { refreshTreasury } from "../src/dao/backfill.js";
import { loadCache, saveCache } from "../src/dao/cache.js";
import {
  atlasRefillAmount,
  evaluateEcofund,
  nextQuarterDate,
  perPipLimit,
  usdcRefillAmount,
} from "../src/dao/ecofund.js";
import { assertProposalId, getJson, parseProposals, parseRevenue, parseVotes, summarizeRevenue, summarizeVotes } from "../src/dao/galaxy.js";
import { parseTransaction, type RpcParsedTransaction } from "../src/dao/parse-tx.js";
import { createDaoReaders } from "../src/dao/readers.js";
import { liveReadStamp, updatedAgo } from "../src/dao/freshness.js";
import {
  assertReadMethod,
  createFallbackRpc,
  createRpcClient,
  listSignatures,
  SIGNATURE_PAGE_LIMIT,
  type SolanaReadRpc,
} from "../src/dao/rpc.js";
import type { TreasuryCache } from "../src/dao/types.js";
import {
  ATLAS_MINT,
  DAO_TREASURY_ADDRESS,
  ECOSYSTEM_FUND_ADDRESS,
  USDC_MINT,
} from "../src/dao/wallets.js";
import { loadConfig } from "../src/config.js";
import { SafeClientError } from "../src/errors.js";
import { base58Encode } from "../src/hub/base58.js";
import { profileByKeyParams } from "../src/legacy/programs.js";

const tracked = new Map<string, "dao_treasury" | "ecosystem_fund">([
  [DAO_TREASURY_ADDRESS, "dao_treasury"],
  [ECOSYSTEM_FUND_ADDRESS, "ecosystem_fund"],
]);

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(path.join("tests/fixtures/dao", name), "utf8")) as unknown;
}

describe("recorded chain fixtures", () => {
  it("parses the October 2024 refill as an internal ATLAS transfer of 159713142", () => {
    const tx = readJson("refill-2024-10-04.json") as RpcParsedTransaction;
    const parsed = parseTransaction(tx, tx.transaction?.signatures?.[0] ?? "", tracked);
    const atlas = parsed.movements.filter((movement) => movement.mint === ATLAS_MINT);
    const treasury = atlas.find((movement) => movement.role === "dao_treasury");
    const fund = atlas.find((movement) => movement.role === "ecosystem_fund");
    expect(treasury?.internal).toBe(true);
    expect(fund?.internal).toBe(true);
    expect(treasury?.direction).toBe("out");
    expect(fund?.direction).toBe("in");
    expect(fund?.deltaRaw).toBe("15971314200000000");
    expect(fund?.postRaw).toBe("15971314300000000");
    expect(treasury?.counterparties).toEqual([ECOSYSTEM_FUND_ADDRESS]);
  });

  it("matches the PIP-23 July 2025 balance-after example", () => {
    const tx = readJson("refill-2025-07-03.json") as RpcParsedTransaction;
    const parsed = parseTransaction(tx, tx.transaction?.signatures?.[0] ?? "", tracked);
    const fund = parsed.movements.find((movement) => movement.role === "ecosystem_fund" && movement.mint === ATLAS_MINT);
    expect(fund?.preRaw).toBe("13654309100000000");
    expect(fund?.postRaw).toBe("22409433000000000");
    expect(formatRaw(BigInt(fund?.postRaw ?? "0"), 8)).toBe("224094330");
    expect(perPipLimit(BigInt(fund?.postRaw ?? "0"), 8).amount).toBe("11204716.5");
  });
});

describe("PIP-23 ecosystem fund formula", () => {
  it("keeps the published quarter dates, including June 20", () => {
    expect(nextQuarterDate("2026-10-24T03:00:00.000Z")).toBe("2026-12-31");
    expect(nextQuarterDate("2026-06-20T00:00:00.000Z")).toBe("2026-06-20");
    expect(nextQuarterDate("2026-06-21T00:00:00.000Z")).toBe("2026-09-30");
    expect(nextQuarterDate("2027-01-01T00:00:00.000Z")).toBe("2027-03-31");
  });

  it("refills ATLAS only when the fund is under 20 percent", () => {
    const due = atlasRefillAmount(400n * 10n ** 8n, 50n * 10n ** 8n, 8);
    expect(due.due).toBe(true);
    expect(due.amount).toBe("40");
    expect(due.onChainRounding).toBe("exact");
    const enough = atlasRefillAmount(400n * 10n ** 8n, 100n * 10n ** 8n, 8);
    expect(enough.due).toBe(false);
    expect(enough.amount).toBe("0");
  });

  it("sends no USDC at 500000 and 20 percent of the excess above it", () => {
    expect(usdcRefillAmount(500_000n * 10n ** 6n, 6).due).toBe(false);
    const above = usdcRefillAmount(600_000n * 10n ** 6n, 6);
    expect(above.due).toBe(true);
    expect(above.amount).toBe("20000");
  });

  it("leaves an indivisible refill rounding unknown", () => {
    const odd = atlasRefillAmount(6n, 0n, 0);
    expect(odd.due).toBe(true);
    expect(odd.amount).toBeNull();
    expect(odd.onChainRounding).toBe("unknown");
    expect(formatScaled(5n, 5n, 0).text).toBe("1");
  });

  it("does not treat a missing unpaid list as zero, and labels a Council override", () => {
    const base = {
      refills: [
        {
          signature: "sig",
          blockTime: 1,
          time: "2025-07-03T22:59:09.000Z",
          amountRaw: "8755123900000000",
          amount: "87551239",
          balanceBeforeRaw: "13654309100000000",
          balanceBefore: "136543091",
          balanceAfterRaw: "22409433000000000",
          balanceAfter: "224094330",
          decimals: 8,
          solscanUrl: "https://solscan.io/tx/sig",
          detection: "test",
        },
      ],
      balances: {
        treasuryAtlasRaw: 800n * 10n ** 8n,
        fundAtlasRaw: 100n * 10n ** 8n,
        treasuryUsdcRaw: 0n,
        fundUsdcRaw: 0n,
        atlasDecimals: 8,
        usdcDecimals: 6,
        fetchedAt: "2026-10-24T00:00:00.000Z",
      },
      asOf: "2026-10-24T00:00:00.000Z",
      movementsComplete: true,
    };
    const withheld = evaluateEcofund(base);
    expect(withheld.remainingAfterUnpaidPips.status).toBe("unknown");
    expect(withheld.figureInForce).toMatchObject({ source: "pip23", perPipLimitAtlas: "11204716.5" });

    const supplied = evaluateEcofund({
      ...base,
      unpaidPips: [{ pip: "PIP-32", amountAtlas: "40", sourceLabel: "Council sheet row, supplied by the caller" }],
      councilOverride: { label: "Council 2026-10-24", perPipLimitAtlas: "100" },
    });
    expect(supplied.remainingAfterUnpaidPips).toMatchObject({
      status: "known",
      source: "council_supplied",
      remainingAtlas: "60",
    });
    expect(supplied.councilOverride).toMatchObject({ source: "council_supplied", label: "Council 2026-10-24" });
    expect(supplied.figureInForce).toMatchObject({ source: "council_override", perPipLimitAtlas: "100" });
    expect(supplied.currentPerPipLimit).toMatchObject({ amount: "11204716.5" });
  });
});

describe("galaxy documents", () => {
  it("reads recorded proposals, votes, and revenue without the network", () => {
    const proposals = parseProposals(readJson("proposals.json"));
    expect(proposals.map((proposal) => proposal.pipNumber).sort((a, b) => a - b)).toEqual([4, 23, 36]);
    expect(proposals.find((proposal) => proposal.pipNumber === 23)?.status).toBe("Voting_Complete_Measure_Passes");

    const votes = parseVotes(readJson("votes.json"));
    const summary = summarizeVotes(votes, 1);
    expect(summary.voterCount).toBe(5);
    expect(summary.topVoters).toHaveLength(1);
    expect(summary.rankedWinner.status).toBe("unknown");
    const powers = summary.options.reduce((sum, option) => sum + Number(option.votingPower), 0);
    expect(powers).toBeGreaterThan(0);

    const revenue = summarizeRevenue(parseRevenue(readJson("revenue.json")));
    expect(revenue.bySource.map((source) => `${source.segmentation}:${source.mint}`).sort()).toEqual([
      "Game Activity:ATLAS",
      "Marketplace Fees:ATLAS",
      "Marketplace Fees:USDC",
    ]);
    expect(revenue.months[0]?.period).toBe("2023-05-01");
  });

  it("refuses a proposal id that is not a UUID and GETs the votes URL", async () => {
    expect(() => assertProposalId("../secrets")).toThrow(SafeClientError);
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      return new Response(JSON.stringify([]), { status: 200 });
    });
    await getJson(fetchImpl, "https://galaxy.staratlas.com/proposals");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("fails closed when the proposals payload is not a list", () => {
    expect(() => parseProposals({ proposals: [] })).toThrow(/not a list/);
  });
});

describe("read-only RPC client", () => {
  it("does not send a non-read method", async () => {
    const fetchImpl = vi.fn();
    const rpc = createRpcClient("https://api.mainnet-beta.solana.com", fetchImpl, { minIntervalMs: 0 });
    await expect(rpc.call("sendTransaction", [])).rejects.toThrow(/read methods/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => assertReadMethod("getBalance")).not.toThrow();
    expect(() => assertReadMethod("getMultipleAccounts")).not.toThrow();
    expect(() => assertReadMethod("getProgramAccounts")).not.toThrow();
  });

  it("sends getProgramAccounts only for a fixed program, memcmp, and dataSlice on public mainnet", async () => {
    const wallet = base58Encode(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
    const params = profileByKeyParams(wallet, 0);
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method?: string; params?: unknown[] };
      expect(body.method).toBe("getProgramAccounts");
      const config = body.params?.[1] as { filters?: unknown; dataSlice?: { offset: number; length: number } };
      expect(config.filters).toHaveLength(2);
      expect(config.dataSlice?.offset).toBe(0);
      expect(config.dataSlice?.length).toBeGreaterThan(0);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const rpc = createRpcClient("https://api.mainnet-beta.solana.com", fetchImpl, { minIntervalMs: 0 });
    await expect(rpc.call("getProgramAccounts", params)).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledOnce();

    const refused = createRpcClient("https://solana-rpc.publicnode.com", fetchImpl, { minIntervalMs: 0 });
    await expect(refused.call("getProgramAccounts", params)).rejects.toThrow(/public mainnet RPC/);
    expect(fetchImpl).toHaveBeenCalledOnce();

    await expect(
      rpc.call("getProgramAccounts", ["11111111111111111111111111111111", params[1]]),
    ).rejects.toThrow(/Player Profile, Profile Faction, and SAGE/);
    await expect(rpc.call("getProgramAccounts", [params[0], { encoding: "base64", filters: [] }])).rejects.toThrow(/dataSlice/);
    const wide = params[1] as { dataSlice: { length: number } };
    await expect(
      rpc.call("getProgramAccounts", [
        params[0],
        { ...wide, filters: (params[1] as { filters: unknown }).filters, dataSlice: { offset: 0, length: wide.dataSlice.length + 1 }, encoding: "base64", commitment: "confirmed" },
      ]),
    ).rejects.toThrow(/dataSlice/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("refuses getProgramAccounts from a browser page", async () => {
    const wallet = base58Encode(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
    const fetchImpl = vi.fn();
    const rpc = createRpcClient("https://api.mainnet-beta.solana.com", fetchImpl, { minIntervalMs: 0 });
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {};
    try {
      await expect(rpc.call("getProgramAccounts", profileByKeyParams(wallet, 1))).rejects.toThrow(/server/);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = previous;
    }
  });

  it("retries a JSON-RPC rate limit and then returns the read", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      const body =
        calls === 1
          ? { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "Too many requests for a specific RPC call" } }
          : { jsonrpc: "2.0", id: 1, result: { value: 1 } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    const rpc = createRpcClient("https://api.mainnet-beta.solana.com", fetchImpl, { minIntervalMs: 0 });
    await expect(rpc.call("getBalance", ["addr"])).resolves.toEqual({ value: 1 });
    expect(calls).toBe(2);
  });

  it("names each public host when the primary refuses and the fallback answers", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const host = new URL(String(url)).host;
      if (host === "api.mainnet-beta.solana.com") {
        return new Response("slow down", { status: 429 });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: 2 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const rpc = createFallbackRpc(
      ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"],
      fetchImpl,
      { minIntervalMs: 0, attempts: 1 },
    );
    await expect(rpc.call("getBalance", ["addr"])).resolves.toEqual({ value: 2 });
  });

  it("fails loudly and names both hosts when every public RPC refuses", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const host = new URL(String(url)).host;
      return new Response("no", { status: host === "solana-rpc.publicnode.com" ? 403 : 429 });
    });
    const rpc = createFallbackRpc(
      ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"],
      fetchImpl,
      { minIntervalMs: 0, attempts: 1 },
    );
    await expect(rpc.call("getBalance", ["addr"])).rejects.toThrow(/api\.mainnet-beta\.solana\.com: HTTP 429/);
    await expect(rpc.call("getBalance", ["addr"])).rejects.toThrow(/solana-rpc\.publicnode\.com: HTTP 403/);
  });

  it("an empty before page reaches the official host and ignores a removed filtered field", async () => {
    const pages: unknown[] = [
      [],
      {
        signatures: [],
        filtered: [{ signature: "from-filtered", slot: 1, blockTime: 1, err: null }],
      },
    ];
    for (const empty of pages) {
      const seen: { host: string; before?: string; limit?: number }[] = [];
      const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const host = new URL(String(url)).host;
        const body = JSON.parse(String(init?.body)) as { params?: [string, { before?: string; limit?: number }?] };
        const config = body.params?.[1] ?? {};
        seen.push({ host, before: config.before, limit: config.limit });
        const result =
          host === "solana-rpc.publicnode.com"
            ? empty
            : [{ signature: "from-official", slot: 2, blockTime: 2, err: null }];
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      const rpc = createFallbackRpc(
        ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"],
        fetchImpl,
        { minIntervalMs: 0, attempts: 1 },
      );
      const listed = await listSignatures(rpc, "Addr", null, { before: "cursor-sig", maxPages: 1 });
      expect(listed.signatures.map((item) => item.signature)).toEqual(["from-official"]);
      expect(listed.reachedEnd).toBe(true);
      expect(seen.map((item) => item.host)).toEqual(["solana-rpc.publicnode.com", "api.mainnet-beta.solana.com"]);
      expect(seen.every((item) => item.before === "cursor-sig" && item.limit === SIGNATURE_PAGE_LIMIT)).toBe(true);
      expect(JSON.stringify(listed)).not.toContain("from-filtered");
    }
  });

  it("sends getTransaction one call at a time and does not retry a publicnode HTTP 400", async () => {
    const bodies: unknown[] = [];
    let publicnode = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const host = new URL(String(url)).host;
      const body = JSON.parse(String(init?.body)) as { method?: string };
      bodies.push(body);
      if (host === "solana-rpc.publicnode.com") {
        publicnode += 1;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32600, message: "Maximum number of 'getTransaction' calls in a batch request is 1" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { signature: body.method } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const rpc = createFallbackRpc(
      ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"],
      fetchImpl,
      { minIntervalMs: 0 },
    );
    const results = await rpc.batch([
      { method: "getTransaction", params: ["sig-a", {}] },
      { method: "getTransaction", params: ["sig-b", {}] },
    ]);
    expect(results).toEqual([{ signature: "getTransaction" }, { signature: "getTransaction" }]);
    expect(bodies.every((body) => !Array.isArray(body))).toBe(true);
    expect(publicnode).toBe(2);
  });

  it("asks the official host once when publicnode refuses an indexed read", async () => {
    let publicnode = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const host = new URL(String(url)).host;
      if (host === "solana-rpc.publicnode.com") {
        publicnode += 1;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32602, message: "Indexed requests require a personal token." },
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: 7 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const rpc = createFallbackRpc(
      ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"],
      fetchImpl,
      { minIntervalMs: 0 },
    );
    await expect(rpc.call("getTokenAccountBalance", ["acct"])).resolves.toEqual({ value: 7 });
    expect(publicnode).toBe(1);
  });
});

describe("source freshness label", () => {
  it("says how long ago a timestamp was", () => {
    const now = Date.parse("2026-10-24T12:00:00.000Z");
    expect(updatedAgo("2026-10-24T12:00:00.000Z", now)).toBe("updated just now");
    expect(updatedAgo("2026-10-24T11:00:00.000Z", now)).toBe("updated 1 hour ago");
    expect(updatedAgo("2026-10-22T12:00:00.000Z", now)).toBe("updated 2 days ago");
    expect(updatedAgo("not-a-time", now)).toBe("");
  });

  it("stamps a live balance read as a UTC clock time", () => {
    expect(liveReadStamp("2026-10-24T14:07:00.000Z")).toBe("live, read at 14:07 UTC");
    expect(liveReadStamp("not-a-time")).toBe("");
  });
});

describe("treasury cache", () => {
  it("fails closed when the cache file is missing", async () => {
    const readers = createDaoReaders(
      loadConfig({ TREASURY_CACHE_PATH: path.join(tmpdir(), "missing-treasury-cache.json") }),
      fetch,
      () => new Date("2026-10-24T00:00:00.000Z"),
    );
    await expect(readers.daoTreasuryFlows({})).rejects.toThrow(/refresh-treasury/);
    await expect(readers.daoPayments({})).rejects.toThrow(/refresh-treasury/);
    const history = await readers.treasuryHistory({ granularity: "month" });
    const limit = await readers.ecofundLimit({});
    expect(history).toMatchObject({
      dataMode: "cached",
      populated: false,
      sources: [],
      asOf: "2026-10-24T00:00:00.000Z",
    });
    expect(history.note).toMatch(/not yet populated/);
    expect(limit.populated).toBe(false);
    expect(JSON.stringify(history)).not.toMatch(/amountRaw|externalIn/);
    expect(JSON.stringify(limit)).not.toMatch(/amountRaw|perPip/);
  });

  it("still fails closed when the treasury cache is not valid JSON", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "treasury-bad-")), "cache.json");
    writeFileSync(file, "{");
    const readers = createDaoReaders(loadConfig({ TREASURY_CACHE_PATH: file }));
    await expect(readers.treasuryHistory({})).rejects.toThrow(/not valid JSON/);
    await expect(readers.ecofundLimit({})).rejects.toThrow(/not valid JSON/);
  });

  it("pages proposals with a default limit of 20 and a cursor", async () => {
    const proposals = Array.from({ length: 25 }, (_, index) => ({
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, "0")}`,
      pipNumber: index + 1,
      title: `PIP-${index + 1}`,
      brief: "",
      categories: [],
      status: "Voting",
      authorPublicKey: "author",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      votingStartsAt: "2026-01-01T00:00:00.000Z",
      votingEndsAt: "2026-01-02T00:00:00.000Z",
      voteOptionsMaxChoices: 1,
      voteWinners: 1,
      voteData: null,
    }));
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/proposals")) {
        return new Response(JSON.stringify(proposals), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("no", { status: 404 });
    };
    const readers = createDaoReaders(loadConfig({}), fetchImpl, () => new Date("2026-10-24T00:00:00.000Z"));
    const first = await readers.listProposals({});
    expect(first.matched).toBe(25);
    expect(first.returned).toBe(20);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toBe(proposals[19]?.id);
    const second = await readers.listProposals({ cursor: String(first.nextCursor) });
    expect(second.returned).toBe(5);
    expect(second.truncated).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect((second.proposals as { pipNumber: number }[]).map((item) => item.pipNumber)).toEqual([21, 22, 23, 24, 25]);
    await expect(readers.listProposals({ cursor: "not-a-uuid" })).rejects.toThrow(/cursor must be a proposal id/);
    await expect(readers.listProposals({ cursor: "aaaaaaaa-aaaa-4aaa-8aaa-000000000099" })).rejects.toThrow(/not in this proposal list/);
    await expect(readers.listProposals({ limit: 101 })).rejects.toThrow(/limit must be from 1 to 100/);
  });

  it("backfills a fixture chain twice without duplicating movements", async () => {
    const cachePath = path.join(mkdtempSync(path.join(tmpdir(), "treasury-")), "cache.json");
    const rpc = fixtureRpc();
    const first = await refreshTreasury({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      cachePath,
      rpc,
      maxAtlasPages: 5,
      log: () => undefined,
    });
    const second = await refreshTreasury({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      cachePath,
      rpc,
      maxAtlasPages: 5,
      log: () => undefined,
    });
    expect(second.movements.length).toBe(first.movements.length);
    expect(second.atlasScan?.reachedEnd).toBe(true);
    expect(second.atlasScan?.assumption).toBe("holds");
    expect(second.completeness).toBe("complete");
    expect(second.partialReason).toBeNull();
    const loaded = loadCache(cachePath);
    const flows = buildFlows(loaded, {});
    const treasury = flows.rows.find((row) => row.role === "dao_treasury" && row.symbol === "ATLAS");
    expect(treasury).toMatchObject({
      month: "2024-10",
      externalIn: "150",
      externalOut: "100",
      internalOut: "100",
      method: "residual",
      complete: true,
    });
    const payments = buildPayments(loaded, {});
    expect(payments.payments.map((payment) => payment.amount)).toEqual(["100"]);
    expect(payments.payments[0]?.solscanUrl).toContain("https://solscan.io/tx/");
    expect(payments.payments[0]?.role).toBe("dao_treasury");
  });

  it("commits a partial cache when a later read fails", async () => {
    const cachePath = path.join(mkdtempSync(path.join(tmpdir(), "treasury-partial-")), "cache.json");
    const inner = fixtureRpc();
    const rpc: SolanaReadRpc = {
      async call(method, params) {
        if (method === "getTransaction") {
          throw new SafeClientError("Solana RPC read failed after retries (api.mainnet-beta.solana.com: HTTP 429).");
        }
        return inner.call(method, params);
      },
      async batch(requests) {
        return Promise.all(requests.map((request) => this.call(request.method, request.params)));
      },
    };
    await expect(
      refreshTreasury({
        rpcUrl: "https://api.mainnet-beta.solana.com",
        cachePath,
        rpc,
        maxAtlasPages: 1,
        log: () => undefined,
      }),
    ).rejects.toThrow(/HTTP 429/);
    const saved = JSON.parse(readFileSync(cachePath, "utf8")) as TreasuryCache;
    expect(saved.completeness).toBe("partial");
    expect(saved.partialReason).toMatch(/HTTP 429/);
    expect(saved.balances).toEqual([]);
    const cursor = saved.cursors.find((item) => item.address === DAO_TREASURY_ADDRESS && item.kind === "wallet");
    expect(cursor?.reachedEnd).toBe(false);
    expect(cursor?.oldestSignature ?? null).toBeNull();
  });

  it("parses incremental history and advances the backward cursor across runs", async () => {
    const cachePath = path.join(mkdtempSync(path.join(tmpdir(), "treasury-incremental-")), "cache.json");
    const inner = fixtureRpc();
    const head = (await inner.call("getSignaturesForAddress", [DAO_TREASURY_ADDRESS, { limit: 1000 }])) as {
      signature: string;
      slot: number;
      blockTime: number;
      err: null;
    }[];
    const older = Array.from({ length: 1000 }, (_, index) => ({
      signature: `old-${index}`,
      slot: 100 + index,
      blockTime: head[0]!.blockTime - index - 1,
      err: null as null,
    }));
    const book = [...head, ...older];
    let transactions = 0;
    const rpc: SolanaReadRpc = {
      async call(method, params) {
        if (method === "getTransaction") transactions += 1;
        if (method === "getSignaturesForAddress" && String(params[0]) === DAO_TREASURY_ADDRESS) {
          const config = (params[1] ?? {}) as { before?: string; until?: string; limit?: number };
          let list = book;
          if (config.until) {
            const index = list.findIndex((item) => item.signature === config.until);
            if (index >= 0) list = list.slice(0, index);
          }
          if (config.before) {
            const index = list.findIndex((item) => item.signature === config.before);
            list = index >= 0 ? list.slice(index + 1) : [];
          }
          return list.slice(0, config.limit ?? 1000) as never;
        }
        return inner.call(method, params);
      },
      async batch(requests) {
        return Promise.all(requests.map((request) => this.call(request.method, request.params)));
      },
    };
    const first = await refreshTreasury({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      cachePath,
      rpc,
      incremental: true,
      maxAtlasPages: 2,
      maxSignaturePages: 1,
      log: () => undefined,
    });
    const firstCursor = first.cursors.find((cursor) => cursor.address === DAO_TREASURY_ADDRESS && cursor.kind === "wallet");
    expect(transactions).toBeGreaterThan(0);
    expect(first.movements.length).toBeGreaterThan(0);
    expect(first.completeness).toBe("partial");
    expect(first.partialReason).toMatch(/oldest parsed signature/);
    expect(firstCursor?.newestSignature).toBe("refill");
    expect(firstCursor?.oldestSignature).toBe(book[SIGNATURE_PAGE_LIMIT - 1]?.signature);
    expect(firstCursor?.reachedEnd).toBe(false);

    const seen: { before?: string }[] = [];
    const secondRpc: SolanaReadRpc = {
      async call(method, params) {
        if (method === "getSignaturesForAddress" && String(params[0]) === DAO_TREASURY_ADDRESS) {
          const config = (params[1] ?? {}) as { before?: string };
          seen.push({ before: config.before });
        }
        return rpc.call(method, params);
      },
      async batch(requests) {
        return Promise.all(requests.map((request) => this.call(request.method, request.params)));
      },
    };
    const pagesLeft = Math.ceil((book.length - SIGNATURE_PAGE_LIMIT) / SIGNATURE_PAGE_LIMIT);
    const second = await refreshTreasury({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      cachePath,
      rpc: secondRpc,
      incremental: true,
      maxAtlasPages: 2,
      maxSignaturePages: pagesLeft,
      log: () => undefined,
    });
    const secondCursor = second.cursors.find((cursor) => cursor.address === DAO_TREASURY_ADDRESS && cursor.kind === "wallet");
    expect(seen.some((item) => item.before === firstCursor?.oldestSignature)).toBe(true);
    expect(secondCursor?.oldestSignature).toBe(book[book.length - 1]?.signature);
    expect(secondCursor?.oldestSignature).not.toBe(firstCursor?.oldestSignature);
    expect(secondCursor?.newestSignature).toBe("refill");
    expect(secondCursor?.reachedEnd).toBe(true);
    expect(second.movements.length).toBe(first.movements.length);
  });

  it("does not page older than the cursor on an incremental run", async () => {
    const cachePath = path.join(mkdtempSync(path.join(tmpdir(), "treasury-incremental-next-")), "cache.json");
    const first = fixtureRpc();
    await refreshTreasury({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      cachePath,
      rpc: first,
      maxAtlasPages: 5,
      log: () => undefined,
    });
    const seen: { until?: string; before?: string }[] = [];
    const inner = fixtureRpc();
    const rpc: SolanaReadRpc = {
      async call(method, params) {
        if (method === "getSignaturesForAddress") {
          const config = (params[1] ?? {}) as { until?: string; before?: string };
          seen.push({ until: config.until, before: config.before });
        }
        return inner.call(method, params);
      },
      async batch(requests) {
        return Promise.all(requests.map((request) => this.call(request.method, request.params)));
      },
    };
    const second = await refreshTreasury({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      cachePath,
      rpc,
      incremental: true,
      maxAtlasPages: 5,
      maxSignaturePages: 2,
      log: () => undefined,
    });
    expect(second.movements.length).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((item) => !item.before)).toBe(true);
    expect(seen.some((item) => item.until)).toBe(true);
  });

  it("applies new signatures that overflow the page cap across runs", async () => {
    const cachePath = path.join(mkdtempSync(path.join(tmpdir(), "treasury-overflow-")), "cache.json");
    const inner = fixtureRpc();
    const seeded = await refreshTreasury({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      cachePath,
      rpc: inner,
      maxAtlasPages: 5,
      log: () => undefined,
    });
    expect(seeded.completeness).toBe("complete");
    const seededWallet = seeded.cursors.find((cursor) => cursor.address === DAO_TREASURY_ADDRESS && cursor.kind === "wallet");
    expect(seededWallet?.newestSignature).toBe("refill");
    expect(seededWallet?.oldestSignature).toBe("payment");
    expect(seeded.atlasScan?.newestSignature).toBe("drip2");
    const seedSignatures = new Set(seeded.movements.map((movement) => movement.signature));

    const saved = loadCache(cachePath);
    const savedWallet = saved.cursors.find((cursor) => cursor.address === DAO_TREASURY_ADDRESS && cursor.kind === "wallet");
    if (!savedWallet) throw new Error("seeded treasury cursor missing");
    savedWallet.reachedEnd = false;
    saveCache(cachePath, saved);

    const head = (await inner.call("getSignaturesForAddress", [DAO_TREASURY_ADDRESS, { limit: 1000 }])) as {
      signature: string;
      slot: number;
      blockTime: number;
      err: null;
    }[];
    const atlasHead = (await inner.call("getSignaturesForAddress", ["treasuryAtlas", { limit: 1000 }])) as {
      signature: string;
      slot: number;
      blockTime: number;
      err: null;
    }[];
    const newCount = 250;
    const olderCount = 150;
    const refillTime = head[0]?.blockTime ?? 0;
    const atlasTime = atlasHead[0]?.blockTime ?? 0;
    const newSigs = Array.from({ length: newCount }, (_, index) => ({
      signature: `new-${index}`,
      slot: 5_000 - index,
      blockTime: refillTime + (newCount - index),
      err: null as null,
    }));
    const older = Array.from({ length: olderCount }, (_, index) => ({
      signature: `old-${index}`,
      slot: index,
      blockTime: refillTime - index - 1,
      err: null as null,
    }));
    const atlasSigs = Array.from({ length: newCount }, (_, index) => ({
      signature: `atlas-${index}`,
      slot: 8_000 - index,
      blockTime: atlasTime + (newCount - index),
      err: null as null,
    }));
    const walletBook = [...newSigs, ...head, ...older];
    const atlasBook = [...atlasSigs, ...atlasHead];
    const walletRank = new Map(walletBook.map((item, index) => [item.signature, index]));
    const atlasRank = new Map(atlasBook.map((item, index) => [item.signature, index]));

    const pageBook = (
      book: { signature: string; slot: number; blockTime: number; err: null }[],
      config: { before?: string; until?: string; limit?: number },
    ) => {
      let list = book;
      if (config.until) {
        const index = list.findIndex((item) => item.signature === config.until);
        if (index >= 0) list = list.slice(0, index);
      }
      if (config.before) {
        const index = list.findIndex((item) => item.signature === config.before);
        list = index >= 0 ? list.slice(index + 1) : [];
      }
      return list.slice(0, config.limit ?? 1000);
    };

    const rpc: SolanaReadRpc = {
      async call(method, params) {
        assertReadMethod(method);
        if (method === "getSignaturesForAddress" && String(params[0]) === DAO_TREASURY_ADDRESS) {
          return pageBook(walletBook, (params[1] ?? {}) as { before?: string; until?: string; limit?: number }) as never;
        }
        if (method === "getSignaturesForAddress" && String(params[0]) === "treasuryAtlas") {
          return pageBook(atlasBook, (params[1] ?? {}) as { before?: string; until?: string; limit?: number }) as never;
        }
        if (method === "getTransaction" && String(params[0]).startsWith("new-")) {
          const signature = String(params[0]);
          const row = newSigs.find((item) => item.signature === signature);
          return transfer({
            signature,
            time: row?.blockTime ?? refillTime + 1,
            slot: row?.slot ?? 1,
            rows: {
              pre: [token(DAO_TREASURY_ADDRESS, ATLAS_MINT, 1000n * RAW, 8), token(EXT, ATLAS_MINT, 10n * RAW, 8)],
              post: [token(DAO_TREASURY_ADDRESS, ATLAS_MINT, 1001n * RAW, 8), token(EXT, ATLAS_MINT, 9n * RAW, 8)],
            },
          }) as never;
        }
        return inner.call(method, params);
      },
      async batch(requests) {
        return Promise.all(requests.map((request) => this.call(request.method, request.params)));
      },
    };

    const keysOf = (cache: TreasuryCache) => cache.movements.map((movement) => `${movement.signature}:${movement.wallet}:${movement.mint}`);
    const assertOldestSuffix = (cache: TreasuryCache) => {
      const ids = [
        ...new Set(cache.movements.filter((movement) => movement.signature.startsWith("new-")).map((movement) => movement.signature)),
      ].map((signature) => Number(signature.slice(4)));
      ids.sort((left, right) => left - right);
      expect(new Set(keysOf(cache)).size).toBe(keysOf(cache).length);
      if (ids.length === 0) return;
      expect(ids[ids.length - 1]).toBe(newCount - 1);
      expect(ids[0]).toBe(newCount - ids.length);
      for (let index = 1; index < ids.length; index += 1) expect(ids[index]).toBe(ids[index - 1]! + 1);
    };

    let newestRank = walletRank.get("refill") ?? 0;
    let oldestRank = walletRank.get("payment") ?? 0;
    let atlasNewestRank = atlasRank.get("drip2") ?? 0;
    let previous = "";
    let finished: TreasuryCache | null = null;
    for (let run = 0; run < 12; run += 1) {
      const cache = await refreshTreasury({
        rpcUrl: "https://api.mainnet-beta.solana.com",
        cachePath,
        rpc,
        incremental: true,
        maxAtlasPages: 1,
        maxSignaturePages: 1,
        log: () => undefined,
      });
      const wallet = cache.cursors.find((cursor) => cursor.address === DAO_TREASURY_ADDRESS && cursor.kind === "wallet");
      const newest = walletRank.get(wallet?.newestSignature ?? "");
      const oldest = walletRank.get(wallet?.oldestSignature ?? "");
      const atlasNewest = atlasRank.get(cache.atlasScan?.newestSignature ?? "");
      expect(newest).toEqual(expect.any(Number));
      expect(oldest).toEqual(expect.any(Number));
      expect(atlasNewest).toEqual(expect.any(Number));
      expect(newest!).toBeLessThanOrEqual(newestRank);
      expect(oldest!).toBeGreaterThanOrEqual(oldestRank);
      expect(atlasNewest!).toBeLessThanOrEqual(atlasNewestRank);
      newestRank = newest!;
      oldestRank = oldest!;
      atlasNewestRank = atlasNewest!;
      assertOldestSuffix(cache);
      for (const signature of seedSignatures) {
        expect(cache.movements.some((movement) => movement.signature === signature)).toBe(true);
      }
      const progress = [
        wallet?.newestSignature,
        wallet?.oldestSignature,
        wallet?.pendingNewer?.length ?? 0,
        cache.atlasScan?.newestSignature,
        cache.atlasScan?.pendingNewer?.length ?? 0,
        wallet?.reachedEnd,
        cache.atlasScan?.reachedEnd,
      ].join("|");
      if (cache.completeness !== "complete") {
        expect(progress).not.toBe(previous);
        expect(cache.partialReason ?? "").not.toMatch(/left in place|not applied/);
        expect(cache.partialReason ?? "").toMatch(/page cap/);
      }
      previous = progress;
      if (cache.completeness === "complete") {
        finished = cache;
        break;
      }
    }

    expect(finished?.completeness).toBe("complete");
    expect(finished?.partialReason).toBeNull();
    const finishedWallet = finished?.cursors.find((cursor) => cursor.address === DAO_TREASURY_ADDRESS && cursor.kind === "wallet");
    expect(finishedWallet?.newestSignature).toBe("new-0");
    expect(finishedWallet?.oldestSignature).toBe(`old-${olderCount - 1}`);
    expect(finishedWallet?.reachedEnd).toBe(true);
    expect(finishedWallet?.pendingNewer).toBeUndefined();
    expect(finished?.atlasScan?.newestSignature).toBe("atlas-0");
    expect(finished?.atlasScan?.pendingNewer).toBeUndefined();
    const newMovements = finished?.movements.filter((movement) => movement.signature.startsWith("new-")) ?? [];
    expect(new Set(newMovements.map((movement) => movement.signature)).size).toBe(newCount);
    expect(newMovements).toHaveLength(newCount);
    expect(finished?.movements.length).toBe(seeded.movements.length + newCount);

    const again = await refreshTreasury({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      cachePath,
      rpc,
      incremental: true,
      maxAtlasPages: 1,
      maxSignaturePages: 1,
      log: () => undefined,
    });
    expect(again.completeness).toBe("complete");
    expect(again.partialReason).toBeNull();
    expect(again.movements.length).toBe(finished?.movements.length);
    expect(new Set(keysOf(again)).size).toBe(keysOf(again).length);
    const againWallet = again.cursors.find((cursor) => cursor.address === DAO_TREASURY_ADDRESS && cursor.kind === "wallet");
    expect(againWallet?.newestSignature).toBe("new-0");
    expect(againWallet?.oldestSignature).toBe(`old-${olderCount - 1}`);
  }, 30_000);

  it("withholds treasury ATLAS inflows when the outflow sample fails", () => {
    const cache = {
      schemaVersion: 1,
      generatedAt: "2026-10-24T00:00:00.000Z",
      rpc: "https://api.mainnet-beta.solana.com/",
      discovery: { at: "2026-10-24T00:00:00.000Z" },
      cursors: [
        {
          address: DAO_TREASURY_ADDRESS,
          role: "dao_treasury",
          kind: "wallet",
          mint: null,
          newestSignature: "sig",
          reachedEnd: true,
          gaps: [],
          reconciled: true,
          signatures: ["sig"],
        },
      ],
      tokenAccounts: [],
      movements: [],
      balances: [],
      atlasScan: {
        tokenAccount: "ata",
        wallet: DAO_TREASURY_ADDRESS,
        newestSignature: "sig",
        oldestSignature: "sig",
        openDay: null,
        reachedEnd: true,
        pagesScanned: 1,
        days: {},
        snapshots: {},
        opening: null,
        samples: [],
        sampleSeen: {},
        undatedCount: 0,
        undatedSignatures: [],
        assumption: "failed",
        assumptionViolations: [{ signature: "bad", deltaRaw: "-1" }],
      },
    } as TreasuryCache;
    const flows = buildFlows(cache, { mint: "ATLAS", wallet: "dao_treasury" });
    expect(flows.rows).toEqual([]);
    expect(flows.omitted[0]?.reason).toMatch(/sample|outflow/i);
  });
});

const RAW = 10n ** 8n;
const EXT = "ExternalCounterparty11111111111111111111111111";

function token(owner: string, mint: string, amount: bigint, decimals: number) {
  return {
    mint,
    owner,
    uiTokenAmount: { amount: amount.toString(), decimals },
  };
}

function transfer(options: {
  signature: string;
  time: number;
  slot: number;
  rows: { pre: ReturnType<typeof token>[]; post: ReturnType<typeof token>[] };
}): RpcParsedTransaction {
  return {
    blockTime: options.time,
    slot: options.slot,
    meta: {
      err: null,
      fee: 0,
      preBalances: [],
      postBalances: [],
      preTokenBalances: options.rows.pre,
      postTokenBalances: options.rows.post,
    },
    transaction: { signatures: [options.signature], message: { accountKeys: [] } },
  };
}

function fixtureRpc(): SolanaReadRpc {
  const day1 = Math.floor(Date.parse("2024-10-04T10:00:00.000Z") / 1000);
  const payTime = Math.floor(Date.parse("2024-10-04T15:00:00.000Z") / 1000);
  const refillTime = Math.floor(Date.parse("2024-10-04T18:00:00.000Z") / 1000);
  const day2 = Math.floor(Date.parse("2024-10-05T12:00:00.000Z") / 1000);
  const txs: Record<string, RpcParsedTransaction> = {
    drip1: transfer({
      signature: "drip1",
      time: day1,
      slot: 1,
      rows: {
        pre: [token(DAO_TREASURY_ADDRESS, ATLAS_MINT, 1000n * RAW, 8), token(EXT, ATLAS_MINT, 500n * RAW, 8)],
        post: [token(DAO_TREASURY_ADDRESS, ATLAS_MINT, 1100n * RAW, 8), token(EXT, ATLAS_MINT, 400n * RAW, 8)],
      },
    }),
    payment: transfer({
      signature: "payment",
      time: payTime,
      slot: 2,
      rows: {
        pre: [token(DAO_TREASURY_ADDRESS, ATLAS_MINT, 1100n * RAW, 8), token(EXT, ATLAS_MINT, 0n, 8)],
        post: [token(DAO_TREASURY_ADDRESS, ATLAS_MINT, 1000n * RAW, 8), token(EXT, ATLAS_MINT, 100n * RAW, 8)],
      },
    }),
    refill: transfer({
      signature: "refill",
      time: refillTime,
      slot: 3,
      rows: {
        pre: [token(DAO_TREASURY_ADDRESS, ATLAS_MINT, 1000n * RAW, 8), token(ECOSYSTEM_FUND_ADDRESS, ATLAS_MINT, 0n, 8)],
        post: [token(DAO_TREASURY_ADDRESS, ATLAS_MINT, 900n * RAW, 8), token(ECOSYSTEM_FUND_ADDRESS, ATLAS_MINT, 100n * RAW, 8)],
      },
    }),
    drip2: transfer({
      signature: "drip2",
      time: day2,
      slot: 4,
      rows: {
        pre: [token(DAO_TREASURY_ADDRESS, ATLAS_MINT, 900n * RAW, 8), token(EXT, ATLAS_MINT, 50n * RAW, 8)],
        post: [token(DAO_TREASURY_ADDRESS, ATLAS_MINT, 950n * RAW, 8), token(EXT, ATLAS_MINT, 0n, 8)],
      },
    }),
    usdc: transfer({
      signature: "usdc",
      time: day1,
      slot: 5,
      rows: {
        pre: [token(DAO_TREASURY_ADDRESS, USDC_MINT, 0n, 6), token(EXT, USDC_MINT, 10n * 10n ** 6n, 6)],
        post: [token(DAO_TREASURY_ADDRESS, USDC_MINT, 10n * 10n ** 6n, 6), token(EXT, USDC_MINT, 0n, 6)],
      },
    }),
  };
  const sig = (signature: string, time: number, slot: number) => ({ signature, slot, blockTime: time, err: null });
  const books: Record<string, { signature: string; slot: number; blockTime: number; err: null }[]> = {
    [DAO_TREASURY_ADDRESS]: [sig("refill", refillTime, 3), sig("payment", payTime, 2)],
    [ECOSYSTEM_FUND_ADDRESS]: [],
    treasuryAtlas: [sig("drip2", day2, 4), sig("refill", refillTime, 3), sig("payment", payTime, 2), sig("drip1", day1, 1)],
    fundAtlas: [sig("refill", refillTime, 3)],
    treasuryUsdc: [sig("usdc", day1, 5)],
  };
  const accounts: Record<string, { address: string; mint: string; amount: string; decimals: number }> = {
    [`${DAO_TREASURY_ADDRESS}:${ATLAS_MINT}`]: { address: "treasuryAtlas", mint: ATLAS_MINT, amount: (950n * RAW).toString(), decimals: 8 },
    [`${DAO_TREASURY_ADDRESS}:${USDC_MINT}`]: { address: "treasuryUsdc", mint: USDC_MINT, amount: (10n * 10n ** 6n).toString(), decimals: 6 },
    [`${ECOSYSTEM_FUND_ADDRESS}:${ATLAS_MINT}`]: { address: "fundAtlas", mint: ATLAS_MINT, amount: (100n * RAW).toString(), decimals: 8 },
  };

  const call = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    assertReadMethod(method);
    if (method === "getSignaturesForAddress") {
      const address = String(params[0]);
      const config = (params[1] ?? {}) as { before?: string; until?: string; limit?: number };
      let list = books[address] ?? [];
      if (config.until) {
        const index = list.findIndex((item) => item.signature === config.until);
        if (index >= 0) list = list.slice(0, index);
      }
      if (config.before) {
        const index = list.findIndex((item) => item.signature === config.before);
        list = index >= 0 ? list.slice(index + 1) : [];
      }
      return list.slice(0, config.limit ?? 1000);
    }
    if (method === "getTransaction") return txs[String(params[0])] ?? null;
    if (method === "getTokenAccountsByOwner") {
      const filter = params[1] as { mint?: string; programId?: string };
      const key = `${String(params[0])}:${filter.mint ?? ""}`;
      const account = filter.mint ? accounts[key] : undefined;
      if (!account) return { value: [] };
      return {
        value: [
          {
            pubkey: account.address,
            account: { data: { parsed: { info: { mint: account.mint, tokenAmount: { amount: account.amount, decimals: account.decimals } } } } },
          },
        ],
      };
    }
    if (method === "getTokenAccountBalance") {
      const account = Object.values(accounts).find((item) => item.address === params[0]);
      if (!account) throw new Error("missing account");
      return { value: { amount: account.amount, decimals: account.decimals } };
    }
    if (method === "getBalance") return { value: 0 };
    throw new Error(`unexpected ${method}`);
  };

  return {
    call: call as SolanaReadRpc["call"],
    async batch(requests) {
      return Promise.all(requests.map((request) => call(request.method, request.params)));
    },
  };
}
