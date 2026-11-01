import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class LocalPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalPathError";
  }
}

export const PATH_INSIDE_REPO = "Refusing to write inside this repository.";
export const PATH_SYMLINK = "Refusing to follow a symlink.";
export const PATH_EXISTS = "The destination already exists.";
export const PATH_NOT_DIR = "The destination is not a directory.";
export const PATH_NO_PARENT = "The destination directory does not exist.";
export const PATH_NOT_EMPTY = "The destination is not empty.";
export const PATH_INVALID = "The destination path is not valid.";

export function nodeRepoRoot(from = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = path.resolve(from);
  for (let hop = 0; hop < 8; hop += 1) {
    try {
      const info = statSync(path.join(dir, ".git"));
      if (info.isDirectory() || info.isFile()) return realpathSync(dir);
    } catch {
      // Keep walking until the work tree root.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new LocalPathError("The repository root could not be found.");
}

function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function canonicalDestination(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  const root = path.parse(resolved).root;
  let current = realpathSync(root);
  const parts = resolved.slice(root.length).split(path.sep).filter((part) => part.length > 0);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? "";
    const next = path.join(current, part);
    const isLast = index === parts.length - 1;
    let info;
    try {
      info = lstatSync(next);
    } catch {
      return path.join(current, ...parts.slice(index));
    }
    if (info.isSymbolicLink()) {
      if (isLast) return next;
      const target = realpathSync(next);
      if (!statSync(target).isDirectory()) throw new LocalPathError(PATH_INVALID);
      current = target;
      continue;
    }
    if (info.isDirectory()) {
      current = next;
      continue;
    }
    if (!isLast) throw new LocalPathError(PATH_INVALID);
    return next;
  }
  return current;
}

function assertOutsideRepo(lexical: string, destination: string): void {
  const repo = nodeRepoRoot();
  if (contains(repo, lexical) || contains(repo, destination)) throw new LocalPathError(PATH_INSIDE_REPO);
  try {
    const parentReal = realpathSync(path.dirname(destination));
    if (contains(repo, path.join(parentReal, path.basename(destination)))) throw new LocalPathError(PATH_INSIDE_REPO);
  } catch (error) {
    if (error instanceof LocalPathError) throw error;
  }
}

/** Path for a new file. Refuses this repository, existing files, and symlinks. */
export function safeNewFilePath(inputPath: string): string {
  if (inputPath.length === 0 || inputPath.includes("\0")) throw new LocalPathError(PATH_INVALID);
  const lexical = path.resolve(inputPath);
  const destination = canonicalDestination(inputPath);
  assertOutsideRepo(lexical, destination);
  try {
    const info = lstatSync(destination);
    if (info.isSymbolicLink()) {
      if (contains(nodeRepoRoot(), realpathSync(destination))) throw new LocalPathError(PATH_INSIDE_REPO);
      throw new LocalPathError(PATH_SYMLINK);
    }
    throw new LocalPathError(PATH_EXISTS);
  } catch (error) {
    if (error instanceof LocalPathError) throw error;
    if ((error as { code?: string }).code !== "ENOENT") throw new LocalPathError(PATH_INVALID);
  }
  const parent = path.dirname(destination);
  try {
    if (!statSync(parent).isDirectory()) throw new LocalPathError(PATH_NO_PARENT);
  } catch (error) {
    if (error instanceof LocalPathError) throw error;
    throw new LocalPathError(PATH_NO_PARENT);
  }
  const parentReal = realpathSync(parent);
  const finalPath = path.join(parentReal, path.basename(destination));
  assertOutsideRepo(lexical, finalPath);
  return finalPath;
}

/** Path for a new directory. An existing empty directory is reused. */
export function safeNewDirectory(inputPath: string): { path: string; exists: boolean } {
  if (inputPath.length === 0 || inputPath.includes("\0")) throw new LocalPathError(PATH_INVALID);
  const lexical = path.resolve(inputPath);
  const destination = canonicalDestination(inputPath);
  assertOutsideRepo(lexical, destination);
  try {
    const info = lstatSync(destination);
    if (info.isSymbolicLink()) {
      if (contains(nodeRepoRoot(), realpathSync(destination))) throw new LocalPathError(PATH_INSIDE_REPO);
      throw new LocalPathError(PATH_SYMLINK);
    }
    if (!info.isDirectory()) throw new LocalPathError(PATH_NOT_DIR);
    const real = realpathSync(destination);
    assertOutsideRepo(lexical, real);
    return { path: real, exists: true };
  } catch (error) {
    if (error instanceof LocalPathError) throw error;
    if ((error as { code?: string }).code !== "ENOENT") throw new LocalPathError(PATH_INVALID);
  }
  const parent = path.dirname(destination);
  try {
    if (!statSync(parent).isDirectory()) throw new LocalPathError(PATH_NO_PARENT);
  } catch (error) {
    if (error instanceof LocalPathError) throw error;
    throw new LocalPathError(PATH_NO_PARENT);
  }
  const finalPath = path.join(realpathSync(parent), path.basename(destination));
  assertOutsideRepo(lexical, finalPath);
  return { path: finalPath, exists: false };
}
