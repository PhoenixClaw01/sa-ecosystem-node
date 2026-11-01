import { createSageClient, type SageClient } from "@aephia/atlas-kit";
import { address, createSolanaRpc } from "@solana/kit";

import type { Config } from "../config.js";
import { UserInputError } from "../errors.js";
import { auditProfileKeys, type ProfileKeyAudit } from "../profile/audit.js";
import { pageStarSystems, summarizeFleet, summarizeStarSystem, type FleetSummary, type StarSystemSummary } from "./summarize.js";

export interface FleetQuery {
  fleetAddress?: string;
  profileAddress?: string;
}

export interface GameReaders {
  listStarSystems(limit: number): Promise<{ total: number; systems: StarSystemSummary[] }>;
  getFleet(query: FleetQuery): Promise<FleetSummary[]>;
  auditProfile(profileAddress: string): Promise<ProfileKeyAudit>;
}

function asAddress(value: string, label: string) {
  try {
    return address(value.trim());
  } catch {
    throw new UserInputError(`${label} is not a valid account address.`);
  }
}

/**
 * Read-only Atlas Kit binding for the z.ink test realm.
 * The submission transport is intentionally omitted.
 */
export function createGameReaders(config: Config): GameReaders {
  let sage: SageClient | undefined;
  const client = (): SageClient => {
    sage ??= createSageClient({
      cluster: config.cluster,
      rpc: createSolanaRpc(config.zinkRpcUrl),
    });
    return sage;
  };

  return {
    async listStarSystems(limit) {
      const systems = await client().systems.all();
      const summaries = systems.map((system) =>
        summarizeStarSystem({
          address: system.address,
          name: system.name,
          systemId: system.systemId,
          coordinates: system.coordinates,
          regionId: system.regionId,
          starbase: system.starbase
            ? { owner: system.starbase.owner, level: system.starbase.level }
            : undefined,
          connectionCount: system.connections.length,
          celestialBodyCount: system.celestialBodyAddresses.length,
        }),
      );
      return { total: summaries.length, systems: pageStarSystems(summaries, limit) };
    },

    async getFleet(query) {
      if (!query.fleetAddress && !query.profileAddress) {
        throw new UserInputError("Provide fleetAddress or profileAddress.");
      }
      const sageClient = client();
      if (query.fleetAddress) {
        const fleet = await sageClient.fleets.get(asAddress(query.fleetAddress, "fleetAddress"));
        const summary = summarizeFleet({
          address: fleet.address,
          name: fleet.name,
          ownerProfile: fleet.ownerProfile.address,
          state: fleet.state,
          ships: fleet.ships,
        });
        if (query.profileAddress && summary.ownerProfile !== query.profileAddress.trim()) {
          throw new UserInputError("That fleet is not owned by the given profile.");
        }
        return [summary];
      }
      const fleets = await sageClient.fleets.byOwner(asAddress(query.profileAddress ?? "", "profileAddress"));
      return fleets.map((fleet) =>
        summarizeFleet({
          address: fleet.address,
          name: fleet.name,
          ownerProfile: fleet.ownerProfile.address,
          state: fleet.state,
          ships: fleet.ships,
        }),
      );
    },

    async auditProfile(profileAddress) {
      const profile = await client().profiles.get(asAddress(profileAddress, "profileAddress"));
      return auditProfileKeys({
        profileAddress: profile.address,
        keyThreshold: profile.keyThreshold,
        authKeyCount: profile.authKeyCount,
        keys: profile.keys,
      });
    },
  };
}
