import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, openSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import nacl from "tweetnacl";

import { formatHubSignerEntry, parseHubSigners, validHubSignerLabel } from "./allowlist.js";
import { base58Encode } from "./base58.js";
import { LocalPathError, safeNewFilePath } from "./repo-path.js";

/**
 * Writes one fresh ed25519 key for the Phoenix Collective agent.
 * The file is a Solana CLI JSON array of 64 bytes, mode 0600, outside this repository.
 * Stdout is the public key and one signers.json entry. The secret is not printed.
 * Wallet owners do not use this script.
 */

const USAGE = "Usage: npm run hub-keygen -- --label <name> --out <path>\n";

function fail(message: string): { code: number; stdout: string; stderr: string } {
  return { code: 1, stdout: "", stderr: `${message}\n` };
}

function writeKeyFile(file: string, body: string): void {
  const fd = openSync(file, "wx", 0o600);
  try {
    writeFileSync(fd, body, { encoding: "utf8" });
  } catch {
    try {
      closeSync(fd);
    } catch {
      // The descriptor is already closed.
    }
    try {
      unlinkSync(file);
    } catch {
      // The new file is already gone.
    }
    throw new Error("The private key could not be written.");
  }
  closeSync(fd);
  chmodSync(file, 0o600);
  if ((statSync(file).mode & 0o777) !== 0o600) {
    unlinkSync(file);
    throw new Error("The private key file mode could not be set to 0600.");
  }
}

export function runKeygenCli(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  let label = "";
  let outPath = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if ((arg === "--label" || arg === "--out") && next && !next.startsWith("--")) {
      if (arg === "--label") label = next;
      else outPath = next;
      index += 1;
    } else {
      return fail(USAGE.trim());
    }
  }
  if (!label || !outPath) return fail(USAGE.trim());
  if (!validHubSignerLabel(label)) return fail("The label must be 1 to 80 letters, numbers, spaces, or . ' _ - ( ).");

  let destination = "";
  try {
    destination = safeNewFilePath(outPath);
  } catch (error) {
    return fail(error instanceof LocalPathError ? error.message : "The destination path is not valid.");
  }

  const seed = randomBytes(32);
  try {
    const pair = nacl.sign.keyPair.fromSeed(seed);
    if (pair.secretKey.length !== 64 || pair.publicKey.length !== 32) {
      return fail("The key could not be generated.");
    }
    let diff = 0;
    for (let index = 0; index < 32; index += 1) diff |= (pair.secretKey[32 + index] ?? 0) ^ (pair.publicKey[index] ?? 0);
    if (diff !== 0) return fail("The key could not be generated.");
    const publicKey = base58Encode(pair.publicKey);
    const entry = formatHubSignerEntry(label, publicKey);
    parseHubSigners({ v: 1, signers: [JSON.parse(entry) as unknown] });
    writeKeyFile(destination, `${JSON.stringify(Array.from(pair.secretKey))}\n`);
    return { code: 0, stdout: `${publicKey}\n${entry}\n`, stderr: "" };
  } catch (error) {
    if (destination) {
      try {
        unlinkSync(destination);
      } catch {
        // Nothing was left behind, or the file was never created.
      }
    }
    const message = error instanceof Error ? error.message : "";
    if (message === "The private key could not be written." || message === "The private key file mode could not be set to 0600.") {
      return fail(message);
    }
    return fail("The key could not be generated.");
  } finally {
    seed.fill(0);
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectRun()) {
  const result = runKeygenCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
