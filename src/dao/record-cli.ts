import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildRecordedMcp, RECORDED_AT } from "./recorded-mcp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(root);

const proposals = JSON.parse(readFileSync("tests/fixtures/dao/proposals.json", "utf8")) as unknown;
const votes = JSON.parse(readFileSync("tests/fixtures/dao/votes.json", "utf8")) as unknown;
const revenue = JSON.parse(readFileSync("tests/fixtures/dao/revenue.json", "utf8")) as unknown;
const trackerCsv = readFileSync("dashboard/tracker.csv", "utf8");

const recorded = await buildRecordedMcp({
  proposals,
  votes,
  revenue,
  trackerCsv,
  now: new Date(RECORDED_AT),
});

const out = path.join(root, "dashboard/data/mcp-recorded.json");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(recorded, null, 2)}\n`);
process.stdout.write(`Wrote ${path.relative(root, out)}\n`);
