import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { guildBodyProblem, guildFailureMessage, inspectGuild } from "./guild.js";
import { inspectListing, listingFailureMessage, listingIdentity } from "./listing.js";
import { normalizeSearchQuery } from "./search.js";
import { parseReputationLink, reputationLinkSignatureValid } from "./reputation-link.js";
import { normalizeHubRepo, parseStoryOptIn, storyOptInSignatureValid } from "./story-optin.js";
import { nodeRepoRoot } from "./repo-path.js";
import { approveHubDocument, readSolanaKeyFile, signHubPayload, solanaKeyAddress } from "./sign-cli.js";
import { formatHubStoreManifest } from "./store-init-cli.js";
import {
  approvalSignatureValid,
  authorSignatureValid,
  hubUpdateHash,
  parseHubPayload,
  parseSignedHubDocument,
  type SignedHubDocument,
} from "./update.js";

/**
 * Writes one signed hub update into a local hub store git repo and commits it.
 * `--dry-run` prints the document, the payload sha256, and the manifest hash
 * without writing. On a document that already has an author signature,
 * `--keypair` adds one detached approval. On an unsigned payload it signs as
 * the author, and `--approve` also attaches that key's approval. The key file
 * is an off-chain ed25519 key. It must hold no funds. This script does not
 * print the secret, and it does not call an RPC.
 */

const USAGE = [
  "Usage: npm run hub-add-update -- --store <dir> (--payload <file> | --id <id> --kind <kind> --body <text> [--listing <json>] [--guild <json>] [--story-optin <json>] [--reputation-link <json>]) [--author <address>] [--prev <hash>] [--created-at <time>] [--pip <id>] [--tx <sig>] [--keypair <path>] [--approve] [--manifest <path>] [--hub-repo <url>] [--dry-run]",
].join("\n");

interface Report {
  dryRun: boolean;
  path: string;
  payloadSha256: string;
  manifestHash: string;
  commit: string | null;
  selfApproved: boolean;
  document?: SignedHubDocument;
  manifest?: { v: 1; updates: string[] };
}

/** Test seams. Not CLI flags. */
export interface AddUpdateHooks {
  /** Runs after the tip is read and before the pre-commit re-check. */
  beforeCommit?: (store: string) => void;
  /** Runs after the directory identity check and before rename. */
  beforeRename?: (store: string, dir: string) => void;
}

interface FsIdentity {
  dev: bigint;
  ino: bigint;
}

const SYMLINK = "Refusing to follow a symlink.";
const DIRECTORY_CHANGED = "The hub store directory changed during the write. The file was removed. Nothing was committed.";
const DIRECTORY_CHANGED_LEFT = "The hub store directory changed during the write. The written file could not be removed. Nothing was committed.";
const LOCK_NAME = "hub-add-update.lock";

function fail(message: string): { code: number; stdout: string; stderr: string } {
  return { code: 1, stdout: "", stderr: `${message}\n` };
}

function inside(root: string, relative: string): string | null {
  if (relative.length === 0 || relative.length > 200 || relative.startsWith("/") || relative.includes("\\") || relative.includes("\0")) {
    return null;
  }
  const segments = relative.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  const full = path.resolve(root, relative);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (full !== root && !full.startsWith(prefix)) return null;
  return full;
}

function insideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    throw new Error("The update file could not be read.");
  }
}

function git(cwd: string, args: readonly string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(
    "git",
    ["-c", "safe.directory=*", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
  return {
    ok: !result.error && result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function lstatOrNull(file: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(SYMLINK);
  }
}

function lstatPrecise(file: string) {
  try {
    return lstatSync(file, { bigint: true });
  } catch {
    return null;
  }
}

function assertRealDirInside(store: string, dir: string): FsIdentity {
  const info = lstatPrecise(dir);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) throw new Error(SYMLINK);
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    throw new Error(SYMLINK);
  }
  if (real !== dir || (!insideRoot(store, real) && real !== store)) throw new Error(SYMLINK);
  return { dev: info.dev, ino: info.ino };
}

/**
 * Unlink `file` only when lstat shows that same regular file.
 * A final symlink is left alone. lstat does not follow it.
 */
function removeIfSameFile(file: string, expected: FsIdentity): boolean {
  const info = lstatPrecise(file);
  if (!info || info.isSymbolicLink() || !info.isFile()) return false;
  if (info.dev !== expected.dev || info.ino !== expected.ino) return false;
  try {
    unlinkSync(file);
  } catch {
    return false;
  }
  return true;
}

/**
 * Node has no renameat, so rename follows a symlink that replaces `dir`.
 * The dev/ino captured before the temp write must still match, and the
 * written file must resolve inside the store.
 */
function placementHeld(
  store: string,
  dir: string,
  destination: string,
  storeId: FsIdentity,
  dirId: FsIdentity,
  fileId: FsIdentity,
): boolean {
  const storeInfo = lstatPrecise(store);
  const dirInfo = lstatPrecise(dir);
  if (!storeInfo || !dirInfo) return false;
  if (storeInfo.isSymbolicLink() || !storeInfo.isDirectory()) return false;
  if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) return false;
  if (storeInfo.dev !== storeId.dev || storeInfo.ino !== storeId.ino) return false;
  if (dirInfo.dev !== dirId.dev || dirInfo.ino !== dirId.ino) return false;
  let realDir: string;
  let realFile: string;
  try {
    realDir = realpathSync(dir);
    realFile = realpathSync(destination);
  } catch {
    return false;
  }
  if (realDir !== dir || (!insideRoot(store, realDir) && realDir !== store)) return false;
  if (!insideRoot(store, realFile)) return false;
  const fileInfo = lstatPrecise(destination);
  if (!fileInfo || fileInfo.isSymbolicLink() || !fileInfo.isFile()) return false;
  return fileInfo.dev === fileId.dev && fileInfo.ino === fileId.ino;
}

/**
 * Walk every component under the store with lstat. A symlink is refused.
 * `absent` allows the final component to be missing. The parent directory's
 * real path must stay inside the store.
 */
function storePath(store: string, relative: string, finalKind: "file" | "absent"): string {
  if (!inside(store, relative)) throw new Error("The update path is not valid.");
  const segments = relative.split("/");
  let current = store;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? "";
    const next = path.join(current, segment);
    const isFinal = index === segments.length - 1;
    const info = lstatOrNull(next);
    if (info?.isSymbolicLink()) throw new Error(SYMLINK);
    if (!info) {
      if (isFinal && finalKind === "absent") {
        assertRealDirInside(store, current);
        return next;
      }
      if (!isFinal && segment === "updates" && current === store && segments.length === index + 2) {
        return path.join(next, segments[index + 1] ?? "");
      }
      throw new Error("The hub store path could not be read.");
    }
    if (!isFinal) {
      if (!info.isDirectory()) throw new Error("The update path is not valid.");
      assertRealDirInside(store, next);
    } else if (finalKind === "absent") {
      throw new Error("The store already has this update.");
    } else if (!info.isFile()) {
      throw new Error(SYMLINK);
    }
    current = next;
  }
  assertRealDirInside(store, path.dirname(current));
  return current;
}

function assertStore(dir: string): string {
  if (dir.length === 0 || dir.includes("\0")) throw new Error("The store path is not valid.");
  const resolved = path.resolve(dir);
  let info;
  try {
    info = lstatSync(resolved);
  } catch {
    throw new Error("The store path is not a directory.");
  }
  if (info.isSymbolicLink()) throw new Error(SYMLINK);
  if (!info.isDirectory()) throw new Error("The store path is not a directory.");
  const real = realpathSync(resolved);
  if (insideRoot(nodeRepoRoot(), real)) throw new Error("Refusing to write inside this repository.");
  const gitPath = path.join(real, ".git");
  const gitInfo = lstatOrNull(gitPath);
  if (!gitInfo) throw new Error("The store is not a git repository.");
  if (gitInfo.isSymbolicLink()) throw new Error(SYMLINK);
  if (!gitInfo.isDirectory()) throw new Error("The store is not a git repository.");
  assertRealDirInside(real, gitPath);
  return real;
}

function acquireLock(store: string): string {
  const lockPath = path.join(store, ".git", LOCK_NAME);
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow();
  try {
    const fd = openSync(lockPath, flags, 0o600);
    closeSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new Error("The hub store is locked by another add. Nothing was written.");
    throw new Error("The hub store lock could not be taken. Nothing was written.");
  }
  return lockPath;
}

function releaseLock(lockPath: string): void {
  try {
    const info = lstatSync(lockPath);
    if (info.isSymbolicLink() || !info.isFile()) return;
    unlinkSync(lockPath);
  } catch {
    // The lock is already gone.
  }
}

function noFollow(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function readStoreFile(store: string, relative: string): string {
  const file = storePath(store, relative, "file");
  return readFileSync(file, "utf8");
}

function ensureUpdatesDir(store: string): void {
  const updates = path.join(store, "updates");
  const info = lstatOrNull(updates);
  if (!info) {
    assertRealDirInside(store, store);
    mkdirSync(updates, { mode: 0o755 });
    assertRealDirInside(store, updates);
    return;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(SYMLINK);
  assertRealDirInside(store, updates);
}

function writeStoreFile(
  store: string,
  relative: string,
  text: string,
  kind: "create" | "replace",
  hooks?: AddUpdateHooks,
): void {
  const destination = storePath(store, relative, kind === "create" ? "absent" : "file");
  const dir = path.dirname(destination);
  if (kind === "create" && path.basename(dir) === "updates") ensureUpdatesDir(store);
  const storeId = assertRealDirInside(store, store);
  const dirId = assertRealDirInside(store, dir);
  const temp = path.join(dir, `.${path.basename(destination)}.${randomBytes(8).toString("hex")}.tmp`);
  if (!insideRoot(store, temp)) throw new Error("The update path is not valid.");
  let fd: number | null = null;
  try {
    fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o644);
    writeSync(fd, text);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    fd = null;
    try {
      unlinkSync(temp);
    } catch {
      // The temp file was not created.
    }
    if (error instanceof Error && (error.message === SYMLINK || error.message.startsWith("The "))) throw error;
    throw new Error("The hub update could not be written.");
  }
  if (fd !== null) closeSync(fd);
  const info = lstatOrNull(destination);
  const discardTemp = () => {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file is already gone.
    }
  };
  if (kind === "create") {
    if (info) {
      discardTemp();
      throw new Error(info.isSymbolicLink() ? SYMLINK : "The store already has this update.");
    }
  } else if (!info || info.isSymbolicLink() || !info.isFile()) {
    discardTemp();
    throw new Error(SYMLINK);
  }
  const tempInfo = lstatPrecise(temp);
  if (!tempInfo || tempInfo.isSymbolicLink() || !tempInfo.isFile()) {
    if (tempInfo && !tempInfo.isSymbolicLink()) {
      try {
        unlinkSync(temp);
      } catch {
        // The temp file is already gone.
      }
    }
    throw new Error(tempInfo?.isSymbolicLink() ? SYMLINK : "The hub update could not be written.");
  }
  const fileId: FsIdentity = { dev: tempInfo.dev, ino: tempInfo.ino };
  try {
    assertRealDirInside(store, dir);
  } catch (error) {
    removeIfSameFile(temp, fileId);
    throw error;
  }
  try {
    hooks?.beforeRename?.(store, dir);
  } catch (error) {
    removeIfSameFile(temp, fileId);
    throw error;
  }
  try {
    renameSync(temp, destination);
  } catch (error) {
    removeIfSameFile(temp, fileId);
    if (error instanceof Error && (error.message === SYMLINK || error.message.startsWith("The "))) throw error;
    throw new Error("The hub update could not be written.");
  }
  let stayed = false;
  try {
    stayed = placementHeld(store, dir, destination, storeId, dirId, fileId);
  } catch {
    stayed = false;
  }
  if (!stayed) {
    const removed = removeIfSameFile(destination, fileId);
    throw new Error(removed ? DIRECTORY_CHANGED : DIRECTORY_CHANGED_LEFT);
  }
}

function assertKeyFile(file: string, store: string): string {
  if (file.length === 0 || file.includes("\0")) throw new Error("The key file could not be read.");
  const resolved = path.resolve(file);
  let info;
  try {
    info = lstatSync(resolved);
  } catch {
    throw new Error("The key file could not be read.");
  }
  if (info.isSymbolicLink()) throw new Error("Refusing to follow a symlink.");
  if (!info.isFile()) throw new Error("The key file could not be read.");
  const real = realpathSync(resolved);
  if (insideRoot(nodeRepoRoot(), real)) throw new Error("Refusing to read a key file from this repository.");
  if (insideRoot(store, real)) throw new Error("Refusing to read a key file from the hub store.");
  return real;
}

interface StoredUpdate {
  relative: string;
  document: SignedHubDocument;
  hash: string;
}

function loadStore(store: string, manifestRel: string): StoredUpdate[] {
  let text: string;
  try {
    text = readStoreFile(store, manifestRel);
  } catch (error) {
    if (error instanceof Error && (error.message === SYMLINK || error.message === "The update path is not valid.")) throw error;
    throw new Error("The hub store manifest could not be read.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("The hub store manifest is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The hub store manifest is not valid.");
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1 || Object.keys(record).length !== 2 || !Array.isArray(record.updates)) {
    throw new Error("The hub store manifest is not valid.");
  }
  const updates: StoredUpdate[] = [];
  for (const relative of record.updates) {
    if (typeof relative !== "string") throw new Error("The hub store manifest is not valid.");
    let body: unknown;
    try {
      body = JSON.parse(readStoreFile(store, relative)) as unknown;
    } catch (error) {
      if (error instanceof Error && (error.message === SYMLINK || error.message === "The update path is not valid.")) throw error;
      throw new Error("The hub store has an update that could not be read.");
    }
    const document = parseSignedHubDocument(body);
    if (!document || !authorSignatureValid(document.payload, document.signature)) {
      throw new Error("The hub store has an update that is not a signed hub document.");
    }
    updates.push({ relative, document, hash: hubUpdateHash(document.payload) });
  }
  return updates;
}

function orderedChain(updates: readonly StoredUpdate[]): StoredUpdate[] {
  if (updates.length === 0) return [];
  const byHash = new Map<string, StoredUpdate>();
  for (const update of updates) {
    if (byHash.has(update.hash)) throw new Error("The hub store repeats a payload hash.");
    byHash.set(update.hash, update);
  }
  const byPrev = new Map<string | null, StoredUpdate[]>();
  for (const update of byHash.values()) {
    const list = byPrev.get(update.document.payload.prev) ?? [];
    list.push(update);
    byPrev.set(update.document.payload.prev, list);
  }
  let prev: string | null = null;
  const ordered: StoredUpdate[] = [];
  const seen = new Set<string>();
  for (let step = 0; step < byHash.size; step += 1) {
    const children: StoredUpdate[] = byPrev.get(prev) ?? [];
    if (children.length !== 1) throw new Error("The hub store does not have a single update chain.");
    const child: StoredUpdate | undefined = children[0];
    if (!child || seen.has(child.hash)) throw new Error("The hub store does not have a single update chain.");
    seen.add(child.hash);
    ordered.push(child);
    prev = child.hash;
  }
  if (seen.size !== byHash.size) throw new Error("The hub store does not have a single update chain.");
  return ordered;
}

function chainTip(updates: readonly StoredUpdate[]): string | null {
  const ordered = orderedChain(updates);
  return ordered.length === 0 ? null : (ordered[ordered.length - 1]?.hash ?? null);
}

function currentListingIdentities(ordered: readonly StoredUpdate[]): Set<string> {
  const live = new Map<string, true>();
  for (const update of ordered) {
    const listing = update.document.payload.listing;
    if (update.document.payload.kind !== "listing" || !listing) continue;
    const key = listingIdentity(listing);
    if (listing.status === "withdrawn") live.delete(key);
    else live.set(key, true);
  }
  return new Set(live.keys());
}

function currentGuildNames(ordered: readonly StoredUpdate[]): Set<string> {
  const live = new Map<string, true>();
  for (const update of ordered) {
    const guild = update.document.payload.guild;
    if (update.document.payload.kind !== "guild" || !guild) continue;
    const key = normalizeSearchQuery(guild.name);
    if (!key) continue;
    if (guild.withdrawn) live.delete(key);
    else live.set(key, true);
  }
  return new Set(live.keys());
}

/** Non-fatal. A withdraw that names nothing current still writes. */
function identityWarnings(existing: readonly StoredUpdate[], document: SignedHubDocument): string[] {
  const ordered = orderedChain(existing);
  const warnings: string[] = [];
  const listing = document.payload.listing;
  if (document.payload.kind === "listing" && listing) {
    if (!listing.listingId) {
      warnings.push(
        "Warning: set listingId on this listing. A later replace or withdraw must repeat that same listingId. Without it, the identity is the stream, category, and normalized title and owner.",
      );
    }
    if (listing.status === "withdrawn" && !currentListingIdentities(ordered).has(listingIdentity(listing))) {
      warnings.push(
        "Warning: this withdraw does not match a current listing. A withdraw must repeat the same identity form: the same listingId, or, when listingId was not set, the same stream, category, and normalized title and owner. The update was not refused.",
      );
    }
  }
  const guild = document.payload.guild;
  if (document.payload.kind === "guild" && guild?.withdrawn) {
    const name = normalizeSearchQuery(guild.name);
    if (!name || !currentGuildNames(ordered).has(name)) {
      warnings.push(
        "Warning: this withdraw does not match a current guild. A withdraw must repeat the same normalized name. The update was not refused.",
      );
    }
  }
  return warnings;
}

function defaultManifest(store: string): string {
  for (const name of ["hub-manifest.json", "manifest.json"]) {
    const info = lstatOrNull(path.join(store, name));
    if (!info) continue;
    if (info.isSymbolicLink()) throw new Error(SYMLINK);
    if (info.isFile()) return name;
  }
  throw new Error("The store has no hub-manifest.json or manifest.json.");
}

function manifestRelative(value: string): string {
  const segments = value.split("/");
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("The manifest path is not valid.");
  }
  return value;
}

function approvalsAreValid(document: SignedHubDocument): boolean {
  const keys = document.approvals.map((approval) => approval.publicKey);
  if (new Set(keys).size !== keys.length) return false;
  return document.approvals.every((approval) => approvalSignatureValid(document.payload, approval.publicKey, approval.signature));
}

function selfApproved(document: SignedHubDocument): boolean {
  const keys: string[] = [];
  for (const approval of document.approvals) {
    if (!approvalSignatureValid(document.payload, approval.publicKey, approval.signature)) continue;
    if (!keys.includes(approval.publicKey)) keys.push(approval.publicKey);
  }
  return keys.length === 1 && keys[0] === document.payload.author;
}

function withOptionalApproval(document: SignedHubDocument, key: Uint8Array | null, approve: boolean): SignedHubDocument {
  if (!key) {
    if (approve) throw new Error("Pass --keypair to sign an approval.");
    return document;
  }
  if (!approve) return document;
  return approveHubDocument(document, key);
}

function assertStoryConsent(opt: NonNullable<ReturnType<typeof parseStoryOptIn>>, repo: string): void {
  const hubId = normalizeHubRepo(repo);
  if (!hubId) throw new Error("Pass --hub-repo with an https repository URL. The hub id is that URL, not a file name.");
  if (!storyOptInSignatureValid(opt, hubId)) throw new Error("The player signature did not verify.");
}

function assertReputationConsent(link: NonNullable<ReturnType<typeof parseReputationLink>>, repo: string): void {
  const hubId = normalizeHubRepo(repo);
  if (!hubId) throw new Error("Pass --hub-repo with an https repository URL. The hub id is that URL, not a file name.");
  if (!reputationLinkSignatureValid(link, hubId)) throw new Error("The player signature did not verify.");
}

function originUrl(store: string): string {
  const remote = git(store, ["remote", "get-url", "origin"]);
  return remote.ok ? remote.stdout : "";
}

function documentFromPayload(value: unknown, key: Uint8Array | null, approve: boolean): SignedHubDocument {
  const signed = parseSignedHubDocument(value);
  if (signed) {
    if (!authorSignatureValid(signed.payload, signed.signature)) throw new Error("The author signature did not verify.");
    if (!approvalsAreValid(signed)) throw new Error("An approval signature did not verify.");
    if (key) return approveHubDocument(signed, key);
    if (approve) throw new Error("Pass --keypair to sign an approval.");
    return signed;
  }
  const payload = parseHubPayload(value);
  if (!payload) throw new Error("The payload does not match the hub update schema.");
  if (!key) throw new Error("The payload has no author signature. Pass --keypair for the author.");
  const authored = signHubPayload(payload, key);
  return withOptionalApproval({ payload: authored.payload, signature: authored.signature, approvals: [] }, key, approve);
}

function storeSnapshot(store: string, manifestRel: string): { manifest: string; head: string } {
  const manifest = readStoreFile(store, manifestRel);
  const head = git(store, ["rev-parse", "HEAD"]);
  if (!head.ok || !/^[0-9a-f]{40}$/.test(head.stdout)) throw new Error("The store is not a git repository.");
  return { manifest, head: head.stdout };
}

export function runAddUpdateCli(argv: readonly string[], hooks?: AddUpdateHooks): { code: number; stdout: string; stderr: string } {
  let storeArg = "";
  let payloadPath = "";
  let keyPath = "";
  let manifestArg = "";
  let id = "";
  let kind = "";
  let body = "";
  let author = "";
  let prevFlag: string | undefined;
  let createdAt = "";
  let pip = "";
  let listingText = "";
  let guildText = "";
  let storyOptInText = "";
  let reputationLinkText = "";
  let hubRepoFlag = "";
  let approve = false;
  let dryRun = false;
  const txs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--approve") {
      approve = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) return fail(USAGE);
    if (arg === "--store") storeArg = next;
    else if (arg === "--payload") payloadPath = next;
    else if (arg === "--keypair") keyPath = next;
    else if (arg === "--manifest") manifestArg = next;
    else if (arg === "--id") id = next;
    else if (arg === "--kind") kind = next;
    else if (arg === "--body") body = next;
    else if (arg === "--author") author = next;
    else if (arg === "--prev") prevFlag = next;
    else if (arg === "--created-at") createdAt = next;
    else if (arg === "--pip") pip = next;
    else if (arg === "--listing") listingText = next;
    else if (arg === "--guild") guildText = next;
    else if (arg === "--story-optin") storyOptInText = next;
    else if (arg === "--reputation-link") reputationLinkText = next;
    else if (arg === "--hub-repo") hubRepoFlag = next;
    else if (arg === "--tx") txs.push(next);
    else return fail(USAGE);
    index += 1;
  }

  const flagPayload = Boolean(
    id ||
      kind ||
      body ||
      author ||
      createdAt ||
      pip ||
      listingText ||
      guildText ||
      storyOptInText ||
      reputationLinkText ||
      txs.length > 0 ||
      prevFlag !== undefined,
  );
  if (!storeArg || (payloadPath ? flagPayload : !id || !kind || !body)) return fail(USAGE);

  let key: Uint8Array | null = null;
  let lockPath: string | null = null;
  try {
    const store = assertStore(storeArg);
    lockPath = acquireLock(store);
    const manifestRel = manifestArg ? manifestRelative(manifestArg) : defaultManifest(store);
    const hubRepo = hubRepoFlag || originUrl(store);
    if (keyPath) key = readSolanaKeyFile(assertKeyFile(keyPath, store));
    const seen = storeSnapshot(store, manifestRel);
    const existing = loadStore(store, manifestRel);
    const tip = chainTip(existing);
    let document: SignedHubDocument;
    if (payloadPath) {
      document = documentFromPayload(readJson(payloadPath), key, approve);
    } else {
      const payloadAuthor = author || (key ? solanaKeyAddress(key) : "");
      if (!payloadAuthor) throw new Error("Pass --author or --keypair.");
      const prev = prevFlag === undefined ? tip : prevFlag === "null" ? null : prevFlag;
      if (listingText && kind !== "listing") throw new Error("--listing is only valid when --kind is listing.");
      if (kind === "listing" && !listingText) throw new Error("Pass --listing with the listing JSON.");
      if (guildText && kind !== "guild") throw new Error("--guild is only valid when --kind is guild.");
      if (kind === "guild" && !guildText) throw new Error("Pass --guild with the guild JSON.");
      if (storyOptInText && kind !== "story-optin") throw new Error("--story-optin is only valid when --kind is story-optin.");
      if (kind === "story-optin" && !storyOptInText) throw new Error("Pass --story-optin with the opt-in JSON.");
      if (reputationLinkText && kind !== "reputation-link") {
        throw new Error("--reputation-link is only valid when --kind is reputation-link.");
      }
      if (kind === "reputation-link" && !reputationLinkText) throw new Error("Pass --reputation-link with the link JSON.");
      if (kind === "guild" && guildBodyProblem(body)) {
        throw new Error("A guild listing cannot include a wallet address or a price.");
      }
      let listing: unknown;
      if (listingText) {
        try {
          listing = JSON.parse(listingText) as unknown;
        } catch {
          throw new Error("The listing JSON could not be read.");
        }
        const inspected = inspectListing(listing);
        if (!inspected.ok) throw new Error(listingFailureMessage(inspected.reason));
      }
      let guild: unknown;
      if (guildText) {
        try {
          guild = JSON.parse(guildText) as unknown;
        } catch {
          throw new Error("The guild JSON could not be read.");
        }
        const inspected = inspectGuild(guild);
        if (!inspected.ok) throw new Error(guildFailureMessage(inspected.reason));
      }
      let storyOptIn: unknown;
      if (storyOptInText) {
        try {
          storyOptIn = JSON.parse(storyOptInText) as unknown;
        } catch {
          throw new Error("The story opt-in JSON could not be read.");
        }
        const parsed = parseStoryOptIn(storyOptIn);
        if (!parsed) throw new Error("The story opt-in does not match the schema.");
        assertStoryConsent(parsed, hubRepo);
      }
      let reputationLink: unknown;
      if (reputationLinkText) {
        try {
          reputationLink = JSON.parse(reputationLinkText) as unknown;
        } catch {
          throw new Error("The reputation link JSON could not be read.");
        }
        const parsed = parseReputationLink(reputationLink);
        if (!parsed) throw new Error("The reputation link does not match the schema.");
        assertReputationConsent(parsed, hubRepo);
      }
      const payload = parseHubPayload({
        v: 1,
        id,
        created_at: createdAt || new Date().toISOString(),
        author: payloadAuthor,
        kind,
        body,
        refs: { pip: pip || null, txs },
        prev,
        ...(listingText ? { listing } : {}),
        ...(guildText ? { guild } : {}),
        ...(storyOptInText ? { storyOptIn } : {}),
        ...(reputationLinkText ? { reputationLink } : {}),
      });
      if (!payload) throw new Error("The payload does not match the hub update schema.");
      if (!key) throw new Error("The payload has no author signature. Pass --keypair for the author.");
      const authored = signHubPayload(payload, key);
      document = withOptionalApproval({ payload: authored.payload, signature: authored.signature, approvals: [] }, key, approve);
    }
    if (document.payload.kind === "story-optin" && document.payload.storyOptIn) {
      assertStoryConsent(document.payload.storyOptIn, hubRepo);
    }
    if (document.payload.kind === "reputation-link" && document.payload.reputationLink) {
      assertReputationConsent(document.payload.reputationLink, hubRepo);
    }
    if (document.payload.prev !== tip) {
      throw new Error(
        tip === null
          ? "The payload prev must be null when the store has no updates."
          : `The payload prev does not match the store tip ${tip}.`,
      );
    }
    const relative = `updates/${document.payload.id}.json`;
    if (!inside(store, relative)) throw new Error("The update path is not valid.");
    if (existing.some((update) => update.relative === relative || update.document.payload.id === document.payload.id)) {
      throw new Error("The store already has this update.");
    }
    storePath(store, relative, "absent");
    storePath(store, manifestRel, "file");
    const nextPaths = [...existing.map((update) => update.relative), relative];
    const manifestText = formatHubStoreManifest(nextPaths);
    const manifestHash = createHash("sha256").update(manifestText).digest("hex");
    const payloadSha256 = hubUpdateHash(document.payload);
    const approvedByAuthor = selfApproved(document);
    const report: Report = {
      dryRun,
      path: relative,
      payloadSha256,
      manifestHash,
      commit: null,
      selfApproved: approvedByAuthor,
    };
    const warnings = [
      key ? "Detached signature only. The key file must hold no funds." : "",
      approvedByAuthor
        ? "Warning: the author key is the only approver (self-approved). Threshold 1 allows this on testnet. At threshold 2 or higher the author approval does not count unless HUB_ALLOW_AUTHOR_APPROVAL is set."
        : "",
      ...identityWarnings(existing, document),
    ].filter(Boolean);
    if (dryRun) {
      report.document = document;
      report.manifest = { v: 1, updates: nextPaths };
      warnings.push("Dry run. Nothing was written.");
      return { code: 0, stdout: `${JSON.stringify(report, null, 2)}\n`, stderr: warnings.length ? `${warnings.join("\n")}\n` : "" };
    }
    const email = git(store, ["config", "user.email"]);
    const name = git(store, ["config", "user.name"]);
    if (!email.ok || !email.stdout || !name.ok || !name.stdout) {
      throw new Error("Set user.name and user.email in the hub store repository before committing.");
    }
    hooks?.beforeCommit?.(store);
    const again = storeSnapshot(store, manifestRel);
    if (again.manifest !== seen.manifest || again.head !== seen.head) {
      throw new Error("The hub store changed before the commit. Nothing was written.");
    }
    const documentText = `${JSON.stringify(document, null, 2)}\n`;
    writeStoreFile(store, relative, documentText, "create", hooks);
    writeStoreFile(store, manifestRel, manifestText, "replace", hooks);
    const added = git(store, ["add", "--", relative, manifestRel]);
    if (!added.ok) throw new Error("The update files were written but the commit failed.");
    const committed = git(store, ["commit", "-m", `Add hub update ${document.payload.id}`, "--", relative, manifestRel]);
    if (!committed.ok) throw new Error("The update files were written but the commit failed.");
    const head = git(store, ["rev-parse", "HEAD"]);
    if (!head.ok || !/^[0-9a-f]{40}$/.test(head.stdout)) throw new Error("The update files were written but the commit failed.");
    report.commit = head.stdout;
    return { code: 0, stdout: `${JSON.stringify(report, null, 2)}\n`, stderr: warnings.length ? `${warnings.join("\n")}\n` : "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The hub update could not be written.";
    return fail(message.length > 400 ? "The hub update could not be written." : message);
  } finally {
    if (lockPath) releaseLock(lockPath);
    key?.fill(0);
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectRun()) {
  const result = runAddUpdateCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
