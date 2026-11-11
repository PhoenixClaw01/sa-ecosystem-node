import { SafeClientError } from "../errors.js";

/**
 * Plain GET routes for the H2H feeds, for renderers and harnesses that do not speak MCP
 * (protocol/h2h/SPEC.md sections 5.1, 6.1, 6.2). GET and HEAD only. No input changes state.
 * On Vercel, dashboard/vercel.json rewrites each path to /api/mcp?h2h=<feed>; both forms are accepted.
 */
export interface H2hFeeds {
  c4Markers(): Promise<unknown>;
  communityTools(): unknown;
  card(): unknown;
}

export const H2H_FEED_PATHS: Readonly<Record<string, keyof H2hFeeds>> = {
  "/c4-markers.json": "c4Markers",
  "/community-tools.json": "communityTools",
  "/.well-known/h2h-card.json": "card",
};

const QUERY_FEEDS: Readonly<Record<string, keyof H2hFeeds>> = {
  "c4-markers": "c4Markers",
  "community-tools": "communityTools",
  card: "card",
};

/** Which feed this request asks for, or null when it is not a feed request. */
export function h2hFeedFor(request: Request): keyof H2hFeeds | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  const byPath = H2H_FEED_PATHS[url.pathname];
  if (byPath) return byPath;
  const query = url.searchParams.get("h2h");
  if (query !== null && Object.hasOwn(QUERY_FEEDS, query)) return QUERY_FEEDS[query] ?? null;
  return null;
}

export async function h2hFeedResponse(request: Request, feeds: H2hFeeds): Promise<Response | null> {
  const feed = h2hFeedFor(request);
  if (!feed) return null;
  let body: unknown;
  try {
    body = await feeds[feed]();
  } catch (error) {
    // A feed that cannot be built (for example an unreadable signer allowlist) answers 503
    // with a short JSON error instead of a 500. Only SafeClientError text is shown.
    const message =
      error instanceof SafeClientError ? error.message : "This feed is unavailable right now. No data was returned.";
    const errorText = `${JSON.stringify({ error: { code: "feed_unavailable", feed, message } }, null, 2)}\n`;
    return new Response(request.method === "HEAD" ? null : errorText, {
      status: 503,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": "300",
      },
    });
  }
  const text = `${JSON.stringify(body, null, 2)}\n`;
  return new Response(request.method === "HEAD" ? null : text, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=300",
    },
  });
}
