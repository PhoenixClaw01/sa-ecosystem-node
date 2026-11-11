import { loadConfig } from "./config.js";
import { createNodeHandler } from "./handler.js";
import { createPublicMcpFetch } from "./public-mcp.js";
import { h2hCard } from "./h2h/feeds.js";
import { createDefaultDeps } from "./runtime.js";

/**
 * Public read-only MCP. `npm run build:dashboard-mcp` writes the bundle to
 * `dashboard/api/mcp.js`. That file is what the dashboard Vercel project runs.
 * TypeScript stays out of `dashboard/api` so Vercel does not compile this
 * module without the repo dependencies.
 */
const settings = loadConfig();
const deps = createDefaultDeps(settings);
const fetchMcp = createPublicMcpFetch(createNodeHandler(deps, settings), {
  maxRequestBytes: settings.maxRequestBytes,
  maxBytes: settings.maxResponseBytes,
  feeds: {
    c4Markers: () => deps.c4Markers({}),
    communityTools: () => deps.communityTools(),
    card: () => h2hCard(),
  },
});

export default {
  fetch(request: Request): Promise<Response> {
    return fetchMcp(request);
  },
};
