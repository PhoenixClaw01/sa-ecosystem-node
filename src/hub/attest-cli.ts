import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  handleCommitment,
  normalizeDiscordAccount,
  normalizeXHandle,
  parseAttestation,
} from "./attestation.js";
import { base58Encode } from "./base58.js";
import { readSolanaKeyFile, signHubPayload, solanaKeyAddress } from "./sign-cli.js";
import { normalizeHubRepo } from "./story-optin.js";
import {
  authorSignatureValid,
  hubUpdateSigningMessage,
  parseHubPayload,
  parseSignedHubDocument,
  type SignedHubDocument,
} from "./update.js";
import { discordAuthorizeUrl, discordIdentify, discordVerifierConfig } from "./verifier/discord-oauth.js";
import { bindAttestationState, parseVerifierProof, readAttestationState, type VerifierProof } from "./verifier/proof.js";
import { fetchPostedCode, isStatusUrl } from "./verifier/x-proof.js";

/**
 * Operator tool for portable verifier attestations.
 * Discord OAuth is off unless DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and
 * DISCORD_REDIRECT_URI are all set. X is a posted-code check of a public status URL.
 * The salt is printed once and is not stored in the hub record.
 */

const USAGE = [
  "Usage: npm run hub-attest -- build --proof-file <proof.json> --verifier-key <address> --verifier-id <id> --wallet <address> --hub <https-repo> --method <discord|x> --nonce <nonce> --issued <time> --expires <time> [--proof <url>] [--show-handle] [--out <file>]",
  "       npm run hub-attest -- verify --file <signed.json> [--hub <https-repo>]",
  "       npm run hub-attest -- sign --payload <file> --key-path <solana.json> [--out <file>]",
  "       npm run hub-attest -- revoke --verifier-key <address> --verifier-id <id> --wallet <address> --hub <https-repo> --method <discord|x> --target <id> --nonce <nonce> --issued <time> --expires <time>",
  "       npm run hub-attest -- discord-url --wallet <address> --nonce <nonce>",
  "       npm run hub-attest -- discord-code --code <code> --state <state> --wallet <address> --nonce <nonce>",
  "       npm run hub-attest -- x-check --post <url> --code <code> --account <handle> --wallet <address> --nonce <nonce>",
].join("\n");

function fail(message: string): { code: number; stdout: string; stderr: string } {
  return { code: 1, stdout: "", stderr: `${message}\n` };
}

function flag(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  if (index < 0) return "";
  return argv[index + 1] ?? "";
}

export async function runAttestCli(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = argv[0] ?? "";
  try {
    if (command === "build") return build(argv.slice(1));
    if (command === "verify") return verify(argv.slice(1));
    if (command === "sign") return sign(argv.slice(1));
    if (command === "revoke") return revoke(argv.slice(1));
    if (command === "discord-url") return discordUrl(argv.slice(1));
    if (command === "discord-code") return await discordCode(argv.slice(1));
    if (command === "x-check") return await xCheck(argv.slice(1));
    return fail(USAGE);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The attestation command failed.");
  }
}

function build(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  const method = flag(argv, "--method");
  if (method !== "discord" && method !== "x") return fail("Pass --method discord or x.");
  const proof = parseVerifierProof(readJson(flag(argv, "--proof-file")));
  if (!proof) return fail("Pass --proof-file from discord-code or x-check.");
  if (proof.method !== method || proof.wallet !== flag(argv, "--wallet") || proof.nonce !== flag(argv, "--nonce")) {
    return fail("The proof does not match this wallet, nonce, and method.");
  }
  const account = method === "discord" ? normalizeDiscordAccount(proof.account) : normalizeXHandle(proof.account);
  if (!account) return fail("The proof account is not usable.");
  const commitment = handleCommitment(proof.salt, account);
  const showHandle = argv.includes("--show-handle") && !/^\d{17,20}$/.test(account);
  const attestation = parseAttestation({
    action: "attest",
    wallet: flag(argv, "--wallet"),
    hubId: normalizeHubRepo(flag(argv, "--hub")) ?? "",
    nonce: flag(argv, "--nonce"),
    issuedAt: flag(argv, "--issued"),
    expiresAt: flag(argv, "--expires"),
    method,
    verifierId: flag(argv, "--verifier-id"),
    handleCommitment: commitment,
    ...(showHandle ? { handle: account } : {}),
    ...(flag(argv, "--proof") ? { proofUrl: flag(argv, "--proof") } : {}),
  });
  if (!attestation) return fail("The attestation fields do not match the schema.");
  const author = flag(argv, "--verifier-key");
  const payload = parseHubPayload({
    v: 1,
    id: flag(argv, "--id") || `attest-${flag(argv, "--nonce")}`,
    created_at: flag(argv, "--issued"),
    author,
    kind: "attestation",
    body: "Verifier attestation.",
    refs: { pip: null, txs: [] },
    prev: flag(argv, "--prev") || null,
    attestation,
  });
  if (!payload) return fail("The attestation payload does not match the hub update schema.");
  const message = new TextDecoder().decode(hubUpdateSigningMessage(payload));
  const text = `${JSON.stringify({ payload, message: { utf8: message, hex: Buffer.from(message).toString("hex") } }, null, 2)}\n`;
  const out = flag(argv, "--out");
  if (out) writeFileSync(out, text);
  return {
    code: 0,
    stdout: out ? "" : text,
    stderr: "The salt stayed in the proof file. It is not part of the hub record.\n",
  };
}

function revoke(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  const attestation = parseAttestation({
    action: "revoke",
    wallet: flag(argv, "--wallet"),
    hubId: normalizeHubRepo(flag(argv, "--hub")) ?? "",
    nonce: flag(argv, "--nonce"),
    issuedAt: flag(argv, "--issued"),
    expiresAt: flag(argv, "--expires"),
    method: flag(argv, "--method"),
    verifierId: flag(argv, "--verifier-id"),
    targetId: flag(argv, "--target"),
  });
  if (!attestation) return fail("The revoke fields do not match the schema.");
  const payload = parseHubPayload({
    v: 1,
    id: flag(argv, "--id") || `revoke-${flag(argv, "--nonce")}`,
    created_at: flag(argv, "--issued"),
    author: flag(argv, "--verifier-key"),
    kind: "attestation",
    body: "Revoke attestation.",
    refs: { pip: null, txs: [] },
    prev: flag(argv, "--prev") || null,
    attestation,
  });
  if (!payload) return fail("The revoke payload does not match the hub update schema.");
  const message = new TextDecoder().decode(hubUpdateSigningMessage(payload));
  const text = `${JSON.stringify({ payload, message: { utf8: message, hex: Buffer.from(message).toString("hex") } }, null, 2)}\n`;
  return { code: 0, stdout: text, stderr: "Sign the utf8 message with the verifier key, the subject wallet, or a threshold of curators.\n" };
}

function verify(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  const document = parseSignedHubDocument(readJson(flag(argv, "--file")));
  if (!document || document.payload.kind !== "attestation" || !document.payload.attestation) {
    return fail("The file is not an attestation.");
  }
  if (!authorSignatureValid(document.payload, document.signature)) return fail("The attestation signature did not verify.");
  const hub = flag(argv, "--hub");
  if (hub) {
    const id = normalizeHubRepo(hub);
    if (!id || id !== document.payload.attestation.hubId) return fail("The attestation names a different hub.");
  }
  const attestation = document.payload.attestation;
  return {
    code: 0,
    stdout: `${JSON.stringify({ ok: true, id: document.payload.id, verifier: document.payload.author, wallet: attestation.wallet, method: attestation.method, verifierId: attestation.verifierId, expiresAt: attestation.expiresAt }, null, 2)}\n`,
    stderr: "",
  };
}

function sign(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  const keyPath = flag(argv, "--key-path");
  if (!keyPath) return fail("Pass --key-path with a Solana JSON key file.");
  const payload = parseHubPayload(readJson(flag(argv, "--payload")));
  if (!payload || payload.kind !== "attestation") return fail("Pass --payload with an unsigned attestation.");
  const key = readSolanaKeyFile(keyPath);
  if (solanaKeyAddress(key) !== payload.author) return fail("The key does not match the payload author.");
  const signed = signHubPayload(payload, key);
  const document: SignedHubDocument = { payload: signed.payload, signature: signed.signature, approvals: [] };
  const text = `${JSON.stringify(document, null, 2)}\n`;
  const out = flag(argv, "--out");
  if (out) writeFileSync(out, text);
  return { code: 0, stdout: out ? "" : text, stderr: `Wrote attestation ${document.payload.id}\n` };
}

function discordUrl(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  const config = discordVerifierConfig(process.env);
  if (!config) return fail("The Discord verifier is disabled. Set DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and DISCORD_REDIRECT_URI to issue Discord attestations.");
  const wallet = flag(argv, "--wallet");
  const nonce = flag(argv, "--nonce");
  if (!wallet || !nonce) return fail("Pass --wallet and --nonce. The state is bound to both.");
  const salt = base58Encode(randomBytes(16));
  const state = bindAttestationState({ wallet, nonce, salt });
  return {
    code: 0,
    stdout: `${discordAuthorizeUrl(config, state)}\n`,
    stderr: `State (pass this to discord-code): ${state}\n`,
  };
}

async function discordCode(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const config = discordVerifierConfig(process.env);
  if (!config) return fail("The Discord verifier is disabled. Set DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and DISCORD_REDIRECT_URI to issue Discord attestations.");
  const wallet = flag(argv, "--wallet");
  const nonce = flag(argv, "--nonce");
  const state = flag(argv, "--state");
  const bound = readBoundState(state, wallet, nonce);
  if (!bound) return fail("The state does not match this wallet and nonce.");
  const identity = await discordIdentify(config, flag(argv, "--code"));
  const proof: VerifierProof = {
    v: 1,
    method: "discord",
    account: identity.id,
    salt: bound.salt,
    wallet,
    nonce,
    state,
  };
  return writeProof(proof, flag(argv, "--out"));
}

async function xCheck(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const post = flag(argv, "--post");
  const code = flag(argv, "--code");
  const account = normalizeXHandle(flag(argv, "--account"));
  const wallet = flag(argv, "--wallet");
  const nonce = flag(argv, "--nonce");
  if (!account || !wallet || !nonce) return fail("Pass --account, --wallet, and --nonce.");
  if (!isStatusUrl(post)) return fail("Pass --post with an https x.com or twitter.com status URL.");
  const found = await fetchPostedCode(post, code, account);
  if (!found) return fail("The public post did not contain the code from that account. No attestation was issued.");
  const salt = base58Encode(randomBytes(16));
  const proof: VerifierProof = {
    v: 1,
    method: "x",
    account,
    salt,
    wallet,
    nonce,
    state: bindAttestationState({ wallet, nonce, salt }),
  };
  return writeProof(proof, flag(argv, "--out"));
}

function readBoundState(state: string, wallet: string, nonce: string): { salt: string } | null {
  const parsed = readAttestationState(state);
  if (!parsed || parsed.wallet !== wallet || parsed.nonce !== nonce) return null;
  return { salt: parsed.salt };
}

function writeProof(proof: VerifierProof, out: string): { code: number; stdout: string; stderr: string } {
  const text = `${JSON.stringify(proof, null, 2)}\n`;
  if (out) writeFileSync(out, text);
  return {
    code: 0,
    stdout: out ? "" : text,
    stderr: "Proof written. Pass it to build with --proof-file. The salt is not part of the hub record.\n",
  };
}

function readJson(file: string): unknown {
  if (!file) throw new Error("Pass a JSON file.");
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    throw new Error("The JSON file could not be read.");
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const result = await runAttestCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
