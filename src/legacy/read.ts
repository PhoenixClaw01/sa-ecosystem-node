import { SafeClientError, UserInputError, publicErrorMessage } from "../errors.js";
import { base58Decode, base58Encode } from "../hub/base58.js";
import { listSignatures, createRpcClient, type RpcCallOptions, type SolanaReadRpc } from "../dao/rpc.js";
import { createTtlCache } from "./cache.js";
import {
  finishLegacyCard,
  signatureBand,
  unavailableLegacyCard,
  type LegacyActivity,
  type LegacyFact,
  type LegacyFleet,
  type LegacyProfile,
  type LegacySource,
  type PlayerLegacyCard,
} from "./card.js";
import { sharedLegacyGate, sharedMissWindow, type MissWindow, type RpcGate } from "./gate.js";
import { decodeFaction, decodeFleet, decodePlayerName, isProfileAccount, profileHasKey } from "./decode.js";
import {
  factionParams,
  fleetParams,
  MAINNET_BETA_RPC_HOST,
  MAX_PROFILE_KEY_SLOTS,
  PLAYER_PROFILE_PROGRAM_ID,
  playerNameParams,
  profileByKeyParams,
  PROFILE_SLICE_LENGTH,
  SAGE_LEGACY_PROGRAM_ID,
  SAGE_STARBASED_PROGRAM_ID,
} from "./programs.js";

const WALLET_SIGNATURE_PAGES = 4;
const PROFILE_SIGNATURE_PAGES = 2;
const FLEET_SIGNATURE_PAGES = 1;
const MAX_PROFILES = 8;
const MAX_FLEETS = 8;
const DEFAULT_BUDGET_MS = 12_000;
const DEFAULT_TTL_MS = 60_000;
const CACHE_ENTRIES = 32;

const CLOSED_FLEET_GAP = "Closed fleets are absent. Only fleet accounts that still exist are listed.";
const LATER_KEY_SLOT_GAP = "Profiles with this wallet in a later key slot were not checked.";
const CALL_BUDGET_MS = 4_000;

export interface LegacyReaders {
  playerLegacy(query: { address: string }): Promise<PlayerLegacyCard>;
}

export function canonicalAddress(value: string): string {
  const trimmed = value.trim();
  let bytes: Uint8Array;
  try {
    bytes = base58Decode(trimmed);
  } catch {
    throw new UserInputError("The address is not a Solana address.");
  }
  if (bytes.length !== 32) throw new UserInputError("The address is not a Solana address.");
  const encoded = base58Encode(bytes);
  if (encoded !== trimmed) throw new UserInputError("The address is not a Solana address.");
  return encoded;
}

function runsInBrowser(): boolean {
  return typeof (globalThis as { window?: unknown }).window !== "undefined";
}

function isoTime(blockTime: number | null | undefined): string | null {
  if (typeof blockTime !== "number" || !Number.isFinite(blockTime)) return null;
  return new Date(blockTime * 1000).toISOString();
}

function decodeBase64(text: string): Uint8Array {
  const buffer = Buffer.from(text, "base64");
  return Uint8Array.from(buffer);
}

interface AccountBytes {
  owner: string;
  data: Uint8Array;
}

function parseAccountInfo(result: unknown): AccountBytes | null {
  if (!result || typeof result !== "object" || !("value" in result)) {
    throw new Error("getAccountInfo returned an unexpected shape.");
  }
  const value = (result as { value: unknown }).value;
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new Error("getAccountInfo returned an unexpected shape.");
  const owner = (value as { owner?: unknown }).owner;
  const data = (value as { data?: unknown }).data;
  if (typeof owner !== "string" || !Array.isArray(data) || typeof data[0] !== "string" || data[1] !== "base64") {
    throw new Error("getAccountInfo returned an unexpected shape.");
  }
  return { owner, data: decodeBase64(data[0]) };
}

function parseProgramAccounts(result: unknown): { pubkey: string; data: Uint8Array }[] {
  if (!Array.isArray(result)) throw new Error("getProgramAccounts returned an unexpected shape.");
  return result.map((item) => {
    if (!item || typeof item !== "object") throw new Error("getProgramAccounts returned an unexpected shape.");
    const pubkey = (item as { pubkey?: unknown }).pubkey;
    const data = (item as { account?: { data?: unknown } }).account?.data;
    if (typeof pubkey !== "string" || !Array.isArray(data) || typeof data[0] !== "string" || data[1] !== "base64") {
      throw new Error("getProgramAccounts returned an unexpected shape.");
    }
    return { pubkey, data: decodeBase64(data[0]) };
  });
}

interface ReadState {
  looked: boolean;
  partial: boolean;
  gaps: string[];
  stopped: boolean;
}

function note(state: ReadState, gap: string): void {
  if (state.gaps.length >= 12) return;
  if (!state.gaps.includes(gap)) state.gaps.push(gap);
}

async function guarded<T>(
  state: ReadState,
  budget: { expired(): boolean },
  run: () => Promise<T>,
): Promise<T | undefined> {
  if (state.stopped || budget.expired()) {
    state.partial = true;
    state.stopped = true;
    note(state, "The read stopped because the time budget ran out.");
    return undefined;
  }
  try {
    const value = await run();
    state.looked = true;
    return value;
  } catch (error) {
    state.partial = true;
    note(state, publicErrorMessage(error));
    return undefined;
  }
}

async function readAccount(
  rpc: SolanaReadRpc,
  address: string,
  sliceLength: number,
): Promise<AccountBytes | null> {
  const result = await rpc.call<unknown>("getAccountInfo", [
    address,
    { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: sliceLength } },
  ]);
  return parseAccountInfo(result);
}

async function readProgramAccounts(
  rpc: SolanaReadRpc,
  params: [string, Record<string, unknown>],
): Promise<{ pubkey: string; data: Uint8Array }[]> {
  const result = await rpc.call<unknown>("getProgramAccounts", params);
  return parseProgramAccounts(result);
}

function budgetedRpc(rpc: SolanaReadRpc, deadline: number, now: () => number): SolanaReadRpc {
  return {
    async call<T>(method: string, params: readonly unknown[], options?: RpcCallOptions): Promise<T> {
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new SafeClientError("The read stopped because the time budget ran out.");
      }
      const timeoutMs = Math.min(CALL_BUDGET_MS, remaining, options?.timeoutMs ?? CALL_BUDGET_MS);
      return rpc.call<T>(method, params, { timeoutMs });
    },
    batch(requests) {
      return rpc.batch(requests);
    },
  };
}

async function readActivity(
  rpc: SolanaReadRpc,
  address: string,
  maxPages: number,
  deadline: number,
  now: () => number,
): Promise<LegacyActivity> {
  const listed = await listSignatures(rpc, address, null, { maxPages, deadlineMs: deadline, now });
  const newest = listed.signatures[0];
  const oldest = listed.reachedEnd ? listed.signatures[listed.signatures.length - 1] : undefined;
  return {
    address,
    band: signatureBand(listed.signatures.length, listed.reachedEnd),
    reachedEnd: listed.reachedEnd,
    firstSeen: isoTime(oldest?.blockTime),
    lastSeen: isoTime(newest?.blockTime),
    firstSignature: oldest?.signature ?? null,
    lastSignature: newest?.signature ?? null,
  };
}

function addFact(sources: Map<string, LegacyFact[]>, account: string, fact: string, signature: string | null): void {
  const facts = sources.get(account) ?? [];
  facts.push({ fact, signature });
  sources.set(account, facts);
}

export async function readPlayerLegacy(input: {
  address: string;
  rpc: SolanaReadRpc;
  now?: () => number;
  budgetMs?: number;
}): Promise<PlayerLegacyCard> {
  if (runsInBrowser()) {
    throw new SafeClientError("This read runs on the server. The public mainnet RPC refuses browser calls.");
  }
  const address = canonicalAddress(input.address);
  const now = input.now ?? Date.now;
  const started = now();
  const budgetMs = input.budgetMs ?? DEFAULT_BUDGET_MS;
  const deadline = started + budgetMs;
  const budget = { expired: () => now() >= deadline };
  const rpc = budgetedRpc(input.rpc, deadline, now);
  const state: ReadState = { looked: false, partial: false, gaps: [], stopped: false };
  const asOf = new Date(started).toISOString();
  const sources = new Map<string, LegacyFact[]>();

  const info = await guarded(state, budget, () => readAccount(rpc, address, PROFILE_SLICE_LENGTH));
  let kind: "wallet" | "profile" = "wallet";
  const profiles: LegacyProfile[] = [];
  const fleets: LegacyFleet[] = [];

  if (info && info.owner === PLAYER_PROFILE_PROGRAM_ID && isProfileAccount(info.data)) {
    kind = "profile";
    profiles.push({
      address,
      name: null,
      faction: null,
      factionAccount: null,
      createdAt: null,
      creationSignature: null,
    });
    addFact(sources, address, "profile", null);
  } else if (info !== undefined) {
    note(state, LATER_KEY_SLOT_GAP);
    const found = new Map<string, LegacyProfile>();
    for (let slot = 0; slot < MAX_PROFILE_KEY_SLOTS; slot += 1) {
      const rows = await guarded(state, budget, () => readProgramAccounts(rpc, profileByKeyParams(address, slot)));
      if (!rows) break;
      for (const row of rows) {
        if (!profileHasKey(row.data, address, slot)) {
          state.partial = true;
          note(state, "A profile account did not match the key filter that was sent.");
          continue;
        }
        if (!found.has(row.pubkey)) {
          found.set(row.pubkey, {
            address: row.pubkey,
            name: null,
            faction: null,
            factionAccount: null,
            createdAt: null,
            creationSignature: null,
          });
        }
      }
    }
    const ordered = [...found.values()];
    if (ordered.length > MAX_PROFILES) {
      state.partial = true;
      note(state, "More player profiles matched than this read returns.");
    }
    for (const profile of ordered.slice(0, MAX_PROFILES)) {
      profiles.push(profile);
      addFact(sources, profile.address, "profile", null);
    }
    if (state.looked && profiles.length === 0) {
      note(state, "No player profile matched the first key slots for this address.");
    }
  }

  let missingName = false;
  let missingFaction = false;
  let unreadableFleet = false;
  let fleetCreationOpen = false;
  let profileCreationOpen = false;
  let searchedFleets = false;

  for (const profile of profiles) {
    const names = await guarded(state, budget, () => readProgramAccounts(rpc, playerNameParams(profile.address)));
    if (names) {
      const named = names.find((row) => decodePlayerName(row.data, profile.address));
      const name = named ? decodePlayerName(named.data, profile.address) : null;
      if (named && name) {
        profile.name = name;
        addFact(sources, named.pubkey, "name", null);
      } else missingName = true;
    }
    const factions = await guarded(state, budget, () => readProgramAccounts(rpc, factionParams(profile.address)));
    if (factions) {
      const match = factions.find((row) => decodeFaction(row.data, profile.address));
      if (match) {
        profile.faction = decodeFaction(match.data, profile.address);
        profile.factionAccount = match.pubkey;
        addFact(sources, match.pubkey, "faction", null);
      } else missingFaction = true;
    }
    for (const program of [
      { id: SAGE_STARBASED_PROGRAM_ID, label: "SAGE" as const },
      { id: SAGE_LEGACY_PROGRAM_ID, label: "Legacy SAGE" as const },
    ]) {
      if (fleets.length >= MAX_FLEETS) {
        state.partial = true;
        note(state, "More SAGE fleets matched than this read returns.");
        break;
      }
      const rows = await guarded(state, budget, () => readProgramAccounts(rpc, fleetParams(program.id, profile.address)));
      if (!rows) continue;
      searchedFleets = true;
      for (const row of rows) {
        if (fleets.length >= MAX_FLEETS) {
          state.partial = true;
          note(state, "More SAGE fleets matched than this read returns.");
          break;
        }
        const fleet = decodeFleet(row.data, profile.address);
        if (!fleet) {
          state.partial = true;
          note(state, "A fleet account did not match the owner filter that was sent.");
          continue;
        }
        if (!fleet.name) unreadableFleet = true;
        fleets.push({
          address: row.pubkey,
          name: fleet.name,
          program: program.label,
          ownerProfile: profile.address,
          createdAt: null,
          creationSignature: null,
        });
        addFact(sources, row.pubkey, "fleet", null);
      }
    }
  }

  const activity = await guarded(state, budget, () =>
    readActivity(
      rpc,
      address,
      kind === "profile" ? Math.max(WALLET_SIGNATURE_PAGES, PROFILE_SIGNATURE_PAGES) : WALLET_SIGNATURE_PAGES,
      deadline,
      now,
    ),
  );
  if (activity && !activity.reachedEnd) state.partial = true;
  if (activity) {
    addFact(sources, address, "first-activity", activity.firstSignature);
    addFact(sources, address, "last-activity", activity.lastSignature);
    if (kind === "profile") {
      const profile = profiles[0];
      if (profile) {
        profile.createdAt = activity.reachedEnd ? activity.firstSeen : null;
        profile.creationSignature = activity.reachedEnd ? activity.firstSignature : null;
        if (activity.reachedEnd) addFact(sources, profile.address, "created", profile.creationSignature);
        else profileCreationOpen = true;
      }
    }
  }

  if (kind === "wallet") {
    for (const profile of profiles) {
      const created = await guarded(state, budget, () => readActivity(rpc, profile.address, PROFILE_SIGNATURE_PAGES, deadline, now));
      if (!created) continue;
      if (!created.reachedEnd) {
        state.partial = true;
        profileCreationOpen = true;
        continue;
      }
      profile.createdAt = created.firstSeen;
      profile.creationSignature = created.firstSignature;
      addFact(sources, profile.address, "created", created.firstSignature);
    }
  }

  for (const fleet of fleets) {
    const created = await guarded(state, budget, () => readActivity(rpc, fleet.address, FLEET_SIGNATURE_PAGES, deadline, now));
    if (!created) continue;
    if (!created.reachedEnd) {
      state.partial = true;
      fleetCreationOpen = true;
      continue;
    }
    fleet.createdAt = created.firstSeen;
    fleet.creationSignature = created.firstSignature;
    addFact(sources, fleet.address, "created", created.firstSignature);
  }

  if (missingName) note(state, "A profile had no name account.");
  if (missingFaction) note(state, "A profile had no faction enlistment account.");
  if (unreadableFleet) note(state, "A fleet account had no readable name.");
  if (profileCreationOpen) note(state, "The earliest signature for a profile was not reached, so its creation date is not shown.");
  if (fleetCreationOpen) note(state, "The earliest signature for a fleet was not reached, so its creation date is not shown.");
  if (searchedFleets) note(state, CLOSED_FLEET_GAP);

  const sourceList: LegacySource[] = [...sources.entries()].map(([account, facts]) => ({ account, facts }));
  return finishLegacyCard({
    looked: state.looked,
    partial: state.partial,
    asOf,
    fromCache: false,
    queried: { address, kind },
    profiles,
    fleets,
    activity: activity ?? null,
    gaps: state.gaps,
    sources: sourceList,
  });
}

export function createLegacyReaders(options?: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  minIntervalMs?: number;
  ttlMs?: number;
  budgetMs?: number;
  gate?: RpcGate;
  misses?: MissWindow;
}): LegacyReaders {
  const now = options?.now ?? Date.now;
  const gate = options?.gate ?? sharedLegacyGate;
  const misses = options?.misses ?? sharedMissWindow;
  const rawFetch = options?.fetchImpl ?? fetch;
  const fetchImpl: typeof fetch = (input, init) => gate.run(() => rawFetch(input, init));
  const rpc = createRpcClient(`https://${MAINNET_BETA_RPC_HOST}`, fetchImpl, {
    minIntervalMs: options?.minIntervalMs ?? 0,
    attempts: 2,
    timeoutMs: CALL_BUDGET_MS,
  });
  const cache = createTtlCache<PlayerLegacyCard>(options?.ttlMs ?? DEFAULT_TTL_MS, CACHE_ENTRIES);
  return {
    async playerLegacy({ address }) {
      const key = canonicalAddress(address);
      const hit = cache.get(key, now());
      if (hit) return { ...hit, fromCache: true };
      if (!misses.permit(key, now())) return unavailableLegacyCard(key, new Date(now()).toISOString());
      const card = await readPlayerLegacy({
        address: key,
        rpc,
        now,
        budgetMs: options?.budgetMs ?? DEFAULT_BUDGET_MS,
      });
      cache.set(key, card, now());
      return card;
    },
  };
}
