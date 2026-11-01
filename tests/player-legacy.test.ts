import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createRpcClient, type SolanaReadRpc } from "../src/dao/rpc.js";
import { createNodeHandler } from "../src/handler.js";
import { base58Decode, base58Encode } from "../src/hub/base58.js";
import { buildLegacySummary, type PlayerLegacyCard } from "../src/legacy/card.js";
import { decodeFleet, decodePlayerName } from "../src/legacy/decode.js";
import { createMissWindow, createRpcGate } from "../src/legacy/gate.js";
import { createLegacyReaders, readPlayerLegacy } from "../src/legacy/read.js";
import {
  FLEET_LABEL_OFFSET,
  FLEET_OWNER_OFFSET,
  PLAYER_PROFILE_PROGRAM_ID,
  PROFILE_FACTION_PROGRAM_ID,
  PROFILE_KEY_OFFSET,
  PROFILE_KEY_STRIDE,
  SAGE_LEGACY_PROGRAM_ID,
  SAGE_STARBASED_PROGRAM_ID,
} from "../src/legacy/programs.js";
import type { NodeDeps } from "../src/server.js";
import { stubDaoReaders } from "./dao-stubs.js";

/**
 * Shape reference for a mainnet quick card: two profiles, a creation day of
 * 2023-09-21, a May 2024 signature, and a history too large to finish in one
 * read. The accounts are synthetic and never leave the test process.
 */
const PROFILE_DISC = Uint8Array.of(184, 101, 165, 188, 95, 63, 127, 188);
const NAME_DISC = Uint8Array.of(102, 9, 241, 98, 96, 196, 212, 161);
const FACTION_DISC = Uint8Array.of(14, 149, 119, 243, 145, 240, 79, 227);
const FLEET_DISC = Uint8Array.of(109, 207, 251, 48, 106, 2, 136, 163);

const CREATED = Date.UTC(2023, 8, 21) / 1000;
const LAST_SEEN = Date.UTC(2024, 4, 1) / 1000;
const FLEET_CREATED = Date.UTC(2024, 1, 2) / 1000;
const HEADER_CREATED = Date.UTC(2020, 0, 1) / 1000;

function addr(seed: number): string {
  const bytes = new Uint8Array(32);
  bytes[0] = seed;
  bytes[1] = 7;
  bytes[31] = 9;
  return base58Encode(bytes);
}

const WALLET = addr(1);
const PROFILE_A = addr(2);
const PROFILE_B = addr(3);
const NAME_A = addr(4);
const NAME_B = addr(5);
const FACTION_A = addr(6);
const FACTION_B = addr(7);
const FLEET_A = addr(8);
const GAME = addr(10);
const OTHER_KEY = addr(11);

const FINANCIAL = /\b(ATH|yields?|fiat|USD|USDC|percent(?:age)?s?|balances?)\b|%/;
const fastGate = createRpcGate({ maxInFlight: 4, spacingMs: 0 });

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function i64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, value, true);
  return bytes;
}

function keySlot(key: string): Uint8Array {
  return concat(base58Decode(key), base58Decode(GAME), i64(-1n), Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0));
}

function profileAccount(keys: readonly string[]): Uint8Array {
  return concat(
    PROFILE_DISC,
    Uint8Array.of(1),
    u16(keys.length),
    Uint8Array.of(1),
    i64(0n),
    i64(BigInt(HEADER_CREATED)),
    u16(keys.length),
    ...keys.map((key) => keySlot(key)),
  );
}

function nameAccount(profile: string, name: string): Uint8Array {
  return concat(NAME_DISC, Uint8Array.of(1), base58Decode(profile), Uint8Array.of(255), new TextEncoder().encode(name));
}

function factionAccount(profile: string, faction: number): Uint8Array {
  return concat(FACTION_DISC, Uint8Array.of(1), base58Decode(profile), Uint8Array.of(faction), Uint8Array.of(255));
}

function fleetAccount(profile: string, label: string): Uint8Array {
  const bytes = new Uint8Array(FLEET_LABEL_OFFSET + 32);
  bytes.set(FLEET_DISC, 0);
  bytes[8] = 1;
  bytes.set(base58Decode(GAME), 9);
  bytes.set(base58Decode(profile), FLEET_OWNER_OFFSET);
  const labelBytes = new TextEncoder().encode(label);
  bytes.set(labelBytes, FLEET_LABEL_OFFSET);
  return bytes;
}

const PROFILE_A_BYTES = profileAccount([WALLET]);
const PROFILE_B_BYTES = profileAccount([OTHER_KEY, WALLET]);
const NAME_A_BYTES = nameAccount(PROFILE_A, "Example");
const NAME_B_BYTES = nameAccount(PROFILE_B, "Second");
const FACTION_A_BYTES = factionAccount(PROFILE_A, 1);
const FACTION_B_BYTES = factionAccount(PROFILE_B, 2);
const FLEET_A_BYTES = fleetAccount(PROFILE_A, "Northwind");

function b64(data: Uint8Array): [string, "base64"] {
  return [Buffer.from(data).toString("base64"), "base64"];
}

function wrapped(owner: string, data: Uint8Array) {
  return {
    lamports: 1,
    owner,
    executable: false,
    rentEpoch: 0,
    space: data.length,
    data: b64(data),
  };
}

interface Memcmp {
  offset: number;
  bytes: Uint8Array;
}

function memcmpFilters(params: unknown[]): Memcmp[] {
  const config = params[1] as { filters?: { memcmp?: { offset?: number; bytes?: string } }[] };
  return (config.filters ?? []).map((filter) => ({
    offset: filter.memcmp?.offset ?? -1,
    bytes: base58Decode(filter.memcmp?.bytes ?? ""),
  }));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sig(signature: string, blockTime: number) {
  return { signature, slot: blockTime, blockTime, err: null };
}

type Mode = "rich" | "thin" | "open" | "profile";

function answer(mode: Mode, method: string, params: unknown[]): unknown {
  if (method === "getAccountInfo") {
    const address = String(params[0]);
    if (mode === "profile" && address === PROFILE_A) {
      return { value: wrapped(PLAYER_PROFILE_PROGRAM_ID, PROFILE_A_BYTES) };
    }
    return { value: null };
  }
  if (method === "getProgramAccounts") {
    if (mode === "thin" || mode === "open") return [];
    const program = String(params[0]);
    const filters = memcmpFilters(params);
    const disc = filters.find((filter) => filter.offset === 0);
    const key = filters.find((filter) => filter.offset !== 0);
    if (!disc || !key) return [];
    if (program === PLAYER_PROFILE_PROGRAM_ID && sameBytes(disc.bytes, PROFILE_DISC)) {
      if (mode === "profile") return [];
      if (key.offset === PROFILE_KEY_OFFSET && sameBytes(key.bytes, base58Decode(WALLET))) {
        return [{ pubkey: PROFILE_A, account: wrapped(program, PROFILE_A_BYTES) }];
      }
      if (key.offset === PROFILE_KEY_OFFSET + PROFILE_KEY_STRIDE && sameBytes(key.bytes, base58Decode(WALLET))) {
        return [{ pubkey: PROFILE_B, account: wrapped(program, PROFILE_B_BYTES) }];
      }
      return [];
    }
    if (program === PLAYER_PROFILE_PROGRAM_ID && sameBytes(disc.bytes, NAME_DISC)) {
      const owner = base58Encode(key.bytes);
      if (owner === PROFILE_A) return [{ pubkey: NAME_A, account: wrapped(program, NAME_A_BYTES) }];
      if (owner === PROFILE_B && mode === "rich") return [{ pubkey: NAME_B, account: wrapped(program, NAME_B_BYTES) }];
      return [];
    }
    if (program === PROFILE_FACTION_PROGRAM_ID) {
      const owner = base58Encode(key.bytes);
      if (owner === PROFILE_A) return [{ pubkey: FACTION_A, account: wrapped(program, FACTION_A_BYTES) }];
      if (owner === PROFILE_B && mode === "rich") return [{ pubkey: FACTION_B, account: wrapped(program, FACTION_B_BYTES) }];
      return [];
    }
    if (program === SAGE_STARBASED_PROGRAM_ID) {
      const owner = base58Encode(key.bytes);
      if (owner === PROFILE_A) return [{ pubkey: FLEET_A, account: wrapped(program, FLEET_A_BYTES) }];
      return [];
    }
    if (program === SAGE_LEGACY_PROGRAM_ID) return [];
    return [];
  }
  if (method === "getSignaturesForAddress") {
    const address = String(params[0]);
    const config = (params[1] ?? {}) as { before?: string };
    if (mode === "open" && address === WALLET) {
      const start = config.before ? Number(config.before.slice("sig-".length)) + 1 : 0;
      return Array.from({ length: 100 }, (_, index) => sig(`sig-${start + index}`, LAST_SEEN - start - index));
    }
    if (mode === "thin") return [];
    if (config.before) return [];
    if (address === WALLET) return [sig("wallet-last", LAST_SEEN), sig("wallet-first", CREATED)];
    if (address === PROFILE_A) return [sig("profile-a-last", LAST_SEEN), sig("profile-a-created", CREATED)];
    if (address === PROFILE_B) return [sig("profile-b-created", CREATED)];
    if (address === FLEET_A) return [sig("fleet-created", FLEET_CREATED)];
    return [];
  }
  throw new Error(`unexpected method ${method}`);
}

function mockRpc(mode: Mode): { fetchImpl: typeof fetch; calls: { method: string; params: unknown[]; host: string }[] } {
  const calls: { method: string; params: unknown[]; host: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const host = new URL(url).host;
    const body = JSON.parse(String(init?.body)) as { id?: number; method?: string; params?: unknown[] } | unknown[];
    expect(Array.isArray(body)).toBe(false);
    const request = body as { id?: number; method: string; params: unknown[] };
    calls.push({ method: request.method, params: request.params, host });
    const result = answer(mode, request.method, request.params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id ?? 1, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

function rpcFor(mode: Mode) {
  const mocked = mockRpc(mode);
  const rpc = createRpcClient("https://api.mainnet-beta.solana.com", mocked.fetchImpl, {
    minIntervalMs: 0,
    attempts: 1,
    timeoutMs: 1_000,
  });
  return { ...mocked, rpc };
}

describe("player legacy offsets", () => {
  it("keeps the published memcmp offsets", () => {
    expect(PROFILE_KEY_OFFSET).toBe(30);
    expect(PROFILE_KEY_STRIDE).toBe(80);
    expect(FLEET_OWNER_OFFSET).toBe(41);
    expect(FLEET_LABEL_OFFSET).toBe(170);
    expect(keySlot(WALLET)).toHaveLength(80);
  });
});

describe("player_legacy reader", () => {
  it("reads profiles, enlistment, fleets, bands, and sources from mocked mainnet", async () => {
    const { rpc, calls } = rpcFor("rich");
    const card = await readPlayerLegacy({ address: WALLET, rpc, now: () => Date.UTC(2026, 9, 31) });
    expect(card.readOnly).toBe(true);
    expect(card.cluster).toBe("mainnet-beta");
    expect(card.rpc).toBe("api.mainnet-beta.solana.com");
    expect(card.dataMode).toBe("live");
    expect(card.fromCache).toBe(false);
    expect(card.queried).toEqual({ address: WALLET, kind: "wallet" });
    expect(card.profiles.map((profile) => profile.name)).toEqual(["Example", "Second"]);
    expect(card.profiles.map((profile) => profile.faction)).toEqual(["MUD", "ONI"]);
    expect(card.profiles.every((profile) => profile.createdAt === "2023-09-21T00:00:00.000Z")).toBe(true);
    expect(card.profiles[0]?.creationSignature).toBe("profile-a-created");
    expect(card.fleets).toEqual([
      {
        address: FLEET_A,
        name: "Northwind",
        program: "SAGE",
        ownerProfile: PROFILE_A,
        createdAt: "2024-02-02T00:00:00.000Z",
        creationSignature: "fleet-created",
      },
    ]);
    expect(card.activity).toMatchObject({
      address: WALLET,
      band: "1–9",
      reachedEnd: true,
      firstSeen: "2023-09-21T00:00:00.000Z",
      lastSeen: "2024-05-01T00:00:00.000Z",
      firstSignature: "wallet-first",
      lastSignature: "wallet-last",
    });
    expect(card.summary).toContain("Public chain record");
    expect(card.summary).toContain("2 player profiles");
    expect(card.summary).toContain("enlisted with MUD and ONI");
    expect(card.summary).toContain("September 2023");
    expect(card.summary).toContain("May 2024");
    expect(card.summary).not.toContain("Example");
    expect(card.summary).not.toContain("Second");
    expect(card.summary).not.toContain("Northwind");
    expect(card.summary).not.toContain("That's all for now");
    expect(card.gaps).toContain("Profiles with this wallet in a later key slot were not checked.");
    expect(card.gaps).toContain("Closed fleets are absent. Only fleet accounts that still exist are listed.");
    const created = card.sources.find((source) => source.account === PROFILE_A);
    expect(created?.facts).toContainEqual({ fact: "created", signature: "profile-a-created" });
    const fleet = card.sources.find((source) => source.account === FLEET_A);
    expect(fleet?.facts).toContainEqual({ fact: "fleet", signature: null });
    expect(fleet?.facts).toContainEqual({ fact: "created", signature: "fleet-created" });
    const activity = card.sources.find((source) => source.account === WALLET);
    expect(activity?.facts).toContainEqual({ fact: "last-activity", signature: "wallet-last" });
    expect(JSON.stringify(card)).not.toMatch(FINANCIAL);
    expect(JSON.stringify(card)).not.toContain("2020-01-01");
    expect(calls.every((call) => call.host === "api.mainnet-beta.solana.com")).toBe(true);
    expect(calls.every((call) => ["getAccountInfo", "getProgramAccounts", "getSignaturesForAddress"].includes(call.method))).toBe(true);
    const programReads = calls.filter((call) => call.method === "getProgramAccounts");
    expect(programReads.length).toBeGreaterThan(0);
    for (const call of programReads) {
      const config = call.params[1] as { dataSlice?: { offset: number; length: number }; filters?: unknown[] };
      expect(config.dataSlice?.offset).toBe(0);
      expect(config.dataSlice?.length).toBeGreaterThan(0);
      expect(config.filters).toHaveLength(2);
    }
  });

  it("treats a profile address as that profile and dates it from the earliest signature", async () => {
    const { rpc, calls } = rpcFor("profile");
    const card = await readPlayerLegacy({ address: PROFILE_A, rpc, now: () => Date.UTC(2026, 9, 31) });
    expect(card.queried.kind).toBe("profile");
    expect(card.profiles).toHaveLength(1);
    expect(card.profiles[0]?.createdAt).toBe("2023-09-21T00:00:00.000Z");
    expect(card.profiles[0]?.creationSignature).toBe("profile-a-created");
    expect(card.activity?.lastSeen).toBe("2024-05-01T00:00:00.000Z");
    expect(card.fleets[0]?.name).toBe("Northwind");
    expect(card.gaps).not.toContain("Profiles with this wallet in a later key slot were not checked.");
    const profileDiscScans = calls.filter((call) => {
      if (call.method !== "getProgramAccounts" || call.params[0] !== PLAYER_PROFILE_PROGRAM_ID) return false;
      const filters = memcmpFilters(call.params);
      return filters.some((filter) => filter.offset === 0 && sameBytes(filter.bytes, PROFILE_DISC));
    });
    expect(profileDiscScans).toEqual([]);
  });

  it("keeps a thin record short when nothing is on the accounts", async () => {
    const { rpc } = rpcFor("thin");
    const card = await readPlayerLegacy({ address: WALLET, rpc, now: () => Date.UTC(2026, 9, 31) });
    expect(card.dataMode).toBe("live");
    expect(card.profiles).toEqual([]);
    expect(card.fleets).toEqual([]);
    expect(card.summary).toBe("Here's what the public chain shows. No player profile was found for this address. That's all for now.");
    expect(card.gaps.some((gap) => gap.includes("No player profile"))).toBe(true);
    expect(JSON.stringify(card)).not.toMatch(FINANCIAL);
  });

  it("reports an open signature band when the walk stops, without inventing a total", async () => {
    const { rpc, calls } = rpcFor("open");
    const card = await readPlayerLegacy({ address: WALLET, rpc, now: () => Date.UTC(2026, 9, 31) });
    expect(card.dataMode).toBe("partial");
    expect(card.activity?.band).toBe("100 or more");
    expect(card.activity?.reachedEnd).toBe(false);
    expect(card.activity?.firstSeen).toBeNull();
    expect(card.summary).toContain("walk stopped early");
    expect(card.summary).toContain("That's all for now.");
    const text = JSON.stringify(card);
    expect(text).not.toContain("149");
    expect(text).not.toMatch(FINANCIAL);
    const signatureCalls = calls.filter((call) => call.method === "getSignaturesForAddress");
    expect(signatureCalls.length).toBeLessThan(8);
  });

  it("stops before the RPC when the time budget is already spent", async () => {
    const { rpc, calls } = rpcFor("rich");
    let ticks = 0;
    const card = await readPlayerLegacy({
      address: WALLET,
      rpc,
      budgetMs: 1_000,
      now: () => {
        ticks += 1;
        return ticks === 1 ? 0 : 100_000;
      },
    });
    expect(card.dataMode).toBe("partial");
    expect(card.summary).toBe("Here's what the public chain shows. The public mainnet read did not finish. That's all for now.");
    expect(calls).toEqual([]);
  });

  it("caches a card in memory and drops it when the TTL passes", async () => {
    const { fetchImpl, calls } = rpcFor("thin");
    let clock = 0;
    const readers = createLegacyReaders({
      fetchImpl,
      now: () => clock,
      minIntervalMs: 0,
      ttlMs: 1_000,
      gate: fastGate,
      misses: createMissWindow(),
    });
    const first = await readers.playerLegacy({ address: WALLET });
    const used = calls.length;
    expect(used).toBeGreaterThan(0);
    const second = await readers.playerLegacy({ address: WALLET });
    expect(calls.length).toBe(used);
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.summary).toBe(first.summary);
    clock = 1_000;
    await readers.playerLegacy({ address: WALLET });
    expect(calls.length).toBe(used * 2);
  });

  it("rejects an address that is not a Solana address and refuses a browser call", async () => {
    const { rpc, calls } = rpcFor("thin");
    await expect(readPlayerLegacy({ address: "not-a-solana-address", rpc })).rejects.toThrow(/Solana address/);
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {};
    try {
      await expect(readPlayerLegacy({ address: WALLET, rpc })).rejects.toThrow(/server/);
    } finally {
      if (previous === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = previous;
    }
    expect(calls).toEqual([]);
  });

  it("serves the card through the read-only MCP tool", async () => {
    const { fetchImpl } = rpcFor("rich");
    const readers = createLegacyReaders({
      fetchImpl,
      now: () => Date.UTC(2026, 9, 31),
      minIntervalMs: 0,
      gate: fastGate,
      misses: createMissWindow(),
    });
    const deps: NodeDeps = {
      ...stubDaoReaders(),
      ...readers,
      async listStarSystems() {
        return { total: 0, systems: [] };
      },
      async getFleet() {
        return [];
      },
      async auditProfile(profileAddress) {
        return { profileAddress, keyThreshold: 0, authKeyCount: 0, keyCount: 0, riskyKeyCount: 0, keys: [] };
      },
    };
    const handler = createNodeHandler(deps, loadConfig({}));
    const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp"), {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
    });
    const client = new Client({ name: "player-legacy-test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(transport);
    try {
      const listed = (await client.listTools()).tools.map((tool) => tool.name);
      expect(listed).toContain("player_legacy");
      const result = await client.callTool({ name: "player_legacy", arguments: { address: WALLET } });
      expect(result.isError).toBeFalsy();
      const body = result.structuredContent as PlayerLegacyCard;
      expect(body.profiles).toHaveLength(2);
      expect(body.fleets[0]?.name).toBe("Northwind");
      expect(body.summary).toContain("Public chain record");
      expect(JSON.stringify(body)).not.toMatch(FINANCIAL);
      const bad = await client.callTool({ name: "player_legacy", arguments: { address: "00000000000000000000000000000000" } });
      expect(bad.isError).toBe(true);
      const text = (bad.content ?? []).map((item) => ("text" in item ? item.text : "")).join("\n");
      expect(text).toMatch(/Solana address/);
      expect(text).not.toMatch(/\n\s*at\s+/);
    } finally {
      await client.close();
      await handler.close();
    }
  });
});

describe("player legacy names", () => {
  const samples: { raw: string; cleaned: string | null }[] = [
    { raw: "<script>alert(1)</script>", cleaned: "scriptalert1script" },
    { raw: "[x](https://evil.example)", cleaned: "xhttpsevil.example" },
    { raw: "a`b*c(d)", cleaned: "abcd" },
    { raw: "***", cleaned: null },
    { raw: "O'Brien", cleaned: "O'Brien" },
    { raw: "North wind", cleaned: "North wind" },
  ];

  it("drops characters outside the allowlist for profile and fleet names", () => {
    for (const sample of samples) {
      expect(decodePlayerName(nameAccount(PROFILE_A, sample.raw), PROFILE_A)).toBe(sample.cleaned);
      const fleetRaw = sample.raw.slice(0, 32);
      const fleet = decodeFleet(fleetAccount(PROFILE_A, fleetRaw), PROFILE_A);
      if (sample.raw.length <= 32) expect(fleet?.name).toBe(sample.cleaned);
      expect(fleet?.name ?? "").not.toMatch(/[<>`*[\]()]/);
      expect(fleet?.name ?? "").not.toContain("https://");
    }
  });

  it("keeps names out of the summary", () => {
    const summary = buildLegacySummary({
      looked: true,
      partial: false,
      profiles: [
        {
          address: PROFILE_A,
          name: "<script>alert(1)</script>",
          faction: "MUD",
          factionAccount: null,
          createdAt: null,
          creationSignature: null,
        },
      ],
      fleetCount: 1,
      activity: null,
    });
    expect(summary).toBe("Public chain record: 1 player profile, enlisted with MUD, 1 SAGE fleet still on the accounts.");
    expect(summary).not.toContain("script");
    expect(summary).not.toContain("<");
    expect(summary).not.toContain("*");
  });
});

describe("player legacy limits", () => {
  it("passes a shrinking per-call timeout and stops the walk inside the budget", async () => {
    const { rpc } = rpcFor("open");
    const timeouts: number[] = [];
    let clock = 0;
    const wrapped: SolanaReadRpc = {
      call: (async (method: string, params: readonly unknown[], options?: { timeoutMs?: number }) => {
        timeouts.push(options?.timeoutMs ?? -1);
        const result = await rpc.call(method, params);
        clock += 3_500;
        return result;
      }) as SolanaReadRpc["call"],
      batch: rpc.batch.bind(rpc),
    };
    const card = await readPlayerLegacy({ address: WALLET, rpc: wrapped, now: () => clock, budgetMs: 12_000 });
    expect(timeouts[0]).toBe(4_000);
    expect(timeouts.some((timeout) => timeout > 0 && timeout < 4_000)).toBe(true);
    expect(card.dataMode).toBe("partial");
    expect(clock).toBeLessThanOrEqual(12_000 + 3_500);
  });

  it("keeps at most four legacy RPC calls in flight and spaces their starts", async () => {
    let clock = 0;
    const waits: number[] = [];
    const gate = createRpcGate({
      maxInFlight: 4,
      spacingMs: 200,
      now: () => clock,
      sleep: async (ms: number) => {
        waits.push(ms);
        clock += ms;
      },
    });
    await gate.run(async () => undefined);
    await gate.run(async () => undefined);
    expect(waits).toEqual([200]);

    let current = 0;
    let peak = 0;
    const busy = createRpcGate({ maxInFlight: 4, spacingMs: 0 });
    await Promise.all(
      Array.from({ length: 8 }, () =>
        busy.run(async () => {
          current += 1;
          peak = Math.max(peak, current);
          await new Promise((resolve) => setTimeout(resolve, 15));
          current -= 1;
        }),
      ),
    );
    expect(peak).toBe(4);
  });

  it("returns an unavailable card after 30 new lookups in a minute", async () => {
    const { fetchImpl, calls } = rpcFor("thin");
    const readers = createLegacyReaders({
      fetchImpl,
      now: () => 5_000,
      minIntervalMs: 0,
      gate: fastGate,
      misses: createMissWindow(2, 60_000),
    });
    const first = await readers.playerLegacy({ address: WALLET });
    const second = await readers.playerLegacy({ address: PROFILE_A });
    const used = calls.length;
    expect(first.summary).not.toContain("unavailable, try later");
    expect(second.summary).not.toContain("unavailable, try later");
    const third = await readers.playerLegacy({ address: PROFILE_B });
    expect(calls.length).toBe(used);
    expect(third.summary).toContain("unavailable, try later");
    expect(third.fromCache).toBe(false);
    expect(JSON.stringify(third)).not.toMatch(FINANCIAL);
    const again = await readers.playerLegacy({ address: WALLET });
    expect(again.fromCache).toBe(true);
    expect(again.summary).toBe(first.summary);
  });
});

describe("player legacy copy", () => {
  it("keeps financial framing out of the legacy modules", () => {
    const files = readdirSync("src/legacy").filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    const hits = files.filter((name) => FINANCIAL.test(readFileSync(path.join("src/legacy", name), "utf8")));
    expect(hits).toEqual([]);
  });
});
