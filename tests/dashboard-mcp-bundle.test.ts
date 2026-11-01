import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("dashboard MCP bundle", () => {
  it("answers initialize and tools/list from the committed file", () => {
    const result = spawnSync(process.execPath, ["scripts/check-dashboard-mcp.mjs"], { encoding: "utf8" });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});