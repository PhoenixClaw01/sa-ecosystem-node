import { describe, expect, it } from "vitest";

import { pageStarSystems, summarizeFleet, summarizeStarSystem } from "../src/game/summarize.js";

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
});
