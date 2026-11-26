import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildRecordedMcp } from "./recorded-mcp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const recorded = await buildRecordedMcp();
const out = path.join(root, "dashboard/data/mcp-recorded.json");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(recorded, null, 2)}\n`);
process.stdout.write(`Wrote ${path.relative(root, out)}\n`);
