/**
 * Posted-code check for an X proof.
 * The verifier asks the subject to post a code, then reads the public status URL.
 * This does not call the X API and does not use a secret. If the public page
 * does not contain the code, the check fails and no attestation is issued.
 */

const CODE_PATTERN = /^[A-Za-z0-9]{8,64}$/;
const MAX_BODY = 64 * 1024;

export function isStatusUrl(value: string): boolean {
  if (!value.startsWith("https://") || value.length > 300) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "x.com" && host !== "twitter.com" && host !== "www.x.com" && host !== "www.twitter.com") return false;
  if (parsed.username || parsed.password) return false;
  return statusHandle(value) !== null;
}

/** The handle in `https://x.com/<handle>/status/<id>`. */
export function statusHandle(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const match = /^\/([A-Za-z0-9_]{1,15})\/status\/[0-9]+$/.exec(parsed.pathname);
  const handle = match?.[1]?.toLowerCase() ?? "";
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) return null;
  return handle;
}

/** True when the code appears as its own token in the page text. */
export function postContainsCode(body: string, code: string): boolean {
  if (!CODE_PATTERN.test(code) || body.length === 0 || body.length > MAX_BODY) return false;
  const tokens = body.split(/[^A-Za-z0-9]+/);
  return tokens.includes(code);
}

export async function fetchPostedCode(
  url: string,
  code: string,
  account: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const handle = account.trim().replace(/^@/, "").toLowerCase();
  if (!isStatusUrl(url) || statusHandle(url) !== handle || !CODE_PATTERN.test(code)) return false;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  const finalUrl = response.url || url;
  if (!isStatusUrl(finalUrl) || statusHandle(finalUrl) !== handle) return false;
  const text = await response.text();
  return postContainsCode(text.slice(0, MAX_BODY), code);
}
