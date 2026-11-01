import { toJsonSafe } from "../json.js";

export interface StarSystemSummary {
  address: string;
  name: string;
  systemId: number;
  coordinates: { x: number; y: number };
  regionId: number | null;
  starbase: { owner: string; level: string } | null;
  connectionCount: number;
  celestialBodyCount: number;
}

export interface FleetSummary {
  address: string;
  name: string;
  ownerProfile: string;
  stateKind: string;
  state: unknown;
  ships: {
    name: string;
    mint: string;
    sizeClass: string;
    quantity: string;
  }[];
}

export function summarizeGalaxyActivity(systems: readonly StarSystemSummary[]) {
  const levels: Record<string, number> = {};
  let starbaseCount = 0;
  let connectionCount = 0;
  let celestialBodyCount = 0;
  const starbases: { system: string; owner: string; level: string }[] = [];
  for (const system of systems) {
    connectionCount += system.connectionCount;
    celestialBodyCount += system.celestialBodyCount;
    if (!system.starbase) continue;
    starbaseCount += 1;
    levels[system.starbase.level] = (levels[system.starbase.level] ?? 0) + 1;
    starbases.push({ system: system.name, owner: system.starbase.owner, level: system.starbase.level });
  }
  return {
    systemCount: systems.length,
    starbaseCount,
    starbaseLevels: levels,
    starbases,
    connectionCount,
    celestialBodyCount,
    activity:
      "Counts are the published star-system graph from this read: starbases, connections, and celestial bodies. A separate fleet-wide activity feed was not read.",
  };
}

/** Lowest systemId first. Address breaks a tie so two nodes return the same page. */
export function pageStarSystems(systems: readonly StarSystemSummary[], limit: number): StarSystemSummary[] {
  return [...systems]
    .sort((left, right) => {
      if (left.systemId !== right.systemId) return left.systemId < right.systemId ? -1 : 1;
      if (left.address === right.address) return 0;
      return left.address < right.address ? -1 : 1;
    })
    .slice(0, limit);
}

export function summarizeStarSystem(input: {
  address: string;
  name: string;
  systemId: number;
  coordinates: { x: number; y: number };
  regionId?: number;
  starbase?: { owner: string; level: string };
  connectionCount: number;
  celestialBodyCount: number;
}): StarSystemSummary {
  return {
    address: input.address,
    name: input.name,
    systemId: input.systemId,
    coordinates: { x: input.coordinates.x, y: input.coordinates.y },
    regionId: input.regionId ?? null,
    starbase: input.starbase ? { owner: input.starbase.owner, level: input.starbase.level } : null,
    connectionCount: input.connectionCount,
    celestialBodyCount: input.celestialBodyCount,
  };
}

function stateKind(state: unknown): string {
  if (state && typeof state === "object" && "kind" in state && typeof state.kind === "string") {
    return state.kind;
  }
  return "unknown";
}

export function summarizeFleet(input: {
  address: string;
  name: string;
  ownerProfile: string;
  state: unknown;
  ships: readonly {
    name: string;
    mint: string;
    sizeClass: string;
    quantity: bigint | number | string;
  }[];
}): FleetSummary {
  return {
    address: input.address,
    name: input.name,
    ownerProfile: input.ownerProfile,
    stateKind: stateKind(input.state),
    state: toJsonSafe(input.state),
    ships: input.ships.map((ship) => ({
      name: ship.name,
      mint: ship.mint,
      sizeClass: ship.sizeClass,
      quantity: typeof ship.quantity === "bigint" ? ship.quantity.toString() : String(ship.quantity),
    })),
  };
}
