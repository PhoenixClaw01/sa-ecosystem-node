import { DISCLAIMER } from "../disclaimer.js";
import { MAINNET_BETA_RPC_HOST, type FactionName } from "./programs.js";

export interface LegacyFact {
  fact: string;
  signature: string | null;
}

export interface LegacySource {
  account: string;
  facts: LegacyFact[];
}

export interface LegacyProfile {
  address: string;
  name: string | null;
  faction: FactionName | null;
  factionAccount: string | null;
  createdAt: string | null;
  creationSignature: string | null;
}

export interface LegacyFleet {
  address: string;
  name: string | null;
  program: "SAGE" | "Legacy SAGE";
  ownerProfile: string;
  createdAt: string | null;
  creationSignature: string | null;
}

export interface LegacyActivity {
  address: string;
  band: string;
  reachedEnd: boolean;
  firstSeen: string | null;
  lastSeen: string | null;
  firstSignature: string | null;
  lastSignature: string | null;
}

export interface PlayerLegacyCard {
  readOnly: true;
  cluster: "mainnet-beta";
  rpc: typeof MAINNET_BETA_RPC_HOST;
  disclaimer: string;
  dataMode: "live" | "partial";
  asOf: string;
  fromCache: boolean;
  queried: { address: string; kind: "wallet" | "profile" };
  summary: string;
  profiles: LegacyProfile[];
  fleets: LegacyFleet[];
  activity: LegacyActivity | null;
  gaps: string[];
  sources: LegacySource[];
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export function monthYear(iso: string): string {
  const date = new Date(iso);
  const month = MONTHS[date.getUTCMonth()] ?? "Unknown";
  return `${month} ${date.getUTCFullYear()}`;
}

export function signatureBand(count: number, reachedEnd: boolean): string {
  if (!reachedEnd) {
    if (count >= 10_000) return "10,000 or more";
    if (count >= 1_000) return "1,000 or more";
    if (count >= 100) return "100 or more";
    if (count >= 10) return "10 or more";
    if (count >= 1) return "1 or more";
    return "none";
  }
  if (count >= 10_000) return "10,000 or more";
  if (count >= 1_000) return "1,000–9,999";
  if (count >= 100) return "100–999";
  if (count >= 10) return "10–99";
  if (count >= 1) return "1–9";
  return "none";
}

const THIN_DONE = "Here's what the public chain shows. No player profile was found for this address. That's all for now.";
const THIN_UNFINISHED = "Here's what the public chain shows. The public mainnet read did not finish. That's all for now.";
const THIN_CLOSER = "Here's what the public chain shows. That's all for now.";

export function buildLegacySummary(input: {
  looked: boolean;
  partial: boolean;
  profiles: readonly LegacyProfile[];
  fleetCount: number;
  activity: LegacyActivity | null;
}): string {
  if (!input.looked) return THIN_UNFINISHED;
  const quietActivity = !input.activity || (input.activity.band === "none" && input.activity.reachedEnd);
  if (input.profiles.length === 0 && input.fleetCount === 0 && quietActivity) {
    return input.partial ? THIN_UNFINISHED : THIN_DONE;
  }
  const profileBit =
    input.profiles.length === 1 ? "1 player profile" : `${input.profiles.length} player profiles`;
  const factions = [
    ...new Set(
      input.profiles
        .map((profile) => profile.faction)
        .filter((faction): faction is FactionName => faction !== null && faction !== "Unaligned"),
    ),
  ];
  const bits = [profileBit];
  if (input.profiles.length > 0) {
    bits.push(factions.length === 0 ? "no faction enlistment" : `enlisted with ${factions.join(" and ")}`);
  }
  bits.push(
    input.fleetCount === 1 ? "1 SAGE fleet still on the accounts" : `${input.fleetCount} SAGE fleets still on the accounts`,
  );
  if (input.activity) {
    bits.push(
      input.activity.reachedEnd
        ? `signatures in the ${input.activity.band} band`
        : `signatures in the ${input.activity.band} band, and the walk stopped early`,
    );
    if (input.activity.firstSeen) bits.push(`first seen ${monthYear(input.activity.firstSeen)}`);
    if (input.activity.lastSeen) bits.push(`last seen ${monthYear(input.activity.lastSeen)}`);
  }
  const line = `Public chain record: ${bits.join(", ")}.`;
  return input.partial ? `${line} ${THIN_CLOSER}` : line;
}

export function unavailableLegacyCard(address: string, asOf: string): PlayerLegacyCard {
  return {
    ...legacyCardShell(address, asOf),
    dataMode: "partial",
    summary: "Here's what the public chain shows. This read is unavailable, try later.",
    gaps: ["Too many new lookups in a short time. This read is unavailable, try later."],
  };
}

export function legacyCardShell(address: string, asOf: string): PlayerLegacyCard {
  return {
    readOnly: true,
    cluster: "mainnet-beta",
    rpc: MAINNET_BETA_RPC_HOST,
    disclaimer: DISCLAIMER,
    dataMode: "live",
    asOf,
    fromCache: false,
    queried: { address, kind: "wallet" },
    summary: THIN_DONE,
    profiles: [],
    fleets: [],
    activity: null,
    gaps: [],
    sources: [],
  };
}

export function finishLegacyCard(
  card: Omit<PlayerLegacyCard, "summary" | "dataMode" | "readOnly" | "cluster" | "rpc" | "disclaimer"> & {
    looked: boolean;
    partial: boolean;
  },
): PlayerLegacyCard {
  const { looked, partial, ...rest } = card;
  return {
    readOnly: true,
    cluster: "mainnet-beta",
    rpc: MAINNET_BETA_RPC_HOST,
    disclaimer: DISCLAIMER,
    dataMode: partial ? "partial" : "live",
    ...rest,
    summary: buildLegacySummary({
      looked,
      partial,
      profiles: rest.profiles,
      fleetCount: rest.fleets.length,
      activity: rest.activity,
    }),
  };
}
