import path from "node:path";
import { pathToFileURL } from "node:url";

import { refreshTreasury } from "./backfill.js";
import { loadConfig } from "../config.js";
import { solanaRpcUrls } from "./rpc.js";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

/**
 * Idempotent cache refresh. Without --incremental, each run continues the older
 * signature walk. With --incremental, a run applies signatures newer than the
 * cached cursor oldest-first inside the page cap, then continues the older walk
 * from the oldest parsed signature. Signatures past the page cap are kept and
 * the cursor advances as each chunk is applied. Pass --max-atlas-pages=all for
 * one uninterrupted scan.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const rawPages = argument("max-atlas-pages");
  const maxAtlasPages = rawPages === undefined ? 400 : rawPages === "all" ? Number.POSITIVE_INFINITY : Number(rawPages);
  if (!Number.isFinite(maxAtlasPages) && rawPages !== "all") {
    throw new Error("--max-atlas-pages must be a non-negative number or all.");
  }
  if (rawPages !== "all" && (!Number.isInteger(maxAtlasPages) || maxAtlasPages < 0)) {
    throw new Error("--max-atlas-pages must be a non-negative integer or all.");
  }
  const rawSignaturePages = argument("max-signature-pages");
  const maxSignaturePages = rawSignaturePages === undefined ? undefined : Number(rawSignaturePages);
  if (maxSignaturePages !== undefined && (!Number.isInteger(maxSignaturePages) || maxSignaturePages < 1)) {
    throw new Error("--max-signature-pages must be a positive integer.");
  }
  const cachePath = argument("cache") ?? config.treasuryCachePath;
  const rpcUrls = solanaRpcUrls(config.solanaRpcUrl, config.solanaRpcFallbackUrls.join(","));
  await refreshTreasury({
    rpcUrl: rpcUrls[0] ?? config.solanaRpcUrl,
    rpcUrls,
    cachePath,
    maxAtlasPages,
    maxSignaturePages,
    incremental: process.argv.includes("--incremental"),
  });
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Refresh failed";
    console.error(message);
    process.exit(1);
  });
}
