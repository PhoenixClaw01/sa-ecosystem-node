import { isIP } from "node:net";

/**
 * Canonical https URL with a dotted public hostname.
 * Userinfo and a non-canonical spelling are refused.
 * Image URLs add a path-extension check on top of this.
 */

function hasForbiddenCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127 || code === 0x85 || code === 0xfeff) return true;
    if (code >= 0x200b && code <= 0x200f) return true;
    if (code === 0x2028 || code === 0x2029) return true;
    if (code >= 0x202a && code <= 0x202e) return true;
    if (code >= 0x2066 && code <= 0x2069) return true;
  }
  return false;
}

function isDottedPublicHost(hostname: string): boolean {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIP(hostname) !== 0 || isIP(bare) !== 0) return false;
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((label) => label.length === 0)) return false;
  return true;
}

export function isPublicHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500 || value !== value.trim()) return false;
  if (hasForbiddenCharacter(value) || value.includes("\\") || !value.startsWith("https://")) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || value !== parsed.href) return false;
  if (parsed.username || parsed.password) return false;
  return isDottedPublicHost(parsed.hostname);
}
