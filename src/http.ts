import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { hostHeaderValidation, localhostOriginValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";

import { loadConfig, type Config } from "./config.js";
import { createNodeHandler } from "./handler.js";
import { createPublicMcpFetch } from "./public-mcp.js";
import { clientKeyFromNode, createRateLimiter, type RateLimiter } from "./rate-limit.js";
import { createDefaultDeps } from "./runtime.js";
import type { NodeDeps } from "./server.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

function writeJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function hostChecksOff(config: Config): boolean {
  const named = config.allowedHosts.filter((host) => host !== "*");
  return config.allowedHosts.includes("*") || named.length === 0;
}

function hostGuard(config: Config): (request: IncomingMessage, response: ServerResponse) => boolean {
  if (!config.publicNode) {
    return hostHeaderValidation(["localhost", "127.0.0.1", "[::1]", config.host]);
  }
  if (hostChecksOff(config)) return () => true;
  const named = config.allowedHosts.filter((host) => host !== "*");
  return hostHeaderValidation([...new Set(["localhost", "127.0.0.1", "[::1]", ...named])]);
}

function originGuard(config: Config): (request: IncomingMessage, response: ServerResponse) => boolean {
  if (!config.publicNode) return localhostOriginValidation();
  if (hostChecksOff(config)) return () => true;
  const named = config.allowedHosts.filter((host) => host !== "*");
  return originValidation([...new Set(["localhost", "127.0.0.1", "[::1]", ...named])]);
}

const allowAll: RateLimiter = {
  check() {
    return { allowed: true, limit: 1, remaining: 1, placeholder: true };
  },
};

const OPEN_HOST_WARNING =
  "warning: PUBLIC_NODE=1 and allowedHosts is empty or '*'. Host and Origin checks are off.";

function enforcePublicHostPolicy(config: Config): void {
  if (!config.publicNode || !hostChecksOff(config)) return;
  if (!config.allowAnyHost) {
    throw new Error(
      "PUBLIC_NODE=1 and allowedHosts is empty or '*'. Refusing to start. Set allowedHosts to the names this node serves, or set ALLOW_ANY_HOST=1 to start with Host and Origin checks off.",
    );
  }
  console.error(OPEN_HOST_WARNING);
}

export async function startHttpServer(options?: { config?: Config; deps?: NodeDeps }): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const config = options?.config ?? loadConfig();
  enforcePublicHostPolicy(config);
  const deps = options?.deps ?? createDefaultDeps(config);
  const limiter = createRateLimiter({
    limit: config.rateLimitMax,
    windowMs: config.rateLimitWindowMs,
  });
  const node = createNodeHandler(deps, config, allowAll);
  const fetchMcp = createPublicMcpFetch(node, {
    maxRequestBytes: config.maxRequestBytes,
    maxBytes: config.maxResponseBytes,
  });
  const nodeHandler = toNodeHandler({ fetch: fetchMcp }, { maxRequestBodySize: config.maxRequestBytes });
  const validateHost = hostGuard(config);
  const validateOrigin = originGuard(config);

  const server = createServer((request, response) => {
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;
    const hostHeader = request.headers.host ?? config.host;
    let pathname = "/";
    try {
      pathname = new URL(request.url ?? "/", `http://${hostHeader}`).pathname;
    } catch {
      writeJson(response, 400, { error: "bad_request" });
      return;
    }

    const decision = limiter.check(clientKeyFromNode(request, config.trustProxy));
    if (!decision.allowed) {
      writeJson(response, 429, { error: "rate_limited", ...decision });
      return;
    }

    if (request.method === "GET" && pathname === "/") {
      writeJson(response, 200, {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        readOnly: true,
        mcp: "/mcp",
        writes: false,
      });
      return;
    }

    if (pathname !== "/mcp") {
      writeJson(response, 404, { error: "not_found", mcp: "/mcp" });
      return;
    }

    void nodeHandler(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(config.port, config.host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;

  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await node.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectRun()) {
  startHttpServer()
    .then(({ url }) => {
      console.error(`${SERVER_NAME} ${SERVER_VERSION} listening on ${url}/mcp`);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Failed to start";
      console.error(message);
      process.exit(1);
    });
}
