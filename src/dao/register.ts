import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { DaoReaders } from "./readers.js";
import { LISTING_STATUSES, LISTING_STREAMS } from "../hub/listing.js";
import { HUB_UPDATE_KINDS } from "../hub/update.js";
import { ECOSYSTEM_CATEGORIES } from "../stubs/hub-update.js";
import { DISCLAIMER } from "../disclaimer.js";
import { SafeClientError, UserInputError, publicErrorMessage } from "../errors.js";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const month = z.string().regex(/^\d{4}-\d{2}$/).optional();
const wallet = z
  .string()
  .optional()
  .describe("dao_treasury, ecosystem_fund, or one of those two published addresses.");
const mint = z.string().optional().describe("ATLAS, USDC, or SOL.");
const amount = z.string().regex(/^\d+(\.\d+)?$/);

function jsonResult(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: JSON.parse(text) as Record<string, unknown>,
  };
}

function failure(error: unknown) {
  const message =
    error instanceof UserInputError || error instanceof SafeClientError ? error.message : publicErrorMessage(error);
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

export function registerDaoTools(server: McpServer, dao: DaoReaders): void {
  server.registerTool(
    "list_proposals",
    {
      title: "List proposals",
      description:
        "Live read of the public galaxy proposal list. Returns one page of id, PIP number, status, dates, and the published vote totals. The default page size is 20 and the maximum is 100. Pass nextCursor back as cursor for the next page. Read-only.",
      inputSchema: z.object({
        pipNumber: z.number().int().positive().optional(),
        status: z.string().min(1).max(80).optional(),
        limit: z.number().int().min(1).max(100).optional().describe("Page size. Default 20. Maximum 100."),
        cursor: z.string().min(1).max(80).optional().describe("Proposal id from the previous page's nextCursor."),
      }),
      annotations: readOnlyAnnotations,
    },
    async (args) => {
      try {
        return jsonResult({ readOnly: true, disclaimer: DISCLAIMER, ...(await dao.listProposals(args)) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_proposal_votes",
    {
      title: "Get proposal votes",
      description:
        "Live read of galaxy /proposals/votes/{id}.json. Summarizes count and voting power per choice. Does not invent a ranked-choice winner. Read-only.",
      inputSchema: z.object({
        proposalId: z.string().optional().describe("Galaxy proposal UUID."),
        pipNumber: z.number().int().positive().optional(),
        topN: z.number().int().min(0).max(20).optional().describe("How many voters to list, by voting power. Default 0."),
      }),
      annotations: readOnlyAnnotations,
    },
    async (args) => {
      try {
        return jsonResult({ readOnly: true, disclaimer: DISCLAIMER, ...(await dao.getProposalVotes(args)) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "dao_revenue",
    {
      title: "DAO revenue",
      description:
        "Live read of galaxy /dao/treasury. Monthly revenue by source (segmentation) and mint, with the published USDC value. Read-only.",
      inputSchema: z.object({
        from: month.describe("First month YYYY-MM, inclusive."),
        to: month.describe("Last month YYYY-MM, inclusive."),
        segmentation: z.string().min(1).max(80).optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async (args) => {
      try {
        return jsonResult({ readOnly: true, disclaimer: DISCLAIMER, ...(await dao.daoRevenue(args)) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "dao_treasury_flows",
    {
      title: "DAO treasury flows",
      description:
        "Monthly inflows and outflows for the DAO Treasury and Ecosystem Fund, from the local signature cache. Treasury ATLAS inflows are withheld when the cache cannot support them. Read-only.",
      inputSchema: z.object({
        wallet,
        mint,
        from: month,
        to: month,
        allowPartial: z.boolean().optional().describe("Include rows the cache cannot fully support. Default false."),
      }),
      annotations: readOnlyAnnotations,
    },
    async (args) => {
      try {
        return jsonResult({ readOnly: true, disclaimer: DISCLAIMER, ...(await dao.daoTreasuryFlows(args)) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "dao_payments",
    {
      title: "DAO payments",
      description:
        "Payment ledger from the cached signature backfill: signature, time, wallet, token, amount, counterparty, and a Solscan link. Defaults to external outflows. Read-only.",
      inputSchema: z.object({
        wallet,
        mint,
        from: month,
        to: month,
        direction: z.enum(["in", "out", "all"]).optional(),
        includeInternal: z.boolean().optional(),
        includeFees: z.boolean().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
        allowPartial: z.boolean().optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async (args) => {
      try {
        return jsonResult({ readOnly: true, disclaimer: DISCLAIMER, ...(await dao.daoPayments(args)) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "treasury_history",
    {
      title: "Treasury history",
      description:
        "Balance over time from the same cache as the treasury flows. DAO Treasury ATLAS uses end-of-day snapshots. Other assets replay parsed balances. If the cache file is not in this deployment yet, the result says the cache is not yet populated and includes no figures. Read-only.",
      inputSchema: z.object({
        wallet,
        mint,
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        granularity: z.enum(["day", "month"]).optional(),
        allowPartial: z.boolean().optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async (args) => {
      try {
        return jsonResult({ readOnly: true, disclaimer: DISCLAIMER, ...(await dao.treasuryHistory(args)) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "ecofund_limit",
    {
      title: "Ecosystem Fund limit",
      description:
        "PIP-23 Ecosystem Fund refills, the 5% limit, the next-quarter projection, and remaining ATLAS after caller-supplied unpaid PIPs. Unknown where PIP-23 states no rule. An optional Council override is labelled and does not replace the computed figure. If the cache file is not in this deployment yet, the result says the cache is not yet populated and includes no figures. Read-only.",
      inputSchema: z.object({
        asOf: z.string().min(4).optional().describe("ISO timestamp used to pick the next quarter date. Defaults to the cached balance time."),
        unpaidPips: z
          .array(
            z.object({
              pip: z.string().min(1).max(40),
              amountAtlas: amount,
              sourceLabel: z.string().min(1).max(200),
            }),
          )
          .optional()
          .describe("Council-supplied unpaid amounts in ATLAS. Omit the field to leave remaining unknown. An empty list means the caller says there are none."),
        councilOverride: z
          .object({
            label: z.string().min(1).max(200),
            perPipLimitAtlas: amount.optional(),
            nextQuarterLimitAtlas: amount.optional(),
            note: z.string().max(500).optional(),
          })
          .optional()
          .describe("Labelled Council figure. Shown beside the computed limit, not silently substituted."),
      }),
      annotations: readOnlyAnnotations,
    },
    async (args) => {
      try {
        return jsonResult({ readOnly: true, disclaimer: DISCLAIMER, ...(await dao.ecofundLimit(args)) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "treasury_balances",
    {
      title: "Treasury balances",
      description:
        "Live SOL, ATLAS, and USDC balances for the DAO Treasury and Ecosystem Fund from one getMultipleAccounts read, with the treasury cache as fallback. Includes a read-only Squads v3 decode of the two published multisigs when the live read works. Standard token accounts only. Read-only.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    async () => {
      try {
        return jsonResult({ readOnly: true, disclaimer: DISCLAIMER, ...(await dao.treasuryBalances()) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "pip_tracker",
    {
      title: "PIP tracker",
      description:
        "Payments and milestones from the public Council Tracker sheet. Blank cells stay null. Read-only.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    async () => {
      try {
        return jsonResult({ readOnly: true, disclaimer: DISCLAIMER, ...(await dao.pipTracker()) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "hub_updates",
    {
      title: "Hub updates",
      description:
        "Read signed hub updates from a public git repo pinned to a commit. The manifest hash is checked first. An update is returned only when its author is allowlisted and it has enough distinct allowlisted approval signatures over that hash. signedBy lists the author and every wallet whose signature verified, including an author who did not count as an approver. approvedBy lists only the wallets whose approvals counted toward the threshold. selfApproved is true when the author key is the only approver. At threshold 2 or higher that approval does not count unless the node allows it. A locally revoked signer does not count, and an update whose only valid approvals are from revoked keys is left out. Revoking a whole signer group is not implemented. A signer-change adds or removes one signer only after the current threshold of other allowlisted signers approve it. An empty allowlist returns nothing. Does not sign or invent updates. Read-only.",
      inputSchema: z.object({
        kind: z.enum(HUB_UPDATE_KINDS).optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async (args) => {
      try {
        return jsonResult({ readOnly: true, disclaimer: DISCLAIMER, ...(await dao.hubUpdates(args)) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_listings",
    {
      title: "List listings",
      description:
        "Read signed business listings from the pinned hub store. Filter by stream, category, or status. Expired listings are hidden unless includeExpired is true, and those rows are marked expired. Each listing includes the signer's display name and a plain signedMeaning line. The url is the business's own page. This node does not take payment. Signer, threshold, revocation, and manifest-pin checks match hub_updates. Read-only.",
      inputSchema: z.object({
        stream: z.enum(LISTING_STREAMS).optional().describe("referral, hybrid, irl, or player."),
        category: z.enum(ECOSYSTEM_CATEGORIES).optional().describe("One list_categories id."),
        status: z.enum(LISTING_STATUSES).optional().describe("available, sold_out, inquire_only, or paused. withdrawn is a takedown and those rows are left out."),
        includeExpired: z
          .boolean()
          .optional()
          .describe("When true, include listings whose expiresAt is before today (UTC) and set expired to true."),
      }),
      annotations: readOnlyAnnotations,
    },
    async (args) => {
      try {
        return jsonResult({ readOnly: true, disclaimer: DISCLAIMER, ...(await dao.listListings(args)) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_c4_markers",
    {
      title: "List C4 markers (H2H)",
      description:
        "H2H bridge feed h2h.c4-markers.v1 (protocol/h2h/SPEC.md section 6.1). One marker per current signed listing and guild listing, with the same signer, threshold, revocation, and manifest-pin checks as hub_updates. Every marker is placement orbit with anchor none: coordinates come only from a signed c4-anchor record, and that kind is not built yet. Also served as GET /c4-markers.json. Not game fleets. Read-only.",
      inputSchema: z.object({
        kind: z.enum(["listing", "guild", "all"]).optional().describe("listing, guild, or all. Default all."),
        anchored: z.boolean().optional().describe("true returns only markers with a resolved signed anchor (none exist yet)."),
        stream: z.enum(LISTING_STREAMS).optional().describe("Listing stream. Guild markers have no stream and are left out when this is set."),
      }),
      annotations: readOnlyAnnotations,
    },
    async (args) => {
      try {
        return jsonResult({ readOnly: true, ...(await dao.c4Markers(args)) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_community_tools",
    {
      title: "List community tools (H2H)",
      description:
        "H2H bridge feed h2h.community-tools.v1 (protocol/h2h/SPEC.md section 6.2). A curated list from protocol/h2h/community-tools.json in this node's repo, including the Community developers and Game publisher packages categories in the same feed. Anyone can add a tool with one pull request. Every row is a pointer only. It is not permission, a partnership, an endorsement, or embedding. Each category entry has a credit line naming the public handle. linkOnly means this repo does not copy that kit's code, docs, or assets. A private repo is never listed. Also served as GET /community-tools.json. Read-only.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    async () => {
      try {
        return jsonResult({ readOnly: true, disclaimer: DISCLAIMER, ...dao.communityTools() });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "claim_status",
    {
      title: "Claim status",
      description:
        "Read claim state for one listing identity, or for every claim in the pinned hub. A player claim is active only when the claimant wallet is a current key on the named player profile. A guild or business claim is active only after curators countersign. The first eligible claim in chain order wins unless curators resolve or revoke it. X and Discord notes are self-attested, unverified, unless a trusted verifier attestation is current. A raw handle is included only when the claim opts in. Read-only. This does not move money.",
      inputSchema: z.object({
        identity: z
          .string()
          .min(1)
          .max(120)
          .optional()
          .describe("A listing id, a guild name, or an identity key such as id:booth or guild:east-hall. Omit it to list every claim."),
      }),
      annotations: readOnlyAnnotations,
    },
    async (args) => {
      try {
        return jsonResult({ readOnly: true, disclaimer: DISCLAIMER, ...(await dao.claimStatus(args)) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "data_health",
    {
      title: "Data health",
      description:
        "Freshness and the last error for the treasury cache, galaxy proposals, the Council sheet, and wallet balances. Wallet balances say live or cached. Read-only.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    async () => {
      try {
        return jsonResult({ readOnly: true, disclaimer: DISCLAIMER, ...(await dao.dataHealth()) });
      } catch (error) {
        return failure(error);
      }
    },
  );
}
