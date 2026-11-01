import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveHubSignersPath } from "../src/config.js";
import { SIGNERS_SHA256_KEY, loadSignerAllowlist } from "../src/hub/allowlist.js";
import { embeddedSignersSha } from "../src/hub/signers-pin-bundle.js";

const canonical = path.resolve("hub/signers.json");
const copy = path.resolve("dashboard/hub/signers.json");

describe("Vercel signer allowlist bundle", () => {
  it("ships one byte copy of hub/signers.json inside the dashboard project", () => {
    const source = readFileSync(canonical);
    const bundled = readFileSync(copy);
    expect(Buffer.compare(source, bundled)).toBe(0);
    expect(lstatSync(canonical).isSymbolicLink()).toBe(false);
    expect(lstatSync(copy).isSymbolicLink()).toBe(false);
    expect(lstatSync(canonical).isFile()).toBe(true);
    expect(lstatSync(copy).isFile()).toBe(true);
    expect([...loadSignerAllowlist(canonical)]).toEqual([...loadSignerAllowlist(copy)]);

    const dashboard = JSON.parse(readFileSync("dashboard/vercel.json", "utf8")) as {
      functions: { "api/mcp.js": { includeFiles: string } };
    };
    expect(dashboard.functions["api/mcp.js"].includeFiles).toContain("hub/signers.json");

    const root = JSON.parse(readFileSync("vercel.json", "utf8")) as {
      functions: { "api/mcp.ts": { includeFiles: string } };
    };
    expect(root.functions["api/mcp.ts"].includeFiles).toBe("hub/signers.json");
  });

  it("reads the copy from a dashboard-shaped directory and refuses a drifted or linked copy", () => {
    const shipped = readFileSync(canonical);
    const project = mkdtempSync(path.join(tmpdir(), "vercel-signers-"));
    mkdirSync(path.join(project, "api"));
    mkdirSync(path.join(project, "hub"));
    writeFileSync(path.join(project, "hub", "signers.json"), shipped);
    expect(resolveHubSignersPath(undefined, path.join(project, "api"), project)).toBe(path.join(project, "hub", "signers.json"));

    const elsewhere = mkdtempSync(path.join(tmpdir(), "vercel-cwd-"));
    expect(resolveHubSignersPath(undefined, path.join(project, "api"), elsewhere)).toBe(path.join(project, "hub", "signers.json"));

    const explicit = path.join(project, "custom.json");
    writeFileSync(explicit, shipped);
    expect(resolveHubSignersPath(explicit, path.join(project, "api"), project)).toBe(explicit);

    const drifted = mkdtempSync(path.join(tmpdir(), "vercel-drift-"));
    mkdirSync(path.join(drifted, "hub"));
    mkdirSync(path.join(drifted, "dashboard", "hub"), { recursive: true });
    writeFileSync(path.join(drifted, "hub", "signers.json"), shipped);
    writeFileSync(path.join(drifted, "dashboard", "hub", "signers.json"), `${shipped.toString("utf8")}\n`);
    expect(() => resolveHubSignersPath(undefined, drifted, drifted)).toThrow(/byte for byte/);

    const linked = mkdtempSync(path.join(tmpdir(), "vercel-link-"));
    mkdirSync(path.join(linked, "hub"));
    mkdirSync(path.join(linked, "dashboard", "hub"), { recursive: true });
    writeFileSync(path.join(linked, "hub", "signers.json"), shipped);
    symlinkSync(path.join(linked, "hub", "signers.json"), path.join(linked, "dashboard", "hub", "signers.json"));
    expect(() => resolveHubSignersPath(undefined, linked, linked)).toThrow(/regular-file copy/);

    const dangling = mkdtempSync(path.join(tmpdir(), "vercel-dangling-"));
    mkdirSync(path.join(dangling, "hub"), { recursive: true });
    mkdirSync(path.join(dangling, "dashboard", "hub"), { recursive: true });
    writeFileSync(path.join(dangling, "hub", "signers.json"), shipped);
    symlinkSync(path.join(dangling, "missing-signers.json"), path.join(dangling, "dashboard", "hub", "signers.json"));
    expect(() => resolveHubSignersPath(undefined, dangling, dangling)).toThrow(/regular-file copy/);
  });

  it("hashes the loaded allowlist against the sha256 embedded in the dashboard bundle", () => {
    const bytes = readFileSync(canonical);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const record = globalThis as Record<string, unknown>;
    const previous = record[SIGNERS_SHA256_KEY];
    try {
      record[SIGNERS_SHA256_KEY] = sha;
      expect(loadSignerAllowlist(canonical).size).toBe(3);
      record[SIGNERS_SHA256_KEY] = "0".repeat(64);
      expect(() => loadSignerAllowlist(canonical)).toThrow(/does not match the pinned copy/);
      record[SIGNERS_SHA256_KEY] = "not-a-hash";
      expect(() => loadSignerAllowlist(canonical)).toThrow(/could not be read/);
    } finally {
      if (previous === undefined) delete record[SIGNERS_SHA256_KEY];
      else record[SIGNERS_SHA256_KEY] = previous;
    }
    const bundle = readFileSync("dashboard/api/mcp.js", "utf8");
    expect(bundle).toContain(`globalThis.${SIGNERS_SHA256_KEY}=${JSON.stringify(sha)}`);
    expect(bundle.split(sha).length - 1).toBeGreaterThanOrEqual(2);
    expect(bundle).not.toContain("__SA_SIGNERS_SHA256_DEFINE__");
  });

  it("refuses a symlink or non-file signer path and a bundle pin that was not defined", () => {
    const shipped = readFileSync(canonical);
    const scratch = mkdtempSync(path.join(tmpdir(), "signer-link-"));
    const real = path.join(scratch, "real.json");
    writeFileSync(real, shipped);
    const link = path.join(scratch, "link.json");
    symlinkSync(real, link);
    expect(() => loadSignerAllowlist(link)).toThrow(/could not be read/);

    const elsewhere = mkdtempSync(path.join(tmpdir(), "signer-cwd-"));
    const moduleRoot = mkdtempSync(path.join(tmpdir(), "signer-mod-"));
    mkdirSync(path.join(moduleRoot, "api"));
    mkdirSync(path.join(moduleRoot, "hub"));
    symlinkSync(real, path.join(moduleRoot, "hub", "signers.json"));
    expect(() => resolveHubSignersPath(undefined, path.join(moduleRoot, "api"), elsewhere)).toThrow(/regular file/);

    const other = mkdtempSync(path.join(tmpdir(), "signer-dir-"));
    mkdirSync(path.join(other, "api"));
    mkdirSync(path.join(other, "hub", "signers.json"), { recursive: true });
    expect(() => resolveHubSignersPath(undefined, path.join(other, "api"), elsewhere)).toThrow(/regular file/);

    expect(() => embeddedSignersSha()).toThrow(/could not be read/);
  });

  it("uses the repository allowlist when the process is started from the repo root", () => {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    expect(resolveHubSignersPath(undefined, path.resolve(moduleDir, "../src"), process.cwd())).toBe(canonical);
  });
});
