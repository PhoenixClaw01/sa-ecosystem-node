import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { parseClaim, type ClaimSubject } from "./claim.js";
import { normalizeWalletSignature, readSolanaKeyFile, signHubPayload, solanaKeyAddress } from "./sign-cli.js";
import { normalizeHubRepo } from "./story-optin.js";
import {
  authorSignatureValid,
  hubUpdateSigningMessage,
  parseHubPayload,
  parseSignedHubDocument,
  type SignedHubDocument,
} from "./update.js";

/**
 * Build an unsigned claim and check a wallet signature locally.
 * The wallet signs the printed message. This command reads a secret only
 * when --key-path is set, and only then for a local test key.
 */

const USAGE = [
  "Usage: npm run hub-claim -- build --wallet <address> --hub <https-repo> --subject <player|guild|business> (--listing-id <id> | --guild-name <name>) --nonce <nonce> --expires <time> [--profile <address>] [--x-handle <handle> --x-proof <url>] [--discord-note <text>] [--show-handles] [--id <id>] [--prev <hash>] [--out <file>]",
  "       npm run hub-claim -- verify --file <signed.json> [--hub <https-repo>]",
  "       npm run hub-claim -- attach --payload <file> --public-key <address> --signature <signature> [--out <file>]",
  "       npm run hub-claim -- sign --payload <file> --key-path <solana.json> [--out <file>]",
].join("\n");

function fail(message: string): { code: number; stdout: string; stderr: string } {
  return { code: 1, stdout: "", stderr: `${message}\n` };
}

function flag(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  if (index < 0) return "";
  return argv[index + 1] ?? "";
}

function has(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

export function runClaimCli(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  const command = argv[0] ?? "";
  try {
    if (command === "build") return build(argv.slice(1));
    if (command === "verify") return verify(argv.slice(1));
    if (command === "attach") return attach(argv.slice(1));
    if (command === "sign") return sign(argv.slice(1));
    return fail(USAGE);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The claim command failed.");
  }
}

function build(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  const wallet = flag(argv, "--wallet");
  const hub = normalizeHubRepo(flag(argv, "--hub"));
  const subject = flag(argv, "--subject");
  const listingId = flag(argv, "--listing-id");
  const guildName = flag(argv, "--guild-name");
  const nonce = flag(argv, "--nonce");
  const expires = flag(argv, "--expires");
  if (!hub) return fail("Pass --hub with the https repository URL.");
  if (subject !== "player" && subject !== "guild" && subject !== "business") {
    return fail("Pass --subject player, guild, or business.");
  }
  const claim = parseClaim(claimObject({
    wallet,
    hub,
    subject,
    listingId,
    guildName,
    nonce,
    expires,
    profile: flag(argv, "--profile"),
    xHandle: flag(argv, "--x-handle"),
    xProof: flag(argv, "--x-proof"),
    discordNote: flag(argv, "--discord-note"),
    discordHandle: flag(argv, "--discord-handle"),
    discordInvite: flag(argv, "--discord-invite"),
    showHandles: has(argv, "--show-handles"),
  }));
  if (!claim) return fail("The claim fields do not match the schema.");
  const payload = parseHubPayload({
    v: 1,
    id: flag(argv, "--id") || `claim-${nonce}`,
    created_at: flag(argv, "--created-at") || new Date().toISOString(),
    author: wallet,
    kind: "claim",
    body: "Claim for this listing.",
    refs: { pip: null, txs: [] },
    prev: flag(argv, "--prev") || null,
    claim,
  });
  if (!payload) return fail("The claim payload does not match the hub update schema.");
  const message = new TextDecoder().decode(hubUpdateSigningMessage(payload));
  const text = `${JSON.stringify({ payload, message: { utf8: message, hex: Buffer.from(message).toString("hex") } }, null, 2)}\n`;
  const out = flag(argv, "--out");
  if (out) writeFileSync(out, text);
  return {
    code: 0,
    stdout: out ? "" : text,
    stderr: "Sign the utf8 message with the claimant wallet. Then run attach with the public key and the signature.\n",
  };
}

function verify(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  const file = flag(argv, "--file");
  if (!file) return fail("Pass --file with the signed claim.");
  const document = parseSignedHubDocument(readJson(file));
  if (!document || document.payload.kind !== "claim" || !document.payload.claim) {
    return fail("The file is not a claim document.");
  }
  if (!authorSignatureValid(document.payload, document.signature)) return fail("The claim signature did not verify.");
  const hub = flag(argv, "--hub");
  if (hub) {
    const id = normalizeHubRepo(hub);
    if (!id || id !== document.payload.claim.hubId) return fail("The claim names a different hub.");
  }
  const claim = document.payload.claim;
  return {
    code: 0,
    stdout: `${JSON.stringify({ ok: true, id: document.payload.id, wallet: claim.wallet, subject: claim.subject, hubId: claim.hubId, expiresAt: claim.expiresAt }, null, 2)}\n`,
    stderr: "",
  };
}

function attach(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  const payload = parseHubPayload(payloadValue(readJson(flag(argv, "--payload"))));
  if (!payload || payload.kind !== "claim") return fail("Pass --payload with an unsigned claim payload.");
  const publicKey = flag(argv, "--public-key").trim();
  if (publicKey !== payload.author) return fail("The public key does not match the payload author.");
  let signature: string;
  try {
    signature = normalizeWalletSignature(flag(argv, "--signature"));
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The signature could not be read.");
  }
  if (!authorSignatureValid(payload, signature)) return fail("The claim signature did not verify.");
  return writeSigned({ payload, signature, approvals: [] }, flag(argv, "--out"));
}

function sign(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  const keyPath = flag(argv, "--key-path");
  if (!keyPath) return fail("Pass --key-path with a Solana JSON key file.");
  const payload = parseHubPayload(payloadValue(readJson(flag(argv, "--payload"))));
  if (!payload) return fail("Pass --payload with an unsigned claim payload.");
  const key = readSolanaKeyFile(keyPath);
  if (solanaKeyAddress(key) !== payload.author) return fail("The key does not match the payload author.");
  const signed = signHubPayload(payload, key);
  return writeSigned({ payload: signed.payload, signature: signed.signature, approvals: [] }, flag(argv, "--out"));
}

function writeSigned(document: SignedHubDocument, out: string): { code: number; stdout: string; stderr: string } {
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (out) writeFileSync(out, text);
  return { code: 0, stdout: out ? "" : text, stderr: `Wrote claim ${document.payload.id}\n` };
}

function claimObject(input: {
  wallet: string;
  hub: string;
  subject: ClaimSubject;
  listingId: string;
  guildName: string;
  nonce: string;
  expires: string;
  profile: string;
  xHandle: string;
  xProof: string;
  discordNote: string;
  discordHandle: string;
  discordInvite: string;
  showHandles: boolean;
}): unknown {
  const identity = input.subject === "guild" ? { type: "guild", name: input.guildName } : { type: "listing", listingId: input.listingId };
  const discord = input.discordNote
    ? {
        note: input.discordNote,
        ...(input.discordHandle ? { handle: input.discordHandle } : {}),
        ...(input.discordInvite ? { invite: input.discordInvite } : {}),
      }
    : undefined;
  const x = input.xHandle || input.xProof ? { handle: input.xHandle, proofUrl: input.xProof } : undefined;
  return {
    action: "claim",
    wallet: input.wallet,
    hubId: input.hub,
    nonce: input.nonce,
    expiresAt: input.expires,
    subject: input.subject,
    identity,
    ...(input.profile ? { playerProfile: input.profile } : {}),
    ...(x ? { x } : {}),
    ...(discord ? { discord } : {}),
    ...(input.showHandles ? { showHandles: true } : {}),
  };
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const result = runClaimCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

function payloadValue(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) && "payload" in value && !("v" in value)) {
    return (value as { payload: unknown }).payload;
  }
  return value;
}

function readJson(file: string): unknown {
  if (!file) throw new Error("Pass a JSON file.");
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    throw new Error("The JSON file could not be read.");
  }
}
