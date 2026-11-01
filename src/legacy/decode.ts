import { base58Encode } from "../hub/base58.js";
import {
  FACTION_DISCRIMINATOR,
  FACTION_PROFILE_OFFSET,
  FLEET_DISCRIMINATOR,
  FLEET_LABEL_OFFSET,
  FLEET_OWNER_OFFSET,
  factionName,
  PLAYER_NAME_DISCRIMINATOR,
  PLAYER_NAME_PROFILE_OFFSET,
  PLAYER_PROFILE_PROGRAM_ID,
  PROFILE_DISCRIMINATOR,
  PROFILE_KEY_COUNT_OFFSET,
  PROFILE_KEY_OFFSET,
  PROFILE_KEY_STRIDE,
  type FactionName,
} from "./programs.js";

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function hasDiscriminator(data: Uint8Array, discriminator: Uint8Array): boolean {
  return data.length >= discriminator.length && bytesEqual(data.subarray(0, discriminator.length), discriminator);
}

function pubkeyAt(data: Uint8Array, offset: number): string | null {
  if (data.length < offset + 32) return null;
  return base58Encode(data.subarray(offset, offset + 32));
}

export function isProfileAccount(data: Uint8Array): boolean {
  return hasDiscriminator(data, PROFILE_DISCRIMINATOR);
}

export function profileHasKey(data: Uint8Array, wallet: string, slot: number): boolean {
  if (!isProfileAccount(data)) return false;
  const found = pubkeyAt(data, PROFILE_KEY_OFFSET + slot * PROFILE_KEY_STRIDE);
  return found === wallet;
}

/**
 * Whether `wallet` is an unexpired auth key on this Profile account.
 * Slot 0 is the auth key. Any later slot counts only when its scope is the
 * Player Profile program and the AUTH permission bit is set.
 * A negative expiry does not expire. The scan stops at `scanMax` keys.
 */
export function profileWalletKey(
  data: Uint8Array,
  wallet: string,
  nowSeconds: bigint,
  scanMax: number,
): "match" | "mismatch" | "truncated" {
  if (!isProfileAccount(data) || data.length < PROFILE_KEY_OFFSET || !Number.isInteger(scanMax) || scanMax < 1) {
    return "mismatch";
  }
  const keyCount = (data[PROFILE_KEY_COUNT_OFFSET] ?? 0) + ((data[PROFILE_KEY_COUNT_OFFSET + 1] ?? 0) << 8);
  const available = Math.floor((data.length - PROFILE_KEY_OFFSET) / PROFILE_KEY_STRIDE);
  const scan = Math.min(keyCount, available, scanMax);
  for (let slot = 0; slot < scan; slot += 1) {
    const offset = PROFILE_KEY_OFFSET + slot * PROFILE_KEY_STRIDE;
    if (!unexpiredKey(data, offset, wallet, nowSeconds)) continue;
    if (slot === 0 || profileAuthPermission(data, offset)) return "match";
  }
  if (keyCount > scan) return "truncated";
  return "mismatch";
}

function unexpiredKey(data: Uint8Array, offset: number, wallet: string, nowSeconds: bigint): boolean {
  if (pubkeyAt(data, offset) !== wallet) return false;
  const expiry = readI64(data, offset + 64);
  if (expiry === null) return false;
  return expiry < 0n || expiry > nowSeconds;
}

/** AUTH is bit 0. The only profile-program scope is the program id. */
function profileAuthPermission(data: Uint8Array, offset: number): boolean {
  if (pubkeyAt(data, offset + 32) !== PLAYER_PROFILE_PROGRAM_ID) return false;
  return ((data[offset + 72] ?? 0) & 1) === 1;
}

function readI64(data: Uint8Array, offset: number): bigint | null {
  if (data.length < offset + 8) return null;
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value |= BigInt(data[offset + index] ?? 0) << (8n * BigInt(index));
  }
  if (value >= 0x8000000000000000n) value -= 0x10000000000000000n;
  return value;
}

export function decodePlayerName(data: Uint8Array, profile: string): string | null {
  if (!hasDiscriminator(data, PLAYER_NAME_DISCRIMINATOR)) return null;
  if (pubkeyAt(data, PLAYER_NAME_PROFILE_OFFSET) !== profile) return null;
  const start = PLAYER_NAME_PROFILE_OFFSET + 32 + 1;
  if (data.length < start) return null;
  return readableLabel(data.subarray(start));
}

export function decodeFaction(data: Uint8Array, profile: string): FactionName | null {
  if (!hasDiscriminator(data, FACTION_DISCRIMINATOR)) return null;
  if (pubkeyAt(data, FACTION_PROFILE_OFFSET) !== profile) return null;
  const factionOffset = FACTION_PROFILE_OFFSET + 32;
  const value = data[factionOffset];
  if (value === undefined) return null;
  return factionName(value);
}

export function decodeFleet(data: Uint8Array, profile: string): { name: string | null } | null {
  if (!hasDiscriminator(data, FLEET_DISCRIMINATOR)) return null;
  if (pubkeyAt(data, FLEET_OWNER_OFFSET) !== profile) return null;
  if (data.length < FLEET_LABEL_OFFSET + 32) return { name: null };
  return { name: readableLabel(data.subarray(FLEET_LABEL_OFFSET, FLEET_LABEL_OFFSET + 32)) };
}

/** Letters, digits, space, and . _ ' - only. Every other character is dropped. */
const LABEL_CHAR = /[A-Za-z0-9 ._'-]/;

function readableLabel(bytes: Uint8Array): string | null {
  const end = bytes.indexOf(0);
  const slice = end === -1 ? bytes : bytes.subarray(0, end);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(slice);
  } catch {
    return null;
  }
  let cleaned = "";
  for (const char of text) {
    if (LABEL_CHAR.test(char)) cleaned += char;
  }
  cleaned = cleaned.trim();
  if (!cleaned || cleaned.length > 64) return null;
  return cleaned;
}
