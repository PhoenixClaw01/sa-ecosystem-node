import { formatRaw } from "./amount.js";
import { SafeClientError } from "../errors.js";

const DECIMAL = /^\d+(\.\d+)?$/;

/** Turn a JSON number into a decimal string only when it round-trips. Otherwise the price is unknown. */
export function numberToDecimal(value: number): string | null {
  if (!Number.isFinite(value) || value < 0 || Object.is(value, -0)) return null;
  const text = value.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
  if (!DECIMAL.test(text)) return null;
  if (Number(text) !== value) return null;
  return text;
}

export function parseJupiterPrices(
  payload: unknown,
  mints: readonly string[],
): { prices: Record<string, string | null>; source: "https://lite-api.jup.ag/price/v3" } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SafeClientError("Jupiter price response was not an object. No price was invented.");
  }
  const body = payload as Record<string, unknown>;
  const prices: Record<string, string | null> = {};
  for (const mint of mints) {
    const row = body[mint];
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      prices[mint] = null;
      continue;
    }
    const usdPrice = (row as { usdPrice?: unknown }).usdPrice;
    if (typeof usdPrice === "string" && DECIMAL.test(usdPrice)) prices[mint] = usdPrice;
    else if (typeof usdPrice === "number") prices[mint] = numberToDecimal(usdPrice);
    else prices[mint] = null;
  }
  return { prices, source: "https://lite-api.jup.ag/price/v3" };
}

/** Exact product of two non-negative decimals. The caller labels the result approximate because the price is a quote. */
export function approximateUsd(amount: string, usdPrice: string): string | null {
  if (!DECIMAL.test(amount) || !DECIMAL.test(usdPrice)) return null;
  const [leftWhole, leftFrac = ""] = amount.split(".");
  const [rightWhole, rightFrac = ""] = usdPrice.split(".");
  const scale = leftFrac.length + rightFrac.length;
  const product = BigInt(`${leftWhole}${leftFrac}`) * BigInt(`${rightWhole}${rightFrac}`);
  return formatRaw(product, scale);
}
