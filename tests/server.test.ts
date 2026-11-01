import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createNodeHandler, type NodeHandler } from "../src/handler.js";
import { auditProfileKeys } from "../src/profile/audit.js";
import { READ_ONLY_TOOLS, type NodeDeps } from "../src/server.js";
import { stubDaoReaders, stubPlayerLegacy } from "./dao-stubs.js";

const config = loadConfig({});

const deps: NodeDeps = {
  ...stubDaoReaders(),
  ...stubPlayerLegacy(),
  async listStarSystems(limit) {
    return {
      total: 2,
      systems: [
        {
          address: "Sys111",
          name: "One",
          systemId: 1,
          coordinates: { x: 0, y: 0 },
          regionId: null,
          starbase: null,
          connectionCount: 0,
          celestialBodyCount: 1,
        },
        {
          address: "Sys222",
          name: "Two",
          systemId: 2,
          coordinates: { x: 1, y: 1 },
          regionId: 4,
          starbase: { owner: "oni", level: "level-0" },
          connectionCount: 1,
          celestialBodyCount: 0,
        },
      ].slice(0, limit),
    };
  },
  async getFleet(query) {
    if (!query.fleetAddress && !query.profileAddress) {
      throw new Error("missing address");
    }
    return [
      {
        address: query.fleetAddress ?? "FleetFromProfile",
        name: "Ravager",
        ownerProfile: query.profileAddress ?? "Profile111",
        stateKind: "idle",
        state: { kind: "idle" },
        ships: [],
      },
    ];
  },
  async auditProfile(profileAddress) {
    return auditProfileKeys({
      profileAddress,
      keyThreshold: 1,
      authKeyCount: 1,
      keys: [
        {
          address: "Key111",
          scope: profileAddress,
          expiresAtRaw: -1n,
          permissionsRaw: 1n,
          permissions: ["authenticate"],
        },
      ],
    });
  },
};

let open: { client: Client; handler: NodeHandler } | undefined;

async function connect(): Promise<Client> {
  const handler = createNodeHandler(deps, config);
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp"), {
    fetch: (input, init) => handler.fetch(new Request(input, init)),
  });
  const client = new Client(
    { name: "sa-ecosystem-node-test", version: "0.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  await client.connect(transport);
  open = { client, handler };
  return client;
}

afterEach(async () => {
  if (!open) return;
  await open.client.close();
  await open.handler.close();
  open = undefined;
});

describe("mcp server", () => {
  it("lists only the read-only tools", async () => {
    const client = await connect();
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...READ_ONLY_TOOLS].sort());
    expect(READ_ONLY_TOOLS).toHaveLength(22);
    expect(names).not.toContain("submit_hub_update");
  });

  it("returns live proposal data with a source and an as-of time", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "list_proposals", arguments: {} });
    expect(result.isError).toBeFalsy();
    const body = result.structuredContent as { dataMode: string; asOf: string; sources: { url: string }[]; readOnly: boolean };
    expect(body.readOnly).toBe(true);
    expect(body.dataMode).toBe("live");
    expect(body.asOf).toContain("2026-10-24");
    expect(body.sources[0]?.url).toContain("galaxy.staratlas.com");
  });

  it("returns a live DAO overview from the injected readers", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "dao_overview", arguments: {} });
    expect(result.isError).toBeFalsy();
    const body = result.structuredContent as {
      sections: { name: string; ok: boolean; data?: { wallets?: { address: string }[] } }[];
    };
    expect(body.sections.map((section) => section.name)).toEqual(["treasury_balances", "proposals", "data_health"]);
    expect(body.sections.every((section) => section.ok)).toBe(true);
    expect(JSON.stringify(body)).toContain("CuwnarNh7FEqZMmffFjRyWj54RecyS7zwFg1CxfzNudi");
    expect(JSON.stringify(body)).not.toContain("FIXTURE:dao-treasury");
  });

  it("summarizes starbases in galaxy_overview and lists categories without members", async () => {
    const client = await connect();
    const overview = await client.callTool({ name: "galaxy_overview", arguments: { limit: 2 } });
    const body = overview.structuredContent as { activity: { starbaseCount: number; systemCount: number }; total: number };
    expect(body.total).toBe(2);
    expect(body.activity.systemCount).toBe(2);
    expect(body.activity.starbaseCount).toBe(1);
    const categories = await client.callTool({ name: "list_categories", arguments: {} });
    const listed = categories.structuredContent as { categories: { id: string; members: string }[] };
    expect(listed.categories.map((category) => category.id)).toContain("creators");
    expect(listed.categories.every((category) => category.members === "unknown")).toBe(true);
  });

  it("serves capped star systems and a profile key audit from injected readers", async () => {
    const client = await connect();
    const systems = await client.callTool({ name: "list_star_systems", arguments: { limit: 1 } });
    const systemsBody = systems.structuredContent as { total: number; truncated: boolean; systems: { name: string }[] };
    expect(systemsBody.total).toBe(2);
    expect(systemsBody.truncated).toBe(true);
    expect(systemsBody.systems.map((system) => system.name)).toEqual(["One"]);

    const audit = await client.callTool({
      name: "profile_key_audit",
      arguments: { profileAddress: "Profile111" },
    });
    const auditBody = audit.structuredContent as { keys: { flags: string[]; permissions: string[] }[] };
    expect(auditBody.keys[0]?.permissions).toEqual(["authenticate"]);
    expect(auditBody.keys[0]?.flags).toContain("no_expiry");
  });

  it("rejects get_fleet when no address is given", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "get_fleet", arguments: {} });
    expect(result.isError).toBe(true);
  });
});
