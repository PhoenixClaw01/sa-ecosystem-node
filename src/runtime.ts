import { loadConfig, type Config } from "./config.js";
import { createDaoReaders } from "./dao/readers.js";
import { createGameReaders } from "./game/live.js";
import { createLegacyReaders } from "./legacy/read.js";
import type { NodeDeps } from "./server.js";

export function createDefaultDeps(config: Config = loadConfig()): NodeDeps {
  return { ...createGameReaders(config), ...createDaoReaders(config), ...createLegacyReaders() };
}
