import { formatRaw, formatScaled, parseUiAmount, utcDay } from "./amount.js";
import { UserInputError } from "../errors.js";
import type { CacheMovement } from "./types.js";
import {
  ATLAS_DECIMALS,
  ATLAS_MINT,
  DAO_TREASURY_ADDRESS,
  ECOSYSTEM_FUND_ADDRESS,
  PIP23_QUARTER_DATES,
  PIP23_URL,
  PIP4_URL,
  USDC_REFILL_THRESHOLD,
  WALLET_SOURCE_URL,
  solscanTx,
} from "./wallets.js";

export interface RefillRecord {
  signature: string;
  blockTime: number;
  time: string;
  amountRaw: string;
  amount: string;
  balanceBeforeRaw: string;
  balanceBefore: string;
  balanceAfterRaw: string;
  balanceAfter: string;
  decimals: number;
  solscanUrl: string;
  detection: string;
}

export interface UnpaidPip {
  pip: string;
  amountAtlas: string;
  sourceLabel: string;
}

export interface CouncilOverride {
  label: string;
  perPipLimitAtlas?: string;
  nextQuarterLimitAtlas?: string;
  note?: string;
}

export interface EcofundBalances {
  treasuryAtlasRaw: bigint;
  fundAtlasRaw: bigint;
  treasuryUsdcRaw: bigint;
  fundUsdcRaw: bigint | null;
  atlasDecimals: number;
  usdcDecimals: number;
  fetchedAt: string;
}

const REFILL_DETECTION =
  "Internal ATLAS transfer from the DAO Treasury wallet to the Ecosystem Fund wallet. PIP-23 does not put an on-chain tag on a refill, so every transfer of this shape is listed. A transfer that is not a refill can be overridden.";

export function findRefills(movements: readonly CacheMovement[]): RefillRecord[] {
  const refills = movements.filter(
    (movement) =>
      movement.role === "ecosystem_fund" &&
      movement.mint === ATLAS_MINT &&
      movement.direction === "in" &&
      movement.internal &&
      movement.attribution === "counterparty" &&
      movement.counterparties.length === 1 &&
      movement.counterparties[0] === DAO_TREASURY_ADDRESS,
  );
  refills.sort((left, right) => left.blockTime - right.blockTime || left.slot - right.slot || left.signature.localeCompare(right.signature));
  return refills.map((movement) => ({
    signature: movement.signature,
    blockTime: movement.blockTime,
    time: new Date(movement.blockTime * 1000).toISOString(),
    amountRaw: movement.deltaRaw.replace(/^-/, ""),
    amount: formatRaw(BigInt(movement.deltaRaw), movement.decimals),
    balanceBeforeRaw: movement.preRaw,
    balanceBefore: formatRaw(BigInt(movement.preRaw), movement.decimals),
    balanceAfterRaw: movement.postRaw,
    balanceAfter: formatRaw(BigInt(movement.postRaw), movement.decimals),
    decimals: movement.decimals,
    solscanUrl: solscanTx(movement.signature),
    detection: REFILL_DETECTION,
  }));
}

/** Next PIP-23 quarter date on or after the UTC calendar day of `asOf`. June 20 is kept as written. */
export function nextQuarterDate(asOf: string): string {
  const time = Date.parse(asOf);
  if (Number.isNaN(time)) throw new UserInputError("asOf is not a timestamp.");
  const date = new Date(time);
  const today = utcDay(Math.floor(time / 1000));
  const startYear = date.getUTCFullYear();
  const candidates: string[] = [];
  for (const year of [startYear, startYear + 1]) {
    for (const quarter of PIP23_QUARTER_DATES) {
      candidates.push(
        `${year}-${String(quarter.month).padStart(2, "0")}-${String(quarter.day).padStart(2, "0")}`,
      );
    }
  }
  const next = candidates.find((candidate) => candidate >= today);
  if (!next) throw new Error("No PIP-23 quarter date followed that timestamp.");
  return next;
}

export function perPipLimit(balanceAfterRaw: bigint, decimals: number) {
  const formatted = formatScaled(balanceAfterRaw * 5n, 100n, decimals);
  return {
    rawNumerator: (balanceAfterRaw * 5n).toString(),
    rawDenominator: "100",
    amount: formatted.exact ? formatted.text : null,
    exact: formatted.exact,
    rule: "5% of the Ecosystem Fund ATLAS balance after the last refill transaction (PIP-23 section c).",
  };
}

export function atlasRefillAmount(treasuryRaw: bigint, fundRaw: bigint, decimals: number) {
  const below = 4n * fundRaw < treasuryRaw;
  if (!below) {
    return {
      due: false,
      amount: formatRaw(0n, decimals),
      exact: true,
      onChainRounding: "not_applicable" as const,
      reason: "Ecosystem Fund ATLAS is at least 20% of treasury ATLAS plus fund ATLAS, so PIP-23 sends no ATLAS.",
    };
  }
  const numerator = treasuryRaw - 4n * fundRaw;
  const remainder = numerator % 5n;
  if (remainder !== 0n) {
    return {
      due: true,
      amount: null,
      exact: false,
      onChainRounding: "unknown" as const,
      remainderRaw: remainder.toString(),
      reason:
        "PIP-23 section b gives R = (treasury - 4 × fund) / 5, but this remainder is not an integer raw amount and the PIP does not state a rounding mode.",
    };
  }
  return {
    due: true,
    amount: formatRaw(numerator / 5n, decimals),
    exact: true,
    onChainRounding: "exact" as const,
    remainderRaw: "0",
    reason:
      "PIP-23 section b: if fund ATLAS is under 20% of (treasury + fund), send enough ATLAS that the fund is 20% of that total. R = (treasury - 4 × fund) / 5.",
  };
}

export function usdcRefillAmount(treasuryRaw: bigint, decimals: number) {
  const threshold = parseUiAmount(USDC_REFILL_THRESHOLD, decimals, "USDC threshold");
  if (treasuryRaw <= threshold) {
    return {
      due: false,
      amount: formatRaw(0n, decimals),
      exact: true,
      onChainRounding: "not_applicable" as const,
      threshold: USDC_REFILL_THRESHOLD,
      reason: "PIP-23 sends no USDC unless the DAO Treasury holds more than 500,000 USDC.",
    };
  }
  const excess = treasuryRaw - threshold;
  const remainder = excess % 5n;
  if (remainder !== 0n) {
    return {
      due: true,
      amount: null,
      exact: false,
      onChainRounding: "unknown" as const,
      remainderRaw: remainder.toString(),
      threshold: USDC_REFILL_THRESHOLD,
      reason:
        "PIP-23 section b sends 20% of DAO Treasury USDC above 500,000. This remainder is not an integer raw amount and the PIP does not state a rounding mode.",
    };
  }
  return {
    due: true,
    amount: formatRaw(excess / 5n, decimals),
    exact: true,
    onChainRounding: "exact" as const,
    remainderRaw: "0",
    threshold: USDC_REFILL_THRESHOLD,
    reason: "PIP-23 section b: 20% of DAO Treasury USDC above 500,000. Fund USDC is not part of this test; PIP-4's combined test was replaced.",
  };
}

function share(fundRaw: bigint, treasuryRaw: bigint) {
  const total = fundRaw + treasuryRaw;
  if (total === 0n) {
    return { fraction: null, percent: null, belowTwentyPercent: null as boolean | null, reason: "Both ATLAS balances are zero." };
  }
  const fraction = formatScaled(fundRaw, total, 0);
  const percent = formatScaled(fundRaw * 100n, total, 0);
  return {
    fraction: fraction.exact ? fraction.text : null,
    percent: percent.exact ? percent.text : null,
    belowTwentyPercent: 4n * fundRaw < treasuryRaw,
  };
}

export interface EcofundInput {
  refills: readonly RefillRecord[];
  balances: EcofundBalances | null;
  unpaidPips?: readonly UnpaidPip[];
  councilOverride?: CouncilOverride;
  asOf: string;
  movementsComplete: boolean;
}

export function evaluateEcofund(input: EcofundInput) {
  const last = input.refills[input.refills.length - 1] ?? null;
  const currentLimit = last
    ? perPipLimit(BigInt(last.balanceAfterRaw), last.decimals)
    : {
        amount: null,
        exact: false,
        rule: "5% of the balance after the last refill.",
        status: "unknown" as const,
        reason: "No treasury-to-fund ATLAS refill is in the parsed cache, so the 5% basis is unknown.",
      };

  const balanceBlock = input.balances
    ? {
        asOf: input.balances.fetchedAt,
        dataMode: "cached" as const,
        treasuryAtlas: formatRaw(input.balances.treasuryAtlasRaw, input.balances.atlasDecimals),
        ecosystemFundAtlas: formatRaw(input.balances.fundAtlasRaw, input.balances.atlasDecimals),
        treasuryUsdc: formatRaw(input.balances.treasuryUsdcRaw, input.balances.usdcDecimals),
        ecosystemFundUsdc:
          input.balances.fundUsdcRaw === null
            ? { status: "unknown" as const, reason: "No Ecosystem Fund USDC balance is in the cache." }
            : formatRaw(input.balances.fundUsdcRaw, input.balances.usdcDecimals),
        fundShareOfCombinedAtlas: share(input.balances.fundAtlasRaw, input.balances.treasuryAtlasRaw),
      }
    : {
        status: "unknown" as const,
        reason: "The cache has no RPC balances. Run npm run refresh-treasury. Current balances were not invented.",
      };

  const atlasNext = input.balances
    ? atlasRefillAmount(input.balances.treasuryAtlasRaw, input.balances.fundAtlasRaw, input.balances.atlasDecimals)
    : { due: null, amount: null, status: "unknown" as const, reason: "Current ATLAS balances are not in the cache." };
  const usdcNext = input.balances
    ? usdcRefillAmount(input.balances.treasuryUsdcRaw, input.balances.usdcDecimals)
    : { due: null, amount: null, status: "unknown" as const, reason: "Current USDC balance is not in the cache." };

  let nextLimit: Record<string, unknown>;
  if (!last) {
    nextLimit = { status: "unknown", reason: "There is no parsed refill, so there is no 5% basis to carry forward." };
  } else if (!input.balances) {
    nextLimit = {
      status: "partial",
      ifNoAtlasRefill: currentLimit,
      reason: "Without current balances this node cannot tell whether the next quarter would refill ATLAS. The limit does not change until a refill transaction.",
    };
  } else if (!atlasNext.due) {
    nextLimit = {
      status: "known",
      amount: "amount" in currentLimit ? currentLimit.amount : null,
      sameAsCurrent: true,
      reason: "No ATLAS refill is due on these balances. PIP-23 keeps the current 5% limit until the next refill transaction.",
    };
  } else if (atlasNext.amount === null) {
    nextLimit = { status: "unknown", reason: "The ATLAS refill is not an exact token amount and PIP-23 does not state a rounding mode." };
  } else {
    const projected = input.balances.fundAtlasRaw + parseUiAmount(atlasNext.amount, input.balances.atlasDecimals, "refill");
    const projectedLimit = perPipLimit(projected, input.balances.atlasDecimals);
    nextLimit = {
      status: projectedLimit.exact ? "known" : "unknown",
      amount: projectedLimit.amount,
      projectedFundAtlas: formatRaw(projected, input.balances.atlasDecimals),
      reason:
        "Projected 5% of (current fund ATLAS + the ATLAS refill computed from cached balances). This is not a forecast of balances on the quarter date.",
    };
  }

  const usdcEffect =
    input.balances && usdcNext.due
      ? {
          status: "unknown" as const,
          reason:
            "PIP-23 says continuous-funding USDC is converted to ATLAS in a timely manner. It does not state a rate or a venue, so the effect on the ATLAS limit is unknown.",
        }
      : { status: "not_applicable" as const, reason: "No USDC refill is due, or USDC balances are unavailable." };

  const remaining = remainingAfterUnpaid(input.unpaidPips, input.balances);

  const override = input.councilOverride
    ? {
        source: "council_supplied" as const,
        label: input.councilOverride.label,
        perPipLimitAtlas: input.councilOverride.perPipLimitAtlas ?? null,
        nextQuarterLimitAtlas: input.councilOverride.nextQuarterLimitAtlas ?? null,
        note: input.councilOverride.note ?? null,
        replacesComputed: false,
      }
    : null;

  const computedPerPip = "amount" in currentLimit ? currentLimit.amount : null;
  const figureInForce = override?.perPipLimitAtlas
    ? { perPipLimitAtlas: override.perPipLimitAtlas, source: "council_override" as const, label: override.label }
    : computedPerPip
      ? { perPipLimitAtlas: computedPerPip, source: "pip23" as const }
      : { perPipLimitAtlas: null, source: "unknown" as const, reason: "No computed limit and no Council override." };

  return {
    wallets: {
      daoTreasury: DAO_TREASURY_ADDRESS,
      ecosystemFund: ECOSYSTEM_FUND_ADDRESS,
      source: WALLET_SOURCE_URL,
    },
    rule: {
      pip: "PIP-23",
      galaxyStatus: "Voting_Complete_Measure_Passes",
      source: PIP23_URL,
      replaced: { pip: "PIP-4", source: PIP4_URL, note: "PIP-23 says it replaces PIP-4 in its entirety. The PIP-4 USDC formula is not applied." },
      perPipLimit: "No Ecosystem Fund PIP shall exceed 5% of the Balance After of the last refill transaction.",
      atlasRefill:
        "On a quarter, if Ecosystem Fund ATLAS is under 20% of (DAO Treasury ATLAS + Ecosystem Fund ATLAS), send ATLAS so the fund is 20% of that total.",
      usdcRefill:
        "If DAO Treasury USDC is more than 500,000, send 20% of the amount above 500,000. Otherwise send no USDC.",
      quarters: "on or about Mar 31, Jun 20, Sep 30, and Dec 31 (June 20 is copied from PIP-23, not normalized).",
      unknown: [
        "USDC-to-ATLAS conversion rate and venue.",
        "Rounding when a refill is not an integer raw amount.",
        "The list of unpaid PIPs. PIP-23 does not publish one.",
      ],
    },
    movementsComplete: input.movementsComplete,
    refills: input.refills,
    lastRefill: last,
    currentPerPipLimit: currentLimit,
    balances: balanceBlock,
    nextQuarter: {
      date: nextQuarterDate(input.asOf),
      onOrAbout: true,
      evaluatedOn: input.balances?.fetchedAt ?? null,
      note: "The date is the next published quarter mark. Amounts use cached balances as of the balance timestamp, not a prediction of that date.",
      atlasRefill: atlasNext,
      usdcRefill: usdcNext,
      perPipLimit: nextLimit,
      usdcConversionEffectOnAtlasLimit: usdcEffect,
    },
    remainingAfterUnpaidPips: remaining,
    councilOverride: override,
    figureInForce,
  };
}

function remainingAfterUnpaid(unpaid: readonly UnpaidPip[] | undefined, balances: EcofundBalances | null) {
  if (!unpaid) {
    return {
      status: "unknown" as const,
      reason:
        "PIP-23 does not publish unpaid PIP amounts. Pass unpaidPips, each with a sourceLabel. An omitted list is unknown, not zero.",
    };
  }
  if (!balances) {
    return { status: "unknown" as const, reason: "Unpaid PIPs were supplied, but the Ecosystem Fund ATLAS balance is not in the cache." };
  }
  let sum = 0n;
  const rows = unpaid.map((row) => {
    const raw = parseUiAmount(row.amountAtlas, balances.atlasDecimals, `${row.pip} amount`);
    sum += raw;
    return { pip: row.pip, amountAtlas: row.amountAtlas, sourceLabel: row.sourceLabel, source: "council_supplied" as const };
  });
  const remaining = balances.fundAtlasRaw - sum;
  return {
    status: "known" as const,
    source: "council_supplied" as const,
    note: "Fund ATLAS balance minus the caller-supplied unpaid amounts. PIP-23 does not define this subtraction; the inputs are labelled and are not chain data.",
    unpaid: rows,
    unpaidAtlas: formatRaw(sum, balances.atlasDecimals),
    fundAtlas: formatRaw(balances.fundAtlasRaw, balances.atlasDecimals),
    remainingAtlas: formatRaw(remaining, balances.atlasDecimals),
  };
}

export const ECOFUND_DECIMALS = ATLAS_DECIMALS;
export const ECOSYSTEM_FUND = ECOSYSTEM_FUND_ADDRESS;
