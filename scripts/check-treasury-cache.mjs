import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";

const file = "dashboard/data/treasury-cache.json";
const output = process.env.GITHUB_OUTPUT;

function emit(key, value) {
  const line = `${key}=${String(value).replace(/\r?\n/g, " ")}`;
  console.log(line);
  if (output) appendFileSync(output, `${line}\n`);
}

if (!existsSync(file)) {
  emit("present", "false");
  emit("completeness", "missing");
  emit("generatedAt", "");
  console.error("No treasury cache file. Nothing was invented.");
  process.exit(0);
}

const size = statSync(file).size;
if (size > 8_000_000) {
  throw new Error(`cache is ${size} bytes, over the 8MB commit cap`);
}
const cache = JSON.parse(readFileSync(file, "utf8"));
if (cache.schemaVersion !== 1 || typeof cache.generatedAt !== "string") {
  throw new Error("cache is not schema version 1");
}
const completeness = cache.completeness === "partial" ? "partial" : "complete";
emit("present", "true");
emit("completeness", completeness);
emit("generatedAt", cache.generatedAt);
console.log("bytes", size);
if (completeness === "partial") {
  console.log("partialReason", cache.partialReason || "(none)");
}
