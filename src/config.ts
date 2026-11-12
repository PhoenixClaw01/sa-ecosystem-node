import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { base58Decode, base58Encode } from "./hub/base58.js";
import { hubRepoPathRewritten } from "./hub/repo-url.js";
import { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES } from "./public-mcp.js";

export const DEFAULT_ZINK_RPC_URL = "https://testnet-rpc.z.ink";
export const DEFAULT_SOLANA_RPC_URL = "https://solana-rpc.publicnode.com";
export const DEFAULT_SOLANA_RPC_FALLBACK_URL = "https://api.mainnet-beta.solana.com";
export const DEFAULT_GALAXY_BASE_URL = "https://galaxy.staratlas.com";
export const ATLAS_CLUSTER = "zink-ptr" as const;

export interface Config {
  /** Public z.ink RPC used for Atlas Kit reads. */
  zinkRpcUrl: string;
  /** Public Solana JSON-RPC used for read methods only. */
  solanaRpcUrl: string;
  /** Tried, in order, when the primary URL refuses a read. */
  solanaRpcFallbackUrls: string[];
  /** Public galaxy JSON origin. Paths are appended by this node, not by the caller. */
  galaxyBaseUrl: string;
  /** Local treasury cache written by the refresh script and only read by the tools. */
  treasuryCachePath: string;
  /** Public https git repo, or an absolute path to a local clone. Empty leaves hub updates unread. */
  hubGitRepo: string;
  /** Full commit the hub store must be checked out at. */
  hubGitCommit: string;
  /** Repo-relative manifest path. Default hub-manifest.json. */
  hubStoreManifest: string;
  /**
   * When true, a missing hub-manifest.json is read from manifest.json.
   * True only when HUB_STORE_MANIFEST was unset. The hash pin still has to match the file that was read.
   */
  hubStoreManifestFallback: boolean;
  /** sha256 hex of the manifest file bytes. */
  hubStoreManifestHash: string;
  /** Distinct allowlisted approval signatures required for each update. */
  hubApprovalThreshold: number;
  /**
   * When true, the author's approval counts at threshold 2 or higher.
   * Threshold 1 always counts it. Default false.
   */
  hubAllowAuthorApproval: boolean;
  /**
   * Signer public keys this node ignores immediately. The key may still be
   * listed in hub/signers.json. This is not a signer-group revocation.
   */
  hubRevokedSigners: string[];
  /**
   * Verifier public keys whose attestations count as verified.
   * Empty by default. Other attestations stay self-attested.
   */
  hubTrustedVerifiers: string[];
  /** Public-key allowlist used when no signer set list is configured. An empty list rejects every update. */
  hubSignersPath: string;
  /** Signer sets this node trusts. A signer-change applies only to one of these ids. */
  hubSignerSets: SignerSetConfig[];
  cluster: typeof ATLAS_CLUSTER;
  host: string;
  port: number;
  /** When true, the HTTP server accepts a public Host header and still serves only reads. */
  publicNode: boolean;
  /** Hostnames allowed when publicNode is set. `*` allows any Host header. */
  allowedHosts: string[];
  /**
   * Start anyway when publicNode is set and allowedHosts is empty or `*`.
   * Host and Origin checks stay off. The process prints a warning.
   */
  allowAnyHost: boolean;
  /** When true, the rate-limit key is the first X-Forwarded-For hop. Off, the key is the socket address. */
  trustProxy: boolean;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
}

/**
 * Kind names a signer set may list. Every current hub update kind is allowed.
 * `c4-anchor`, `community-tool`, and `reputation-link` are proposed kinds a set
 * may name before those records exist. `claim` counts only for a player claim
 * (`action` is `claim` and `subject` is `player`), not a revoke or resolve.
 */
export const SIGNER_SET_KINDS = [
  "announcement",
  "proposal-note",
  "payment-note",
  "status",
  "signer-change",
  "listing",
  "guild",
  "story-optin",
  "claim",
  "attestation",
  "c4-anchor",
  "community-tool",
  "reputation-link",
] as const;

export interface SignerSetConfig {
  id: string;
  path: string;
  threshold: number;
  /** Omitted means this set counts for every record kind. */
  kinds?: readonly string[];
}

function httpUrl(value: string | undefined, fallback: string, name: string): string {
  const raw = value?.trim() || fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an http(s) URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must be an http(s) URL.`);
  }
  return parsed.toString();
}

function httpUrlList(value: string | undefined, fallback: string, name: string): string[] {
  const raw = value?.trim() ? value : fallback;
  const items = raw.split(",").map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) throw new Error(`${name} must list at least one http(s) URL.`);
  return items.map((item) => httpUrl(item, fallback, name));
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function hexPin(value: string | undefined, length: number, name: string): string {
  const raw = value?.trim() ?? "";
  if (!raw) return "";
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(raw)) {
    throw new Error(`${name} must be ${length} lowercase hex characters.`);
  }
  return raw;
}

function hubRepo(value: string | undefined): string {
  const raw = value?.trim() ?? "";
  if (!raw) return "";
  if (raw.startsWith("-") || /\s/.test(raw)) throw new Error("HUB_GIT_REPO must be an https URL or an absolute path.");
  if (raw.startsWith("https://")) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error("HUB_GIT_REPO must be an https URL or an absolute path.");
    }
    if (parsed.username || parsed.password) throw new Error("HUB_GIT_REPO must not include a username or password.");
    if (parsed.search || parsed.hash) throw new Error("HUB_GIT_REPO must not include a query or hash.");
    if (hubRepoPathRewritten(raw)) throw new Error("HUB_GIT_REPO must not contain . or .. path segments.");
    return raw;
  }
  if (path.isAbsolute(raw)) return raw;
  throw new Error("HUB_GIT_REPO must be an https URL or an absolute path.");
}

function canonicalSignerKey(value: string): string | null {
  try {
    const bytes = base58Decode(value);
    if (bytes.length !== 32) return null;
    const encoded = base58Encode(bytes);
    return encoded === value ? encoded : null;
  } catch {
    return null;
  }
}

function addressList(value: string | undefined, name: string): string[] {
  const raw = value?.trim() ?? "";
  if (!raw) return [];
  let items: string[];
  if (raw.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`${name} must be a JSON array of Solana addresses or a comma-separated list.`);
    }
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error(`${name} must be a JSON array of Solana addresses or a comma-separated list.`);
    }
    items = parsed;
  } else {
    const parts = raw.split(",");
    if (parts.some((item) => item.trim() === "")) {
      throw new Error(`${name} has an empty entry.`);
    }
    items = parts.map((item) => item.trim());
  }
  if (items.length > 200) throw new Error(`${name} must list at most 200 public keys.`);
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const item of items) {
    const key = canonicalSignerKey(item);
    if (!key) throw new Error(`${name} has a value that is not a Solana address.`);
    if (seen.has(key)) throw new Error(`${name} repeats a public key.`);
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function manifestRelative(value: string | undefined): string {
  const raw = value?.trim() || "hub-manifest.json";
  const segments = raw.split("/");
  if (raw.startsWith("/") || raw.includes("\\") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("HUB_STORE_MANIFEST must be a relative path inside the repository.");
  }
  return raw;
}

function portNumber(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 8787;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error("PORT must be an integer from 0 to 65535.");
  }
  return parsed;
}

const SET_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function booleanEnv(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const raw = value.trim().toLowerCase();
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function allowedHostList(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const hosts = value.split(",").map((item) => item.trim()).filter(Boolean);
  for (const host of hosts) {
    if (host === "*") continue;
    if (host.length > 253 || /[\s/\\]/.test(host)) throw new Error("ALLOWED_HOSTS has a hostname that is not allowed.");
  }
  return hosts;
}

function signerSetList(
  value: string | undefined,
  signersPath: string,
  threshold: number,
  moduleDir: string = path.dirname(fileURLToPath(import.meta.url)),
  cwd: string = process.cwd(),
): SignerSetConfig[] {
  if (!value?.trim()) return [{ id: "default", path: signersPath, threshold }];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("HUB_SIGNER_SETS must be a JSON array.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 20) {
    throw new Error("HUB_SIGNER_SETS must be a JSON array of 1 to 20 signer sets.");
  }
  const seen = new Set<string>();
  return parsed.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("HUB_SIGNER_SETS has a signer set that is not an object.");
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.some((key) => key !== "id" && key !== "path" && key !== "threshold" && key !== "kinds")) {
      throw new Error("HUB_SIGNER_SETS has a field that is not id, path, threshold, or kinds.");
    }
    if (typeof record.id !== "string" || !SET_ID_PATTERN.test(record.id)) {
      throw new Error("HUB_SIGNER_SETS has a signer set id that is not allowed.");
    }
    if (seen.has(record.id)) throw new Error("HUB_SIGNER_SETS repeats a signer set id.");
    seen.add(record.id);
    if (typeof record.path !== "string" || record.path.trim() === "" || record.path.includes("\0")) {
      throw new Error("HUB_SIGNER_SETS has a signer set path that is not allowed.");
    }
    let setThreshold = threshold;
    if (record.threshold !== undefined) {
      if (typeof record.threshold !== "number" || !Number.isInteger(record.threshold) || record.threshold < 1 || record.threshold > 200) {
        throw new Error("HUB_SIGNER_SETS has a threshold that is not an integer from 1 to 200.");
      }
      setThreshold = record.threshold;
    }
    const kinds = signerSetKinds(record.kinds);
    return {
      id: record.id,
      path: resolveSignerSetPath(record.path.trim(), moduleDir, cwd),
      threshold: setThreshold,
      ...(kinds ? { kinds } : {}),
    };
  });
}

function signerSetKinds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new Error("HUB_SIGNER_SETS has a kinds list that is not 1 to 20 kind names.");
  }
  const allowed = new Set<string>(SIGNER_SET_KINDS);
  const seen = new Set<string>();
  const kinds: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item)) {
      throw new Error("HUB_SIGNER_SETS has a kind that is not allowed.");
    }
    if (seen.has(item)) throw new Error("HUB_SIGNER_SETS repeats a kind.");
    seen.add(item);
    kinds.push(item);
  }
  return kinds;
}

function readNodeConfigFile(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const explicit = env.NODE_CONFIG?.trim();
  let filePath: string | null = null;
  if (explicit) filePath = path.resolve(explicit);
  else if (env === process.env) {
    const candidate = path.resolve("node.config.json");
    if (existsSync(candidate)) filePath = candidate;
  }
  if (!filePath) return {};
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    throw new Error("The node config file could not be read.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("The node config file is not valid JSON.");
  }
  return nodeConfigToEnv(parsed);
}

function nodeConfigToEnv(value: unknown): NodeJS.ProcessEnv {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The node config file does not match schema v1.");
  }
  const record = value as Record<string, unknown>;
  const rootKeys = new Set([
    "v",
    "zinkRpcUrl",
    "solanaRpcUrl",
    "solanaRpcFallbackUrls",
    "galaxyBaseUrl",
    "treasuryCachePath",
    "host",
    "port",
    "publicNode",
    "allowedHosts",
    "allowAnyHost",
    "trustProxy",
    "rateLimitMax",
    "rateLimitWindowMs",
    "maxRequestBytes",
    "maxResponseBytes",
    "hub",
  ]);
  if (record.v !== 1 || Object.keys(record).some((key) => !rootKeys.has(key))) {
    throw new Error("The node config file does not match schema v1.");
  }
  const env: NodeJS.ProcessEnv = {};
  const text = (key: string, name: string) => {
    const item = record[key];
    if (item === undefined) return;
    if (typeof item !== "string") throw new Error(`The node config file ${name} must be a string.`);
    env[name] = item;
  };
  text("zinkRpcUrl", "ZINK_RPC_URL");
  text("solanaRpcUrl", "SOLANA_RPC_URL");
  text("galaxyBaseUrl", "GALAXY_BASE_URL");
  text("treasuryCachePath", "TREASURY_CACHE_PATH");
  text("host", "HOST");
  if (record.solanaRpcFallbackUrls !== undefined) {
    if (!Array.isArray(record.solanaRpcFallbackUrls) || record.solanaRpcFallbackUrls.some((item) => typeof item !== "string")) {
      throw new Error("The node config file solanaRpcFallbackUrls must be an array of strings.");
    }
    env.SOLANA_RPC_FALLBACK_URLS = record.solanaRpcFallbackUrls.join(",");
  }
  if (record.allowedHosts !== undefined) {
    if (!Array.isArray(record.allowedHosts) || record.allowedHosts.some((item) => typeof item !== "string")) {
      throw new Error("The node config file allowedHosts must be an array of strings.");
    }
    env.ALLOWED_HOSTS = record.allowedHosts.join(",");
  }
  const integer = (key: string, name: string) => {
    const item = record[key];
    if (item === undefined) return;
    if (typeof item !== "number" || !Number.isInteger(item)) throw new Error(`The node config file ${key} must be an integer.`);
    env[name] = String(item);
  };
  integer("port", "PORT");
  integer("rateLimitMax", "RATE_LIMIT_MAX");
  integer("rateLimitWindowMs", "RATE_LIMIT_WINDOW_MS");
  integer("maxRequestBytes", "MAX_REQUEST_BYTES");
  integer("maxResponseBytes", "MAX_RESPONSE_BYTES");
  const flag = (key: string, name: string) => {
    const item = record[key];
    if (item === undefined) return;
    if (typeof item !== "boolean") throw new Error(`The node config file ${key} must be true or false.`);
    env[name] = item ? "true" : "false";
  };
  flag("publicNode", "PUBLIC_NODE");
  flag("allowAnyHost", "ALLOW_ANY_HOST");
  flag("trustProxy", "TRUST_PROXY");
  if (record.hub !== undefined) envFromHub(record.hub, env);
  return env;
}

function envFromHub(value: unknown, env: NodeJS.ProcessEnv) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The node config file hub must be an object.");
  }
  const hub = value as Record<string, unknown>;
  const hubKeys = new Set([
    "gitRepo",
    "gitCommit",
    "storeManifest",
    "storeManifestHash",
    "approvalThreshold",
    "allowAuthorApproval",
    "revokedSigners",
    "trustedVerifiers",
    "signersPath",
    "signerSets",
  ]);
  if (Object.keys(hub).some((key) => !hubKeys.has(key))) {
    throw new Error("The node config file hub has a field that is not allowed.");
  }
  const text = (key: string, name: string) => {
    const item = hub[key];
    if (item === undefined) return;
    if (typeof item !== "string") throw new Error(`The node config file hub.${key} must be a string.`);
    env[name] = item;
  };
  text("gitRepo", "HUB_GIT_REPO");
  text("gitCommit", "HUB_GIT_COMMIT");
  text("storeManifest", "HUB_STORE_MANIFEST");
  text("storeManifestHash", "HUB_STORE_MANIFEST_HASH");
  text("signersPath", "HUB_SIGNERS_PATH");
  if (hub.approvalThreshold !== undefined) {
    if (typeof hub.approvalThreshold !== "number" || !Number.isInteger(hub.approvalThreshold)) {
      throw new Error("The node config file hub.approvalThreshold must be an integer.");
    }
    env.HUB_APPROVAL_THRESHOLD = String(hub.approvalThreshold);
  }
  if (hub.allowAuthorApproval !== undefined) {
    if (typeof hub.allowAuthorApproval !== "boolean") {
      throw new Error("The node config file hub.allowAuthorApproval must be true or false.");
    }
    env.HUB_ALLOW_AUTHOR_APPROVAL = hub.allowAuthorApproval ? "true" : "false";
  }
  if (hub.revokedSigners !== undefined) {
    if (!Array.isArray(hub.revokedSigners) || hub.revokedSigners.some((item) => typeof item !== "string")) {
      throw new Error("The node config file hub.revokedSigners must be an array of strings.");
    }
    env.HUB_REVOKED_SIGNERS = JSON.stringify(hub.revokedSigners);
  }
  if (hub.trustedVerifiers !== undefined) {
    if (!Array.isArray(hub.trustedVerifiers) || hub.trustedVerifiers.some((item) => typeof item !== "string")) {
      throw new Error("The node config file hub.trustedVerifiers must be an array of strings.");
    }
    env.HUB_TRUSTED_VERIFIERS = JSON.stringify(hub.trustedVerifiers);
  }
  if (hub.signerSets !== undefined) {
    env.HUB_SIGNER_SETS = JSON.stringify(hub.signerSets);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const fromFile = readNodeConfigFile(env);
  const merged: NodeJS.ProcessEnv = { ...fromFile };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== "") merged[key] = value;
  }
  return parseConfig(merged);
}

function parseConfig(env: NodeJS.ProcessEnv): Config {
  const port = portNumber(env.PORT);
  const host = env.HOST?.trim() || "127.0.0.1";
  const hubGitRepo = hubRepo(env.HUB_GIT_REPO);
  const hubGitCommit = hexPin(env.HUB_GIT_COMMIT, 40, "HUB_GIT_COMMIT");
  const hubStoreManifestSet = Boolean(env.HUB_STORE_MANIFEST?.trim());
  const hubStoreManifestHash = hexPin(env.HUB_STORE_MANIFEST_HASH, 64, "HUB_STORE_MANIFEST_HASH");
  const pins = [hubGitRepo, hubGitCommit, hubStoreManifestHash].filter(Boolean).length;
  if (pins !== 0 && pins !== 3) {
    throw new Error("Set HUB_GIT_REPO, HUB_GIT_COMMIT, and HUB_STORE_MANIFEST_HASH together.");
  }
  const hubApprovalThreshold = positiveInt(env.HUB_APPROVAL_THRESHOLD, 1, "HUB_APPROVAL_THRESHOLD");
  if (hubApprovalThreshold > 200) throw new Error("HUB_APPROVAL_THRESHOLD must be at most 200.");
  const hubRevokedSigners = addressList(env.HUB_REVOKED_SIGNERS, "HUB_REVOKED_SIGNERS");
  const hubTrustedVerifiers = addressList(env.HUB_TRUSTED_VERIFIERS, "HUB_TRUSTED_VERIFIERS");
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const hubSignersPath = resolveHubSignersPath(env.HUB_SIGNERS_PATH, moduleDir, process.cwd());
  const maxRequestBytes = positiveInt(env.MAX_REQUEST_BYTES, MAX_REQUEST_BYTES, "MAX_REQUEST_BYTES");
  const maxResponseBytes = positiveInt(env.MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES, "MAX_RESPONSE_BYTES");
  if (maxRequestBytes > 4_194_304) throw new Error("MAX_REQUEST_BYTES must be at most 4194304.");
  if (maxResponseBytes > 4_194_304) throw new Error("MAX_RESPONSE_BYTES must be at most 4194304.");
  return {
    zinkRpcUrl: httpUrl(env.ZINK_RPC_URL, DEFAULT_ZINK_RPC_URL, "ZINK_RPC_URL"),
    solanaRpcUrl: httpUrl(env.SOLANA_RPC_URL, DEFAULT_SOLANA_RPC_URL, "SOLANA_RPC_URL"),
    solanaRpcFallbackUrls: httpUrlList(
      env.SOLANA_RPC_FALLBACK_URLS,
      DEFAULT_SOLANA_RPC_FALLBACK_URL,
      "SOLANA_RPC_FALLBACK_URLS",
    ),
    galaxyBaseUrl: httpUrl(env.GALAXY_BASE_URL, DEFAULT_GALAXY_BASE_URL, "GALAXY_BASE_URL").replace(/\/$/, ""),
    treasuryCachePath: resolveTreasuryCachePath(env.TREASURY_CACHE_PATH, path.dirname(fileURLToPath(import.meta.url)), process.cwd()),
    hubGitRepo,
    hubGitCommit,
    hubStoreManifest: manifestRelative(env.HUB_STORE_MANIFEST),
    hubStoreManifestFallback: !hubStoreManifestSet,
    hubStoreManifestHash,
    hubApprovalThreshold,
    hubAllowAuthorApproval: booleanEnv(env.HUB_ALLOW_AUTHOR_APPROVAL, false, "HUB_ALLOW_AUTHOR_APPROVAL"),
    hubRevokedSigners,
    hubTrustedVerifiers,
    hubSignersPath,
    hubSignerSets: signerSetList(env.HUB_SIGNER_SETS, hubSignersPath, hubApprovalThreshold, moduleDir, process.cwd()),
    cluster: ATLAS_CLUSTER,
    host,
    port,
    publicNode: booleanEnv(env.PUBLIC_NODE, false, "PUBLIC_NODE"),
    allowedHosts: allowedHostList(env.ALLOWED_HOSTS),
    allowAnyHost: booleanEnv(env.ALLOW_ANY_HOST, false, "ALLOW_ANY_HOST"),
    trustProxy: booleanEnv(env.TRUST_PROXY, false, "TRUST_PROXY"),
    rateLimitMax: positiveInt(env.RATE_LIMIT_MAX, 120, "RATE_LIMIT_MAX"),
    rateLimitWindowMs: positiveInt(env.RATE_LIMIT_WINDOW_MS, 60_000, "RATE_LIMIT_WINDOW_MS"),
    maxRequestBytes,
    maxResponseBytes,
  };
}

/**
 * `hub/signers.json` is the only allowlist. The dashboard Vercel project roots
 * at `dashboard/`, so `npm run build:dashboard-mcp` writes a byte copy to
 * `dashboard/hub/signers.json` and `includeFiles` ships that copy with the function.
 * The same build embeds that file's sha256 in the function. Loading the allowlist
 * hashes the bytes and refuses a mismatch. When both files are on disk they must
 * match. A symlink, including a dangling one, is refused. lstat does not follow it.
 * An explicit path is used as given.
 */
export function resolveHubSignersPath(explicit: string | undefined, moduleDir: string, cwd: string): string {
  assertSignerCopies(cwd);
  if (explicit?.trim()) return path.resolve(cwd, explicit.trim());
  const preferred = path.resolve(cwd, "hub/signers.json");
  const preferredFile = signerCandidate(preferred);
  if (preferredFile) return preferredFile;
  const candidates = [
    path.resolve(moduleDir, "../hub/signers.json"),
    path.resolve(moduleDir, "../../hub/signers.json"),
    path.resolve(moduleDir, "../dashboard/hub/signers.json"),
    path.resolve(moduleDir, "../../dashboard/hub/signers.json"),
  ];
  for (const candidate of candidates) {
    const file = signerCandidate(candidate);
    if (file) return file;
  }
  return preferred;
}

/**
 * A relative `HUB_SIGNER_SETS` path is found the same way as the default signer file:
 * first under the working directory, then next to the code (the dashboard bundle lives in
 * `dashboard/api/`, so `../hub/...` is `dashboard/hub/...`). On Vercel the working
 * directory is not the dashboard root, so a cwd-only lookup missed the shipped copies.
 * An absolute path is used as given. When no candidate exists, the cwd path is returned
 * and the read fails closed later.
 */
export function resolveSignerSetPath(relativeOrAbsolute: string, moduleDir: string, cwd: string): string {
  if (path.isAbsolute(relativeOrAbsolute)) return path.resolve(relativeOrAbsolute);
  const preferred = path.resolve(cwd, relativeOrAbsolute);
  if (signerCandidate(preferred)) return preferred;
  const candidates = [
    path.resolve(moduleDir, "..", relativeOrAbsolute),
    path.resolve(moduleDir, "../..", relativeOrAbsolute),
    path.resolve(moduleDir, "../dashboard", relativeOrAbsolute),
    path.resolve(moduleDir, "../../dashboard", relativeOrAbsolute),
  ];
  for (const candidate of candidates) {
    const file = signerCandidate(candidate);
    if (file) return file;
  }
  return preferred;
}

/** A symlink or a non-file is refused. A missing path is skipped. lstat does not follow a final symlink. */
function signerCandidate(file: string): string | null {
  const kind = signerFileKind(file);
  if (kind === "missing") return null;
  if (kind !== "file") throw new Error("The signer allowlist must be a regular file.");
  return file;
}

type SignerFileKind = "missing" | "file" | "symlink" | "other";

function signerFileKind(file: string): SignerFileKind {
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isFile()) return "file";
    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw new Error("The signer allowlist could not be read.");
  }
}

function assertSignerCopies(cwd: string): void {
  const canonical = path.resolve(cwd, "hub/signers.json");
  const copy = path.resolve(cwd, "dashboard/hub/signers.json");
  const canonicalKind = signerFileKind(canonical);
  const copyKind = signerFileKind(copy);
  if (canonicalKind === "symlink" || copyKind === "symlink" || canonicalKind === "other" || copyKind === "other") {
    throw new Error("dashboard/hub/signers.json must be a regular-file copy of hub/signers.json.");
  }
  if (canonicalKind === "missing" || copyKind === "missing") return;
  if (!readFileSync(canonical).equals(readFileSync(copy))) {
    throw new Error("dashboard/hub/signers.json must match hub/signers.json byte for byte.");
  }
}

const DEFAULT_TREASURY_CACHE = "data/treasury-cache.json";
const COMMITTED_TREASURY_CACHE = "dashboard/data/treasury-cache.json";
const PACKAGE_NAME = "sa-ecosystem-node";

/**
 * An explicit path from `TREASURY_CACHE_PATH` or `treasuryCachePath` in the node
 * config file is used as given, even when the file is missing.
 * When neither is set, the path is `data/treasury-cache.json` under the working
 * directory. That file is gitignored. When it is missing, the committed cache at
 * `dashboard/data/treasury-cache.json` is used, resolved from the package root
 * (this package's package.json), not the working directory. A cache placed
 * beside the dashboard function is still accepted. Callers do not invent a cache.
 */
export function resolveTreasuryCachePath(envPath: string | undefined, moduleDir: string, cwd: string): string {
  if (envPath?.trim()) return path.resolve(envPath.trim());
  const preferred = path.resolve(cwd, DEFAULT_TREASURY_CACHE);
  if (existsSync(preferred)) return preferred;
  const root = packageRoot(moduleDir);
  const fallbacks = [
    path.resolve(root, COMMITTED_TREASURY_CACHE),
    path.resolve(moduleDir, "../data/treasury-cache.json"),
    path.resolve(moduleDir, "../dashboard/data/treasury-cache.json"),
    path.resolve(moduleDir, "../../dashboard/data/treasury-cache.json"),
  ];
  return fallbacks.find((candidate) => existsSync(candidate)) ?? preferred;
}

/** Directory of this package. A module outside `src`, `dist`, or `dashboard` does not claim it. */
function packageRoot(moduleDir: string): string {
  const start = path.resolve(moduleDir);
  let dir = start;
  for (let hop = 0; hop < 8; hop += 1) {
    if (isThisPackage(dir) && moduleLivesInPackage(dir, start)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(moduleDir, "..");
}

function isThisPackage(dir: string): boolean {
  const manifestPath = path.join(dir, "package.json");
  if (!existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
    return manifest.name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

function moduleLivesInPackage(root: string, moduleDir: string): boolean {
  const relative = path.relative(root, moduleDir);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const top = relative.split(path.sep)[0];
  return top === "src" || top === "dist" || top === "dashboard";
}

/** Drop userinfo and query strings so a URL with an embedded token is not echoed. */
export function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "[invalid url]";
  }
}
