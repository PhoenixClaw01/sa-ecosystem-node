import { buildFlows, buildHistory, buildPayments, requireRows, type PaymentQuery, type ReportQuery } from "./aggregate.js";
import { readPublishedMultisigs, readWalletBalancesWithFallback } from "./balances.js";
import { probeDataHealth } from "./health.js";
import { claimStatus, listListings, readHubUpdates, readStoryContext, searchHub, type ListListingsQuery, type StoryHubContext } from "./hub.js";
import { createProfileKeyChecker } from "../hub/claim-profile.js";
import { loadSignerDirectory } from "../hub/allowlist.js";
import { COUNCIL_SHEET_CSV, COUNCIL_SHEET_URL, parsePipTracker } from "./pip-tracker.js";
import { createFallbackRpc, solanaRpcUrls } from "./rpc.js";
import { loadCache } from "./cache.js";
import { evaluateEcofund, findRefills, type CouncilOverride, type UnpaidPip } from "./ecofund.js";
import {
  assertProposalId,
  getJson,
  parseProposals,
  parseRevenue,
  parseVotes,
  proposalsUrl,
  revenueUrl,
  summarizeRevenue,
  summarizeVotes,
  votesUrl,
} from "./galaxy.js";
import type { ToolEnvelope } from "./types.js";
import {
  ATLAS_MINT,
  DAO_TREASURY_ADDRESS,
  ECOSYSTEM_FUND_ADDRESS,
  NATIVE_MINT,
  PIP23_URL,
  PIP4_URL,
  USDC_MINT,
  USDC_SOURCE_URL,
  WALLET_SOURCE_URL,
} from "./wallets.js";
import type { Config } from "../config.js";
import { redactRpcUrl } from "../config.js";
import { publicErrorMessage, SafeClientError, UserInputError } from "../errors.js";

export const DEFAULT_PROPOSAL_LIMIT = 20;
export const MAX_PROPOSAL_LIMIT = 100;

const CACHE_NOT_POPULATED = "The treasury cache is not yet populated. No figures were invented.";

export interface ProposalQuery {
  pipNumber?: number;
  status?: string;
  limit?: number;
  cursor?: string;
}

export interface VotesQuery {
  proposalId?: string;
  pipNumber?: number;
  topN?: number;
}

export interface RevenueQuery {
  from?: string;
  to?: string;
  segmentation?: string;
}

export interface EcofundQuery {
  unpaidPips?: UnpaidPip[];
  councilOverride?: CouncilOverride;
  asOf?: string;
}

export interface DaoReaders {
  listProposals(query: ProposalQuery): Promise<ToolEnvelope & Record<string, unknown>>;
  getProposalVotes(query: VotesQuery): Promise<ToolEnvelope & Record<string, unknown>>;
  daoRevenue(query: RevenueQuery): Promise<ToolEnvelope & Record<string, unknown>>;
  daoTreasuryFlows(query: ReportQuery): Promise<ToolEnvelope & Record<string, unknown>>;
  daoPayments(query: PaymentQuery): Promise<ToolEnvelope & Record<string, unknown>>;
  treasuryHistory(query: ReportQuery & { granularity?: "day" | "month" }): Promise<ToolEnvelope & Record<string, unknown>>;
  ecofundLimit(query: EcofundQuery): Promise<ToolEnvelope & Record<string, unknown>>;
  treasuryBalances(): Promise<ToolEnvelope & Record<string, unknown>>;
  pipTracker(): Promise<ToolEnvelope & Record<string, unknown>>;
  hubUpdates(query: { kind?: string }): Promise<ToolEnvelope & Record<string, unknown>>;
  listListings(query: ListListingsQuery): Promise<ToolEnvelope & Record<string, unknown>>;
  searchDirectory(
    query: { query: string },
    names: (wallet: string) => Promise<string | null>,
  ): Promise<ToolEnvelope & Record<string, unknown>>;
  storyContext(): Promise<StoryHubContext>;
  claimStatus(query: { identity?: string }): Promise<ToolEnvelope & Record<string, unknown>>;
  dataHealth(): Promise<ToolEnvelope & Record<string, unknown>>;
}

function searchBody(result: {
  pinned: boolean;
  results: unknown;
  note: string;
  truncated: boolean;
}) {
  return {
    pinned: result.pinned,
    results: result.results,
    note: result.note,
    truncated: result.truncated,
  };
}

function listingBody(result: {
  schema: string;
  listings: unknown;
  rejected: unknown;
  includeExpired: boolean;
  note: string;
}) {
  return {
    schema: result.schema,
    listings: result.listings,
    rejected: result.rejected,
    includeExpired: result.includeExpired,
    note: result.note,
  };
}

function live(
  sources: ToolEnvelope["sources"],
  body: Record<string, unknown>,
  now: Date = new Date(),
): ToolEnvelope & Record<string, unknown> {
  return { dataMode: "live", asOf: now.toISOString(), sources, ...body };
}

function cached(config: Config, body: Record<string, unknown>): ToolEnvelope & Record<string, unknown> {
  const cache = loadCache(config.treasuryCachePath);
  return {
    dataMode: "cached",
    asOf: cache.generatedAt,
    sources: cacheSources(cache.rpc),
    ...body,
    cache: {
      generatedAt: cache.generatedAt,
      rpc: cache.rpc,
      atlasScanReachedEnd: cache.atlasScan?.reachedEnd ?? false,
      atlasOutflowSample: cache.atlasScan?.assumption ?? "unchecked",
    },
  };
}

function proposalCursor(cursor: string): string {
  try {
    return assertProposalId(cursor);
  } catch {
    throw new UserInputError("cursor must be a proposal id from the previous page.");
  }
}

function unpopulatedCache(now: Date): ToolEnvelope & Record<string, unknown> {
  return {
    dataMode: "cached",
    asOf: now.toISOString(),
    sources: [],
    populated: false,
    note: CACHE_NOT_POPULATED,
  };
}

function isUnpopulated(value: object): value is ToolEnvelope & Record<string, unknown> {
  return "populated" in value && value.populated === false;
}

function readCache(file: string, now: Date): ReturnType<typeof loadCache> | (ToolEnvelope & Record<string, unknown>) {
  try {
    return loadCache(file);
  } catch (error) {
    if (error instanceof SafeClientError && error.message.startsWith("No treasury cache file.")) {
      return unpopulatedCache(now);
    }
    throw error;
  }
}

export function cacheSources(rpc: string): ToolEnvelope["sources"] {
  return [
    { url: WALLET_SOURCE_URL, note: "Published DAO Treasury and Ecosystem Fund addresses. The retired pre-multisig treasury is not scanned." },
    { url: PIP23_URL, note: "PIP-23 names the same two wallets." },
    { url: rpc, note: "Public Solana read methods only. The URL is redacted." },
    { url: "https://solscan.io/tx/", note: "Transaction links are built from signatures. Solscan is not queried." },
  ];
}

export function createDaoReaders(
  config: Config,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): DaoReaders {
  const base = config.galaxyBaseUrl;
  const balanceRpc = () =>
    createFallbackRpc(
      solanaRpcUrls(config.solanaRpcUrl, config.solanaRpcFallbackUrls.join(",")),
      fetchImpl,
      { minIntervalMs: 200, attempts: 2 },
    );
  const hubSource = () => ({
    repo: config.hubGitRepo,
    commit: config.hubGitCommit,
    manifestPath: config.hubStoreManifest,
    manifestHash: config.hubStoreManifestHash,
    manifestFallback: config.hubStoreManifestFallback,
  });
  let profileChecker: ReturnType<typeof createProfileKeyChecker> | undefined;
  const claimReadOptions = () => {
    profileChecker ??= createProfileKeyChecker(balanceRpc());
    return {
      allowAuthorApproval: config.hubAllowAuthorApproval,
      revokedSigners: new Set(config.hubRevokedSigners),
      trustedVerifiers: new Set(config.hubTrustedVerifiers),
      profile: (wallet: string, profileAddress: string, nowMs: number) =>
        profileChecker?.walletIsProfileKey(wallet, profileAddress, nowMs) ?? Promise.resolve("unavailable" as const),
    };
  };

  return {
    async listProposals(query) {
      const url = proposalsUrl(base);
      const proposals = parseProposals(await getJson(fetchImpl, url));
      const limit = query.limit ?? DEFAULT_PROPOSAL_LIMIT;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PROPOSAL_LIMIT) {
        throw new UserInputError(`limit must be from 1 to ${MAX_PROPOSAL_LIMIT}.`);
      }
      const matched = proposals.filter((proposal) => {
        if (query.pipNumber !== undefined && proposal.pipNumber !== query.pipNumber) return false;
        if (query.status && proposal.status !== query.status) return false;
        return true;
      });
      let start = 0;
      if (query.cursor !== undefined) {
        const cursor = proposalCursor(query.cursor);
        const index = matched.findIndex((proposal) => proposal.id === cursor);
        if (index < 0) throw new UserInputError("cursor is not in this proposal list.");
        start = index + 1;
      }
      const page = matched.slice(start, start + limit);
      const more = start + limit < matched.length;
      return live(
        [{ url, note: "Public galaxy proposal list." }],
        {
          matched: matched.length,
          returned: page.length,
          truncated: more,
          nextCursor: more ? page[page.length - 1]?.id ?? null : null,
          proposals: page,
        },
        now(),
      );
    },

    async getProposalVotes(query) {
      const topN = query.topN ?? 0;
      if (!Number.isInteger(topN) || topN < 0 || topN > 20) throw new UserInputError("topN must be from 0 to 20.");
      let proposalId = query.proposalId;
      if (query.pipNumber !== undefined) {
        const proposals = parseProposals(await getJson(fetchImpl, proposalsUrl(base)));
        const found = proposals.find((proposal) => proposal.pipNumber === query.pipNumber);
        if (!found) throw new SafeClientError(`No galaxy proposal is numbered PIP-${query.pipNumber}.`);
        if (proposalId && proposalId.toLowerCase() !== found.id) {
          throw new UserInputError("proposalId and pipNumber do not refer to the same proposal.");
        }
        proposalId = found.id;
      }
      if (!proposalId) throw new UserInputError("Provide proposalId or pipNumber.");
      const url = votesUrl(base, proposalId);
      const votes = parseVotes(await getJson(fetchImpl, url));
      if (votes.some((vote) => vote.proposalId !== proposalId?.toLowerCase())) {
        throw new SafeClientError("The votes file contains a record for a different proposal. No tally was returned.");
      }
      return live(
        [{ url, note: "Public signed-vote file." }],
        {
          proposalId: proposalId.toLowerCase(),
          ...summarizeVotes(votes, topN),
        },
        now(),
      );
    },

    async daoRevenue(query) {
      const url = revenueUrl(base);
      let rows = parseRevenue(await getJson(fetchImpl, url));
      if (query.segmentation) rows = rows.filter((row) => row.segmentation === query.segmentation);
      if (query.from) rows = rows.filter((row) => row.recorded_period.slice(0, 7) >= query.from!);
      if (query.to) rows = rows.filter((row) => row.recorded_period.slice(0, 7) <= query.to!);
      return live(
        [{ url, note: "Public monthly revenue by segment and mint. Amounts are the figures galaxy published." }],
        { rowCount: rows.length, ...summarizeRevenue(rows) },
        now(),
      );
    },

    async daoTreasuryFlows(query) {
      const cache = loadCache(config.treasuryCachePath);
      const report = buildFlows(cache, query);
      requireRows(report.rows, report.omitted, "Treasury flows");
      return cached(config, report);
    },

    async daoPayments(query) {
      const cache = loadCache(config.treasuryCachePath);
      const report = buildPayments(cache, query);
      requireRows(report.payments, report.omitted, "Payments");
      return cached(config, report);
    },

    async treasuryHistory(query) {
      const cache = readCache(config.treasuryCachePath, now());
      if (isUnpopulated(cache)) return cache;
      const report = buildHistory(cache, query);
      requireRows(report.series, report.omitted, "Treasury history");
      return cached(config, report);
    },

    async ecofundLimit(query) {
      const loaded = readCache(config.treasuryCachePath, now());
      if (isUnpopulated(loaded)) return loaded;
      const cache = loaded;
      if (query.councilOverride && !query.councilOverride.perPipLimitAtlas && !query.councilOverride.nextQuarterLimitAtlas) {
        throw new UserInputError("councilOverride needs perPipLimitAtlas or nextQuarterLimitAtlas, and a label.");
      }
      const fundCursor = cache.cursors.find(
        (cursor) => cursor.role === "ecosystem_fund" && cursor.kind === "token" && cursor.mint === ATLAS_MINT,
      );
      const refills = findRefills(cache.movements);
      const treasuryAtlas = cache.balances.find((balance) => balance.role === "dao_treasury" && balance.mint === ATLAS_MINT);
      const fundAtlas = cache.balances.find((balance) => balance.role === "ecosystem_fund" && balance.mint === ATLAS_MINT);
      const treasuryUsdc = cache.balances.find((balance) => balance.role === "dao_treasury" && balance.mint === USDC_MINT);
      const fundUsdc = cache.balances.find((balance) => balance.role === "ecosystem_fund" && balance.mint === USDC_MINT);
      const balances =
        treasuryAtlas && fundAtlas && treasuryUsdc
          ? {
              treasuryAtlasRaw: BigInt(treasuryAtlas.amountRaw),
              fundAtlasRaw: BigInt(fundAtlas.amountRaw),
              treasuryUsdcRaw: BigInt(treasuryUsdc.amountRaw),
              fundUsdcRaw: fundUsdc ? BigInt(fundUsdc.amountRaw) : null,
              atlasDecimals: treasuryAtlas.decimals,
              usdcDecimals: treasuryUsdc.decimals,
              fetchedAt: treasuryAtlas.fetchedAt,
            }
          : null;
      const asOf = query.asOf ?? balances?.fetchedAt ?? cache.generatedAt;
      const evaluated = evaluateEcofund({
        refills,
        balances,
        unpaidPips: query.unpaidPips,
        councilOverride: query.councilOverride,
        asOf,
        movementsComplete: Boolean(fundCursor?.reachedEnd && fundCursor.gaps.length === 0 && fundCursor.reconciled === true),
      });
      return {
        dataMode: "cached",
        asOf: cache.generatedAt,
        sources: [
          ...cacheSources(cache.rpc),
          { url: PIP23_URL, note: "Refill rule, 5% limit, and quarter dates. Passed as Voting_Complete_Measure_Passes on the public proposals list (checked 2026-10-24)." },
          { url: PIP4_URL, note: "Replaced in its entirety by PIP-23. Not used for the current numbers." },
          { url: USDC_SOURCE_URL, note: "Circle's published Solana USDC mint, matched to the treasury token account." },
          { url: `${base}/proposals`, note: "Proposal status was read from this public list on 2026-10-24. This call does not refresh it." },
        ],
        scope: {
          wallets: [walletAddress("dao_treasury"), walletAddress("ecosystem_fund")],
          mints: { ATLAS: ATLAS_MINT, USDC: USDC_MINT, SOL: NATIVE_MINT },
          retiredTreasuryNotScanned: "DRGThVUMGEYcsoTERhmkFSa5q7HVjxBQdKwMNjyvehD1",
        },
        ...evaluated,
        cache: { generatedAt: cache.generatedAt, rpc: redactRpcUrl(config.solanaRpcUrl) },
      };
    },

    async treasuryBalances() {
      const rpc = balanceRpc();
      let cacheBalances: Parameters<typeof readWalletBalancesWithFallback>[0]["cacheBalances"] = null;
      try {
        cacheBalances = loadCache(config.treasuryCachePath).balances;
      } catch {
        cacheBalances = null;
      }
      const readAt = now();
      const read = await readWalletBalancesWithFallback({ rpc, now: readAt, cacheBalances });
      if (!read.ok || !read.asOf) {
        throw new SafeClientError(read.label);
      }
      if (read.mode === "cached") {
        return {
          dataMode: "cached" as const,
          asOf: read.asOf,
          sources: [
            ...cacheSources(redactRpcUrl(config.solanaRpcUrl)),
            {
              url: WALLET_SOURCE_URL,
              note: "Cached SOL, ATLAS, and USDC balances for the two published wallets. The live read failed.",
            },
          ],
          wallets: read.wallets,
          multisigs: [],
          multisigError: "Multisig accounts were not read. The live balance read failed, so no multisig state was invented.",
          standardAccountOnly: true,
          freshness: { mode: "cached" as const, asOf: read.asOf },
          liveError: read.liveError,
        };
      }
      let multisigs: Awaited<ReturnType<typeof readPublishedMultisigs>> = [];
      let multisigError: string | null = null;
      try {
        multisigs = await readPublishedMultisigs(rpc);
      } catch (error) {
        multisigError = publicErrorMessage(error);
      }
      return live(
        [
          { url: WALLET_SOURCE_URL, note: "Published DAO Treasury and Ecosystem Fund addresses." },
          {
            url: redactRpcUrl(config.solanaRpcUrl),
            note: "One getMultipleAccounts read for SOL and the standard ATLAS and USDC accounts. Squads accounts are decoded, not signed.",
          },
        ],
        {
          wallets: read.wallets,
          multisigs,
          multisigError,
          standardAccountOnly: true,
          freshness: { mode: "live", asOf: read.asOf },
        },
        readAt,
      );
    },

    async pipTracker() {
      const response = await fetchImpl(COUNCIL_SHEET_CSV, { method: "GET", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new SafeClientError(`Council sheet HTTP ${response.status}. No payments were invented.`);
      const parsed = parsePipTracker(await response.text());
      return live(
        [{ url: COUNCIL_SHEET_URL, note: "Public Council Tracker tab. Payments and milestones are the sheet cells." }],
        {
          rowCount: parsed.rows.length,
          missingColumns: parsed.missingColumns,
          rows: parsed.rows,
        },
        now(),
      );
    },

    async hubUpdates(query) {
      const source = hubSource();
      if (!source.repo && !source.commit && !source.manifestHash) {
        const result = await readHubUpdates(source, new Set(), config.hubApprovalThreshold, query.kind);
        return live([], { schema: result.schema, updates: result.updates, rejected: result.rejected, note: result.note }, now());
      }
      const directory = loadSignerDirectory(config.hubSignerSets);
      const allowlist = new Set(directory.sets.flatMap((set) => [...set.publicKeys]));
      const result = await readHubUpdates(source, allowlist, config.hubApprovalThreshold, query.kind, directory.sets, claimReadOptions());
      return live(
        result.sourceUrl
          ? [{ url: result.sourceUrl, note: "Public git commit. The manifest hash was checked before any update was returned." }]
          : [],
        {
          schema: result.schema,
          updates: result.updates,
          rejected: result.rejected,
          note: result.note,
        },
        now(),
      );
    },

    async listListings(query) {
      const source = hubSource();
      const verify = claimReadOptions();
      if (!source.repo && !source.commit && !source.manifestHash) {
        const result = await listListings(source, new Set(), config.hubApprovalThreshold, query, undefined, verify, new Map(), now());
        return live([], listingBody(result), now());
      }
      const directory = loadSignerDirectory(config.hubSignerSets);
      const allowlist = new Set(directory.sets.flatMap((set) => [...set.publicKeys]));
      const result = await listListings(
        source,
        allowlist,
        config.hubApprovalThreshold,
        query,
        directory.sets,
        verify,
        directory.labels,
        now(),
      );
      return live(
        result.sourceUrl
          ? [{ url: result.sourceUrl, note: "Public git commit. The manifest hash was checked before any listing was returned." }]
          : [],
        listingBody(result),
        now(),
      );
    },

    async searchDirectory(query, names) {
      const source = hubSource();
      const verify = claimReadOptions();
      const run = (allowlist: Set<string>, sets: ReturnType<typeof loadSignerDirectory>["sets"] | undefined, labels: Map<string, string>) =>
        searchHub(source, allowlist, config.hubApprovalThreshold, query.query, sets, verify, labels, now(), names);
      if (!source.repo && !source.commit && !source.manifestHash) {
        const result = await run(new Set(), undefined, new Map());
        return live([], searchBody(result), now());
      }
      const directory = loadSignerDirectory(config.hubSignerSets);
      const allowlist = new Set(directory.sets.flatMap((set) => [...set.publicKeys]));
      const result = await run(allowlist, directory.sets, directory.labels);
      return live(
        result.sourceUrl
          ? [{ url: result.sourceUrl, note: "Public git commit. The manifest hash was checked before the search." }]
          : [],
        searchBody(result),
        now(),
      );
    },

    async storyContext() {
      const source = hubSource();
      const verify = claimReadOptions();
      if (!source.repo && !source.commit && !source.manifestHash) {
        return readStoryContext(source, new Set(), config.hubApprovalThreshold, undefined, verify, new Map(), now());
      }
      const directory = loadSignerDirectory(config.hubSignerSets);
      const allowlist = new Set(directory.sets.flatMap((set) => [...set.publicKeys]));
      return readStoryContext(source, allowlist, config.hubApprovalThreshold, directory.sets, verify, directory.labels, now());
    },

    async claimStatus(query) {
      const source = hubSource();
      const verify = claimReadOptions();
      const run = (allowlist: Set<string>, sets: ReturnType<typeof loadSignerDirectory>["sets"] | undefined) =>
        claimStatus(source, allowlist, config.hubApprovalThreshold, query.identity, sets, verify, now());
      if (!source.repo && !source.commit && !source.manifestHash) {
        const result = await run(new Set(), undefined);
        return live([], { schema: result.schema, hubId: result.hubId, claims: result.claims, note: result.note }, now());
      }
      const directory = loadSignerDirectory(config.hubSignerSets);
      const allowlist = new Set(directory.sets.flatMap((set) => [...set.publicKeys]));
      const result = await run(allowlist, directory.sets);
      return live(
        result.sourceUrl
          ? [{ url: result.sourceUrl, note: "Public git commit. The manifest hash was checked before claim state was read." }]
          : [],
        { schema: result.schema, hubId: result.hubId, claims: result.claims, note: result.note },
        now(),
      );
    },

    async dataHealth() {
      const readAt = now().toISOString();
      const checks = await probeDataHealth({
        fetchImpl,
        galaxyBaseUrl: base,
        cachePath: config.treasuryCachePath,
        rpc: balanceRpc(),
        now: readAt,
      });
      return live(
        [
          { url: `${base}/proposals`, note: "Galaxy probe." },
          { url: COUNCIL_SHEET_URL, note: "Council sheet probe." },
          {
            url: redactRpcUrl(config.solanaRpcUrl),
            note: "Wallet balances use one getMultipleAccounts read. If that fails, freshness is the cached balance time.",
          },
        ],
        { checks },
        now(),
      );
    },
  };
}

function walletAddress(role: "dao_treasury" | "ecosystem_fund"): string {
  return role === "dao_treasury" ? DAO_TREASURY_ADDRESS : ECOSYSTEM_FUND_ADDRESS;
}
