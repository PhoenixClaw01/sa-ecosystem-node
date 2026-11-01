import { UserInputError } from "../errors.js";

/** Integer string, optional leading minus. Rejects blanks and decimals. */
export function parseInteger(value: string, label = "amount"): bigint {
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${label} is not an integer string.`);
  }
  return BigInt(value);
}

/** Whole-token decimal typed by a caller, such as "11204716.5". */
export function parseUiAmount(value: string, decimals: number, label = "amount"): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new UserInputError(`${label} must be a non-negative decimal number.`);
  }
  const [whole, frac = ""] = value.split(".");
  if (frac.length > decimals) {
    throw new UserInputError(`${label} has more than ${decimals} decimal places.`);
  }
  const scale = 10n ** BigInt(decimals);
  return BigInt(whole ?? "0") * scale + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Format a raw integer at `decimals` without binary floating point. */
export function formatRaw(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = abs % scale;
  let text = whole.toString();
  if (frac !== 0n) {
    text += `.${frac.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
  }
  return negative ? `-${text}` : text;
}

/**
 * Format numerator/denominator as a raw integer scaled by 10^decimals.
 * `exact` is false when the decimal does not terminate within the digit cap.
 */
export function formatScaled(
  numerator: bigint,
  denominator: bigint,
  decimals: number,
): { text: string; exact: boolean } {
  if (denominator <= 0n) throw new Error("denominator must be positive.");
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const div = denominator * 10n ** BigInt(decimals);
  const whole = abs / div;
  let rem = abs % div;
  let digits = "";
  while (rem !== 0n && digits.length < decimals + 24) {
    rem *= 10n;
    digits += (rem / div).toString();
    rem %= div;
  }
  const exact = rem === 0n;
  const trimmed = digits.replace(/0+$/, "");
  let text = whole.toString();
  if (trimmed.length > 0) text += `.${trimmed}`;
  if (!exact) text += "…";
  return { text: negative ? `-${text}` : text, exact };
}

export function addDecimalStrings(values: string[]): string {
  let scale = 0;
  for (const value of values) {
    if (!/^-?\d+(\.\d+)?$/.test(value)) throw new Error("Not a decimal string.");
    scale = Math.max(scale, value.split(".")[1]?.length ?? 0);
  }
  let total = 0n;
  for (const value of values) {
    const negative = value.startsWith("-");
    const body = negative ? value.slice(1) : value;
    const [whole, frac = ""] = body.split(".");
    const raw = BigInt(whole ?? "0") * 10n ** BigInt(scale) + BigInt(frac.padEnd(scale, "0") || "0");
    total += negative ? -raw : raw;
  }
  return formatRaw(total, scale);
}

export function compareDecimal(left: string, right: string): number {
  const sum = addDecimalStrings([left, right.startsWith("-") ? right.slice(1) : `-${right}`]);
  if (sum === "0") return 0;
  return sum.startsWith("-") ? -1 : 1;
}

export function utcDay(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function utcMonth(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 7);
}

export function dayBefore(isoDay: string): string {
  const time = Date.parse(`${isoDay}T00:00:00Z`);
  if (Number.isNaN(time)) throw new Error(`Bad day ${isoDay}.`);
  return new Date(time - 86_400_000).toISOString().slice(0, 10);
}

export function monthEnd(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error(`Bad month ${month}.`);
  const year = Number(match[1]);
  const mon = Number(match[2]);
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}

export function isoFromUnix(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}
