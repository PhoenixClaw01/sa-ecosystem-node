import path from "node:path";
import { pathToFileURL } from "node:url";

import { getJson, parseProposals, parseRevenue, proposalsUrl, revenueUrl } from "./galaxy.js";
import { createFallbackRpc, solanaRpcUrls } from "./rpc.js";
import { DAO_TREASURY_ADDRESS, ECOSYSTEM_FUND_ADDRESS, PIP23_ID } from "./wallets.js";
import { loadConfig } from "../config.js";

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

/**
 * Optional live check. Not part of `npm test`. GET galaxy JSON and one balance read.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const proposals = parseProposals(await getJson(fetch, proposalsUrl(config.galaxyBaseUrl)));
  const pip23 = proposals.find((proposal) => proposal.id === PIP23_ID);
  if (!pip23 || pip23.pipNumber !== 23) throw new Error("Galaxy proposals did not include PIP-23.");
  const revenue = parseRevenue(await getJson(fetch, revenueUrl(config.galaxyBaseUrl)));
  if (!revenue.some((row) => row.segmentation === "Game Activity")) {
    throw new Error("Galaxy treasury revenue did not include Game Activity.");
  }
  const rpc = createFallbackRpc(solanaRpcUrls(config.solanaRpcUrl, config.solanaRpcFallbackUrls.join(",")));
  const treasury = await rpc.call<{ value?: number }>("getBalance", [DAO_TREASURY_ADDRESS, { commitment: "confirmed" }]);
  const fund = await rpc.call<{ value?: number }>("getBalance", [ECOSYSTEM_FUND_ADDRESS, { commitment: "confirmed" }]);
  if (typeof treasury.value !== "number" || typeof fund.value !== "number") {
    throw new Error("Balance read did not return lamports.");
  }
  console.log(
    JSON.stringify({
      ok: true,
      proposals: proposals.length,
      pip23: pip23.status,
      revenueRows: revenue.length,
      treasuryLamports: treasury.value,
      fundLamports: fund.value,
    }),
  );
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Smoke failed";
    console.error(message);
    process.exit(1);
  });
}
