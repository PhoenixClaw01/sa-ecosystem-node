import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { redactRpcUrl, type Config } from "./config.js";
import { registerDaoTools } from "./dao/register.js";
import type { DaoReaders } from "./dao/readers.js";
import { DISCLAIMER } from "./disclaimer.js";
import { listCategories } from "./dao/hub.js";
import { publicErrorMessage, UserInputError } from "./errors.js";
import type { GameReaders } from "./game/live.js";
import type { LegacyReaders } from "./legacy/read.js";
import { createPlayerStoryReader } from "./legacy/story.js";
import { summarizeGalaxyActivity } from "./game/summarize.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

export const READ_ONLY_TOOLS = [
  "list_star_systems",
  "get_fleet",
  "profile_key_audit",
  "player_legacy",
  "player_story",
  "dao_overview",
  "treasury_balances",
  "pip_tracker",
  "galaxy_overview",
  "list_categories",
  "hub_updates",
  "list_listings",
  "search_hub",
  "claim_status",
  "list_c4_markers",
  "list_community_tools",
  "data_health",
  "list_proposals",
  "get_proposal_votes",
  "dao_revenue",
  "dao_treasury_flows",
  "dao_payments",
  "treasury_history",
  "ecofund_limit",
] as const;

const DEFAULT_SYSTEM_LIMIT = 100;
const MAX_SYSTEM_LIMIT = 500;

export type NodeDeps = GameReaders & DaoReaders & LegacyReaders;

async function playerDisplayName(deps: NodeDeps, wallet: string): Promise<string | null> {
  try {
    const card = await deps.playerLegacy({ address: wallet });
    for (const profile of card.profiles) {
      if (typeof profile.name === "string" && profile.name.trim()) return profile.name.trim();
    }
  } catch {
    return null;
  }
  return null;
}

function jsonResult(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: JSON.parse(text) as Record<string, unknown>,
  };
}

function failure(error: unknown) {
  const message = error instanceof UserInputError ? error.message : publicErrorMessage(error);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * Read-only MCP server. `submit_hub_update` is intentionally not registered.
 */
export function createNodeServer(deps: NodeDeps, config: Config): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  const readPlayerStory = createPlayerStoryReader({
    playerLegacy: (query) => deps.playerLegacy(query),
    hub: () => deps.storyContext(),
  });

  server.registerTool(
    "list_star_systems",
    {
      title: "List star systems",
      description:
        "Read star systems from the z.ink test realm via @aephia/atlas-kit. Read-only. Inspired by Star Atlas; not an ATMTA service.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_SYSTEM_LIMIT)
          .optional()
          .describe(`How many systems to return. Default ${DEFAULT_SYSTEM_LIMIT}.`),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ limit }) => {
      try {
        const cap = limit ?? DEFAULT_SYSTEM_LIMIT;
        const page = await deps.listStarSystems(cap);
        return jsonResult({
          readOnly: true,
          cluster: config.cluster,
          rpc: redactRpcUrl(config.zinkRpcUrl),
          disclaimer: DISCLAIMER,
          limit: cap,
          total: page.total,
          truncated: page.total > page.systems.length,
          systems: page.systems,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_fleet",
    {
      title: "Get fleet",
      description:
        "Read one public fleet by account address, or list fleets owned by a player profile, on the z.ink test realm. Read-only.",
      inputSchema: z.object({
        fleetAddress: z.string().min(1).optional().describe("Fleet account address."),
        profileAddress: z
          .string()
          .min(1)
          .optional()
          .describe("Player profile address. Lists that profile's fleets when fleetAddress is omitted."),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ fleetAddress, profileAddress }) => {
      try {
        if (!fleetAddress && !profileAddress) {
          throw new UserInputError("Provide fleetAddress or profileAddress.");
        }
        const fleets = await deps.getFleet({ fleetAddress, profileAddress });
        return jsonResult({
          readOnly: true,
          cluster: config.cluster,
          rpc: redactRpcUrl(config.zinkRpcUrl),
          disclaimer: DISCLAIMER,
          fleets,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "profile_key_audit",
    {
      title: "Profile key audit",
      description:
        "List keys on a player profile: address, scope, expiry, decoded permissions, and heuristic risk flags. Read-only. Does not use or grant those keys.",
      inputSchema: z.object({
        profileAddress: z.string().min(1).describe("Player profile account address."),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ profileAddress }) => {
      try {
        const audit = await deps.auditProfile(profileAddress);
        return jsonResult({
          readOnly: true,
          cluster: config.cluster,
          rpc: redactRpcUrl(config.zinkRpcUrl),
          disclaimer: DISCLAIMER,
          note: "Risk flags are heuristics for review. They are not chain authorization policy.",
          ...audit,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "player_legacy",
    {
      title: "Player legacy",
      description:
        "Read a public mainnet record for a wallet or a player profile: profiles, creation dates, faction enlistment, SAGE fleets still on the accounts, signature bands, and first and last activity. Read-only. The lookup runs on the server against the public mainnet RPC. Nothing is stored.",
      inputSchema: z.object({
        address: z.string().min(32).max(44).describe("A wallet address or a player profile address."),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ address }) => {
      try {
        return jsonResult(await deps.playerLegacy({ address }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "player_story",
    {
      title: "Player story",
      description:
        "Turn a public player_legacy card into a short plain-language story, only after that wallet opts in. The wallet signs a fixed sentence, and an allowlisted hub signer publishes it as a story-optin update. Without a valid unrevoked opt-in the tool returns not opted in and does not tell the story. Read-only. The story does not quote names, prices, or a call to action.",
      inputSchema: z.object({
        address: z.string().min(32).max(44).describe("The wallet that signed the opt-in, or a player profile address that signed one."),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ address }) => {
      try {
        return jsonResult(await readPlayerStory({ address }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "dao_overview",
    {
      title: "DAO overview",
      description:
        "Live treasury balances, Squads decode, a short proposal list, and data-health checks. A section that cannot be read is an error, not a made-up figure. Read-only.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    async () => {
      const section = async (name: string, run: () => Promise<unknown>) => {
        try {
          return { name, ok: true as const, data: await run() };
        } catch (error) {
          return { name, ok: false as const, error: publicErrorMessage(error) };
        }
      };
      const sections = await Promise.all([
        section("treasury_balances", () => deps.treasuryBalances()),
        section("proposals", () => deps.listProposals({ limit: 10 })),
        section("data_health", () => deps.dataHealth()),
      ]);
      return jsonResult({
        readOnly: true,
        disclaimer: DISCLAIMER,
        solanaRpc: { url: redactRpcUrl(config.solanaRpcUrl) },
        sections,
      });
    },
  );

  server.registerTool(
    "galaxy_overview",
    {
      title: "Galaxy overview",
      description:
        "Star systems from the z.ink test realm, with starbases and an activity summary of connections and celestial bodies. Read-only.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(500).optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ limit }) => {
      try {
        const cap = limit ?? 100;
        const page = await deps.listStarSystems(cap);
        return jsonResult({
          readOnly: true,
          cluster: config.cluster,
          rpc: redactRpcUrl(config.zinkRpcUrl),
          disclaimer: DISCLAIMER,
          dataMode: "live",
          asOf: new Date().toISOString(),
          limit: cap,
          total: page.total,
          truncated: page.total > page.systems.length,
          activity: summarizeGalaxyActivity(page.systems),
          systems: page.systems,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_categories",
    {
      title: "List categories",
      description:
        "The v0 ecosystem category ids. Approved members are unknown until a public roster exists. Read-only.",
      inputSchema: z.object({}),
      annotations: { ...readOnlyAnnotations, openWorldHint: false },
    },
    async () => {
      return jsonResult({
        readOnly: true,
        disclaimer: DISCLAIMER,
        dataMode: "live",
        asOf: new Date().toISOString(),
        categories: listCategories(),
        note: "Category ids are the ones this node publishes. No member list was invented.",
      });
    },
  );

  server.registerTool(
    "search_hub",
    {
      title: "Search the hub",
      description:
        "Search signed hub listings and guild listings by name, description, and tags, plus the display name of a player who opted in to a public story. A player who has not opted in is left out. The query is text, not an address. Nothing is uploaded. Read-only.",
      inputSchema: z.object({
        query: z.string().describe("Text to match. At most 80 characters."),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ query }) => {
      try {
        return jsonResult({
          readOnly: true,
          disclaimer: DISCLAIMER,
          ...(await deps.searchDirectory({ query }, (wallet) => playerDisplayName(deps, wallet))),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  registerDaoTools(server, deps);

  return server;
}
