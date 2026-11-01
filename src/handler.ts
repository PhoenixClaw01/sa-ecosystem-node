import { createMcpHandler } from "@modelcontextprotocol/server";

import type { Config } from "./config.js";
import { clientKeyFromRequest, createRateLimiter, type RateLimiter } from "./rate-limit.js";
import { createNodeServer, type NodeDeps } from "./server.js";

export interface NodeHandler {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

/**
 * Stateless Streamable HTTP handler. One fresh server per request.
 * The rate limiter in front of it is in memory on this instance.
 */
export function createNodeHandler(
  deps: NodeDeps,
  config: Config,
  limiter: RateLimiter = createRateLimiter({
    limit: config.rateLimitMax,
    windowMs: config.rateLimitWindowMs,
  }),
): NodeHandler {
  const mcp = createMcpHandler(() => createNodeServer(deps, config), { responseMode: "json" });

  return {
    async fetch(request: Request): Promise<Response> {
      const decision = limiter.check(clientKeyFromRequest(request, config.trustProxy));
      if (!decision.allowed) {
        return new Response(
          JSON.stringify({
            error: "rate_limited",
            ...decision,
          }),
          {
            status: 429,
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          },
        );
      }
      return mcp.fetch(request);
    },
    close: () => mcp.close(),
  };
}
