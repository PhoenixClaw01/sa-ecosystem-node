import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SafeClientError } from "../errors.js";
import { fetchGithubArchive } from "./github-archive.js";
import { hubRepoPathRewritten } from "./repo-url.js";

const MAX_DOCUMENTS = 200;
const MAX_FILE_BYTES = 64 * 1024;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

const DEFAULT_MANIFEST = "hub-manifest.json";
const LEGACY_MANIFEST = "manifest.json";

export interface HubStorePin {
  repo: string;
  commit: string;
  manifestPath: string;
  manifestHash: string;
  /**
   * When hub-manifest.json is missing, read manifest.json.
   * A file that is present is the one that is hashed. A mismatch refuses the read.
   */
  manifestFallback?: boolean;
}

export interface LoadedHubStore {
  documents: unknown[];
  sourceUrl: string | null;
  /** Manifest path that was hashed. This is the hub id in a story consent sentence. */
  manifestPath: string;
}

/** Failures of one HTTPS pin are remembered this long. Inside the 5–10 second band. */
export const HUB_FETCH_FAILURE_TTL_MS = 8_000;

const fetchFailures = new Map<string, { at: number; error: SafeClientError }>();
const httpsInFlight = new Map<string, Promise<LoadedHubStore>>();
const fetchIds = new WeakMap<object, number>();
let nextFetchId = 1;

export interface HubStoreLoadOptions {
  /** Force a transport. Omit to use git when the binary is on PATH, and HTTPS otherwise. */
  transport?: "git" | "https";
  /** Test hook for the git probe. Production calls `git --version`. */
  gitAvailable?: () => boolean;
  /** HTTPS fetch. Tests pass a stub. Production uses global fetch. */
  fetch?: typeof fetch;
}

function refuse(message: string): never {
  throw new SafeClientError(message);
}

let gitOnPath: boolean | undefined;

function gitBinaryAvailable(): boolean {
  if (gitOnPath !== undefined) return gitOnPath;
  const result = spawnSync("git", ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const missing = Boolean(result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT");
  gitOnPath = !missing;
  return gitOnPath;
}

/** Git when the binary is present. HTTPS when it is not. An explicit transport wins. */
export function chooseHubTransport(options?: HubStoreLoadOptions): "git" | "https" {
  if (options?.transport === "git" || options?.transport === "https") return options.transport;
  const available = options?.gitAvailable ? options.gitAvailable() : gitBinaryAvailable();
  return available ? "git" : "https";
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync(
    "git",
    ["-c", "safe.directory=*", "-c", "core.hooksPath=/dev/null", "-c", "fetch.fsckObjects=true", ...args],
    {
      cwd,
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
  if (result.error || result.status !== 0) {
    refuse("The hub git store could not be read. No updates were returned.");
  }
  return (result.stdout ?? "").trim();
}

function httpsRepo(repo: string): string | null {
  if (!repo.startsWith("https://") || repo.startsWith("-") || /\s/.test(repo)) return null;
  let parsed: URL;
  try {
    parsed = new URL(repo);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (hubRepoPathRewritten(repo)) return null;
  return repo;
}

function relativeAllowed(relative: string): boolean {
  if (relative.length === 0 || relative.length > 200 || relative.startsWith("/") || relative.includes("\\") || relative.includes("\0")) {
    return false;
  }
  const segments = relative.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== ".." && segment !== ".git");
}

type ManifestPresence = "missing" | "file" | "invalid";

interface HubTree {
  presence(relative: string): ManifestPresence;
  read(relative: string): Buffer | null;
}

/**
 * Walk each path component with lstat. A symlink, a gitdir entry, or a final
 * component that is not a regular file is invalid. O_NOFOLLOW closes the gap
 * between that check and the read.
 */
function classifyFile(root: string, relative: string): ManifestPresence {
  if (!relativeAllowed(relative)) return "invalid";
  const segments = relative.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index] ?? "");
    const resolved = path.resolve(current);
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (resolved !== root && !resolved.startsWith(prefix)) return "invalid";
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid";
    }
    if (info.isSymbolicLink()) return "invalid";
    const last = index === segments.length - 1;
    if (!last) {
      if (!info.isDirectory()) return "invalid";
      continue;
    }
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return "invalid";
  }
  return "file";
}

function readRegular(file: string): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const got = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (got <= 0) return null;
      offset += got;
    }
    return bytes;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function directoryTree(root: string): HubTree {
  return {
    presence(relative) {
      return classifyFile(root, relative);
    },
    read(relative) {
      if (classifyFile(root, relative) !== "file") return null;
      return readRegular(path.resolve(root, relative));
    },
  };
}

function memoryTree(files: Map<string, Buffer | null>): HubTree {
  return {
    presence(relative) {
      if (!relativeAllowed(relative)) return "invalid";
      if (!files.has(relative)) return "missing";
      return files.get(relative) ? "file" : "invalid";
    },
    read(relative) {
      if (!relativeAllowed(relative)) return null;
      const value = files.get(relative);
      if (!value || value.length > MAX_FILE_BYTES) return null;
      return value;
    },
  };
}

function checkout(pin: HubStorePin, directory: string): string | null {
  const remote = httpsRepo(pin.repo);
  if (remote) {
    git(directory, ["init"]);
    git(directory, ["remote", "add", "origin", remote]);
    git(directory, ["fetch", "--depth", "1", "origin", pin.commit]);
    git(directory, ["checkout", "--detach", "FETCH_HEAD"]);
    return remote;
  }
  if (!path.isAbsolute(pin.repo) || pin.repo.startsWith("-")) return null;
  git(directory, ["clone", "--local", "--no-hardlinks", "--", pin.repo, "."]);
  git(directory, ["checkout", "--detach", pin.commit]);
  return null;
}

/**
 * The pinned path when that file is present. When the path is the default
 * hub-manifest.json, the file is missing, and fallback is set, use manifest.json.
 * A present file with the wrong hash is not replaced by the other name.
 */
function resolveManifestRelative(tree: HubTree, pin: HubStorePin): string {
  if (!relativeAllowed(pin.manifestPath)) refuse("The hub store manifest is not valid. No updates were returned.");
  const state = tree.presence(pin.manifestPath);
  if (state === "file") return pin.manifestPath;
  if (state === "invalid") refuse("The hub store manifest is not valid. No updates were returned.");
  const canFallback = pin.manifestFallback === true && pin.manifestPath === DEFAULT_MANIFEST;
  if (!canFallback) refuse("The hub store manifest is not valid. No updates were returned.");
  if (tree.presence(LEGACY_MANIFEST) !== "file") {
    refuse("The hub store manifest is not valid. No updates were returned.");
  }
  return LEGACY_MANIFEST;
}

function readTree(pin: HubStorePin, tree: HubTree, sourceUrl: string | null): LoadedHubStore {
  const manifestRelativePath = resolveManifestRelative(tree, pin);
  const bytes = tree.read(manifestRelativePath);
  if (!bytes) refuse("The hub store manifest is not valid. No updates were returned.");
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== pin.manifestHash) {
    refuse("The hub store manifest hash did not match. No updates were returned.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    refuse("The hub store manifest is not valid. No updates were returned.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    refuse("The hub store manifest is not valid. No updates were returned.");
  }
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1 || Object.keys(record).length !== 2 || !Array.isArray(record.updates)) {
    refuse("The hub store manifest is not valid. No updates were returned.");
  }
  if (record.updates.length > MAX_DOCUMENTS || new Set(record.updates).size !== record.updates.length) {
    refuse("The hub store manifest is not valid. No updates were returned.");
  }
  const documents = record.updates.map((relative) => {
    if (typeof relative !== "string") refuse("The hub store manifest is not valid. No updates were returned.");
    const body = tree.read(relative);
    if (!body) refuse("The hub store manifest is not valid. No updates were returned.");
    try {
      return JSON.parse(body.toString("utf8")) as unknown;
    } catch {
      return null;
    }
  });
  return { documents, sourceUrl, manifestPath: manifestRelativePath };
}

function loadFromGit(pin: HubStorePin): LoadedHubStore {
  const directory = mkdtempSync(path.join(tmpdir(), "hub-store-"));
  try {
    const sourceUrl = checkout(pin, directory);
    if (sourceUrl === null && !path.isAbsolute(pin.repo)) {
      refuse("The hub git store pin is not valid. No updates were returned.");
    }
    const head = git(directory, ["rev-parse", "HEAD"]);
    if (head !== pin.commit) {
      refuse("The hub store commit did not match the pin. No updates were returned.");
    }
    return readTree(pin, directoryTree(directory), sourceUrl);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function loadFromHttps(pin: HubStorePin, fetchImpl: typeof fetch): Promise<LoadedHubStore> {
  const remote = httpsRepo(pin.repo);
  if (!remote) {
    if (!path.isAbsolute(pin.repo)) refuse("The hub git store pin is not valid. No updates were returned.");
    refuse("The hub git store could not be read. No updates were returned.");
  }
  try {
    const archive = await fetchGithubArchive(remote, pin.commit, MAX_FILE_BYTES, fetchImpl);
    return readTree(pin, memoryTree(archive.files), archive.sourceUrl);
  } catch (error) {
    if (error instanceof SafeClientError) throw error;
    refuse("The hub git store could not be read. No updates were returned.");
  }
}

/**
 * Read one pinned hub commit and return the documents named by its manifest.
 * A host with `git` checks out that commit. A host without it downloads a public
 * github.com repository at that commit over HTTPS. The manifest file's sha256
 * must match the pin. A mismatch, a bad path, or a failed read rejects the whole
 * read. When `manifestFallback` is set and `hub-manifest.json` is missing,
 * `manifest.json` is read instead. The hash pin applies to that file. A present
 * file is never swapped for the other name.
 */
function hubPinKey(pin: HubStorePin): string {
  return `${pin.repo}\n${pin.commit}\n${pin.manifestHash}\n${pin.manifestPath}\n${pin.manifestFallback ? "1" : "0"}`;
}

function fetchKey(fetchImpl: typeof fetch): number {
  const existing = fetchIds.get(fetchImpl);
  if (existing !== undefined) return existing;
  const id = nextFetchId;
  nextFetchId += 1;
  fetchIds.set(fetchImpl, id);
  return id;
}

function httpsCacheKey(pin: HubStorePin, fetchImpl: typeof fetch): string {
  return `${fetchKey(fetchImpl)}\n${hubPinKey(pin)}`;
}

function readFetchFailure(key: string, now: number): SafeClientError | undefined {
  const hit = fetchFailures.get(key);
  if (!hit) return undefined;
  if (now - hit.at >= HUB_FETCH_FAILURE_TTL_MS) {
    fetchFailures.delete(key);
    return undefined;
  }
  return hit.error;
}

function writeFetchFailure(key: string, error: SafeClientError, now: number): void {
  fetchFailures.delete(key);
  fetchFailures.set(key, { at: now, error });
  while (fetchFailures.size > 32) {
    const oldest = fetchFailures.keys().next().value;
    if (oldest === undefined) break;
    fetchFailures.delete(oldest);
  }
}

/** Drops in-flight and negative HTTPS cache entries. Tests use this between cases. */
export function resetHubFetchCache(): void {
  httpsInFlight.clear();
  fetchFailures.clear();
}

export async function loadPinnedHubStore(pin: HubStorePin, options?: HubStoreLoadOptions): Promise<LoadedHubStore> {
  if (!COMMIT_PATTERN.test(pin.commit) || !HASH_PATTERN.test(pin.manifestHash)) {
    refuse("The hub git store pin is not valid. No updates were returned.");
  }
  if (chooseHubTransport(options) !== "https") return loadFromGit(pin);
  const fetchImpl = options?.fetch ?? fetch;
  const key = httpsCacheKey(pin, fetchImpl);
  const failed = readFetchFailure(key, Date.now());
  if (failed) throw failed;
  const pending = httpsInFlight.get(key);
  if (pending) return pending;
  const tracked = loadFromHttps(pin, fetchImpl).then(
    (loaded) => loaded,
    (error: unknown) => {
      const safe = error instanceof SafeClientError
        ? error
        : new SafeClientError("The hub git store could not be read. No updates were returned.");
      writeFetchFailure(key, safe, Date.now());
      throw safe;
    },
  );
  const settled = tracked.finally(() => {
    if (httpsInFlight.get(key) === settled) httpsInFlight.delete(key);
  });
  httpsInFlight.set(key, settled);
  return settled;
}
