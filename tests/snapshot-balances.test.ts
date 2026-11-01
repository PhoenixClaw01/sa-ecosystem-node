import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { ATLAS_MINT, DAO_TREASURY_ADDRESS, USDC_MINT } from "../src/dao/wallets.js";

const execFileAsync = promisify(execFile);

describe("dashboard balance snapshot imports", () => {
  it("loads associatedTokenAddress and b64 after the dashboard package became ESM", async () => {
    const script = `
      import { loadDashboardCrypto } from "./dashboard/scripts/snapshot-balances.mjs";
      const { ATA, SQUADS } = loadDashboardCrypto();
      if (typeof ATA.associatedTokenAddress !== "function") throw new Error("ATA.associatedTokenAddress is not a function");
      if (typeof SQUADS.b64 !== "function") throw new Error("SQUADS.b64 is not a function");
      const atlas = await ATA.associatedTokenAddress(${JSON.stringify(DAO_TREASURY_ADDRESS)}, ${JSON.stringify(ATLAS_MINT)});
      const usdc = await ATA.associatedTokenAddress(${JSON.stringify(DAO_TREASURY_ADDRESS)}, ${JSON.stringify(USDC_MINT)});
      const byte = SQUADS.b64("YQ==")[0];
      process.stdout.write(JSON.stringify({ atlas, usdc, byte }));
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.resolve("."),
    });
    expect(JSON.parse(stdout)).toEqual({
      atlas: "5XJei3jBZi8WuqDGUQ5KCe8t72vMRMTWLr6ok3hhXE2R",
      usdc: "GNhWRbT4jLRrcmpUyagsHrfxMiyE7TSE8VK8SYGS3e6H",
      byte: 97,
    });
  });
});
