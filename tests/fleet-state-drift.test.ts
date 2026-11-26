import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Fleet state variants the pinned @staratlas/dev-sage bindings can decode.
 * Variant indexes are 0..7. A later Sage layout (for example variant 8) is
 * unreadable until this list, the pin, and get_fleet's tolerant path are
 * updated together.
 */
const KNOWN_FLEET_STATE_VARIANTS = [
  { index: 0, idlName: "idle", kind: "Idle" },
  { index: 1, idlName: "claimStakeTransfer", kind: "ClaimStakeTransfer" },
  { index: 2, idlName: "destroyed", kind: "Destroyed" },
  { index: 3, idlName: "docked", kind: "Docked" },
  { index: 4, idlName: "mineAsteroid", kind: "MineAsteroid" },
  { index: 5, idlName: "moveWarp", kind: "MoveWarp" },
  { index: 6, idlName: "moveSubwarp", kind: "MoveSubwarp" },
  { index: 7, idlName: "respawn", kind: "Respawn" },
] as const;

const require = createRequire(import.meta.url);
const idlPath = require.resolve("@staratlas/dev-sage/idl.json");
const sageRoot = path.dirname(idlPath);
const generatedStatePath = path.join(sageRoot, "src/generated/types/fleetState.ts");
const generatedAccountPath = path.join(sageRoot, "src/generated/accounts/fleet.ts");

interface IdlEnumVariant {
  name: string;
  discriminator?: number;
}

function fleetStateFromIdl(): IdlEnumVariant[] {
  const idl = JSON.parse(readFileSync(idlPath, "utf8")) as {
    definedTypes?: { name: string; type?: { kind?: string; variants?: IdlEnumVariant[] } }[];
  };
  const type = idl.definedTypes?.find((item) => item.name === "fleetState");
  if (type?.type?.kind !== "enumTypeNode" || !type.type.variants) {
    throw new Error("The pinned SAGE IDL has no fleetState enum.");
  }
  return type.type.variants;
}

function kindsFromGenerated(source: string): string[] {
  const start = source.indexOf("export type FleetState =");
  const end = source.indexOf("export type FleetStateArgs");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("Generated FleetState union was not found.");
  }
  return [...source.slice(start, end).matchAll(/__kind:\s*'([^']+)'/g)].map((match) => match[1]);
}

function discriminatorFromSource(source: string, name: string): number[] {
  const match = source.match(new RegExp(`(?:export )?const ${name} = new Uint8Array\\(\\s*\\[([^\\]]+)\\]`));
  if (!match) throw new Error(`${name} was not found.`);
  return match[1].split(",").map((part) => part.trim()).filter(Boolean).map((part) => Number(part));
}

describe("fleet state discriminator drift", () => {
  it("keeps the pinned IDL, generated decoder, and live filter on the same 8 variants", () => {
    const idlVariants = fleetStateFromIdl();
    expect(idlVariants.map((variant, index) => ({
      index: variant.discriminator ?? index,
      idlName: variant.name,
      kind: `${variant.name.slice(0, 1).toUpperCase()}${variant.name.slice(1)}`,
    }))).toEqual([...KNOWN_FLEET_STATE_VARIANTS]);

    const generated = readFileSync(generatedStatePath, "utf8");
    expect(kindsFromGenerated(generated)).toEqual(KNOWN_FLEET_STATE_VARIANTS.map((variant) => variant.kind));

    const live = readFileSync("src/game/live.ts", "utf8");
    const generatedAccount = readFileSync(generatedAccountPath, "utf8");
    expect(discriminatorFromSource(live, "FLEET_DISCRIMINATOR")).toEqual(
      discriminatorFromSource(generatedAccount, "FLEET_DISCRIMINATOR"),
    );
  });
});
