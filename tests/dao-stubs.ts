import type { DaoReaders } from "../src/dao/readers.js";
import { legacyCardShell } from "../src/legacy/card.js";

const sources = [{ url: "https://galaxy.staratlas.com/proposals", note: "stub" }];

/** Injected DAO readers for tests that only need the tool list or the HTTP shell. */
export function stubDaoReaders(): DaoReaders {
  return {
    async listProposals() {
      return { dataMode: "live", asOf: "2026-10-24T00:00:00.000Z", sources, matched: 0, proposals: [] };
    },
    async getProposalVotes() {
      return {
        dataMode: "live",
        asOf: "2026-10-24T00:00:00.000Z",
        sources,
        proposalId: "0ecf2928-15df-497e-8b67-d87eda030d5a",
        voterCount: 0,
        options: [],
      };
    },
    async daoRevenue() {
      return { dataMode: "live", asOf: "2026-10-24T00:00:00.000Z", sources, rowCount: 0, months: [], bySource: [] };
    },
    async daoTreasuryFlows() {
      return { dataMode: "cached", asOf: "2026-10-24T00:00:00.000Z", sources, rows: [], omitted: [], notes: [] };
    },
    async daoPayments() {
      return { dataMode: "cached", asOf: "2026-10-24T00:00:00.000Z", sources, payments: [], omitted: [], notes: [] };
    },
    async treasuryHistory() {
      return { dataMode: "cached", asOf: "2026-10-24T00:00:00.000Z", sources, series: [], omitted: [], notes: [] };
    },
    async ecofundLimit() {
      return { dataMode: "cached", asOf: "2026-10-24T00:00:00.000Z", sources, refills: [] };
    },
    async treasuryBalances() {
      return {
        dataMode: "live",
        asOf: "2026-10-24T00:00:00.000Z",
        sources,
        wallets: [{ name: "DAO Treasury", address: "CuwnarNh7FEqZMmffFjRyWj54RecyS7zwFg1CxfzNudi", sol: { amount: "0" }, tokens: [] }],
        multisigs: [],
        standardAccountOnly: true,
      };
    },
    async pipTracker() {
      return { dataMode: "live", asOf: "2026-10-24T00:00:00.000Z", sources, rowCount: 0, missingColumns: [], rows: [] };
    },
    async hubUpdates() {
      return {
        dataMode: "live",
        asOf: "2026-10-24T00:00:00.000Z",
        sources: [],
        updates: [],
        note: "HUB_GIT_REPO, HUB_GIT_COMMIT, and HUB_STORE_MANIFEST_HASH are not set. No hub updates were read, and none were invented.",
      };
    },
    async listListings() {
      return {
        dataMode: "live",
        asOf: "2026-10-24T00:00:00.000Z",
        sources: [],
        listings: [],
        includeExpired: false,
        note: "HUB_GIT_REPO, HUB_GIT_COMMIT, and HUB_STORE_MANIFEST_HASH are not set. No hub updates were read, and none were invented.",
      };
    },
    async searchDirectory() {
      return {
        dataMode: "live",
        asOf: "2026-10-24T00:00:00.000Z",
        sources: [],
        pinned: false,
        results: [],
        truncated: false,
        note: "HUB_GIT_REPO, HUB_GIT_COMMIT, and HUB_STORE_MANIFEST_HASH are not set. No hub updates were read, and none were invented.",
      };
    },
    async storyContext() {
      return { hubId: null, updates: [], listings: [], sourceUrl: null };
    },
    async claimStatus() {
      return {
        dataMode: "live",
        asOf: "2026-10-24T00:00:00.000Z",
        sources: [],
        claims: [],
        hubId: "",
        note: "HUB_GIT_REPO, HUB_GIT_COMMIT, and HUB_STORE_MANIFEST_HASH are not set. No hub updates were read, and none were invented.",
      };
    },
    async dataHealth() {
      return {
        dataMode: "live",
        asOf: "2026-10-24T00:00:00.000Z",
        sources,
        checks: [{ source: "treasury_cache", ok: false, asOf: null, error: "No treasury cache file. Balances were not invented." }],
      };
    },
  };
}

/** A short card for tests that do not read mainnet. */
export function stubPlayerLegacy(): {
  playerLegacy(query: { address: string }): Promise<ReturnType<typeof legacyCardShell>>;
} {
  return {
    async playerLegacy({ address }) {
      return legacyCardShell(address, "2026-10-24T00:00:00.000Z");
    },
  };
}
