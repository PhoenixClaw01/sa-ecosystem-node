import { existsSync, readFileSync } from "node:fs";
import { Module } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { SafeClientError } from "../errors.js";

const INLINE_KEY = "__SA_DASHBOARD_SCRIPTS";

type ScriptFile = "ata.js" | "squads.js";

interface ScriptTable {
  "ata.js": string;
  "squads.js": string;
}

type CommonJsWrapper = (
  this: unknown,
  exports: unknown,
  require: (specifier: string) => unknown,
  module: { exports: unknown },
  filename: string,
  dirname: string,
) => void;

const evaluated = new Map<string, unknown>();

/**
 * `ata.js` and `squads.js` are browser scripts that also assign `module.exports`.
 * The dashboard package is `"type": "module"`, so Node's `require()` rejects them.
 * Evaluate the source with the CommonJS wrapper instead.
 * The MCP bundle inlines both files on `globalThis.__SA_DASHBOARD_SCRIPTS`.
 * A process without that table reads the same files from disk.
 */
export function requireDashboardScript(file: ScriptFile): unknown {
  const table = inlineScripts();
  if (table) return loadInline(file, table);
  return loadFromDisk(file);
}

function inlineScripts(): ScriptTable | null {
  const value = (globalThis as Record<string, unknown>)[INLINE_KEY];
  if (!value || typeof value !== "object") return null;
  const table = value as Record<string, unknown>;
  if (typeof table["ata.js"] !== "string" || typeof table["squads.js"] !== "string") return null;
  return { "ata.js": table["ata.js"], "squads.js": table["squads.js"] };
}

function loadInline(file: ScriptFile, table: ScriptTable): unknown {
  return evaluate(file, table[file], (specifier) => {
    if (specifier === "./ata.js") return loadInline("ata.js", table);
    throw new SafeClientError(`dashboard/${file} cannot load ${specifier}.`);
  });
}

function loadFromDisk(file: ScriptFile): unknown {
  const found = findOnDisk(file);
  return evaluate(found, readFileSync(found, "utf8"), (specifier) => {
    if (specifier === "./ata.js") return loadFromDisk("ata.js");
    throw new SafeClientError(`dashboard/${file} cannot load ${specifier}.`);
  });
}

function findOnDisk(file: ScriptFile): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../dashboard", file),
    path.resolve(here, "..", file),
    path.resolve(process.cwd(), file),
    path.resolve(process.cwd(), "dashboard", file),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new SafeClientError(`dashboard/${file} did not load.`);
  return found;
}

function evaluate(filename: string, source: string, localRequire: (specifier: string) => unknown): unknown {
  const key = `${filename}\0${source}`;
  const cached = evaluated.get(key);
  if (cached) return cached;
  const compiled = vm.runInThisContext(Module.wrap(source), { filename }) as CommonJsWrapper;
  const current = { exports: {} as unknown };
  compiled.call(current.exports, current.exports, localRequire, current, filename, path.dirname(filename));
  evaluated.set(key, current.exports);
  return current.exports;
}
