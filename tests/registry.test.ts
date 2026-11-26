import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PUBLIC_MCP_URL } from "../src/public-mcp.js";
import { READ_ONLY_TOOLS } from "../src/tool-names.js";
import { SERVER_VERSION } from "../src/version.js";

const server = JSON.parse(readFileSync("server.json", "utf8")) as {
  $schema: string;
  name: string;
  title: string;
  description: string;
  version: string;
  websiteUrl: string;
  repository: { url: string; source: string };
  remotes: { type: string; url: string }[];
  packages?: unknown;
};
const discovery = JSON.parse(readFileSync("dashboard/.well-known/mcp.json", "utf8")) as {
  name: string;
  transport: string;
  url: string;
  readOnly: boolean;
  toolCount: number;
  note: string;
};
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string; description: string };

describe("MCP registry server.json", () => {
  it("matches the 2025-12-11 schema and the published read-only endpoint", () => {
    expect(server.$schema).toBe("https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
    expect(server.name).toBe("io.github.PhoenixClaw01/sa-ecosystem-node");
    expect(server.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(server.name.length).toBeGreaterThanOrEqual(3);
    expect(server.name.length).toBeLessThanOrEqual(200);
    expect(server.version).toBe(pkg.version);
    expect(server.version).toBe(SERVER_VERSION);
    expect(server.version).toBe("1.0.2");
    expect(server.version).not.toMatch(/[\^~*]|(?:>=|<=)/);
    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.description).toContain(String(READ_ONLY_TOOLS.length));
    expect(server.description.toLowerCase()).toContain("read-only");
    expect(server.description).toContain("Star Atlas");
    expect(server.description).toContain("DAO");
    expect(server.description.toLowerCase()).toContain("community");
    expect(server.description.toLowerCase()).toContain("no sign-in");
    expect(server.description).toContain("API key");
    expect(server.title.length).toBeGreaterThan(0);
    expect(server.title.length).toBeLessThanOrEqual(100);
    expect(server.repository).toEqual({
      url: "https://github.com/PhoenixClaw01/sa-ecosystem-node",
      source: "github",
    });
    expect(server.websiteUrl).toBe("https://sa-ecosystem-node-dashboard.vercel.app");
    expect(server.remotes).toEqual([{ type: "streamable-http", url: PUBLIC_MCP_URL }]);
    expect(server.packages).toBeUndefined();
    expect(JSON.stringify(server)).not.toMatch(/supabase|service_role|eyJ/i);
  });
});

describe("public discovery", () => {
  it("points at the same endpoint and the live tool count", () => {
    expect(PUBLIC_MCP_URL).toBe("https://sa-ecosystem-node-dashboard.vercel.app/api/mcp");
    expect(discovery.url).toBe(PUBLIC_MCP_URL);
    expect(discovery.transport).toBe("streamable-http");
    expect(discovery.readOnly).toBe(true);
    expect(discovery.toolCount).toBe(READ_ONLY_TOOLS.length);
    expect(READ_ONLY_TOOLS).toHaveLength(24);
    expect(discovery.note).toContain("24");
    expect(discovery.note.toLowerCase()).toContain("no api key");

    const readme = readFileSync("README.md", "utf8");
    const spec = readFileSync("docs/spec.md", "utf8");
    const tools = readme.slice(readme.indexOf("## Tools"), readme.indexOf("## Collaborating"));
    for (const name of READ_ONLY_TOOLS) {
      expect(tools).toContain(`\`${name}\``);
      expect(spec).toContain(`\`${name}\``);
    }
    expect(readme).toContain("24 read-only tools");
    expect(spec).not.toMatch(/returned 22 tools/);
    expect(readme).not.toMatch(/\b22 read-only tools\b/);
    expect(server.description).toContain("24");
  });
});
