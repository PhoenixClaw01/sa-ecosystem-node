import { base58Decode, base58Encode } from "../hub/base58.js";
import { SafeClientError } from "../errors.js";

/** Free public mainnet HTTP RPC. Browsers receive 403, so reads stay on the server. */
export const MAINNET_BETA_RPC_HOST = "api.mainnet-beta.solana.com";

export const PLAYER_PROFILE_PROGRAM_ID = "pprofELXjL5Kck7Jn5hCpwAL82DpTkSYBENzahVtbc9";
export const PROFILE_FACTION_PROGRAM_ID = "pFACSRuobDmvfMKq1bAzwj27t6d2GJhSCHb1VcfnRmq";
export const SAGE_STARBASED_PROGRAM_ID = "SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE";
export const SAGE_LEGACY_PROGRAM_ID = "SAGEqqFewepDHH6hMDcmWy7yjHPpyKLDnRXKb3Ki8e6";

/** Published Profile account discriminator. */
export const PROFILE_DISCRIMINATOR = Uint8Array.of(184, 101, 165, 188, 95, 63, 127, 188);
export const PLAYER_NAME_DISCRIMINATOR = Uint8Array.of(102, 9, 241, 98, 96, 196, 212, 161);
export const FACTION_DISCRIMINATOR = Uint8Array.of(14, 149, 119, 243, 145, 240, 79, 227);
export const FLEET_DISCRIMINATOR = Uint8Array.of(109, 207, 251, 48, 106, 2, 136, 163);

/**
 * Profile bytes: 8 discriminator + 20 header + 2 key-count + keys.
 * Each key is 32 + 32 + 8 + 8. The first key therefore starts at offset 30.
 */
export const PROFILE_KEY_OFFSET = 30;
/** Little-endian u16 key count. It sits in the two bytes before the first key. */
export const PROFILE_KEY_COUNT_OFFSET = 28;
export const PROFILE_KEY_STRIDE = 80;
export const MAX_PROFILE_KEY_SLOTS = 4;
/** One claim check reads at most this many ProfileKey entries. */
export const PROFILE_KEY_SCAN_MAX = 32;

/** PlayerName: discriminator, version, profile pubkey. The pubkey starts at offset 9. */
export const PLAYER_NAME_PROFILE_OFFSET = 9;
export const PLAYER_NAME_SLICE_LENGTH = 106;

/** ProfileFactionAccount: discriminator, version, profile pubkey at offset 9, then the faction byte. */
export const FACTION_PROFILE_OFFSET = 9;
export const FACTION_SLICE_LENGTH = 43;

/**
 * Fleet prefix shared by Starbased and Legacy SAGE:
 * discriminator, version, game id, then owner profile at offset 41.
 * The 32-byte label starts at offset 170.
 */
export const FLEET_OWNER_OFFSET = 41;
export const FLEET_LABEL_OFFSET = 170;
export const FLEET_SLICE_LENGTH = 202;

export const PROFILE_SLICE_LENGTH = PROFILE_KEY_OFFSET + PROFILE_KEY_STRIDE * MAX_PROFILE_KEY_SLOTS;

const FACTION_NAMES = ["Unaligned", "MUD", "ONI", "Ustur"] as const;
export type FactionName = (typeof FACTION_NAMES)[number];

export function factionName(value: number): FactionName | null {
  return FACTION_NAMES[value] ?? null;
}

interface DiscRule {
  bytes: Uint8Array;
  pubkeyOffsets: readonly number[];
}

interface ProgramRule {
  id: string;
  maxSlice: number;
  discriminators: readonly DiscRule[];
}

const PROGRAM_RULES: readonly ProgramRule[] = [
  {
    id: PLAYER_PROFILE_PROGRAM_ID,
    maxSlice: PROFILE_SLICE_LENGTH,
    discriminators: [
      {
        bytes: PROFILE_DISCRIMINATOR,
        pubkeyOffsets: Array.from({ length: MAX_PROFILE_KEY_SLOTS }, (_, slot) => PROFILE_KEY_OFFSET + slot * PROFILE_KEY_STRIDE),
      },
      { bytes: PLAYER_NAME_DISCRIMINATOR, pubkeyOffsets: [PLAYER_NAME_PROFILE_OFFSET] },
    ],
  },
  {
    id: PROFILE_FACTION_PROGRAM_ID,
    maxSlice: FACTION_SLICE_LENGTH,
    discriminators: [{ bytes: FACTION_DISCRIMINATOR, pubkeyOffsets: [FACTION_PROFILE_OFFSET] }],
  },
  {
    id: SAGE_STARBASED_PROGRAM_ID,
    maxSlice: FLEET_SLICE_LENGTH,
    discriminators: [{ bytes: FLEET_DISCRIMINATOR, pubkeyOffsets: [FLEET_OWNER_OFFSET] }],
  },
  {
    id: SAGE_LEGACY_PROGRAM_ID,
    maxSlice: FLEET_SLICE_LENGTH,
    discriminators: [{ bytes: FLEET_DISCRIMINATOR, pubkeyOffsets: [FLEET_OWNER_OFFSET] }],
  },
];

export interface MemcmpFilter {
  offset: number;
  bytes: Uint8Array;
}

export function programAccountsParams(
  programId: string,
  filters: readonly MemcmpFilter[],
  sliceLength: number,
): [string, Record<string, unknown>] {
  return [
    programId,
    {
      encoding: "base64",
      commitment: "confirmed",
      dataSlice: { offset: 0, length: sliceLength },
      filters: filters.map((filter) => ({
        memcmp: { offset: filter.offset, bytes: base58Encode(filter.bytes) },
      })),
    },
  ];
}

export function profileByKeyParams(wallet: string, slot: number): [string, Record<string, unknown>] {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_PROFILE_KEY_SLOTS) {
    throw new SafeClientError("Profile key slot is outside the slots this node searches.");
  }
  return programAccountsParams(
    PLAYER_PROFILE_PROGRAM_ID,
    [
      { offset: 0, bytes: PROFILE_DISCRIMINATOR },
      { offset: PROFILE_KEY_OFFSET + slot * PROFILE_KEY_STRIDE, bytes: base58Decode(wallet) },
    ],
    PROFILE_SLICE_LENGTH,
  );
}

export function playerNameParams(profile: string): [string, Record<string, unknown>] {
  return programAccountsParams(
    PLAYER_PROFILE_PROGRAM_ID,
    [
      { offset: 0, bytes: PLAYER_NAME_DISCRIMINATOR },
      { offset: PLAYER_NAME_PROFILE_OFFSET, bytes: base58Decode(profile) },
    ],
    PLAYER_NAME_SLICE_LENGTH,
  );
}

export function factionParams(profile: string): [string, Record<string, unknown>] {
  return programAccountsParams(
    PROFILE_FACTION_PROGRAM_ID,
    [
      { offset: 0, bytes: FACTION_DISCRIMINATOR },
      { offset: FACTION_PROFILE_OFFSET, bytes: base58Decode(profile) },
    ],
    FACTION_SLICE_LENGTH,
  );
}

export function fleetParams(programId: string, profile: string): [string, Record<string, unknown>] {
  return programAccountsParams(
    programId,
    [
      { offset: 0, bytes: FLEET_DISCRIMINATOR },
      { offset: FLEET_OWNER_OFFSET, bytes: base58Decode(profile) },
    ],
    FLEET_SLICE_LENGTH,
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function parseMemcmp(filter: unknown): { offset: number; bytes: Uint8Array } {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    throw new SafeClientError("getProgramAccounts filters must be memcmp filters.");
  }
  const keys = Object.keys(filter);
  if (keys.length !== 1 || keys[0] !== "memcmp") {
    throw new SafeClientError("getProgramAccounts filters must be memcmp filters.");
  }
  const memcmp = (filter as { memcmp?: unknown }).memcmp;
  if (!memcmp || typeof memcmp !== "object" || Array.isArray(memcmp)) {
    throw new SafeClientError("getProgramAccounts filters must be memcmp filters.");
  }
  const memcmpKeys = Object.keys(memcmp);
  if (memcmpKeys.length !== 2 || !memcmpKeys.includes("offset") || !memcmpKeys.includes("bytes")) {
    throw new SafeClientError("getProgramAccounts memcmp filters take an offset and bytes.");
  }
  const offset = (memcmp as { offset?: unknown }).offset;
  const encoded = (memcmp as { bytes?: unknown }).bytes;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
    throw new SafeClientError("getProgramAccounts memcmp offset is not allowed.");
  }
  if (typeof encoded !== "string") {
    throw new SafeClientError("getProgramAccounts memcmp bytes are not base58.");
  }
  try {
    return { offset, bytes: base58Decode(encoded) };
  } catch {
    throw new SafeClientError("getProgramAccounts memcmp bytes are not base58.");
  }
}

/**
 * getProgramAccounts is a read, and it is still a scan unless the program id,
 * the discriminator, the pubkey offset, and the dataSlice are all fixed.
 */
export function assertProgramAccountsParams(params: readonly unknown[]): void {
  if (params.length !== 2 || typeof params[0] !== "string") {
    throw new SafeClientError("getProgramAccounts needs a program id and a filter config.");
  }
  const rule = PROGRAM_RULES.find((item) => item.id === params[0]);
  if (!rule) {
    throw new SafeClientError("getProgramAccounts is limited to the Player Profile, Profile Faction, and SAGE programs.");
  }
  const config = params[1];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new SafeClientError("getProgramAccounts needs a filter config.");
  }
  const record = config as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "encoding" && key !== "commitment" && key !== "filters" && key !== "dataSlice") {
      throw new SafeClientError("getProgramAccounts config has a field this node does not send.");
    }
  }
  if (record.encoding !== "base64") {
    throw new SafeClientError("getProgramAccounts encoding must be base64.");
  }
  if (record.commitment !== undefined && record.commitment !== "confirmed") {
    throw new SafeClientError("getProgramAccounts commitment must be confirmed.");
  }
  const slice = record.dataSlice;
  if (!slice || typeof slice !== "object" || Array.isArray(slice)) {
    throw new SafeClientError("getProgramAccounts requires a dataSlice.");
  }
  const sliceOffset = (slice as { offset?: unknown }).offset;
  const sliceLength = (slice as { length?: unknown }).length;
  if (sliceOffset !== 0 || typeof sliceLength !== "number" || !Number.isInteger(sliceLength) || sliceLength < 1 || sliceLength > rule.maxSlice) {
    throw new SafeClientError("getProgramAccounts dataSlice is outside the allowed range.");
  }
  if (!Array.isArray(record.filters) || record.filters.length !== 2) {
    throw new SafeClientError("getProgramAccounts requires a discriminator filter and one pubkey filter.");
  }
  const parsed = record.filters.map((filter) => parseMemcmp(filter));
  const discriminator = parsed.find((filter) => filter.offset === 0);
  const pubkey = parsed.find((filter) => filter.offset !== 0);
  if (!discriminator || !pubkey) {
    throw new SafeClientError("getProgramAccounts requires a discriminator filter and one pubkey filter.");
  }
  const discRule = rule.discriminators.find((item) => bytesEqual(item.bytes, discriminator.bytes));
  if (!discRule || discriminator.bytes.length !== 8) {
    throw new SafeClientError("getProgramAccounts discriminator is not one this node searches.");
  }
  if (!discRule.pubkeyOffsets.includes(pubkey.offset) || pubkey.bytes.length !== 32) {
    throw new SafeClientError("getProgramAccounts pubkey filter is not at an allowed offset.");
  }
}
