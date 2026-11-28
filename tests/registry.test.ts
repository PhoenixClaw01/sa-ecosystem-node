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
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  version: string;
  description: string;
  license: string;
};

describe("MCP registry server.json", () => {
  it("matches the 2025-12-11 schema and the published read-only endpoint", () => {
    expect(server.$schema).toBe("https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
    expect(server.name).toBe("io.github.PhoenixClaw01/sa-ecosystem-node");
    expect(server.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(server.name.length).toBeGreaterThanOrEqual(3);
    expect(server.name.length).toBeLessThanOrEqual(200);
    expect(server.version).toBe(pkg.version);
    expect(server.version).toBe(SERVER_VERSION);
    expect(server.version).toBe("1.0.3");
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

describe("multi-ecosystem MCP manifests", () => {
  const gemini = JSON.parse(readFileSync("gemini-extension.json", "utf8")) as {
    name: string;
    version: string;
    description: string;
    mcpServers: Record<string, { type?: string; url?: string; httpUrl?: string; command?: string }>;
    contextFileName?: string;
  };
  const grokMcp = JSON.parse(readFileSync(".mcp.json", "utf8")) as {
    mcpServers: Record<string, { type: string; url: string }>;
  };
  const plugin = JSON.parse(readFileSync(".grok-plugin/plugin.json", "utf8")) as {
    name: string;
    version: string;
    description: string;
    homepage: string;
    repository: string;
    license: string;
    keywords: string[];
    domains: string[];
  };

  it("points Grok, Gemini CLI, and plugin metadata at the published read-only endpoint", () => {
    expect(gemini.name).toBe("sa-ecosystem-node");
    expect(gemini.version).toBe(SERVER_VERSION);
    expect(gemini.description).toBe(server.description);
    expect(gemini.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(gemini.mcpServers["sa-ecosystem-node"]).toEqual({ type: "http", url: PUBLIC_MCP_URL });
    expect(Object.keys(gemini.mcpServers["sa-ecosystem-node"]).sort()).toEqual(["type", "url"]);
    expect(gemini.contextFileName).toBe("GEMINI.md");
    const geminiContext = readFileSync("GEMINI.md", "utf8");
    expect(geminiContext).toContain(PUBLIC_MCP_URL);
    expect(geminiContext.toLowerCase()).toContain("read-only");
    expect(geminiContext).toContain("not an ATMTA product");

    expect(grokMcp.mcpServers["sa-ecosystem-node"]).toEqual({ type: "http", url: PUBLIC_MCP_URL });
    expect(Object.keys(grokMcp.mcpServers["sa-ecosystem-node"]).sort()).toEqual(["type", "url"]);

    expect(plugin.name).toBe("sa-ecosystem-node");
    expect(plugin.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(plugin.name.length).toBeLessThanOrEqual(64);
    expect(plugin.version).toBe(SERVER_VERSION);
    expect(plugin.license).toBe(pkg.license);
    expect(plugin.license).toBe("Apache-2.0");
    expect(plugin.homepage).toBe(server.websiteUrl);
    expect(plugin.repository).toBe(server.repository.url);
    expect(plugin.keywords).toEqual([
      "sa-ecosystem-node",
      "star atlas ecosystem node",
      "sa-ecosystem-node mcp",
    ]);
    expect(plugin.domains).toEqual(["sa-ecosystem-node-dashboard.vercel.app"]);
    expect(plugin.description.toLowerCase()).toContain("read-only");
    expect(plugin.description).toContain("sa-ecosystem-node-dashboard.vercel.app");

    const readme = readFileSync("README.md", "utf8");
    const useIn = readme.slice(
      readme.indexOf("## Use in Grok / Gemini CLI / Claude / ChatGPT"),
      readme.indexOf("## Deploy"),
    );
    expect(useIn.startsWith("## Use in Grok")).toBe(true);
    expect(useIn).toContain(PUBLIC_MCP_URL);
    expect(useIn).toContain("default branch");
    expect(useIn).toContain("gemini extensions install https://github.com/PhoenixClaw01/sa-ecosystem-node");
    expect(useIn).toContain("that listing is not part of this change");
    expect(useIn).not.toMatch(/staratlas\.com|mika|mikatachan/i);

    const packed = JSON.stringify({ gemini, grokMcp, plugin, geminiContext });
    expect(packed).not.toMatch(/supabase|service_role|eyJ|staratlas\.com|mika|mikatachan/i);
    expect(packed).not.toMatch(/"command"|"args"|"headers"|"env"/);
  });
});
