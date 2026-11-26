import { randomBytes } from "node:crypto";

import { base58Encode } from "./base58.js";
import type { ProfileKeyChecker } from "./claim-profile.js";
import {
  buildPlayerAttestationDraft,
  buildPlayerClaimDraft,
  discordProof,
  PLAYER_PACK_NOTE,
  readyPlayerPack,
  signedHubDocument,
  verifierAttestationForClaim,
  writePlayerPack,
  type PlayerClaimFields,
} from "./player-discord-flow.js";
import { normalizeWalletSignature } from "./sign-cli.js";
import { hubUpdateHash, type HubUpdatePayload } from "./update.js";
import { discordAuthorizeUrl, discordIdentify, discordPkce, discordVerifierConfig, type DiscordVerifierConfig } from "./verifier/discord-oauth.js";
import { opaqueVerifierState, type VerifierProof } from "./verifier/proof.js";
import { PLAYER_FLOW_HTML, PLAYER_FLOW_SCRIPT } from "./player-flow-page.js";

/**
 * Loopback Discord identify exchange for one player claim.
 * The public server does not import this module. It binds nowhere by itself.
 * The client secret stays in this process. Responses must not include it.
 */

const SESSION_TTL_MS = 15 * 60_000;
const SESSION_CAP = 32;
const BODY_CAP = 32_768;

export interface ExchangeListenTarget {
  host: "127.0.0.1";
  port: number;
  callbackPath: string;
}

export function exchangeListenTarget(redirectUri: string): ExchangeListenTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port) return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!parsed.pathname.startsWith("/") || parsed.pathname === "/" || parsed.pathname.includes("//")) return null;
  return { host: "127.0.0.1", port, callbackPath: parsed.pathname };
}

export interface PlayerExchangeOptions {
  env: NodeJS.ProcessEnv;
  outDir: string;
  profile: ProfileKeyChecker;
  fetchImpl?: typeof fetch;
  now?: () => number;
  verifierKey?: string;
  verifierId?: string;
  signVerifier?: (payload: HubUpdatePayload) => string;
}

interface Session {
  id: string;
  state: string;
  salt: string;
  /** PKCE verifier. It is not returned to the browser. */
  verifier: string;
  fields: PlayerClaimFields;
  proof: VerifierProof | null;
  codeUsed: boolean;
  createdAtMs: number;
}

export function createPlayerExchange(
  options: PlayerExchangeOptions,
): { ok: true; listen: ExchangeListenTarget; handle(request: Request): Promise<Response> } | { ok: false; reason: string } {
  const config = readDiscordConfig(options.env);
  if ("error" in config) return { ok: false, reason: config.error };
  const discord: DiscordVerifierConfig = config;
  const target = exchangeListenTarget(discord.redirectUri);
  if (!target) {
    return {
      ok: false,
      reason:
        "The player exchange listens on 127.0.0.1 only. Set DISCORD_REDIRECT_URI to http://127.0.0.1:<port>/<path>. An https redirect still works with hub-attest discord-url and discord-code.",
    };
  }
  if ((options.verifierKey || options.signVerifier) && !options.verifierId?.trim()) {
    return { ok: false, reason: "Pass --verifier-id with the verifier key." };
  }
  if (Boolean(options.verifierKey) !== Boolean(options.signVerifier)) {
    return { ok: false, reason: "The verifier key is not ready." };
  }
  const listen: ExchangeListenTarget = target;

  const sessions = new Map<string, Session>();
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  let hits = 0;
  let windowStart = now();

  function allowRequest(): boolean {
    const clock = now();
    if (clock - windowStart >= 60_000) {
      hits = 0;
      windowStart = clock;
    }
    hits += 1;
    return hits <= 120;
  }

  async function handle(request: Request): Promise<Response> {
    if (!allowRequest()) return text(429, "Too many requests.");
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return text(400, "That request is refused.");
    }
    if (url.hostname !== "127.0.0.1") return text(403, "This exchange listens on 127.0.0.1 only.");
    const navigation = discordCallbackNavigation(request, url, listen.callbackPath);
    if (request.headers.get("sec-fetch-site") === "cross-site" && !navigation) {
      return text(403, "Cross-site requests are refused.");
    }
    const origin = request.headers.get("origin");
    if (!navigation && origin && origin !== `http://127.0.0.1:${listen.port}`) return text(403, "That origin is refused.");
    if (request.method === "GET" && url.pathname === "/") return html(PLAYER_FLOW_HTML);
    if (request.method === "GET" && url.pathname === "/player.js") {
      return new Response(PLAYER_FLOW_SCRIPT, {
        status: 200,
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
      });
    }
    if (request.method === "GET" && url.pathname === listen.callbackPath) return callback(url);
    if (request.method === "POST") {
      if (request.headers.get("x-player-flow") !== "1") return text(403, "That request is refused.");
      if (url.pathname === "/begin") return begin(request);
      if (url.pathname === "/messages") return messages(request);
      if (url.pathname === "/finish") return finish(request);
    }
    return text(404, "Not found.");
  }

  function dropExpired(): void {
    const clock = now();
    for (const [id, session] of sessions) {
      if (clock - session.createdAtMs > SESSION_TTL_MS) sessions.delete(id);
    }
    while (sessions.size > SESSION_CAP) {
      const oldest = sessions.keys().next().value;
      if (!oldest) break;
      sessions.delete(oldest);
    }
  }

  async function begin(request: Request): Promise<Response> {
    const body = await readBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { error: "The claim fields are not usable." });
    const record = body as Record<string, unknown>;
    const fields: PlayerClaimFields = {
      wallet: stringField(record.wallet),
      hub: stringField(record.hub),
      listingId: stringField(record.listingId),
      profile: stringField(record.profile),
      nonce: stringField(record.nonce),
      expiresAt: stringField(record.expiresAt),
      createdAt: stringField(record.createdAt),
      ...(record.showHandles === true ? { showHandles: true } : {}),
    };
    const draft = buildPlayerClaimDraft(fields);
    if (!draft?.payload.claim) return json(400, { error: "Those fields do not match the claim schema." });
    dropExpired();
    const salt = base58Encode(randomBytes(16));
    const state = opaqueVerifierState(randomBytes(32));
    const pkce = discordPkce(randomBytes(32));
    let authorizeUrl = "";
    try {
      authorizeUrl = discordAuthorizeUrl(discord, state, pkce.challenge);
    } catch {
      return json(400, { error: "The Discord authorize URL was refused." });
    }
    if (authorizeUrl.includes(discord.clientSecret) || !authorizeUrl.includes("scope=identify")) {
      return json(400, { error: "The Discord authorize URL was refused." });
    }
    const id = base58Encode(randomBytes(16));
    sessions.set(id, {
      id,
      state,
      salt,
      verifier: pkce.verifier,
      fields: {
        ...fields,
        wallet: draft.payload.author,
        nonce: draft.payload.claim.nonce,
        hub: draft.payload.claim.hubId,
        profile: draft.payload.claim.playerProfile ?? fields.profile,
        listingId: draft.payload.claim.identity.type === "listing" ? draft.payload.claim.identity.listingId : fields.listingId,
      },
      proof: null,
      codeUsed: false,
      createdAtMs: now(),
    });
    return json(200, { authorizeUrl });
  }

  async function callback(url: URL): Promise<Response> {
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const session = [...sessions.values()].find((item) => item.state === state);
    if (!session) return text(400, "The Discord state does not match this exchange.");
    if (session.codeUsed || session.proof) return text(400, "That Discord state was already used.");
    session.codeUsed = true;
    let identity: { id: string };
    try {
      identity = await discordIdentify(discord, code, session.verifier, fetchImpl);
    } catch {
      return text(400, "Discord did not confirm the account.");
    }
    const proof = discordProof({
      v: 1,
      method: "discord",
      account: identity.id,
      salt: session.salt,
      wallet: session.fields.wallet,
      nonce: session.fields.nonce,
      state,
    });
    if (!proof) return text(400, "The Discord proof was refused.");
    session.proof = proof;
    return new Response(null, {
      status: 302,
      headers: { location: `/?session=${encodeURIComponent(session.id)}`, "cache-control": "no-store" },
    });
  }

  async function messages(request: Request): Promise<Response> {
    const session = await sessionFrom(request);
    if (!session) return json(400, { error: "The Discord proof is not ready." });
    if (!session.proof) return json(400, { error: "The Discord proof is not ready." });
    const claim = buildPlayerClaimDraft(session.fields);
    if (!claim) return json(400, { error: "Those fields do not match the claim schema." });
    const attestation = buildPlayerAttestationDraft({
      proof: session.proof,
      hub: session.fields.hub,
      issuedAt: session.fields.createdAt,
      expiresAt: session.fields.expiresAt,
      prev: hubUpdateHash(claim.payload),
    });
    if (!attestation) return json(400, { error: "The attestation could not be built." });
    const claimHash = hubUpdateHash(claim.payload);
    if (attestation.payload.prev !== claimHash) return json(400, { error: "The attestation could not be built." });
    const body = {
      wallet: session.fields.wallet,
      listingId: session.fields.listingId,
      profile: session.fields.profile,
      hub: session.fields.hub,
      claim: { message: claim.message },
      attestation: { message: attestation.message },
    };
    if (
      jsonMentions(body, discord.clientSecret) ||
      quoted(claim.message.utf8, session.proof.account) ||
      quoted(attestation.message.utf8, session.proof.account) ||
      quoted(claim.message.utf8, session.proof.salt) ||
      quoted(attestation.message.utf8, session.proof.salt)
    ) {
      return json(500, { error: "The attestation was refused." });
    }
    return json(200, body);
  }

  async function finish(request: Request): Promise<Response> {
    const body = await readBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { published: false, error: "The signatures are not usable." });
    const record = body as Record<string, unknown>;
    const session = sessions.get(stringField(record.session));
    if (!session?.proof || now() - session.createdAtMs > SESSION_TTL_MS) {
      return json(400, { published: false, error: "The Discord proof is not ready." });
    }
    let claimSignature = "";
    let attestationSignature = "";
    try {
      claimSignature = normalizeWalletSignature(stringField(record.claimSignature));
      attestationSignature = normalizeWalletSignature(stringField(record.attestationSignature));
    } catch {
      return json(400, { published: false, error: "The signature could not be read." });
    }
    const verdict = await options.profile.walletIsProfileKey(session.fields.wallet, session.fields.profile, now());
    if (verdict !== "match") {
      return json(409, {
        published: false,
        profile: verdict,
        error:
          verdict === "mismatch"
            ? "The wallet is not the Player Profile auth key. Nothing was written."
            : "The Player Profile could not be read. Nothing was written.",
      });
    }
    let verifier = null;
    if (options.signVerifier && options.verifierKey && options.verifierId) {
      const draft = verifierAttestationForClaim({
        fields: session.fields,
        proof: session.proof,
        verifierKey: options.verifierKey,
        verifierId: options.verifierId,
      });
      if (!draft) return json(400, { published: false, error: "The verifier attestation was not signed. Nothing was written." });
      try {
        const signature = options.signVerifier(draft.payload);
        verifier = signedHubDocument(draft.payload, signature);
      } catch {
        verifier = null;
      }
      if (!verifier) return json(400, { published: false, error: "The verifier attestation was not signed. Nothing was written." });
    }
    const packed = readyPlayerPack({
      fields: session.fields,
      proof: session.proof,
      claimSignature,
      attestationSignature,
      profile: verdict,
      verifier,
    });
    if (!packed.ok) {
      return json(400, { published: false, profile: verdict, error: "The signed files were refused. Nothing was written." });
    }
    let files: string[];
    try {
      files = writePlayerPack(options.outDir, packed.pack);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Nothing was written.";
      return json(409, { published: false, error: message });
    }
    return json(200, { published: false, profile: "match", files, note: PLAYER_PACK_NOTE });
  }

  async function sessionFrom(request: Request): Promise<Session | null> {
    const body = await readBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const session = sessions.get(stringField((body as Record<string, unknown>).session));
    if (!session || now() - session.createdAtMs > SESSION_TTL_MS) return null;
    return session;
  }

  return { ok: true, listen, handle };
}

function readDiscordConfig(env: NodeJS.ProcessEnv): DiscordVerifierConfig | { error: string } {
  try {
    const config = discordVerifierConfig(env);
    if (!config) {
      return {
        error:
          "The Discord verifier is disabled. Set DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and DISCORD_REDIRECT_URI together on this machine.",
      };
    }
    return config;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The Discord verifier is disabled." };
  }
}

async function readBody(request: Request): Promise<unknown | null> {
  const text = await request.text();
  if (text.length > BODY_CAP) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Discord's redirect is a cross-site top-level GET. Every other cross-site request stays refused. */
function discordCallbackNavigation(request: Request, url: URL, callbackPath: string): boolean {
  return (
    request.method === "GET" &&
    url.pathname === callbackPath &&
    request.headers.get("sec-fetch-site") === "cross-site" &&
    request.headers.get("sec-fetch-mode") === "navigate" &&
    request.headers.get("sec-fetch-dest") === "document"
  );
}

function jsonMentions(value: unknown, secret: string): boolean {
  return secret.length > 0 && JSON.stringify(value).includes(secret);
}

function quoted(message: string, secret: string): boolean {
  return secret.length > 0 && message.includes(`"${secret}"`);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function text(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function html(page: string): Response {
  return new Response(page, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'",
    },
  });
}
