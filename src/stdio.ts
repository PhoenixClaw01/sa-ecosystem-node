import path from "node:path";
import { pathToFileURL } from "node:url";

import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";

import { loadConfig } from "./config.js";
import { createDefaultDeps } from "./runtime.js";
import { createNodeServer } from "./server.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

/** Local MCP process. No socket, no write endpoint, no keys. */
export function startStdio(env: NodeJS.ProcessEnv = process.env): StdioServerHandle {
  const config = loadConfig(env);
  const deps = createDefaultDeps(config);
  console.error(`${SERVER_NAME} ${SERVER_VERSION} listening on stdio`);
  return serveStdio(() => createNodeServer(deps, config));
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectRun()) {
  const handle = startStdio();
  process.on("SIGINT", () => {
    void handle.close();
  });
}
