import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_SOLANA_RPC_FALLBACK_URL,
  DEFAULT_SOLANA_RPC_URL,
  DEFAULT_ZINK_RPC_URL,
  loadConfig,
  redactRpcUrl,
  resolveTreasuryCachePath,
  SIGNER_SET_KINDS,
} from "../src/config.js";
import { publicErrorMessage } from "../src/errors.js";
import { HUB_UPDATE_KINDS } from "../src/hub/update.js";

describe("config", () => {
  it("uses public RPC defaults", () => {
    const config = loadConfig({});
    expect(config.zinkRpcUrl).toBe(`${DEFAULT_ZINK_RPC_URL}/`);
    expect(config.solanaRpcUrl).toBe(`${DEFAULT_SOLANA_RPC_URL}/`);
    expect(config.solanaRpcFallbackUrls).toEqual([`${DEFAULT_SOLANA_RPC_FALLBACK_URL}/`]);
    expect(config.cluster).toBe("zink-ptr");
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8787);
    expect(config.publicNode).toBe(false);
    expect(config.allowAnyHost).toBe(false);
    expect(config.trustProxy).toBe(false);
    expect(config.hubApprovalThreshold).toBe(1);
    expect(config.hubAllowAuthorApproval).toBe(false);
    expect(config.hubRevokedSigners).toEqual([]);
    expect(config.hubStoreManifest).toBe("hub-manifest.json");
    expect(config.hubStoreManifestFallback).toBe(true);
    expect(loadConfig({ HUB_STORE_MANIFEST: "hub-manifest.json" }).hubStoreManifestFallback).toBe(false);
    expect(loadConfig({ HUB_STORE_MANIFEST: "manifest.json" }).hubStoreManifest).toBe("manifest.json");
    expect(loadConfig({ HUB_STORE_MANIFEST: "manifest.json" }).hubStoreManifestFallback).toBe(false);
  });

  it("reads a custom Solana RPC and fallback list", () => {
    const config = loadConfig({
      SOLANA_RPC_URL: "https://rpc.example",
      SOLANA_RPC_FALLBACK_URLS: "https://fallback.example, https://other.example/",
    });
    expect(config.solanaRpcUrl).toBe("https://rpc.example/");
    expect(config.solanaRpcFallbackUrls).toEqual(["https://fallback.example/", "https://other.example/"]);
  });

  it("rejects a non-http RPC URL", () => {
    expect(() => loadConfig({ ZINK_RPC_URL: "file:///tmp/rpc" })).toThrow(/ZINK_RPC_URL/);
  });

  it("keeps an explicit missing cache path and finds a cache beside the function", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cache-layout-"));
    const moduleDir = path.join(root, "dashboard", "api");
    mkdirSync(path.join(root, "dashboard", "data"), { recursive: true });
    mkdirSync(moduleDir, { recursive: true });
    const cache = path.join(root, "dashboard", "data", "treasury-cache.json");
    writeFileSync(cache, "{}");
    const missing = path.join(root, "missing.json");
    expect(resolveTreasuryCachePath(missing, moduleDir, root)).toBe(path.resolve(missing));
    expect(resolveTreasuryCachePath(undefined, moduleDir, root)).toBe(cache);
    const preferred = path.join(root, "data", "treasury-cache.json");
    mkdirSync(path.dirname(preferred), { recursive: true });
    writeFileSync(preferred, "{}");
    expect(resolveTreasuryCachePath(undefined, moduleDir, root)).toBe(preferred);
    const empty = mkdtempSync(path.join(tmpdir(), "cache-empty-"));
    expect(resolveTreasuryCachePath(undefined, path.join(empty, "dashboard", "api"), empty)).toBe(
      path.resolve(empty, "data/treasury-cache.json"),
    );
  });

  it("a root-started node finds the committed treasury cache from the package root", () => {
    const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
    const committed = path.join(packageRoot, "dashboard", "data", "treasury-cache.json");
    expect(existsSync(committed)).toBe(true);
    expect(existsSync(path.join(packageRoot, "data", "treasury-cache.json"))).toBe(false);
    const elsewhere = mkdtempSync(path.join(tmpdir(), "node-cwd-"));
    mkdirSync(path.join(elsewhere, "dashboard", "data"), { recursive: true });
    writeFileSync(path.join(elsewhere, "dashboard", "data", "treasury-cache.json"), "{}");
    for (const moduleDir of [path.join(packageRoot, "src"), path.join(packageRoot, "dist")]) {
      expect(resolveTreasuryCachePath(undefined, moduleDir, packageRoot)).toBe(committed);
      expect(resolveTreasuryCachePath(undefined, moduleDir, elsewhere)).toBe(committed);
    }
    const custom = path.join(elsewhere, "custom-cache.json");
    expect(resolveTreasuryCachePath(custom, path.join(packageRoot, "dist"), elsewhere)).toBe(path.resolve(custom));
    const previous = process.cwd();
    try {
      process.chdir(elsewhere);
      expect(loadConfig({}).treasuryCachePath).toBe(committed);
    } finally {
      process.chdir(previous);
    }
  });

  it("loads node.config.example.json onto an existing treasury cache", () => {
    const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
    const example = path.join(packageRoot, "node.config.example.json");
    const committed = path.join(packageRoot, "dashboard", "data", "treasury-cache.json");
    const previous = process.cwd();
    try {
      process.chdir(packageRoot);
      const config = loadConfig({ NODE_CONFIG: example });
      expect(config.treasuryCachePath).toBe(committed);
      expect(existsSync(config.treasuryCachePath)).toBe(true);
      expect(config.hubApprovalThreshold).toBe(1);
      expect(config.hubAllowAuthorApproval).toBe(false);
      expect(config.hubRevokedSigners).toEqual([]);
      expect(config.hubTrustedVerifiers).toEqual([]);
      expect(config.hubStoreManifest).toBe("hub-manifest.json");
      expect(config.hubStoreManifestFallback).toBe(false);
    } finally {
      process.chdir(previous);
    }
  });

  it("keeps an explicit missing /tmp/x/data/treasury-cache.json path", () => {
    const explicit = "/tmp/x/data/treasury-cache.json";
    const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
    const moduleDir = path.join(packageRoot, "dist");
    expect(existsSync(path.join(packageRoot, "dashboard", "data", "treasury-cache.json"))).toBe(true);
    expect(existsSync(explicit)).toBe(false);
    expect(resolveTreasuryCachePath(explicit, moduleDir, packageRoot)).toBe(path.resolve(explicit));
    expect(loadConfig({ TREASURY_CACHE_PATH: explicit }).treasuryCachePath).toBe(path.resolve(explicit));
    const root = mkdtempSync(path.join(tmpdir(), "explicit-cache-"));
    const file = path.join(root, "node.config.json");
    writeFileSync(file, JSON.stringify({ v: 1, treasuryCachePath: explicit }));
    expect(loadConfig({ NODE_CONFIG: file }).treasuryCachePath).toBe(path.resolve(explicit));
  });

  it("reads node.config.json and lets env override it without keeping secrets in errors", () => {
    const root = mkdtempSync(path.join(tmpdir(), "node-config-"));
    const file = path.join(root, "node.config.json");
    writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        host: "127.0.0.1",
        port: 9,
        publicNode: true,
        allowAnyHost: true,
        trustProxy: true,
        rateLimitMax: 7,
        maxRequestBytes: 1024,
        hub: {
          approvalThreshold: 2,
          signersPath: "hub/signers.json",
          signerSets: [{ id: "council", path: "hub/signers.json", threshold: 2 }],
        },
      }),
    );
    const config = loadConfig({ NODE_CONFIG: file, PORT: "0", SOLANA_RPC_URL: "https://rpc.example/path?api-key=supersecret" });
    expect(config.port).toBe(0);
    expect(config.publicNode).toBe(true);
    expect(config.allowAnyHost).toBe(true);
    expect(config.trustProxy).toBe(true);
    expect(loadConfig({ NODE_CONFIG: file, ALLOW_ANY_HOST: "0" }).allowAnyHost).toBe(false);
    expect(config.rateLimitMax).toBe(7);
    expect(config.maxRequestBytes).toBe(1024);
    expect(config.hubApprovalThreshold).toBe(2);
    expect(config.hubAllowAuthorApproval).toBe(false);
    expect(config.hubRevokedSigners).toEqual([]);
    expect(config.hubSignerSets.map((set) => set.id)).toEqual(["council"]);
    expect(config.solanaRpcUrl).toBe("https://rpc.example/path?api-key=supersecret");
    expect(redactRpcUrl(config.solanaRpcUrl)).toBe("https://rpc.example/path");
    expect(() => loadConfig({ NODE_CONFIG: file, HUB_GIT_REPO: "https://user:secret@example.com/hub.git" })).toThrow(
      /username or password/,
    );
    try {
      loadConfig({ NODE_CONFIG: file, HUB_GIT_REPO: "https://user:secret@example.com/hub.git" });
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toMatch(/secret/);
    }
    expect(() => loadConfig({ NODE_CONFIG: path.join(root, "missing.json") })).toThrow(/could not be read/);
  });

  it("reads revoked signer keys from env or the node config file and rejects a bad entry", () => {
    const zero = "11111111111111111111111111111111";
    const other = "CuwnarNh7FEqZMmffFjRyWj54RecyS7zwFg1CxfzNudi";
    expect(loadConfig({ HUB_REVOKED_SIGNERS: `${zero},${other}` }).hubRevokedSigners).toEqual([zero, other]);
    expect(loadConfig({ HUB_REVOKED_SIGNERS: JSON.stringify([zero]), HUB_ALLOW_AUTHOR_APPROVAL: "true" })).toMatchObject({
      hubRevokedSigners: [zero],
      hubAllowAuthorApproval: true,
    });
    expect(() => loadConfig({ HUB_REVOKED_SIGNERS: "not-a-key" })).toThrow(/Solana address/);
    expect(() => loadConfig({ HUB_REVOKED_SIGNERS: `${zero},${zero}` })).toThrow(/repeats/);
    expect(() => loadConfig({ HUB_ALLOW_AUTHOR_APPROVAL: "maybe" })).toThrow(/HUB_ALLOW_AUTHOR_APPROVAL/);
    const root = mkdtempSync(path.join(tmpdir(), "revoked-config-"));
    const file = path.join(root, "node.config.json");
    writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        hub: { approvalThreshold: 1, allowAuthorApproval: false, revokedSigners: [other] },
      }),
    );
    expect(loadConfig({ NODE_CONFIG: file }).hubRevokedSigners).toEqual([other]);
    expect(loadConfig({ NODE_CONFIG: file, HUB_REVOKED_SIGNERS: zero }).hubRevokedSigners).toEqual([zero]);
    expect(loadConfig({ NODE_CONFIG: file, HUB_REVOKED_SIGNERS: "[]" }).hubRevokedSigners).toEqual([]);
    for (const empty of [",", ",,", ", ,"]) {
      expect(() => loadConfig({ NODE_CONFIG: file, HUB_REVOKED_SIGNERS: empty }), empty).toThrow(/empty entry/);
    }
    writeFileSync(file, JSON.stringify({ v: 1, hub: { revokeSignerGroup: ["default"] } }));
    expect(() => loadConfig({ NODE_CONFIG: file })).toThrow(/not allowed/);
  });

  it("accepts kinds on a signer set and leaves an omitted list unscoped", () => {
    for (const kind of HUB_UPDATE_KINDS) expect(SIGNER_SET_KINDS).toContain(kind);
    const scoped = loadConfig({
      HUB_SIGNER_SETS: JSON.stringify([
        { id: "player-tools", path: "hub/signers/player-tools.json", threshold: 1, kinds: ["story-optin", "claim", "reputation-link"] },
      ]),
    });
    expect(scoped.hubSignerSets[0]?.kinds).toEqual(["story-optin", "claim", "reputation-link"]);
    const plain = loadConfig({});
    expect(plain.hubSignerSets).toHaveLength(1);
    expect(plain.hubSignerSets[0]?.id).toBe("default");
    expect(plain.hubSignerSets[0]?.kinds).toBeUndefined();
    expect(plain.hubRevokedSigners).toEqual([]);
    expect(() => loadConfig({ HUB_SIGNER_SETS: JSON.stringify([{ id: "default", path: "hub/signers.json", kinds: [] }]) })).toThrow(/kinds list/);
    expect(() => loadConfig({ HUB_SIGNER_SETS: JSON.stringify([{ id: "default", path: "hub/signers.json", kinds: ["nope"] }]) })).toThrow(/kind that is not allowed/);
  });

  it("strips query secrets from echoed RPC URLs", () => {
    expect(redactRpcUrl("https://rpc.example/path?api-key=secret")).toBe("https://rpc.example/path");
  });

  it("removes RPC URLs from upstream errors", () => {
    expect(publicErrorMessage(new Error("failed https://rpc.example/path?api-key=secret"))).toBe(
      "failed [rpc]",
    );
  });
});
