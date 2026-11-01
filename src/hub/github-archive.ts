import { gunzipSync } from "node:zlib";

import { SafeClientError } from "../errors.js";

/** Compressed GitHub archive cap. A larger body is refused before it is stored. */
export const HUB_ARCHIVE_MAX_BYTES = 16 * 1024 * 1024;

/** Uncompressed tar cap. Stops a small gzip from expanding without a bound. */
export const HUB_ARCHIVE_UNCOMPRESSED_MAX_BYTES = 20 * 1024 * 1024;

/** Same budget the git checkout uses for one fetch. */
export const HUB_FETCH_TIMEOUT_MS = 20_000;

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
/** Regular files only. Directory and pax headers do not count toward this cap. */
export const HUB_ARCHIVE_MAX_FILES = 4096;
/** Every ustar header, including pax and directory headers. */
export const HUB_ARCHIVE_MAX_HEADERS = 8192;
const MAX_PAX_BYTES = 8192;
const MAX_HEADER_NAME = 512;

const READ_ERROR = "The hub git store could not be read. No updates were returned.";
const COMMIT_ERROR = "The hub store commit did not match the pin. No updates were returned.";
const TOO_MANY = "The hub archive has too many entries. No updates were returned.";

export interface GithubRepo {
  owner: string;
  name: string;
}

/**
 * `https://github.com/owner/repo` or the same URL with a trailing `.git` or slash.
 * The host is exactly github.com. Userinfo, a query, a hash, and any other host are refused.
 */
export function parseGithubRepo(repo: string): GithubRepo | null {
  if (!repo.startsWith("https://") || repo.startsWith("-") || /\s/.test(repo)) return null;
  let parsed: URL;
  try {
    parsed = new URL(repo);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.port) return null;
  const match = /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_][A-Za-z0-9._-]{0,99})(?:\.git)?\/?$/.exec(
    parsed.pathname,
  );
  if (!match) return null;
  const owner = match[1] ?? "";
  let name = match[2] ?? "";
  if (name.toLowerCase().endsWith(".git")) name = name.slice(0, -4);
  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(name) || name.includes("..") || name.endsWith(".")) return null;
  return { owner, name };
}

interface ArchiveEntry {
  segments: string[];
  bytes: Buffer | null;
  directory: boolean;
}

/**
 * Download one public GitHub commit as a tar.gz and return the files under that commit.
 * The request starts at github.com. The only redirect that is followed is the matching
 * `codeload.github.com` tarball for the same owner, repository, and commit. The archive's
 * pax comment and root directory must both name that commit. Symlinks, gitdirs, and `..`
 * paths refuse the whole read.
 */
export async function fetchGithubArchive(
  repo: string,
  commit: string,
  maxFileBytes: number,
  fetchImpl: typeof fetch,
): Promise<{ files: Map<string, Buffer | null>; sourceUrl: string }> {
  if (!COMMIT_PATTERN.test(commit)) refuse(COMMIT_ERROR);
  const parsed = parseGithubRepo(repo);
  if (!parsed) refuse(READ_ERROR);
  const signal = AbortSignal.timeout(HUB_FETCH_TIMEOUT_MS);
  const first = archiveUrl(parsed, commit, 0);
  const second = archiveUrl(parsed, commit, 1);
  let response: Response;
  try {
    response = await fetchImpl(first, fetchInit(signal));
  } catch {
    refuse(READ_ERROR);
  }
  if (isRedirect(response.status)) {
    const location = response.headers.get("location");
    if (!location || !codeloadRedirectAllowed(location, parsed, commit)) refuse(READ_ERROR);
    try {
      response = await fetchImpl(second, fetchInit(signal));
    } catch {
      refuse(READ_ERROR);
    }
  }
  if (isRedirect(response.status) || response.status !== 200) refuse(READ_ERROR);
  const disposition = response.headers.get("content-disposition");
  if (disposition !== null) {
    if (disposition.length > 500) refuse(READ_ERROR);
    const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
    if (!filename || !filename.endsWith(`-${commit}.tar.gz`)) refuse(COMMIT_ERROR);
  }
  let compressed: Buffer;
  try {
    compressed = await readLimited(response, HUB_ARCHIVE_MAX_BYTES);
  } catch (error) {
    if (error instanceof SafeClientError) throw error;
    refuse(READ_ERROR);
  }
  let uncompressed: Buffer;
  try {
    uncompressed = gunzipSync(compressed, { maxOutputLength: HUB_ARCHIVE_UNCOMPRESSED_MAX_BYTES });
  } catch {
    refuse(READ_ERROR);
  }
  const entries = parseTar(uncompressed, maxFileBytes);
  return { files: filesForCommit(entries, commit), sourceUrl: repo };
}

function fetchInit(signal: AbortSignal) {
  return {
    method: "GET" as const,
    redirect: "manual" as const,
    cache: "no-store" as const,
    credentials: "omit" as const,
    signal,
    headers: {
      accept: "application/gzip",
      "user-agent": "sa-ecosystem-node",
    },
  };
}

function archiveUrl(repo: GithubRepo, commit: string, hop: 0 | 1): string {
  const owner = encodeURIComponent(repo.owner);
  const name = encodeURIComponent(repo.name);
  if (hop === 0) return `https://github.com/${owner}/${name}/archive/${commit}.tar.gz`;
  return `https://codeload.github.com/${owner}/${name}/tar.gz/${commit}`;
}

/**
 * The redirect must be the codeload tarball for this owner, repository, and commit.
 * Owner and repository are compared case-insensitively. The caller still fetches
 * the URL it built, not the Location header.
 */
function codeloadRedirectAllowed(location: string, repo: GithubRepo, commit: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(location);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.port) return false;
  if (parsed.protocol !== "https:" || parsed.hostname !== "codeload.github.com") return false;
  const parts = parsed.pathname.split("/");
  if (parts.length !== 5 || parts[0] !== "" || parts[3] !== "tar.gz" || parts[4] !== commit) return false;
  const owner = parts[1] ?? "";
  const name = parts[2] ?? "";
  return owner.toLowerCase() === repo.owner.toLowerCase() && name.toLowerCase() === repo.name.toLowerCase();
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readLimited(response: Response, max: number): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^[0-9]+$/.test(declared)) refuse(READ_ERROR);
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size > max) refuse(READ_ERROR);
  }
  const body = response.body;
  if (!body) refuse(READ_ERROR);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      refuse(READ_ERROR);
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks, total);
}

function parseTar(buffer: Buffer, maxFileBytes: number): { comment: string | null; entries: ArchiveEntry[] } {
  let offset = 0;
  let headers = 0;
  let files = 0;
  let pendingName: string | null = null;
  let comment: string | null = null;
  const entries: ArchiveEntry[] = [];

  while (offset < buffer.length) {
    if (offset + 512 > buffer.length) refuse(READ_ERROR);
    const header = buffer.subarray(offset, offset + 512);
    offset += 512;
    if (isZero(header)) {
      const next = buffer.subarray(offset, offset + 512);
      if (next.length === 512 && isZero(next)) {
        offset += 512;
        break;
      }
      if (next.length === 0) break;
      refuse(READ_ERROR);
    }
    const stored = readOctal(header, 148, 8);
    if (stored === null || stored !== headerChecksum(header)) refuse(READ_ERROR);
    headers += 1;
    if (headers > HUB_ARCHIVE_MAX_HEADERS) refuse(TOO_MANY);
    if ((header[124] & 0x80) !== 0) refuse(READ_ERROR);
    const size = readOctal(header, 124, 12);
    if (size === null || size > buffer.length - offset) refuse(READ_ERROR);
    const payload = buffer.subarray(offset, offset + size);
    offset += size;
    const padding = size % 512 === 0 ? 0 : 512 - (size % 512);
    if (offset + padding > buffer.length) refuse(READ_ERROR);
    offset += padding;

    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156] ?? 0);
    if (type === "g") {
      if (size > MAX_PAX_BYTES) refuse(READ_ERROR);
      const records = parsePax(payload);
      if (records.has("size") || records.has("path") || records.has("linkpath")) refuse(READ_ERROR);
      const value = records.get("comment");
      if (value !== undefined) {
        if (comment !== null && comment !== value) refuse(COMMIT_ERROR);
        comment = value;
      }
      continue;
    }
    if (type === "x" || type === "L") {
      if (size > MAX_PAX_BYTES) refuse(READ_ERROR);
      if (type === "x") {
        const records = parsePax(payload);
        if (records.has("size")) refuse(READ_ERROR);
        const name = records.get("path");
        if (name !== undefined && name.length > MAX_HEADER_NAME) refuse(READ_ERROR);
        pendingName = name ?? null;
      } else {
        const name = payload.toString("utf8").replace(/\0+$/g, "");
        if (name.length > MAX_HEADER_NAME) refuse(READ_ERROR);
        pendingName = name;
      }
      continue;
    }
    if (type !== "0" && type !== "5") refuse(READ_ERROR);
    const ustarName = tarName(header);
    const name = pendingName ?? ustarName;
    pendingName = null;
    if (name.length > MAX_HEADER_NAME) refuse(READ_ERROR);
    const segments = safeSegments(name);
    if (!segments) refuse(READ_ERROR);
    if (type === "5") {
      entries.push({ segments, bytes: null, directory: true });
      continue;
    }
    files += 1;
    if (files > HUB_ARCHIVE_MAX_FILES) refuse(TOO_MANY);
    entries.push({
      segments,
      bytes: size > maxFileBytes ? null : Buffer.from(payload),
      directory: false,
    });
  }
  if (offset < buffer.length && !isZero(buffer.subarray(offset))) refuse(READ_ERROR);
  return { comment, entries };
}

function filesForCommit(parsed: { comment: string | null; entries: ArchiveEntry[] }, commit: string): Map<string, Buffer | null> {
  if (parsed.comment !== commit) refuse(COMMIT_ERROR);
  const prefix = new RegExp(`^[A-Za-z0-9._-]{1,100}-${commit}$`);
  let root: string | null = null;
  const files = new Map<string, Buffer | null>();
  for (const entry of parsed.entries) {
    const first = entry.segments[0];
    if (!first || !prefix.test(first)) refuse(COMMIT_ERROR);
    if (root === null) root = first;
    if (first !== root) refuse(COMMIT_ERROR);
    if (entry.directory || entry.segments.length === 1) continue;
    const relative = entry.segments.slice(1).join("/");
    if (relative.length > 200) refuse(READ_ERROR);
    if (files.has(relative)) refuse(READ_ERROR);
    files.set(relative, entry.bytes);
  }
  if (root === null) refuse(COMMIT_ERROR);
  return files;
}

function safeSegments(name: string): string[] | null {
  if (name.length === 0 || name.includes("\\") || /[\0\r\n]/.test(name) || name.startsWith("/")) return null;
  const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
  if (trimmed.length === 0) return null;
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment === ".git")) return null;
  return segments;
}

function tarName(header: Buffer): string {
  const name = textField(header, 0, 100);
  const prefix = textField(header, 345, 155);
  if (name === null || prefix === null) refuse(READ_ERROR);
  return prefix.length > 0 ? `${prefix}/${name}` : name;
}

function textField(header: Buffer, start: number, length: number): string | null {
  let end = start;
  const stop = start + length;
  while (end < stop && header[end] !== 0) end += 1;
  const value = header.toString("utf8", start, end);
  if (value.includes("\0")) return null;
  return value;
}

function parsePax(body: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < body.length && body[offset] !== 0) {
    let space = offset;
    while (space < body.length && body[space] !== 0x20) space += 1;
    if (space >= body.length) refuse(READ_ERROR);
    const lengthText = body.toString("utf8", offset, space);
    if (!/^[0-9]+$/.test(lengthText)) refuse(READ_ERROR);
    const length = Number(lengthText);
    if (!Number.isInteger(length) || length < 4 || offset + length > body.length) refuse(READ_ERROR);
    const record = body.toString("utf8", offset, offset + length);
    if (!record.endsWith("\n")) refuse(READ_ERROR);
    const eq = record.indexOf("=");
    const keyStart = space - offset + 1;
    if (eq <= keyStart) refuse(READ_ERROR);
    const key = record.slice(keyStart, eq);
    const value = record.slice(eq + 1, -1);
    if (key.length === 0 || key.includes("\0") || value.includes("\0")) refuse(READ_ERROR);
    records.set(key, value);
    offset += length;
  }
  return records;
}

function headerChecksum(header: Buffer): number {
  let sum = 0;
  for (let index = 0; index < 512; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
  }
  return sum;
}

function readOctal(header: Buffer, start: number, length: number): number | null {
  let end = start;
  const stop = start + length;
  while (end < stop && header[end] !== 0 && header[end] !== 32) end += 1;
  if (end === start) return null;
  let value = 0;
  for (let index = start; index < end; index += 1) {
    const byte = header[index] ?? 0;
    if (byte < 48 || byte > 55) return null;
    value = value * 8 + (byte - 48);
    if (!Number.isSafeInteger(value)) return null;
  }
  return value;
}

function isZero(buffer: Buffer): boolean {
  for (const byte of buffer) {
    if (byte !== 0) return false;
  }
  return true;
}

function refuse(message: string): never {
  throw new SafeClientError(message);
}
