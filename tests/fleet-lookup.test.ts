import { describe, expect, it, vi } from "vitest";

import { FALLBACK_BATCH_SIZE, MAX_FALLBACK_FLEETS, readFleetsTolerantly, type TolerantFleetReads } from "../src/game/fleet-lookup.js";
import { isUndecodableAccount } from "../src/game/live.js";
import type { FleetSummary } from "../src/game/summarize.js";

class DecodeError extends Error {
  readonly code = "ACCOUNT_DECODE_FAILED";
}

function summary(address: string): FleetSummary {
  return { address, name: address, ownerProfile: "Owner", stateKind: "idle", state: { kind: "idle" }, ships: [] };
}

function reads(addresses: string[], bad: Set<string>, overrides: Partial<TolerantFleetReads<string>> = {}): TolerantFleetReads<string> {
  const readOne = async (address: string) => {
    if (bad.has(address)) throw new DecodeError("cannot decode");
    return address;
  };
  return {
    readAll: async () => {
      if (addresses.some((address) => bad.has(address))) throw new DecodeError("cannot decode");
      return addresses;
    },
    discoverAddresses: async () => addresses,
    readMany: async (batch) => Promise.all(batch.map(readOne)),
    readOne,
    isUnreadable: isUndecodableAccount,
    summarize: summary,
    ...overrides,
  };
}

describe("readFleetsTolerantly", () => {
  it("uses the batched read when every fleet decodes", async () => {
    const discoverAddresses = vi.fn(async () => ["A"]);
    const result = await readFleetsTolerantly(reads(["A", "B"], new Set(), { discoverAddresses }));
    expect(result.fleets.map((fleet) => fleet.address)).toEqual(["A", "B"]);
    expect(result.unreadableFleetCount).toBe(0);
    expect(discoverAddresses).not.toHaveBeenCalled();
  });

  it("returns the readable fleets and counts the undecodable ones", async () => {
    const result = await readFleetsTolerantly(reads(["A", "B", "C", "D"], new Set(["B", "D"])));
    expect(result.fleets.map((fleet) => fleet.address)).toEqual(["A", "C"]);
    expect(result.unreadableFleetCount).toBe(2);
  });

  it("reads clean batches together and only splits the failing batch", async () => {
    const addresses = Array.from({ length: FALLBACK_BATCH_SIZE * 2 }, (_, index) => `F${index}`);
    const bad = new Set([addresses[FALLBACK_BATCH_SIZE + 1]!]);
    const base = reads(addresses, bad);
    const readOne = vi.fn(base.readOne);
    const result = await readFleetsTolerantly({ ...base, readOne });
    expect(result.fleets).toHaveLength(addresses.length - 1);
    expect(result.unreadableFleetCount).toBe(1);
    expect(readOne).toHaveBeenCalledTimes(FALLBACK_BATCH_SIZE);
  });

  it("counts every fleet as unreadable when none decode, without failing", async () => {
    const result = await readFleetsTolerantly(reads(["A", "B"], new Set(["A", "B"])));
    expect(result).toEqual({ fleets: [], unreadableFleetCount: 2 });
  });

  it("deduplicates discovered addresses", async () => {
    const result = await readFleetsTolerantly(reads(["A", "B"], new Set(["B"]), { discoverAddresses: async () => ["A", "A", "B"] }));
    expect(result.fleets.map((fleet) => fleet.address)).toEqual(["A"]);
    expect(result.unreadableFleetCount).toBe(1);
  });

  it("propagates provider errors instead of counting them as unreadable", async () => {
    const outage = new Error("rpc down");
    await expect(readFleetsTolerantly(reads(["A"], new Set(), { readAll: async () => Promise.reject(outage) }))).rejects.toBe(outage);

    const partialOutage = reads(["A", "B"], new Set(["B"]), {
      readOne: async (address) => {
        if (address === "B") throw outage;
        return address;
      },
      readMany: async () => {
        throw new DecodeError("cannot decode");
      },
    });
    await expect(readFleetsTolerantly(partialOutage)).rejects.toBe(outage);
  });

  it("refuses to read more than the fallback cap one by one", async () => {
    const many = Array.from({ length: MAX_FALLBACK_FLEETS + 1 }, (_, index) => `F${index}`);
    await expect(readFleetsTolerantly(reads(many, new Set(["F0"])))).rejects.toThrow(/more than the 500/);
  });

  it("lets a summarize ownership error through", async () => {
    const result = readFleetsTolerantly(
      reads(["A"], new Set(), {
        summarize: () => {
          throw new Error("A discovered fleet did not match the requested owner profile.");
        },
      }),
    );
    await expect(result).rejects.toThrow(/did not match/);
  });
});

describe("isUndecodableAccount", () => {
  it("matches only the Atlas Kit decode error code", () => {
    expect(isUndecodableAccount(new DecodeError("x"))).toBe(true);
    expect(isUndecodableAccount(Object.assign(new Error("x"), { code: "PROVIDER_ERROR" }))).toBe(false);
    expect(isUndecodableAccount(new Error("x"))).toBe(false);
    expect(isUndecodableAccount(undefined)).toBe(false);
  });
});
