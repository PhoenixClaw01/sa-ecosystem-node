import { readFileSync } from "node:fs";

import type { Config } from "../config.js";
import { ATLAS_CLUSTER } from "../config.js";
import { createDaoReaders } from "./readers.js";
import { matchTrackerToPayments, mintCompleteFromCache, parseTrackerMoney } from "./payment-match.js";
import { monthlyIncome } from "./dashboard-view.js";

export const RECORDED_AT = "2026-10-24T00:00:00.000Z";
export const RECORDED_LABEL = "recorded MCP output";

const CACHE_PATH = "dashboard/data/treasury-cache.json";

export interface RecordedPanel {
  tool: string;
  arguments: Record<string, unknown>;
  /** True only when `output` is the return value of a registered read-only tool. */
  registered: boolean;
  ok: boolean;
  output: unknown;
  error: string | null;
}

export interface RecordedMcp {
  label: typeof RECORDED_LABEL;
  recordedAt: string;
  liveEndpoint: "";
  network: false;
  note: string;
  panels: Record<string, RecordedPanel>;
}

export interface RecordedInputs {
  proposals: unknown;
  votes: unknown;
  revenue: unknown;
  trackerCsv: string;
  now?: Date;
}

function recordingConfig(): Config {
  return {
    zinkRpcUrl: "https://testnet-rpc.z.ink",
    solanaRpcUrl: "https://solana-rpc.publicnode.com",
    solanaRpcFallbackUrls: ["https://api.mainnet-beta.solana.com"],
    galaxyBaseUrl: "https://galaxy.staratlas.com",
    hubGitRepo: "",
    hubGitCommit: "",
    hubStoreManifest: "hub-manifest.json",
    hubStoreManifestFallback: false,
    hubStoreManifestHash: "",
    hubApprovalThreshold: 1,
    hubAllowAuthorApproval: false,
    hubRevokedSigners: [],
    hubTrustedVerifiers: [],
    hubSignersPath: "hub/signers.json",
    hubSignerSets: [{ id: "default", path: "hub/signers.json", threshold: 1 }],
    treasuryCachePath: CACHE_PATH,
    cluster: ATLAS_CLUSTER,
    host: "127.0.0.1",
    port: 8787,
    publicNode: false,
    allowedHosts: [],
    allowAnyHost: false,
    trustProxy: false,
    rateLimitMax: 120,
    rateLimitWindowMs: 60_000,
    maxRequestBytes: 512 * 1024,
    maxResponseBytes: 512 * 1024,
  };
}

function fixtureFetch(inputs: RecordedInputs): typeof fetch {
  const routes = new Map<string, unknown>([
    ["https://galaxy.staratlas.com/proposals", inputs.proposals],
    ["https://galaxy.staratlas.com/proposals/votes/c00de055-1942-486f-a64d-dd4ee360500f.json", inputs.votes],
    ["https://galaxy.staratlas.com/dao/treasury", inputs.revenue],
  ]);
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = routes.get(url);
    if (body === undefined) {
      return new Response("not in the recording sample", { status: 404 });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

async function call(
  tool: string,
  args: Record<string, unknown>,
  run: () => Promise<unknown>,
): Promise<RecordedPanel> {
  try {
    return { tool, arguments: args, registered: true, ok: true, output: await run(), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The tool failed.";
    if (/\/workspace|\/home\/|\/tmp\/|\/Users\//.test(message)) {
      throw new Error(`${tool} returned an error that names a local path. The recording was not written.`);
    }
    return { tool, arguments: args, registered: true, ok: false, output: null, error: message };
  }
}

function cachePayload(): unknown | null {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as unknown;
  } catch {
    return null;
  }
}

export async function buildRecordedMcp(inputs: RecordedInputs): Promise<RecordedMcp> {
  const now = inputs.now ?? new Date(RECORDED_AT);
  const readers = createDaoReaders(recordingConfig(), fixtureFetch(inputs), () => now);
  const proposalArgs = { limit: 100 };
  const voteArgs = { pipNumber: 36, topN: 5 };
  const revenueArgs = {};
  const paymentArgs = { direction: "out" as const, limit: 20 };
  const flowArgs = {};
  const historyArgs = { granularity: "month" as const };
  const limitArgs = {};

  const results = await call("list_proposals", proposalArgs, () => readers.listProposals(proposalArgs));
  const votes = await call("get_proposal_votes", voteArgs, () => readers.getProposalVotes(voteArgs));
  const revenue = await call("dao_revenue", revenueArgs, () => readers.daoRevenue(revenueArgs));
  const payments = await call("dao_payments", paymentArgs, () => readers.daoPayments(paymentArgs));
  const flows = await call("dao_treasury_flows", flowArgs, () => readers.daoTreasuryFlows(flowArgs));
  const history = await call("treasury_history", historyArgs, () => readers.treasuryHistory(historyArgs));
  const limit = await call("ecofund_limit", limitArgs, () => readers.ecofundLimit(limitArgs));

  const parsedSheet = parseTrackerMoney(inputs.trackerCsv);
  const cache = cachePayload();
  const chainPayments =
    payments.ok && payments.output && typeof payments.output === "object" && Array.isArray((payments.output as { payments?: unknown }).payments)
      ? ((payments.output as { payments: { signature: string; mint: string; symbol: string | null; amount: string; time: string | null; direction: string; internal: boolean }[] }).payments)
          .filter((payment) => payment.direction === "out" && payment.internal === false)
          .map((payment) => ({
            signature: payment.signature,
            mint: payment.mint,
            symbol: payment.symbol,
            amount: payment.amount,
            time: payment.time,
          }))
      : [];
  const match = matchTrackerToPayments(parsedSheet, chainPayments, {
    chainRead: payments.ok,
    mintComplete: (mint) => (cache ? mintCompleteFromCache(cache, mint) : false),
  });

  let income: unknown = null;
  let incomeError: string | null = null;
  try {
    income = monthlyIncome(inputs.revenue);
  } catch (error) {
    incomeError = error instanceof Error ? error.message : "Monthly income could not be summed.";
  }

  return {
    label: RECORDED_LABEL,
    recordedAt: now.toISOString(),
    liveEndpoint: "",
    network: false,
    note: "Tools ran against the checked-in galaxy sample and the checked-in Tracker export. The clock is fixed so the file stays stable. This was not a live network read. No balance was invented.",
    panels: {
      results: results,
      votes,
      revenue,
      income: {
        tool: "dao_revenue",
        arguments: revenueArgs,
        registered: false,
        ok: incomeError === null,
        output: income,
        error: incomeError,
      },
      payments,
      flows,
      history,
      limit,
      match: {
        tool: "dao_payments",
        arguments: paymentArgs,
        registered: false,
        ok: true,
        output: match,
        error: payments.error,
      },
      balances: {
        tool: "treasury_balances",
        arguments: {},
        registered: false,
        ok: false,
        output: null,
        error: "No balance reader ran for this recording. Wallet balances stay a browser read. No balance was invented.",
      },
      health: {
        tool: "data_health",
        arguments: {},
        registered: false,
        ok: true,
        output: {
          sources: [
            {
              source: "galaxy /proposals",
              status: results.ok ? "ok" : "error",
              asOf: results.ok ? now.toISOString() : null,
              detail: results.error,
            },
            {
              source: "galaxy /proposals/votes",
              status: votes.ok ? "ok" : "error",
              asOf: votes.ok ? now.toISOString() : null,
              detail: votes.error,
            },
            {
              source: "galaxy /dao/treasury",
              status: revenue.ok ? "ok" : "error",
              asOf: revenue.ok ? now.toISOString() : null,
              detail: revenue.error,
            },
            {
              source: "treasury cache",
              status: payments.ok ? "ok" : "missing",
              asOf: null,
              detail: payments.error,
            },
            {
              source: "Council Tracker export",
              status: parsedSheet.rows.length > 0 ? "ok" : "error",
              asOf: now.toISOString(),
              detail:
                parsedSheet.rows.length > 0
                  ? "Parsed the checked-in copy of the public Tracker export. Not a live sheet fetch."
                  : "The Tracker export had no PIP rows.",
            },
            {
              source: "Jupiter price",
              status: "not_requested",
              asOf: null,
              detail: "The approximate USD toggle defaults to off. No price was requested.",
            },
            {
              source: "other Council multisigs",
              status: "missing",
              asOf: null,
              detail: "Other Council multisigs are listed once their addresses are published.",
            },
          ],
        },
        error: null,
      },
      multisigs: {
        tool: "other_multisigs",
        arguments: {},
        registered: false,
        ok: true,
        output: {
          verified: [],
          detail: "Other Council multisigs are listed once their addresses are published.",
        },
        error: null,
      },
      usd: {
        tool: "jupiter_price",
        arguments: {},
        registered: false,
        ok: false,
        output: null,
        error: "Not requested. The approximate USD toggle is off. No price was invented.",
      },
    },
  };
}
