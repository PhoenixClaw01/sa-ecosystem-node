import { SafeClientError } from "../errors.js";

export const COUNCIL_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1QWkFjcLwhw4GHqk5Stz72H3WRwIb52f-UDnKne7hTtY/edit?usp=sharing";

export const COUNCIL_SHEET_CSV =
  "https://docs.google.com/spreadsheets/d/1QWkFjcLwhw4GHqk5Stz72H3WRwIb52f-UDnKne7hTtY/export?format=csv&gid=0";

const COLUMNS = {
  pip: "PIP",
  name: "PIP Name",
  result: "Vote Result",
  usdcPaid: "Total Amount Paid (USDC)",
  usdcLeft: "Total Amount Left (USDC)",
  atlasPaid: "Total Amount Paid (ATLAS)",
  atlasLeft: "Total Amount Left (ATLAS)",
  msDone: "Completed Milestones",
  msTotal: "Total Payment Milestones",
} as const;

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
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

function norm(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function money(raw: string): { raw: string; amount: string | null } {
  const cleaned = raw.replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return { raw: raw.trim(), amount: null };
  return { raw: raw.trim(), amount: cleaned };
}

function count(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").trim();
  if (!/^\d+$/.test(cleaned)) return null;
  return Number(cleaned);
}

export interface PipTrackerRow {
  pip: string;
  name: string;
  voteResult: string;
  usdcPaid: string | null;
  usdcLeft: string | null;
  atlasPaid: string | null;
  atlasLeft: string | null;
  milestonesDone: number | null;
  milestonesTotal: number | null;
}

export function parsePipTracker(csv: string): { rows: PipTrackerRow[]; missingColumns: string[] } {
  const table = parseCsv(csv);
  const headerIndex = table.findIndex((row) => row.some((cell) => norm(cell) === "PIP Name"));
  if (headerIndex < 0) throw new SafeClientError("The Council sheet has no PIP Name header. No payments were invented.");
  const header = table[headerIndex]?.map(norm) ?? [];
  const index = new Map(header.map((name, position) => [name, position]));
  const missingColumns = Object.values(COLUMNS).filter((name) => !index.has(name));
  const rows: PipTrackerRow[] = [];
  for (const record of table.slice(headerIndex + 1)) {
    const cell = (name: string) => {
      const position = index.get(name);
      return position === undefined ? "" : (record[position] ?? "").trim();
    };
    const pip = cell(COLUMNS.pip);
    const name = cell(COLUMNS.name);
    if (!pip && !name) continue;
    if (!pip) continue;
    rows.push({
      pip,
      name,
      voteResult: cell(COLUMNS.result),
      usdcPaid: money(cell(COLUMNS.usdcPaid)).amount,
      usdcLeft: money(cell(COLUMNS.usdcLeft)).amount,
      atlasPaid: money(cell(COLUMNS.atlasPaid)).amount,
      atlasLeft: money(cell(COLUMNS.atlasLeft)).amount,
      milestonesDone: count(cell(COLUMNS.msDone)),
      milestonesTotal: count(cell(COLUMNS.msTotal)),
    });
  }
  return { rows, missingColumns };
}
