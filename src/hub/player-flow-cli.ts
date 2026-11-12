import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { loadConfig } from "../config.js";
import { createRpcClient } from "../dao/rpc.js";
import { createProfileKeyChecker, type ProfileKeyChecker } from "./claim-profile.js";
import {
  buildPlayerAttestationDraft,
  buildPlayerClaimDraft,
  buildVerifierAttestationDraft,
  PLAYER_PACK_NOTE,
  readyPlayerPack,
  signedHubDocument,
  writePlayerPack,
  type PlayerClaimFields,
} from "./player-discord-flow.js";
import { createPlayerExchange } from "./player-exchange.js";
import { normalizeWalletSignature, readSolanaKeyFile, signHubPayload, solanaKeyAddress } from "./sign-cli.js";
import { hubUpdateHash, type HubUpdatePayload } from "./update.js";

/**
 * Player-facing claim files. Discord identify stays on 127.0.0.1.
 * This command does not publish a hub update and does not change signer sets.
 */

export const LOOPBACK_HOST = "127.0.0.1";

const USAGE = [
  "Usage: npm run hub-player -- prepare --wallet <address> --hub <https-repo> --listing-id <id> --profile <address> --nonce <nonce> --expires <time> --created-at <time> [--id <id>] [--show-handles] [--out <file>]",
  "       npm run hub-player -- check --wallet <address> --profile <address>",
  "       npm run hub-player -- pack --wallet <address> --hub <https-repo> --listing-id <id> --profile <address> --nonce <nonce> --expires <time> --created-at <time> --claim-signature <sig> --attest-signature <sig> --proof-file <proof.json> --out <dir> [--verifier-key <solana.json> --verifier-id <id>] [--show-handles]",
  "       npm run hub-player -- exchange --out <dir> [--verifier-key <solana.json> --verifier-id <id>]",
].join("\n");

export interface PlayerFlowDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  profile?: ProfileKeyChecker;
  now?: () => number;
}

function fail(message: string): { code: number; stdout: string; stderr: string } {
  return { code: 1, stdout: "", stderr: `${message}\n` };
}

function flag(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  if (index < 0) return "";
  return argv[index + 1] ?? "";
}

function fieldsFrom(argv: readonly string[]): PlayerClaimFields {
  return {
    wallet: flag(argv, "--wallet"),
    hub: flag(argv, "--hub"),
    listingId: flag(argv, "--listing-id"),
    profile: flag(argv, "--profile"),
    nonce: flag(argv, "--nonce"),
    expiresAt: flag(argv, "--expires"),
    createdAt: flag(argv, "--created-at"),
    ...(flag(argv, "--id") ? { id: flag(argv, "--id") } : {}),
    ...(argv.includes("--show-handles") ? { showHandles: true } : {}),
  };
}

export async function runPlayerFlowCli(
  argv: readonly string[],
  deps: PlayerFlowDeps = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = argv[0] ?? "";
  try {
    if (command === "prepare") return prepare(argv.slice(1));
    if (command === "check") return await check(argv.slice(1), deps);
    if (command === "pack") return await pack(argv.slice(1), deps);
    if (command === "exchange") return await exchange(argv.slice(1), deps);
    return fail(USAGE);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The player claim command failed.");
  }
}

function prepare(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  const draft = buildPlayerClaimDraft(fieldsFrom(argv));
  if (!draft) return fail("The claim fields do not match the schema.");
  const text = `${JSON.stringify(draft, null, 2)}\n`;
  const out = flag(argv, "--out");
  if (out) writeText(out, text);
  return {
    code: 0,
    stdout: out ? "" : text,
    stderr: "Sign the utf8 message with the claimant wallet. Then pass that signature to pack. Nothing was published.\n",
  };
}

async function check(
  argv: readonly string[],
  deps: PlayerFlowDeps,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const wallet = flag(argv, "--wallet");
  const profile = flag(argv, "--profile");
  if (!wallet || !profile) return fail("Pass --wallet and --profile.");
  const verdict = await (deps.profile ?? defaultProfile()).walletIsProfileKey(wallet, profile, deps.now?.() ?? Date.now());
  return {
    code: verdict === "match" ? 0 : 1,
    stdout: `${JSON.stringify({ profile: verdict, published: false })}\n`,
    stderr: verdict === "match" ? "" : "The Player Profile check did not match. Nothing was written.\n",
  };
}

async function pack(
  argv: readonly string[],
  deps: PlayerFlowDeps,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fields = fieldsFrom(argv);
  const out = flag(argv, "--out");
  if (!out) return fail("Pass --out with a directory for the signed files.");
  const proof = readJson(flag(argv, "--proof-file"));
  let claimSignature = "";
  let attestationSignature = "";
  try {
    claimSignature = normalizeWalletSignature(flag(argv, "--claim-signature"));
    attestationSignature = normalizeWalletSignature(flag(argv, "--attest-signature"));
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The signature could not be read.");
  }
  const claim = buildPlayerClaimDraft(fields);
  if (!claim) return fail("The claim fields do not match the schema.");
  const verifierKey = flag(argv, "--verifier-key");
  let verifier = null;
  if (verifierKey) {
    const verifierId = flag(argv, "--verifier-id");
    if (!verifierId) return fail("Pass --verifier-id with the verifier key.");
    const key = readSolanaKeyFile(verifierKey);
    const playerAttestation = buildPlayerAttestationDraft({
      proof,
      hub: fields.hub,
      issuedAt: fields.createdAt,
      expiresAt: fields.expiresAt,
      prev: hubUpdateHash(claim.payload),
    });
    const draft = playerAttestation
      ? buildVerifierAttestationDraft({
          proof,
          hub: fields.hub,
          verifierKey: solanaKeyAddress(key),
          verifierId,
          issuedAt: fields.createdAt,
          expiresAt: fields.expiresAt,
          prev: hubUpdateHash(playerAttestation.payload),
        })
      : null;
    if (!draft) return fail("The verifier attestation was not signed. Nothing was written.");
    verifier = signedHubDocument(draft.payload, signHubPayload(draft.payload, key).signature);
    if (!verifier) return fail("The verifier attestation was not signed. Nothing was written.");
  }
  const verdict = await (deps.profile ?? defaultProfile()).walletIsProfileKey(
    claim.payload.author,
    claim.payload.claim?.playerProfile ?? fields.profile,
    deps.now?.() ?? Date.now(),
  );
  const packed = readyPlayerPack({
    fields,
    proof,
    claimSignature,
    attestationSignature,
    profile: verdict,
    verifier,
  });
  if (!packed.ok) {
    return fail(
      packed.reason === "profile_mismatch"
        ? "The wallet is not the Player Profile auth key. Nothing was written."
        : packed.reason === "profile_unavailable"
          ? "The Player Profile could not be read. Nothing was written."
          : "The signed files were refused. Nothing was written.",
    );
  }
  const files = writePlayerPack(out, packed.pack);
  return {
    code: 0,
    stdout: `${JSON.stringify({ published: false, profile: "match", files })}\n`,
    stderr: `${PLAYER_PACK_NOTE}\n`,
  };
}

async function exchange(
  argv: readonly string[],
  deps: PlayerFlowDeps,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = flag(argv, "--out");
  if (!out) return fail("Pass --out with a directory for the signed files.");
  const verifierKeyPath = flag(argv, "--verifier-key");
  const verifierId = flag(argv, "--verifier-id");
  let verifierKey = "";
  let signVerifier: ((payload: HubUpdatePayload) => string) | undefined;
  if (verifierKeyPath) {
    if (!verifierId) return fail("Pass --verifier-id with the verifier key.");
    const key = readSolanaKeyFile(verifierKeyPath);
    verifierKey = solanaKeyAddress(key);
    signVerifier = (payload) => signHubPayload(payload, key).signature;
  }
  const opened = createPlayerExchange({
    env: deps.env ?? process.env,
    outDir: out,
    profile: deps.profile ?? defaultProfile(),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(verifierKey && signVerifier ? { verifierKey, verifierId, signVerifier } : {}),
  });
  if (!opened.ok) return fail(opened.reason);
  const bound = await listenLoopback(opened.listen.port, opened.handle);
  return {
    code: 0,
    stdout: `Player exchange on http://${LOOPBACK_HOST}:${bound.port}/\n`,
    stderr: "Discord identify stays on this machine. Nothing is published from this page.\n",
  };
}

export function listenLoopback(
  port: number,
  handler: (request: Request) => Promise<Response>,
): Promise<{ port: number; address: string; close(): Promise<void> }> {
  let boundPort = port;
  const server = createServer((req, res) => {
    void serve(req, res, boundPort, handler);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LOOPBACK_HOST, () => {
      const address = server.address();
      boundPort = address && typeof address === "object" ? address.port : port;
      const boundAddress = address && typeof address === "object" ? address.address : LOOPBACK_HOST;
      resolve({
        port: boundPort,
        address: boundAddress,
        close: () =>
          new Promise((done, failClose) => {
            server.close((error) => (error ? failClose(error) : done()));
          }),
      });
    });
  });
}

async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  handler: (request: Request) => Promise<Response>,
): Promise<void> {
  const remote = req.socket.remoteAddress ?? "";
  if (remote !== "127.0.0.1" && remote !== "::ffff:127.0.0.1") {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("This exchange listens on 127.0.0.1 only.");
    return;
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
  }
  const method = req.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : await readIncoming(req);
  const request = new Request(`http://${LOOPBACK_HOST}:${port}${req.url ?? "/"}`, {
    method,
    headers,
    ...(body ? { body: new Uint8Array(body) } : {}),
  });
  const response = await handler(request);
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  res.writeHead(response.status, responseHeaders);
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function readIncoming(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 32_768) break;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function defaultProfile(): ProfileKeyChecker {
  const config = loadConfig();
  return createProfileKeyChecker(
    createRpcClient(config.solanaRpcUrl, fetch, { attempts: 2, timeoutMs: 10_000, minIntervalMs: 0 }),
  );
}

function writeText(file: string, text: string): void {
  writeFileSync(file, text, { mode: 0o600 });
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
  const result = await runPlayerFlowCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.code !== 0) process.exitCode = result.code;
}
