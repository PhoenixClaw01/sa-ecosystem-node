import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SERVER_VERSION } from "../src/version.js";
import { READ_ONLY_TOOLS } from "../src/tool-names.js";

const ROOT_LLMS = "llms.txt";
const DASHBOARD_LLMS = "dashboard/llms.txt";

describe("llms.txt", () => {
  const root = readFileSync(ROOT_LLMS, "utf8");
  const dashboard = readFileSync(DASHBOARD_LLMS, "utf8");
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string; scripts: Record<string, string> };

  it("is identical at the repo root and on the dashboard, and names the live node", () => {
    expect(dashboard).toBe(root);
    expect(root).toContain(`v${SERVER_VERSION}`);
    expect(root).toContain(pkg.version);
    expect(root).toContain("io.github.PhoenixClaw01/sa-ecosystem-node");
    expect(root).toContain("https://sa-ecosystem-node-dashboard.vercel.app/api/mcp");
    expect(root).toContain("https://sa-ecosystem-node-dashboard.vercel.app/llms.txt");
    expect(root).toContain("https://github.com/PhoenixClaw01/sa-ecosystem-node/issues?q=label%3Ah2h");
    expect(root).toContain("protocol/h2h/SPEC.md");
    expect(root).toContain("protocol/TRUST-ARCHITECTURE.md");
    expect(root).toContain("npm run verify");
    expect(root).toContain("24 read-only");
    expect(root).toContain("C1");
    expect(root).toContain("C4");
    expect(root).toContain("x-phoenix-agent");
    expect(root).toContain("self_traffic");
    expect(root).toContain("A21 stays open");
    expect(root).toContain("node.config.example.json");
    expect(root).toContain("A22 stays deferred");
    expect(root).not.toContain("second Phoenix key");
    expect(root).toContain("published as latest in the Official MCP Registry");
    expect(root).not.toContain("Publishing that version is a separate step");
    expect(root).not.toMatch(/Registry: io\.github\.PhoenixClaw01\/sa-ecosystem-node \(v/);
    expect(root).not.toMatch(/Founder/);
  });

  it("tells operators that stdout is the default and that off writes nothing", () => {
    const hosting = readFileSync("docs/hosting.md", "utf8");
    const envExample = readFileSync(".env.example", "utf8");
    for (const text of [hosting, envExample]) {
      expect(text).toContain("MCP_TELEMETRY_SINK=off");
      expect(text).toContain("stdout");
      expect(text.toLowerCase()).not.toContain("send nothing");
      expect(text).not.toContain("Off unless");
      expect(text).not.toContain("is off when MCP_TELEMETRY_URL is unset");
    }
  });

  it("does not mention private repos or embed credentials", () => {
    const lower = root.toLowerCase();
    expect(lower).not.toContain("rome-guild-ops");
    expect(lower).not.toContain("mikatachan");
    expect(root).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}/);
    expect(root).not.toMatch(/(?:sk-|ghp_|github_pat_)/);
  });

  it("is linked from the dashboard and served as a static text file", () => {
    const index = readFileSync("dashboard/index.html", "utf8");
    expect(index).toContain('href="/llms.txt"');
    const vercel = readFileSync("dashboard/vercel.json", "utf8");
    expect(vercel).toContain("/llms.txt");
    expect(vercel).toContain("text/plain; charset=utf-8");
  });
});

describe("zero-secret verify", () => {
  it("exposes npm run verify as lint, typecheck, tests, build, and bundle check, with no keys", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    const verify = pkg.scripts.verify ?? "";
    expect(verify).toContain("npm run lint");
    expect(verify).toContain("npm run typecheck");
    expect(verify).toContain("npm test");
    expect(verify).toContain("npm run build");
    expect(verify).toContain("build:dashboard-mcp");
    expect(verify).toContain("scripts/check-dashboard-mcp.mjs");
    expect(verify.toLowerCase()).not.toContain("api_key");
    expect(verify.toLowerCase()).not.toContain("token");

    const contributing = readFileSync("CONTRIBUTING.md", "utf8");
    const readme = readFileSync("README.md", "utf8");
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(contributing).toContain("npm run verify");
    expect(readme).toContain("npm run verify");
    expect(ci).toContain("npm run verify");
    expect(READ_ONLY_TOOLS).toHaveLength(24);
  });
});
