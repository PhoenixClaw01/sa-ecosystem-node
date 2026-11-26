import { createSageClient, type SageClient } from "@aephia/atlas-kit";
import { getFleets } from "@aephia/atlas-kit/fleets";
import {
  address,
  createSolanaRpc,
  getAddressEncoder,
  getBase58Decoder,
  type Address,
  type Base58EncodedBytes,
} from "@solana/kit";

import type { Config } from "../config.js";
import { UserInputError } from "../errors.js";
import { readFleetsTolerantly, type FleetLookup } from "./fleet-lookup.js";
import { auditProfileKeys, type ProfileKeyAudit } from "../profile/audit.js";
import { pageStarSystems, summarizeFleet, summarizeStarSystem, type FleetSummary, type StarSystemSummary } from "./summarize.js";

export interface FleetQuery {
  fleetAddress?: string;
  profileAddress?: string;
}

export interface GameReaders {
  listStarSystems(limit: number): Promise<{ total: number; systems: StarSystemSummary[] }>;
  getFleet(query: FleetQuery): Promise<FleetLookup>;
  auditProfile(profileAddress: string): Promise<ProfileKeyAudit>;
}

/** Anchor discriminator of the SAGE `Fleet` account (from the pinned SAGE IDL). */
const FLEET_DISCRIMINATOR = new Uint8Array([0x4a, 0xb2, 0x95, 0x9e, 0xb6, 0x34, 0x78, 0x5e]);
/** Stable Fleet field offsets Atlas Kit also filters on: discriminator, game, owner profile. */
const FLEET_OFFSETS = { discriminator: 0n, game: 10n, owner: 42n } as const;

interface FleetLike {
  address: string;
  name: string;
  ownerProfile: { address: string };
  state: Parameters<typeof summarizeFleet>[0]["state"];
  ships: Parameters<typeof summarizeFleet>[0]["ships"];
}

function toSummary(fleet: FleetLike): FleetSummary {
  return summarizeFleet({
    address: fleet.address,
    name: fleet.name,
    ownerProfile: fleet.ownerProfile.address,
    state: fleet.state,
    ships: fleet.ships,
  });
}

/** True for Atlas Kit's "account could not be decoded" error, not for provider or input errors. */
export function isUndecodableAccount(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ACCOUNT_DECODE_FAILED"
  );
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
  let solanaRpc: ReturnType<typeof createSolanaRpc> | undefined;
  const rpc = () => (solanaRpc ??= createSolanaRpc(config.zinkRpcUrl));
  const client = (): SageClient => {
    sage ??= createSageClient({
      cluster: config.cluster,
      rpc: rpc(),
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
        const summary = toSummary(fleet);
        if (query.profileAddress && summary.ownerProfile !== query.profileAddress.trim()) {
          throw new UserInputError("That fleet is not owned by the given profile.");
        }
        return { fleets: [summary], unreadableFleetCount: 0 };
      }
      const owner = asAddress(query.profileAddress ?? "", "profileAddress");
      const context = sageClient.context;
      return readFleetsTolerantly<FleetLike>({
        readAll: () => sageClient.fleets.byOwner(owner),
        discoverAddresses: async () => {
          const game = context.game;
          if (game === undefined) throw new Error("The SAGE client has no Game configured.");
          const base58 = getBase58Decoder();
          const encoder = getAddressEncoder();
          const accounts = await rpc()
            .getProgramAccounts(context.programs.sage, {
              encoding: "base64",
              dataSlice: { offset: 0, length: 0 },
              filters: [
                {
                  memcmp: {
                    offset: FLEET_OFFSETS.discriminator,
                    bytes: base58.decode(FLEET_DISCRIMINATOR) as Base58EncodedBytes,
                    encoding: "base58",
                  },
                },
                { memcmp: { offset: FLEET_OFFSETS.game, bytes: base58.decode(encoder.encode(game)) as Base58EncodedBytes, encoding: "base58" } },
                { memcmp: { offset: FLEET_OFFSETS.owner, bytes: base58.decode(encoder.encode(owner)) as Base58EncodedBytes, encoding: "base58" } },
              ],
            })
            .send();
          return accounts.map((account) => account.pubkey);
        },
        readMany: (addresses) => getFleets(context, addresses as Address[]),
        readOne: (fleetAddress) => sageClient.fleets.get(fleetAddress as Address),
        isUnreadable: isUndecodableAccount,
        summarize: (fleet) => {
          const summary = toSummary(fleet);
          if (summary.ownerProfile !== owner) {
            throw new Error("A discovered fleet did not match the requested owner profile.");
          }
          return summary;
        },
      });
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
