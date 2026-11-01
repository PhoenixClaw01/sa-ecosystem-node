import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { hubStoreReadme, hubTreeProblem, runStoreInitCli } from "../src/hub/store-init-cli.js";

describe("hub store init", () => {
  it("refuses symlinks and submodules and says so in the README", () => {
    expect(hubStoreReadme()).toMatch(/symlink/);
    expect(hubStoreReadme()).toMatch(/submodule/);

    const clean = mkdtempSync(path.join(tmpdir(), "hub-init-clean-"));
    const created = runStoreInitCli(["--dir", clean]);
    expect(created.code, created.stderr).toBe(0);
    expect(readFileSync(path.join(clean, "README.md"), "utf8")).toMatch(/symlink/);
    expect(readFileSync(path.join(clean, "README.md"), "utf8")).toMatch(/submodule/);
    expect(hubTreeProblem(clean)).toBeNull();

    const linked = mkdtempSync(path.join(tmpdir(), "hub-init-link-"));
    symlinkSync(clean, path.join(linked, "outside"));
    const linkResult = runStoreInitCli(["--dir", linked]);
    expect(linkResult.code).toBe(1);
    expect(linkResult.stderr).toMatch(/symlink/);

    const submodule = mkdtempSync(path.join(tmpdir(), "hub-init-sub-"));
    writeFileSync(path.join(submodule, ".gitmodules"), "[submodule]\n");
    const modulesResult = runStoreInitCli(["--dir", submodule]);
    expect(modulesResult.code).toBe(1);
    expect(modulesResult.stderr).toMatch(/submodule/);

    const gitdir = mkdtempSync(path.join(tmpdir(), "hub-init-gitdir-"));
    const nested = path.join(gitdir, "vendor");
    mkdirSync(nested);
    writeFileSync(path.join(nested, ".git"), "gitdir: /tmp/other/.git\n");
    const gitdirResult = runStoreInitCli(["--dir", gitdir]);
    expect(gitdirResult.code).toBe(1);
    expect(gitdirResult.stderr).toMatch(/submodule/);
  });
});
