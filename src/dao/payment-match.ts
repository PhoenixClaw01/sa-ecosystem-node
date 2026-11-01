import { compareDecimal, addDecimalStrings } from "./amount.js";
import { ATLAS_MINT, USDC_MINT } from "./wallets.js";

const DECIMAL = /^\d+(\.\d+)?$/;

export interface TrackerMoneyRow {
  pip: string;
  atlasPaid: string | null;
  usdcPaid: string | null;
}

export interface ChainOutflow {
  signature: string;
  mint: string;
  symbol: string | null;
  amount: string;
  time: string | null;
}

export interface PaymentMatch {
  signature: string;
  pip: string;
  mint: string;
  symbol: string | null;
  amount: string;
  confidence: "exact" | "remainder_sum";
  reason: string;
}

export interface PaymentMismatch {
  kind: "ambiguous_amount" | "sheet_without_outflow" | "outflow_without_sheet";
  mint: string;
  pip: string | null;
  signature: string | null;
  amount: string | null;
  detail: string;
}

export interface PaymentUnresolved {
  mint: string;
  pip: string | null;
  signature: string | null;
  amount: string | null;
  detail: string;
}

export interface MatchReport {
  matches: PaymentMatch[];
  mismatches: PaymentMismatch[];
  unresolved: PaymentUnresolved[];
  unknownCells: { pip: string; mint: string; raw: string }[];
  blankCells: number;
  notes: string[];
}

interface ParsedCell {
  amount: string | null;
  /** True when the cell is empty. A non-numeric mark such as "?" is unknown, not blank. */
  blank: boolean;
  raw: string;
}

function norm(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function parseMoney(raw: string): ParsedCell {
  const trimmed = raw.trim();
  if (!trimmed) return { amount: null, blank: true, raw: trimmed };
  const text = trimmed.replace(/[$,\s]/g, "");
  if (/^n\/?a$/i.test(text) || text === "?" || text === "-" || text === "—") {
    return { amount: null, blank: false, raw: trimmed };
  }
  if (!DECIMAL.test(text)) return { amount: null, blank: false, raw: trimmed };
  return { amount: text, blank: false, raw: trimmed };
}

export function parseTrackerMoney(csv: string): { rows: TrackerMoneyRow[]; unknownCells: MatchReport["unknownCells"]; blankCells: number } {
  const table = parseCsv(csv.replace(/^\uFEFF/, ""));
  const headerIndex = table.findIndex((cells) => cells.some((cell) => norm(cell) === "PIP Name"));
  const header = headerIndex >= 0 ? table[headerIndex] : undefined;
  if (!header) {
    return { rows: [], unknownCells: [], blankCells: 0 };
  }
  const index = new Map<string, number>();
  header.forEach((name, i) => {
    const key = norm(name);
    if (key && !index.has(key)) index.set(key, i);
  });
  const pipCol = index.get("PIP");
  const usdcCol = index.get("Total Amount Paid (USDC)");
  const atlasCol = index.get("Total Amount Paid (ATLAS)");
  const rows: TrackerMoneyRow[] = [];
  const unknownCells: MatchReport["unknownCells"] = [];
  let blankCells = 0;
  if (pipCol === undefined) return { rows, unknownCells, blankCells };
  for (const cells of table.slice(headerIndex + 1)) {
    const pip = (cells[pipCol] ?? "").trim();
    if (!pip) continue;
    const usdc = parseMoney(usdcCol === undefined ? "" : (cells[usdcCol] ?? ""));
    const atlas = parseMoney(atlasCol === undefined ? "" : (cells[atlasCol] ?? ""));
    for (const [mint, cell] of [
      [USDC_MINT, usdc],
      [ATLAS_MINT, atlas],
    ] as const) {
      if (cell.blank) blankCells += 1;
      else if (cell.amount === null) unknownCells.push({ pip, mint, raw: cell.raw });
    }
    rows.push({ pip, usdcPaid: usdc.amount, atlasPaid: atlas.amount });
  }
  return { rows, unknownCells, blankCells };
}

function paidFor(row: TrackerMoneyRow, mint: string): string | null {
  if (mint === USDC_MINT) return row.usdcPaid;
  if (mint === ATLAS_MINT) return row.atlasPaid;
  return null;
}

function symbolFor(mint: string, fallback: string | null): string {
  if (fallback) return fallback;
  if (mint === USDC_MINT) return "USDC";
  if (mint === ATLAS_MINT) return "ATLAS";
  return mint;
}

export function matchTrackerToPayments(
  parsed: ReturnType<typeof parseTrackerMoney>,
  payments: readonly ChainOutflow[],
  options: { chainRead: boolean; mintComplete: (mint: string) => boolean },
): MatchReport {
  const notes = [
    "A match is recorded only when a Tracker paid amount equals a chain outflow, or when one remaining paid amount equals the sum of the remaining outflows.",
    "A blank cell is unknown. It is not treated as zero.",
  ];
  if (!options.chainRead) {
    return {
      matches: [],
      mismatches: [],
      unresolved: [
        {
          mint: "",
          pip: null,
          signature: null,
          amount: null,
          detail: "The treasury cache was not read, so no payment was matched and none is listed as a mismatch.",
        },
      ],
      unknownCells: parsed.unknownCells,
      blankCells: parsed.blankCells,
      notes,
    };
  }

  const matches: PaymentMatch[] = [];
  const mismatches: PaymentMismatch[] = [];
  const unresolved: PaymentUnresolved[] = [];
  const mints = [USDC_MINT, ATLAS_MINT];

  for (const mint of mints) {
    const complete = options.mintComplete(mint);
    const outflows = payments.filter((payment) => payment.mint === mint && DECIMAL.test(payment.amount));
    const rows = parsed.rows
      .map((row) => ({ pip: row.pip, amount: paidFor(row, mint) }))
      .filter((row): row is { pip: string; amount: string } => row.amount !== null && compareDecimal(row.amount, "0") > 0);
    const usedRows = new Set<number>();
    const usedPays = new Set<number>();
    const blockedRows = new Set<number>();

    outflows.forEach((payment, payIndex) => {
      const candidates = rows
        .map((row, rowIndex) => ({ row, rowIndex }))
        .filter((item) => !usedRows.has(item.rowIndex) && compareDecimal(item.row.amount, payment.amount) === 0);
      if (candidates.length === 1) {
        const only = candidates[0];
        if (!only) return;
        usedRows.add(only.rowIndex);
        usedPays.add(payIndex);
        matches.push({
          signature: payment.signature,
          pip: only.row.pip,
          mint,
          symbol: symbolFor(mint, payment.symbol),
          amount: payment.amount,
          confidence: "exact",
          reason: "This outflow equals that PIP's paid amount, and no other open PIP has the same paid amount.",
        });
        return;
      }
      if (candidates.length > 1) {
        usedPays.add(payIndex);
        for (const item of candidates) blockedRows.add(item.rowIndex);
        mismatches.push({
          kind: "ambiguous_amount",
          mint,
          pip: null,
          signature: payment.signature,
          amount: payment.amount,
          detail: `More than one PIP lists this paid amount (${candidates.map((item) => item.row.pip).join(", ")}), so the outflow is not assigned.`,
        });
      }
    });

    const leftRows = rows.filter((_, index) => !usedRows.has(index) && !blockedRows.has(index));
    const leftPays = outflows.filter((_, index) => !usedPays.has(index));
    if (complete && leftRows.length === 1 && leftPays.length > 1) {
      const only = leftRows[0];
      const sum = addDecimalStrings(leftPays.map((payment) => payment.amount));
      if (only && compareDecimal(sum, only.amount) === 0) {
        for (const payment of leftPays) {
          matches.push({
            signature: payment.signature,
            pip: only.pip,
            mint,
            symbol: symbolFor(mint, payment.symbol),
            amount: payment.amount,
            confidence: "remainder_sum",
            reason: "The scan for this mint is complete. These remaining outflows add up to the only remaining PIP paid amount. They are not matched one by one.",
          });
        }
        continue;
      }
    }

    for (const payment of leftPays) {
      const detail = complete
        ? "No Tracker paid amount equals this outflow."
        : "The scan for this mint is not complete, so this outflow is not called a mismatch.";
      const item = {
        mint,
        pip: null,
        signature: payment.signature,
        amount: payment.amount,
        detail,
      };
      if (complete) mismatches.push({ kind: "outflow_without_sheet", ...item });
      else unresolved.push(item);
    }
    for (const row of leftRows) {
      const claimed = matches.some((match) => match.pip === row.pip && match.mint === mint) ||
        (complete && leftRows.length === 1 && leftPays.length > 1 && compareDecimal(addDecimalStrings(leftPays.map((payment) => payment.amount)), row.amount) === 0);
      if (claimed) continue;
      const detail = complete
        ? "No chain outflow equals this paid amount."
        : "The scan for this mint is not complete, so this paid amount is not called a mismatch.";
      const item = { mint, pip: row.pip, signature: null, amount: row.amount, detail };
      if (complete) mismatches.push({ kind: "sheet_without_outflow", ...item });
      else unresolved.push(item);
    }
  }

  return {
    matches,
    mismatches,
    unresolved,
    unknownCells: parsed.unknownCells,
    blankCells: parsed.blankCells,
    notes,
  };
}

export function mintCompleteFromCache(payload: unknown, mint: string): boolean {
  if (!payload || typeof payload !== "object") return false;
  const cursors = (payload as { cursors?: unknown }).cursors;
  if (!Array.isArray(cursors)) return false;
  const relevant = cursors.filter((cursor) => {
    if (!cursor || typeof cursor !== "object") return false;
    const row = cursor as { kind?: unknown; mint?: unknown };
    return row.kind === "token" && row.mint === mint;
  }) as { reachedEnd?: unknown; gaps?: unknown; reconciled?: unknown }[];
  if (relevant.length === 0) return false;
  return relevant.every(
    (cursor) => cursor.reachedEnd === true && Array.isArray(cursor.gaps) && cursor.gaps.length === 0 && cursor.reconciled === true,
  );
}
