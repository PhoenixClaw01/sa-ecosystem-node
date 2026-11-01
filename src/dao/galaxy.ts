import { addDecimalStrings, compareDecimal } from "./amount.js";
import { SafeClientError } from "../errors.js";
import { GALAXY_PROPOSALS_PATH, GALAXY_TREASURY_PATH, GALAXY_VOTES_PATH } from "./wallets.js";

const PROPOSAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GalaxyProposal {
  id: string;
  pipNumber: number;
  title: string;
  brief: string;
  categories: string[];
  status: string;
  authorPublicKey: string;
  createdAt: string;
  updatedAt: string;
  votingStartsAt: string;
  votingEndsAt: string;
  voteOptionsMaxChoices: number;
  voteWinners: number;
  voteData: Record<string, { count: string; pvp: string }> | null;
}

export interface VoteRecord {
  id: string;
  proposalId: string;
  walletPublicKey: string;
  voteResult: string;
  votingPower: string;
  createdAt: string;
}

export interface RevenueRow {
  segmentation: string;
  recorded_period: string;
  mint: string;
  amount: string;
  usdcValue: string;
}

export function assertProposalId(id: string): string {
  if (!PROPOSAL_ID.test(id)) {
    throw new SafeClientError("proposalId must be the galaxy proposal UUID. Refusing to build a URL from anything else.");
  }
  return id.toLowerCase();
}

export async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SafeClientError("Refusing a URL that could not be parsed.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SafeClientError("Refusing a non-http URL.");
  }
  let response: Response;
  try {
    response = await fetchImpl(parsed.toString(), {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
      headers: { accept: "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "network error";
    throw new SafeClientError(`Could not read ${parsed.origin}${parsed.pathname} (${message.replace(/https?:\/\/\S+/g, "[url]")}).`);
  }
  if (response.status === 404) {
    throw new SafeClientError(`No document at ${parsed.origin}${parsed.pathname} (HTTP 404).`);
  }
  if (!response.ok) {
    throw new SafeClientError(`Could not read ${parsed.origin}${parsed.pathname} (HTTP ${response.status}).`);
  }
  try {
    return await response.json();
  } catch {
    throw new SafeClientError(`The document at ${parsed.origin}${parsed.pathname} was not JSON.`);
  }
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new SafeClientError(`A galaxy record is missing ${key}.`);
  }
  return value;
}

function decimalField(value: unknown, label: string): string {
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const text = Object.is(value, -0) ? "0" : String(value);
    if (/^-?\d+(\.\d+)?$/.test(text)) return text;
    throw new SafeClientError(`${label} could not be read without rounding.`);
  }
  throw new SafeClientError(`${label} is not a decimal number.`);
}

export function parseProposals(payload: unknown): GalaxyProposal[] {
  if (!Array.isArray(payload)) {
    throw new SafeClientError("galaxy /proposals was not a list. No proposals were invented.");
  }
  return payload.map((item) => {
    if (!item || typeof item !== "object") throw new SafeClientError("A proposal record was not an object.");
    const row = item as Record<string, unknown>;
    const pipNumber = row.pipNumber;
    if (typeof pipNumber !== "number" || !Number.isInteger(pipNumber)) {
      throw new SafeClientError("A proposal is missing pipNumber.");
    }
    const choices = row.voteOptionsMaxChoices;
    const winners = row.voteWinners;
    if (typeof choices !== "number" || typeof winners !== "number") {
      throw new SafeClientError(`PIP-${pipNumber} is missing vote option fields.`);
    }
    return {
      id: assertProposalId(stringField(row, "id")),
      pipNumber,
      title: stringField(row, "title"),
      brief: typeof row.brief === "string" ? row.brief : "",
      categories: Array.isArray(row.categories) ? row.categories.filter((c): c is string => typeof c === "string") : [],
      status: stringField(row, "status"),
      authorPublicKey: typeof row.authorPublicKey === "string" ? row.authorPublicKey : "",
      createdAt: stringField(row, "createdAt"),
      updatedAt: stringField(row, "updatedAt"),
      votingStartsAt: stringField(row, "votingStartsAt"),
      votingEndsAt: stringField(row, "votingEndsAt"),
      voteOptionsMaxChoices: choices,
      voteWinners: winners,
      voteData: parseVoteData(row.voteData),
    };
  });
}

function parseVoteData(value: unknown): GalaxyProposal["voteData"] {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SafeClientError("Proposal voteData was not an object.");
  }
  const out: NonNullable<GalaxyProposal["voteData"]> = {};
  for (const [choice, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object") throw new SafeClientError(`voteData.${choice} was not an object.`);
    const row = raw as Record<string, unknown>;
    out[choice] = {
      count: decimalField(row.count, `voteData.${choice}.count`),
      pvp: decimalField(row.pvp, `voteData.${choice}.pvp`),
    };
  }
  return out;
}

export function parseVotes(payload: unknown): VoteRecord[] {
  if (!Array.isArray(payload)) {
    throw new SafeClientError("The votes file was not a list. No tallies were invented.");
  }
  return payload.map((item) => {
    if (!item || typeof item !== "object") throw new SafeClientError("A vote record was not an object.");
    const row = item as Record<string, unknown>;
    return {
      id: stringField(row, "id"),
      proposalId: assertProposalId(stringField(row, "proposalId")),
      walletPublicKey: stringField(row, "walletPublicKey"),
      voteResult: stringField(row, "voteResult"),
      votingPower: decimalField(row.votingPower, "votingPower"),
      createdAt: stringField(row, "createdAt"),
    };
  });
}

export function summarizeVotes(votes: VoteRecord[], topN: number) {
  const grouped = new Map<string, string[]>();
  for (const vote of votes) {
    const list = grouped.get(vote.voteResult) ?? [];
    list.push(vote.votingPower);
    grouped.set(vote.voteResult, list);
  }
  const options = [...grouped.entries()]
    .map(([choice, powers]) => ({
      choice,
      count: powers.length,
      votingPower: addDecimalStrings(powers.length > 0 ? powers : ["0"]),
    }))
    .sort((left, right) => compareDecimal(right.votingPower, left.votingPower) || left.choice.localeCompare(right.choice));
  const ranked = [...votes].sort(
    (left, right) => compareDecimal(right.votingPower, left.votingPower) || left.walletPublicKey.localeCompare(right.walletPublicKey),
  );
  return {
    voterCount: votes.length,
    uniqueWallets: new Set(votes.map((vote) => vote.walletPublicKey)).size,
    options,
    topVoters: ranked.slice(0, topN).map((vote) => ({
      wallet: vote.walletPublicKey,
      choice: vote.voteResult,
      votingPower: vote.votingPower,
      createdAt: vote.createdAt,
    })),
    rankedWinner: {
      status: "unknown" as const,
      reason:
        "The votes file records a choice and voting power for each signature. It does not define a ranked-choice winner. This tool does not invent one. list_proposals includes the published voteWinners and voteOptionsMaxChoices.",
    },
  };
}

export function parseRevenue(payload: unknown): RevenueRow[] {
  if (!Array.isArray(payload)) {
    throw new SafeClientError("galaxy /dao/treasury was not a list. No revenue was invented.");
  }
  return payload.map((item) => {
    if (!item || typeof item !== "object") throw new SafeClientError("A revenue row was not an object.");
    const row = item as Record<string, unknown>;
    return {
      segmentation: stringField(row, "segmentation"),
      recorded_period: stringField(row, "recorded_period"),
      mint: stringField(row, "mint"),
      amount: decimalField(row.amount, "amount"),
      usdcValue: decimalField(row.usdc_value, "usdc_value"),
    };
  });
}

export function summarizeRevenue(rows: RevenueRow[]) {
  const months = new Map<string, RevenueRow[]>();
  for (const row of rows) {
    const list = months.get(row.recorded_period) ?? [];
    list.push(row);
    months.set(row.recorded_period, list);
  }
  const bySourceMap = new Map<string, RevenueRow[]>();
  for (const row of rows) {
    const key = `${row.segmentation}\u0000${row.mint}`;
    const list = bySourceMap.get(key) ?? [];
    list.push(row);
    bySourceMap.set(key, list);
  }
  return {
    months: [...months.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([period, periodRows]) => ({
        period,
        sources: periodRows.map((row) => ({
          segmentation: row.segmentation,
          mint: row.mint,
          amount: row.amount,
          usdcValue: row.usdcValue,
        })),
      })),
    bySource: [...bySourceMap.entries()].map(([, sourceRows]) => {
      const first = sourceRows[0];
      if (!first) throw new SafeClientError("Empty revenue group.");
      return {
        segmentation: first.segmentation,
        mint: first.mint,
        amount: addDecimalStrings(sourceRows.map((row) => row.amount)),
        usdcValue: addDecimalStrings(sourceRows.map((row) => row.usdcValue)),
        months: sourceRows.length,
      };
    }),
  };
}

export function proposalsUrl(base: string): string {
  return `${base}${GALAXY_PROPOSALS_PATH}`;
}

export function votesUrl(base: string, id: string): string {
  return `${base}${GALAXY_VOTES_PATH}/${assertProposalId(id)}.json`;
}

export function revenueUrl(base: string): string {
  return `${base}${GALAXY_TREASURY_PATH}`;
}
