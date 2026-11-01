/**
 * True when an https repository URL contains a `.` or `..` path segment,
 * or when the raw path is not the path the URL parser normalised.
 * Encoded dot segments collapse during parsing, so the raw path and the
 * normalised path differ and the URL is refused.
 */
export function hubRepoPathRewritten(repo: string): boolean {
  const match = /^https:\/\/[^/?#]*([^?#]*)/i.exec(repo);
  if (!match) return true;
  let parsed: URL;
  try {
    parsed = new URL(repo);
  } catch {
    return true;
  }
  const rawPath = match[1] && match[1].startsWith("/") ? match[1] : "/";
  if (rawPath !== parsed.pathname) return true;
  return rawPath.split("/").some((segment) => segment === "." || segment === "..");
}
