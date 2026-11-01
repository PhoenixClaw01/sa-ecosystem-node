import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const signerSource = readFileSync("hub/signers.json");
const signerCopyPath = "dashboard/hub/signers.json";
if (lstatSync(signerCopyPath).isSymbolicLink() || !signerSource.equals(readFileSync(signerCopyPath))) {
  console.error("dashboard/hub/signers.json is not a byte copy of hub/signers.json.");
  process.exit(1);
}

const bundlePath = path.resolve("dashboard/api/mcp.js");
const bundleText = readFileSync(bundlePath, "utf8");
const signerSha = createHash("sha256").update(signerSource).digest("hex");
if (bundleText.split(signerSha).length - 1 < 2) {
  console.error("Bundle signer hash is not inlined by the esbuild define.");
  process.exit(1);
}
const handler = (await import(pathToFileURL(bundlePath).href)).default;
if (globalThis.__SA_SIGNERS_SHA256 !== signerSha) {
  console.error("Bundle signer hash does not match hub/signers.json.");
  process.exit(1);
}

const inlined = globalThis.__SA_DASHBOARD_SCRIPTS;
if (!inlined || typeof inlined["ata.js"] !== "string" || !inlined["ata.js"].includes("SA_ATA")) {
  console.error("Bundle did not inline dashboard/ata.js.");
  process.exit(1);
}
if (typeof inlined["squads.js"] !== "string" || !inlined["squads.js"].includes("SA_SQUADS")) {
  console.error("Bundle did not inline dashboard/squads.js.");
  process.exit(1);
}
const here = path.dirname(fileURLToPath(pathToFileURL(bundlePath).href));

for (const file of ["ata.js", "squads.js"]) {
  const besideFunction = path.resolve(here, "..", file);
  if (!existsSync(besideFunction)) {
    console.error(`dashboard/${file} is not beside the function directory.`);
    process.exit(1);
  }
}

const headers = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

async function post(body) {
  const response = await handler.fetch(
    new globalThis.Request("https://sa-ecosystem-node-dashboard.vercel.app/api/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  if (!response.ok) {
    console.error(body.method, response.status, text.slice(0, 500));
    process.exit(1);
  }
  if (!text.trim()) return null;
  const dataLine = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .find(Boolean);
  return JSON.parse(dataLine ?? text);
}

const initialized = await post({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "bundle-check", version: "0" },
  },
});
const versionFile = readFileSync("src/version.ts", "utf8");
const serverVersion = versionFile.match(/export const SERVER_VERSION = "([^"]+)"/)?.[1];
if (!serverVersion) {
  console.error("SERVER_VERSION is missing from src/version.ts.");
  process.exit(1);
}
if (initialized.result?.serverInfo?.name !== "sa-ecosystem-node") {
  console.error("initialize did not return the server name.");
  process.exit(1);
}
if (initialized.result?.serverInfo?.version !== serverVersion) {
  console.error(`initialize serverInfo.version is ${initialized.result?.serverInfo?.version}, expected ${serverVersion}.`);
  process.exit(1);
}

await post({ jsonrpc: "2.0", method: "notifications/initialized" });

const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const names = new Set((listed.result?.tools ?? []).map((tool) => tool.name));
const required = [
  "dao_overview",
  "treasury_balances",
  "pip_tracker",
  "list_categories",
  "galaxy_overview",
  "hub_updates",
  "list_listings",
  "search_hub",
  "player_legacy",
  "player_story",
  "data_health",
];
const missing = required.filter((name) => !names.has(name));
if (missing.length > 0) {
  console.error(`tools/list is missing ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`bundle ok: ${names.size} tools`);
