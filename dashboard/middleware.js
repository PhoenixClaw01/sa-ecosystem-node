const PLAIN_HOME = "/plain/";

export const config = {
  matcher: ["/", "/index.html"],
  runtime: "nodejs",
};

// x-middleware-next continues to the static page, the same signal next() sends.
function nextResponse() {
  return new globalThis.Response(null, {
    headers: { "x-middleware-next": "1" },
  });
}

export function publicHomeMatcherHits(pathname) {
  const patterns = Array.isArray(config.matcher) ? config.matcher : [config.matcher];
  return patterns.some((pattern) => pattern === pathname);
}

export function publicHomeResponse(requestUrl, publicHome) {
  const pathname = new URL(requestUrl).pathname;
  if (publicHome === "plain" && publicHomeMatcherHits(pathname)) {
    return new globalThis.Response(null, {
      status: 302,
      headers: { location: PLAIN_HOME },
    });
  }
  return nextResponse();
}

export default function middleware(request) {
  return publicHomeResponse(request.url, process.env.PUBLIC_HOME);
};
