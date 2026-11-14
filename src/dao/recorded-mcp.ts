import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { loadConfig } from "../config.js";
import { createNodeHandler } from "../handler.js";
import { READ_ONLY_TOOLS, type NodeDeps } from "../server.js";

export const RECORDED_LABEL = "recorded MCP shapes";

const NOTE =
  "Tool names and input schemas only. No timestamps, balances, or cache documents. A change to committed treasury or balance data does not change this file.";

export interface RecordedTool {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations: unknown;
}

export interface RecordedMcp {
  label: typeof RECORDED_LABEL;
  network: false;
  note: typeof NOTE;
  tools: RecordedTool[];
}

function unused(): never {
  throw new Error("Schema recording does not call tools.");
}

function shapeDeps(): NodeDeps {
  return {
    listStarSystems: unused,
    getFleet: unused,
    auditProfile: unused,
    playerLegacy: unused,
    listProposals: unused,
    getProposalVotes: unused,
    daoRevenue: unused,
    daoTreasuryFlows: unused,
    daoPayments: unused,
    treasuryHistory: unused,
    ecofundLimit: unused,
    treasuryBalances: unused,
    pipTracker: unused,
    hubUpdates: unused,
    listListings: unused,
    searchDirectory: unused,
    storyContext: unused,
    claimStatus: unused,
    c4Markers: unused,
    communityTools: unused,
    dataHealth: unused,
  };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) out[key] = stable(item);
  }
  return out;
}

/** List the registered tools and keep only their schemas. Does not call a tool and does not read cache files. */
export async function buildRecordedMcp(): Promise<RecordedMcp> {
  const handler = createNodeHandler(shapeDeps(), loadConfig({}));
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp"), {
    fetch: (input, init) => handler.fetch(new Request(input, init)),
  });
  const client = new Client({ name: "sa-ecosystem-node-record", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    if (byName.size !== READ_ONLY_TOOLS.length) {
      throw new Error(`Expected ${READ_ONLY_TOOLS.length} tools, listed ${byName.size}.`);
    }
    const tools = READ_ONLY_TOOLS.map((name) => {
      const tool = byName.get(name);
      if (!tool) throw new Error(`Missing tool ${name}.`);
      return stable({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
        annotations: tool.annotations ?? {},
      }) as RecordedTool;
    });
    return { label: RECORDED_LABEL, network: false, note: NOTE, tools };
  } finally {
    await client.close();
    await handler.close();
  }
}
