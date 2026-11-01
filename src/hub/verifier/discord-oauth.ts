/**
 * Optional Discord verifier. It stays off unless the operator sets
 * DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and DISCORD_REDIRECT_URI together.
 * The only scope is identify. The node does not import this module.
 */

const IDENTIFY_SCOPE = "identify";
const AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const TOKEN_URL = "https://discord.com/api/oauth2/token";
const USER_URL = "https://discord.com/api/users/@me";

export interface DiscordVerifierConfig {
  clientId: string;
  redirectUri: string;
  /** Present only in memory for the token exchange. Do not log it. */
  clientSecret: string;
}

export function discordVerifierConfig(env: NodeJS.ProcessEnv): DiscordVerifierConfig | null {
  const clientId = env.DISCORD_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.DISCORD_CLIENT_SECRET?.trim() ?? "";
  const redirectUri = env.DISCORD_REDIRECT_URI?.trim() ?? "";
  if (!clientId && !clientSecret && !redirectUri) return null;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Set DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and DISCORD_REDIRECT_URI together, or leave all three unset.");
  }
  if (!/^\d{5,32}$/.test(clientId)) throw new Error("DISCORD_CLIENT_ID is not a Discord application id.");
  if (clientSecret.length < 8 || clientSecret.length > 200) throw new Error("DISCORD_CLIENT_SECRET is not usable.");
  if (!allowedRedirect(redirectUri)) {
    throw new Error("DISCORD_REDIRECT_URI must be http://127.0.0.1, http://localhost, or an https URL.");
  }
  return { clientId, clientSecret, redirectUri };
}

/** Authorize URL. The scope is identify and nothing else. */
export function discordAuthorizeUrl(config: DiscordVerifierConfig, state: string): string {
  if (!/^[A-Za-z0-9_-]{8,500}$/.test(state)) throw new Error("The Discord state value is not usable.");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", IDENTIFY_SCOPE);
  url.searchParams.set("state", state);
  return url.toString();
}

export interface DiscordIdentity {
  id: string;
}

/**
 * Exchange one code for the identify user id.
 * The access token is not returned. A failure does not include the client secret.
 */
export async function discordIdentify(
  config: DiscordVerifierConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscordIdentity> {
  if (!/^[A-Za-z0-9._-]{4,128}$/.test(code)) throw new Error("The Discord code is not usable.");
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
  });
  let tokenResponse: Response;
  try {
    tokenResponse = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Discord did not answer the token exchange.");
  }
  if (!tokenResponse.ok) throw new Error("Discord refused the token exchange.");
  const tokenJson = (await tokenResponse.json()) as { access_token?: unknown; scope?: unknown };
  if (typeof tokenJson.access_token !== "string" || tokenJson.access_token.length < 8) {
    throw new Error("Discord did not return an access token.");
  }
  if (typeof tokenJson.scope === "string" && tokenJson.scope.split(" ").some((scope) => scope && scope !== IDENTIFY_SCOPE)) {
    throw new Error("Discord returned a scope other than identify.");
  }
  let userResponse: Response;
  try {
    userResponse = await fetchImpl(USER_URL, {
      headers: { authorization: `Bearer ${tokenJson.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Discord did not answer the identify read.");
  }
  if (!userResponse.ok) throw new Error("Discord refused the identify read.");
  const user = (await userResponse.json()) as { id?: unknown };
  if (typeof user.id !== "string" || !/^\d{17,20}$/.test(user.id)) {
    throw new Error("Discord did not return an account id.");
  }
  return { id: user.id };
}

function allowedRedirect(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
  if (parsed.protocol === "https:") return parsed.hostname.includes(".");
  if (parsed.protocol !== "http:") return false;
  return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
}
