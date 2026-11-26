import { describe, expect, it } from "vitest";

import { pageStarSystems, summarizeFleet, summarizeGalaxyActivity, summarizeStarSystem } from "../src/game/summarize.js";

describe("game summaries", () => {
  it("keeps a compact star system shape", () => {
    expect(
      summarizeStarSystem({
        address: "Sys111",
        name: "Example",
        systemId: 3,
        coordinates: { x: 1.5, y: -2 },
        connectionCount: 2,
        celestialBodyCount: 4,
        starbase: { owner: "mud", level: "level-1" },
      }),
    ).toEqual({
      address: "Sys111",
      name: "Example",
      systemId: 3,
      coordinates: { x: 1.5, y: -2 },
      regionId: null,
      starbase: { owner: "mud", level: "level-1" },
      connectionCount: 2,
      celestialBodyCount: 4,
    });
  });

  it("sorts star systems by systemId before the limit", () => {
    const system = (systemId: number, address: string) =>
      summarizeStarSystem({
        address,
        name: address,
        systemId,
        coordinates: { x: 0, y: 0 },
        connectionCount: 0,
        celestialBodyCount: 0,
      });
    const systems = [system(30, "Z"), system(2, "B"), system(10, "M"), system(2, "A")];
    expect(pageStarSystems(systems, 3).map((item) => `${item.systemId}:${item.address}`)).toEqual(["2:A", "2:B", "10:M"]);
    expect(systems.map((item) => item.systemId)).toEqual([30, 2, 10, 2]);
  });

  it("renders fleet state bigints as strings", () => {
    const fleet = summarizeFleet({
      address: "Fleet111",
      name: "Ravager",
      ownerProfile: "Profile111",
      state: { kind: "docked", systemSeqId: 9n, system: { type: "starSystem", address: "Sys111" } },
      ships: [{ name: "Fimbul", mint: "Mint111", sizeClass: "small", quantity: 2n }],
    });
    expect(fleet.stateKind).toBe("docked");
    expect(fleet.state).toEqual({
      kind: "docked",
      systemSeqId: "9",
      system: { type: "starSystem", address: "Sys111" },
    });
    expect(fleet.ships).toEqual([{ name: "Fimbul", mint: "Mint111", sizeClass: "small", quantity: "2" }]);
    expect(JSON.stringify(fleet)).not.toContain("bigint");
  });

  it("counts a __proto__ starbase level without writing to Object.prototype", () => {
    const prototypeKeys = Object.getOwnPropertyNames(Object.prototype);
    const system = (name: string, level: string) =>
      summarizeStarSystem({
        address: name,
        name,
        systemId: 1,
        coordinates: { x: 0, y: 0 },
        connectionCount: 0,
        celestialBodyCount: 0,
        starbase: { owner: "owner", level },
      });
    const result = summarizeGalaxyActivity([
      system("A", "__proto__"),
      system("B", "constructor"),
      system("C", "prototype"),
      system("D", "level-1"),
    ]);
    expect(Object.getPrototypeOf(result.starbaseLevels)).toBeNull();
    expect(Object.getOwnPropertyNames(result.starbaseLevels).sort()).toEqual(["__proto__", "constructor", "level-1", "prototype"]);
    expect(result.starbaseLevels["__proto__"]).toBe(1);
    expect(result.starbaseLevels.constructor).toBe(1);
    expect(result.starbaseLevels.prototype).toBe(1);
    expect(result.starbaseLevels["level-1"]).toBe(1);
    expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(prototypeKeys);

    const roundTrip = JSON.parse(JSON.stringify({ activity: result })) as {
      activity: { starbaseLevels: Record<string, number> };
    };
    const levels = roundTrip.activity.starbaseLevels;
    expect(Object.getOwnPropertyDescriptor(levels, "__proto__")).toMatchObject({ value: 1, enumerable: true });
    expect(levels["constructor"]).toBe(1);
    expect(levels["prototype"]).toBe(1);
    expect(levels["level-1"]).toBe(1);
    expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(prototypeKeys);
  });
});

