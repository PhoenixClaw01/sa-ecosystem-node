import type { FleetSummary } from "./summarize.js";

/** Result of a fleet read. `unreadableFleetCount` counts owned fleet accounts the pinned bindings could not decode. */
export interface FleetLookup {
  fleets: FleetSummary[];
  unreadableFleetCount: number;
}

/** Most fleet accounts one profile lookup will read one by one after a batched read fails. */
export const MAX_FALLBACK_FLEETS = 500;
/** Fleets read together in one batched request during the fallback. */
export const FALLBACK_BATCH_SIZE = 25;

export interface TolerantFleetReads<T> {
  /** Batched read of the whole profile; throws when any one fleet cannot be decoded. */
  readAll(): Promise<readonly T[]>;
  /** Addresses of fleet accounts owned by the profile, without decoding them. */
  discoverAddresses(): Promise<readonly string[]>;
  /** Batched read of the given addresses; throws when any one cannot be decoded. */
  readMany(addresses: readonly string[]): Promise<readonly T[]>;
  /** Read of one address. */
  readOne(address: string): Promise<T>;
  /** True when the error means "this account could not be decoded", not an outage. */
  isUnreadable(error: unknown): boolean;
  summarize(fleet: T): FleetSummary;
}

/**
 * Reads a profile's fleets and skips accounts the bindings cannot decode,
 * instead of failing the whole lookup. Other errors still propagate.
 */
export async function readFleetsTolerantly<T>(reads: TolerantFleetReads<T>): Promise<FleetLookup> {
  try {
    const fleets = await reads.readAll();
    return { fleets: fleets.map((fleet) => reads.summarize(fleet)), unreadableFleetCount: 0 };
  } catch (error) {
    if (!reads.isUnreadable(error)) throw error;
  }

  const addresses = [...new Set(await reads.discoverAddresses())];
  if (addresses.length > MAX_FALLBACK_FLEETS) {
    throw new Error(
      `This profile owns ${addresses.length} fleet accounts, more than the ${MAX_FALLBACK_FLEETS} this node reads one by one. Read single fleets by fleetAddress instead.`,
    );
  }

  const fleets: FleetSummary[] = [];
  let unreadableFleetCount = 0;
  for (let start = 0; start < addresses.length; start += FALLBACK_BATCH_SIZE) {
    const batch = addresses.slice(start, start + FALLBACK_BATCH_SIZE);
    try {
      const read = await reads.readMany(batch);
      fleets.push(...read.map((fleet) => reads.summarize(fleet)));
      continue;
    } catch (error) {
      if (!reads.isUnreadable(error)) throw error;
    }
    const settled = await Promise.allSettled(batch.map((address) => reads.readOne(address)));
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        fleets.push(reads.summarize(outcome.value));
      } else if (reads.isUnreadable(outcome.reason)) {
        unreadableFleetCount += 1;
      } else {
        throw outcome.reason;
      }
    }
  }
  return { fleets, unreadableFleetCount };
}
