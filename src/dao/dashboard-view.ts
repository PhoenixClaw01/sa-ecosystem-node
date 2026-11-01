import { addDecimalStrings, compareDecimal } from "./amount.js";
import { updatedAgo } from "./freshness.js";
import { buildFlows, buildHistory, buildPayments } from "./aggregate.js";
import { parseTreasuryCache } from "./cache-json.js";
import { evaluateEcofund, findRefills, type CouncilOverride } from "./ecofund.js";
import { parseRevenue, summarizeRevenue, summarizeVotes, type GalaxyProposal, type VoteRecord } from "./galaxy.js";
import type { MatchReport } from "./payment-match.js";
import type { TreasuryCache } from "./types.js";
import {
  ATLAS_MINT,
  PIP23_URL,
  PIP4_URL,
  USDC_MINT,
  USDC_SOURCE_URL,
  WALLET_SOURCE_URL,
  symbolForMint,
} from "./wallets.js";

export interface ChartPath {
  width: number;
  height: number;
  points: string;
  firstDay: string;
  lastDay: string;
  firstAmount: string;
  lastAmount: string;
  min: string;
  max: string;
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => {
    const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[ch] ?? ch;
  });
}

function groupAmount(amount: string): string {
  if (!DECIMAL.test(amount)) return amount;
  const negative = amount.startsWith("-");
  const body = negative ? amount.slice(1) : amount;
  const [whole, frac] = body.split(".");
  const grouped = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

function showAmount(amount: string | null | undefined, status?: string): string {
  if (status === "unknown" || amount == null || amount === "") return "unknown";
  return groupAmount(amount);
}

export function chartPath(
  points: readonly { day: string; amount: string }[],
  width = 640,
  height = 200,
): ChartPath | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;
  if (points.some((point) => !DECIMAL.test(point.amount))) return null;
  let min = first.amount;
  let max = first.amount;
  for (const point of points) {
    if (compareDecimal(point.amount, min) < 0) min = point.amount;
    if (compareDecimal(point.amount, max) > 0) max = point.amount;
  }
  const minN = Number(min);
  const maxN = Number(max);
  if (!Number.isFinite(minN) || !Number.isFinite(maxN)) return null;
  const span = maxN - minN;
  const pad = 12;
  const coords = points.map((point, index) => {
    const x = points.length === 1 ? width / 2 : pad + (index / (points.length - 1)) * (width - pad * 2);
    const value = Number(point.amount);
    const y = span === 0 ? height / 2 : pad + (1 - (value - minN) / span) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return {
    width,
    height,
    points: coords.join(" "),
    firstDay: first.day,
    lastDay: last.day,
    firstAmount: first.amount,
    lastAmount: last.amount,
    min,
    max,
  };
}

function cacheSources(rpc: string) {
  return [
    { url: WALLET_SOURCE_URL, note: "Published DAO Treasury and Ecosystem Fund addresses." },
    { url: PIP23_URL, note: "PIP-23 names the same two wallets and states the Ecosystem Fund rules." },
    { url: rpc, note: "Public Solana read RPC recorded on the cache. The URL is redacted." },
    { url: "https://solscan.io/tx/", note: "Transaction links are built from signatures. Solscan is not queried." },
  ];
}

function balancesFrom(cache: TreasuryCache) {
  const treasuryAtlas = cache.balances.find((balance) => balance.role === "dao_treasury" && balance.mint === ATLAS_MINT);
  const fundAtlas = cache.balances.find((balance) => balance.role === "ecosystem_fund" && balance.mint === ATLAS_MINT);
  const treasuryUsdc = cache.balances.find((balance) => balance.role === "dao_treasury" && balance.mint === USDC_MINT);
  const fundUsdc = cache.balances.find((balance) => balance.role === "ecosystem_fund" && balance.mint === USDC_MINT);
  if (!treasuryAtlas || !fundAtlas || !treasuryUsdc) return null;
  return {
    treasuryAtlasRaw: BigInt(treasuryAtlas.amountRaw),
    fundAtlasRaw: BigInt(fundAtlas.amountRaw),
    treasuryUsdcRaw: BigInt(treasuryUsdc.amountRaw),
    fundUsdcRaw: fundUsdc ? BigInt(fundUsdc.amountRaw) : null,
    atlasDecimals: treasuryAtlas.decimals,
    usdcDecimals: treasuryUsdc.decimals,
    fetchedAt: treasuryAtlas.fetchedAt,
  };
}

export function treasuryReport(payload: unknown) {
  const cache = parseTreasuryCache(payload);
  const flows = buildFlows(cache, {});
  const payments = buildPayments(cache, { limit: 200 });
  const history = buildHistory(cache, { granularity: "month" });
  return {
    dataMode: "cached" as const,
    asOf: cache.generatedAt,
    completeness: cache.completeness === "partial" ? ("partial" as const) : ("complete" as const),
    partialReason: cache.partialReason ?? null,
    sources: cacheSources(typeof cache.rpc === "string" ? cache.rpc : "[missing rpc]"),
    flows,
    payments,
    history,
    notes: [
      "A row is omitted when the cache cannot support it. Omission is not a zero.",
      "DAO Treasury ATLAS inflows stay unknown until the signature scan covers the month and the outflow sample holds.",
      ...(cache.completeness === "partial" && cache.partialReason ? [cache.partialReason] : []),
    ],
  };
}

export type TreasuryReport = ReturnType<typeof treasuryReport>;

export function ecofundReport(payload: unknown, councilOverride?: CouncilOverride) {
  const cache = parseTreasuryCache(payload);
  const fundCursor = cache.cursors.find(
    (cursor) => cursor.role === "ecosystem_fund" && cursor.kind === "token" && cursor.mint === ATLAS_MINT,
  );
  const balances = balancesFrom(cache);
  const evaluated = evaluateEcofund({
    refills: findRefills(cache.movements),
    balances,
    councilOverride,
    asOf: balances?.fetchedAt ?? cache.generatedAt,
    movementsComplete: Boolean(fundCursor?.reachedEnd && fundCursor.gaps.length === 0 && fundCursor.reconciled === true),
  });
  return {
    dataMode: "cached" as const,
    asOf: cache.generatedAt,
    completeness: cache.completeness === "partial" ? ("partial" as const) : ("complete" as const),
    sources: [
      ...cacheSources(typeof cache.rpc === "string" ? cache.rpc : "[missing rpc]"),
      { url: PIP23_URL, note: "Refill rule, 5% limit, and quarter dates." },
      { url: PIP4_URL, note: "Replaced in its entirety by PIP-23. Not used for these numbers." },
      { url: USDC_SOURCE_URL, note: "Circle's published Solana USDC mint." },
    ],
    ...evaluated,
  };
}

export type EcofundReport = ReturnType<typeof ecofundReport>;

function oneChoice(
  options: readonly { choice: string; count: string; votingPower: string }[],
  name: "yes" | "no" | "abstain",
): { count: string; votingPower: string } | null {
  const hits = options.filter((option) => option.choice.toLowerCase() === name);
  if (hits.length !== 1) return null;
  return { count: hits[0]?.count ?? "", votingPower: hits[0]?.votingPower ?? "" };
}

export function proposalVoteTable(proposals: readonly GalaxyProposal[]) {
  return [...proposals]
    .sort((left, right) => right.pipNumber - left.pipNumber || left.title.localeCompare(right.title))
    .map((proposal) => {
      const ranked = proposal.voteOptionsMaxChoices > 1 || proposal.voteWinners > 1;
      const options = proposal.voteData
        ? Object.entries(proposal.voteData).map(([choice, row]) => ({
            choice,
            count: row.count,
            votingPower: row.pvp,
          }))
        : [];
      const named = new Set(["yes", "no", "abstain"]);
      const votingPower = options.length > 0 ? addDecimalStrings(options.map((option) => option.votingPower)) : null;
      return {
        id: proposal.id,
        pipNumber: proposal.pipNumber,
        title: proposal.title,
        status: proposal.status,
        votingEndsAt: proposal.votingEndsAt,
        voteOptionsMaxChoices: proposal.voteOptionsMaxChoices,
        voteWinners: proposal.voteWinners,
        options,
        yes: oneChoice(options, "yes"),
        no: oneChoice(options, "no"),
        abstain: oneChoice(options, "abstain"),
        other: options.filter((option) => !named.has(option.choice.toLowerCase())),
        votingPower,
        turnout: {
          status: "unknown" as const,
          reason:
            "galaxy voteData publishes a count and voting power for each choice. It does not publish the electorate, so turnout is not a percentage.",
        },
        winner: ranked
          ? {
              status: "unknown" as const,
              reason:
                "voteOptionsMaxChoices or voteWinners is greater than 1. The votes file does not define a ranked-choice winner, so none is declared.",
            }
          : {
              status: "not_declared" as const,
              reason: "Counts and voting power are galaxy's published voteData. This page does not pick a winner from them.",
            },
      };
    });
}

export function monthlyIncome(payload: unknown) {
  const summary = summarizeRevenue(parseRevenue(payload));
  const months = summary.months.map((month) => ({
    period: month.period,
    usdcValue: addDecimalStrings(month.sources.map((source) => source.usdcValue)),
  }));
  return {
    months,
    earliestPublished: months[0]?.period ?? null,
    may2023Present: months.some((month) => month.period.startsWith("2023-05")),
  };
}

export function revenueView(payload: unknown) {
  const summary = summarizeRevenue(parseRevenue(payload));
  const income = monthlyIncome(payload);
  const first = summary.months[0];
  const last = summary.months[summary.months.length - 1];
  return {
    dataMode: "live" as const,
    source: "https://galaxy.staratlas.com/dao/treasury",
    bySource: summary.bySource,
    monthCount: summary.months.length,
    firstPeriod: first?.period ?? null,
    lastPeriod: last?.period ?? null,
    monthlyUsdc: income.months,
    may2023Present: income.may2023Present,
  };
}

function sourceList(sources: readonly { url: string; note: string }[]): string {
  return `<ul class="src">${sources
    .map((source) => `<li><a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.url)}</a> ${esc(source.note)}</li>`)
    .join("")}</ul>`;
}

function stamp(dataMode: string, asOf: string, completeness?: "partial" | "complete"): string {
  const label = completeness === "partial" ? "Partial cache" : dataMode === "cached" ? "Cached" : "Live";
  const ago = updatedAgo(asOf, Date.now());
  const relative = ago ? ` <span class="pill">${esc(ago)}</span>` : "";
  return `<p class="asof"><span class="pill snap">${esc(label)} as of ${esc(asOf)}</span>${relative}</p>`;
}

function mcpSlot(panel: string): string {
  return `<div class="mcp-slot" data-mcp-panel="${esc(panel)}"></div>`;
}

export function flowsSectionHtml(report: TreasuryReport): string {
  const rows = report.flows.rows
    .map((row) => {
      return `<tr><td>${esc(row.month)}</td><td>${esc(row.role)}</td><td>${esc(row.symbol ?? row.mint)}</td><td class="num">${esc(showAmount(row.externalIn, row.externalInStatus))}</td><td class="num">${esc(groupAmount(row.externalOut))}</td><td class="num">${esc(groupAmount(row.internalIn))}</td><td class="num">${esc(groupAmount(row.internalOut))}</td><td>${esc(row.method)}</td><td>${esc(row.through)}</td></tr>`;
    })
    .join("");
  const omitted = report.flows.omitted
    .map((item) => `<li>${esc(item.role)} ${esc(symbolForMint(item.mint) ?? item.mint)}: ${esc(item.reason)}</li>`)
    .join("");
  const table = rows
    ? `<div class="table-wrap card-like"><table class="compact"><thead><tr><th>Month</th><th>Wallet</th><th>Token</th><th class="num">External in</th><th class="num">External out</th><th class="num">Internal in</th><th class="num">Internal out</th><th>Method</th><th>Through</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="hint">No complete monthly flow rows are in this cache.</p>`;
  return (
    stamp(report.dataMode, report.asOf, report.completeness) +
    table +
    (omitted ? `<p class="hint">Withheld, not shown as zero:</p><ul class="fill-list">${omitted}</ul>` : "") +
    `<ul class="fill-list">${report.flows.notes.map((note) => `<li>${esc(note)}</li>`).join("")}</ul>` +
    sourceList(report.sources) +
    mcpSlot("flows")
  );
}

export function paymentsSectionHtml(report: TreasuryReport): string {
  const rows = report.payments.payments
    .map((payment) => {
      const counterparty = payment.counterparties[0] ? `${payment.counterparties[0].slice(0, 4)}…${payment.counterparties[0].slice(-4)}` : "—";
      return `<tr><td>${esc(payment.time)}</td><td>${esc(payment.role)}</td><td>${esc(payment.symbol ?? payment.mint)}</td><td class="num">${esc(groupAmount(payment.amount))}</td><td>${esc(payment.direction)}</td><td class="mono">${esc(counterparty)}</td><td><a href="${esc(payment.solscanUrl)}" target="_blank" rel="noopener noreferrer">solscan</a></td></tr>`;
    })
    .join("");
  const omitted = report.payments.omitted
    .map((item) => `<li>${esc(item.role)} ${esc(symbolForMint(item.mint) ?? item.mint)}: ${esc(item.reason)}</li>`)
    .join("");
  const table = rows
    ? `<div class="table-wrap card-like"><table class="compact"><thead><tr><th>Time</th><th>Wallet</th><th>Token</th><th class="num">Amount</th><th>Direction</th><th>Counterparty</th><th>Tx</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="hint">No external outflows are published from this cache.</p>`;
  const more = report.payments.truncated
    ? `<p class="hint">Showing ${report.payments.payments.length} of ${report.payments.total}. The cache has more.</p>`
    : `<p class="hint">${report.payments.total} external outflow${report.payments.total === 1 ? "" : "s"}.</p>`;
  return stamp(report.dataMode, report.asOf, report.completeness) + table + more + (omitted ? `<ul class="fill-list">${omitted}</ul>` : "") + sourceList(report.sources) + mcpSlot("payments");
}

function seriesChart(series: TreasuryReport["history"]["series"][number]): string {
  if (!("points" in series) || series.status !== "known") {
    const reason = "reason" in series ? series.reason : "This series is unknown.";
    return `<p class="hint">${esc(series.role)} ${esc(series.symbol ?? series.mint)}: ${esc(reason)}</p>`;
  }
  const chart = chartPath(series.points);
  const caption = `${series.role} ${series.symbol ?? series.mint}, month-end, ${series.method}`;
  const drawing = chart
    ? `<figure class="chart-wrap"><svg class="chart" viewBox="0 0 ${chart.width} ${chart.height}" role="img" aria-label="${esc(caption)}. ${esc(groupAmount(chart.min))} to ${esc(groupAmount(chart.max))}."><polyline points="${esc(chart.points)}" /></svg><figcaption class="hint">${esc(caption)}. ${esc(chart.firstDay)} ${esc(groupAmount(chart.firstAmount))} → ${esc(chart.lastDay)} ${esc(groupAmount(chart.lastAmount))}. Low ${esc(groupAmount(chart.min))}, high ${esc(groupAmount(chart.max))}.</figcaption></figure>`
    : `<p class="hint">${esc(caption)}. The amounts are listed below. A line was not drawn.</p>`;
  const rows = series.points
    .map((point) => `<tr><td>${esc(point.day)}</td><td class="num">${esc(groupAmount(point.amount))}</td></tr>`)
    .join("");
  return (
    drawing +
    `<div class="table-wrap card-like"><table class="compact"><thead><tr><th>Day</th><th class="num">${esc(series.symbol ?? "Amount")}</th></tr></thead><tbody>${rows}</tbody></table></div>`
  );
}

export function historySectionHtml(report: TreasuryReport): string {
  const preferred =
    report.history.series.find((series) => series.role === "dao_treasury" && series.mint === ATLAS_MINT && series.status === "known") ??
    report.history.series.find((series) => series.status === "known");
  const charts = preferred ? seriesChart(preferred) : `<p class="hint">No complete balance series is in this cache, so no line is drawn.</p>`;
  const others = report.history.series
    .filter((series) => series !== preferred)
    .map((series) => {
      if (series.status !== "known" || !("points" in series)) {
        const reason = "reason" in series ? series.reason : "unknown";
        return `<li>${esc(series.role)} ${esc(series.symbol ?? series.mint)}: ${esc(reason)}</li>`;
      }
      const end = series.points[series.points.length - 1];
      return `<li>${esc(series.role)} ${esc(series.symbol ?? series.mint)}: ${series.points.length} points${end ? `, last ${esc(end.day)} ${esc(groupAmount(end.amount))}` : ""}.</li>`;
    })
    .join("");
  const omitted = report.history.omitted
    .map((item) => `<li>${esc(item.role)} ${esc(symbolForMint(item.mint) ?? item.mint)}: ${esc(item.reason)}</li>`)
    .join("");
  return (
    stamp(report.dataMode, report.asOf, report.completeness) +
    charts +
    (others ? `<p class="hint">Other series in this cache:</p><ul class="fill-list">${others}</ul>` : "") +
    (omitted ? `<p class="hint">Withheld, not shown as zero:</p><ul class="fill-list">${omitted}</ul>` : "") +
    `<ul class="fill-list">${report.history.notes.map((note) => `<li>${esc(note)}</li>`).join("")}</ul>` +
    sourceList(report.sources) +
    mcpSlot("history")
  );
}

function fieldAmount(value: unknown): string {
  if (!value || typeof value !== "object") return "unknown";
  const row = value as { amount?: unknown; status?: unknown; exact?: unknown };
  if (row.status === "unknown") return "unknown";
  if (row.exact === false || row.amount == null) return "unknown";
  if (typeof row.amount === "string") return groupAmount(row.amount);
  return "unknown";
}

export function ecofundSectionHtml(report: EcofundReport): string {
  const current = report.currentPerPipLimit;
  const currentText = "amount" in current && current.amount ? groupAmount(String(current.amount)) : "unknown";
  const currentReason = "reason" in current && current.reason ? String(current.reason) : current.rule;
  const next = report.nextQuarter.perPipLimit;
  const nextAmount = typeof next.amount === "string" ? groupAmount(next.amount) : "unknown";
  const atlas = report.nextQuarter.atlasRefill;
  const usdc = report.nextQuarter.usdcRefill;
  const remaining = report.remainingAfterUnpaidPips;
  const remainingText = remaining.status === "known" && "remainingAtlas" in remaining ? groupAmount(String(remaining.remainingAtlas)) : "unknown";
  const override = report.councilOverride;
  const inForce = report.figureInForce;
  const inForceText = inForce.perPipLimitAtlas ? groupAmount(inForce.perPipLimitAtlas) : "unknown";
  return (
    stamp(report.dataMode, report.asOf, report.completeness) +
    `<div class="kpis">` +
    `<article class="kpi"><div class="label">Computed 5% limit</div><div class="value">${esc(currentText)}${currentText === "unknown" ? "" : '<span class="unit">ATLAS</span>'}</div><div class="sub">${esc(currentReason)}</div></article>` +
    `<article class="kpi"><div class="label">Next quarter</div><div class="value">${esc(report.nextQuarter.date)}</div><div class="sub">On or about this date. Limit ${esc(nextAmount)}${nextAmount === "unknown" ? "" : " ATLAS"}. ${esc(String(next.reason ?? ""))}</div></article>` +
    `<article class="kpi"><div class="label">ATLAS refill</div><div class="value">${esc(fieldAmount(atlas))}${fieldAmount(atlas) === "unknown" ? "" : '<span class="unit">ATLAS</span>'}</div><div class="sub">${esc("reason" in atlas ? String(atlas.reason ?? "") : "")}</div></article>` +
    `<article class="kpi"><div class="label">USDC refill</div><div class="value">${esc(fieldAmount(usdc))}${fieldAmount(usdc) === "unknown" ? "" : '<span class="unit">USDC</span>'}</div><div class="sub">${esc("reason" in usdc ? String(usdc.reason ?? "") : "")}</div></article>` +
    `<article class="kpi"><div class="label">After unpaid PIPs</div><div class="value">${esc(remainingText)}${remainingText === "unknown" ? "" : '<span class="unit">ATLAS</span>'}</div><div class="sub">${esc(remaining.reason ?? remaining.note ?? "")}</div></article>` +
    `<article class="kpi"><div class="label">Figure in force</div><div class="value">${esc(inForceText)}${inForceText === "unknown" ? "" : '<span class="unit">ATLAS</span>'}</div><div class="sub">${esc(inForce.source)}${"label" in inForce && inForce.label ? " — " + esc(String(inForce.label)) : ""}</div></article>` +
    `</div>` +
    (override
      ? `<p class="hint">Council override (${esc(override.label)}): per-PIP ${esc(override.perPipLimitAtlas ? groupAmount(override.perPipLimitAtlas) : "not supplied")}, next quarter ${esc(override.nextQuarterLimitAtlas ? groupAmount(override.nextQuarterLimitAtlas) : "not supplied")}. The computed figure stays above. ${esc(override.note ?? "")}</p>`
      : `<p class="hint">No Council override was supplied. The computed figure is the one in force when it is known.</p>`) +
    `<p class="hint">USDC converted to ATLAS: ${esc(report.nextQuarter.usdcConversionEffectOnAtlasLimit.status)}. ${esc(report.nextQuarter.usdcConversionEffectOnAtlasLimit.reason)}</p>` +
    `<ul class="fill-list">${report.rule.unknown.map((item) => `<li>Unknown in PIP-23: ${esc(item)}</li>`).join("")}</ul>` +
    `<p class="hint">Refills found in the cache: ${report.refills.length}. Fund ATLAS movement backfill complete: ${report.movementsComplete ? "yes" : "no"}.</p>` +
    sourceList(report.sources) +
    mcpSlot("limit")
  );
}

function choiceCell(choice: { count: string; votingPower: string } | null): string {
  if (!choice) return "unknown";
  return `${esc(groupAmount(choice.count))} votes<br>${esc(groupAmount(choice.votingPower))} voting power`;
}

export function proposalTableHtml(
  proposals: readonly GalaxyProposal[],
  asOf: string,
  sourceUrl: string,
): string {
  const rows = proposalVoteTable(proposals);
  const body = rows
    .map((row) => {
      const other = row.other.length
        ? `<br>${row.other.map((option) => `${esc(option.choice)}: ${esc(groupAmount(option.count))} votes, ${esc(groupAmount(option.votingPower))} voting power`).join("<br>")}`
        : "";
      const power = row.votingPower === null ? "unknown" : esc(groupAmount(row.votingPower));
      return `<tr><td><div class="pip">PIP-${esc(row.pipNumber)}</div><div class="name">${esc(row.title)}</div></td><td>${esc(row.status)}</td><td class="num">${choiceCell(row.yes)}</td><td class="num">${choiceCell(row.no)}</td><td class="num">${choiceCell(row.abstain)}</td><td class="num">${power}${other}</td><td>unknown. ${esc(row.turnout.reason)}</td><td>${esc(row.winner.status)}. ${esc(row.winner.reason)}</td><td><button type="button" class="vote-load" data-proposal-id="${esc(row.id)}">Load votes file</button></td></tr>`;
    })
    .join("");
  return (
    stamp("live", asOf) +
    `<div class="table-wrap card-like"><table><thead><tr><th>PIP</th><th>Status</th><th class="num">Yes</th><th class="num">No</th><th class="num">Abstain</th><th class="num">Voting power</th><th>Turnout</th><th>Winner</th><th>Votes file</th></tr></thead><tbody>${body}</tbody></table></div>` +
    `<p class="hint">Yes, No, and Abstain are the published voteData fields, matched without regard to capital letters. Voting power is the sum of the published choice totals. Turnout is unknown because galaxy does not publish the electorate. A ranked-choice winner is not declared. The votes file for one proposal loads only when you ask.</p>` +
    `<p class="hint">Source: <a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(sourceUrl)}</a></p>` +
    `<div id="vote-detail"></div>` +
    mcpSlot("results")
  );
}

export function voteDetailHtml(votes: readonly VoteRecord[], asOf: string, sourceUrl: string): string {
  const summary = summarizeVotes([...votes], 5);
  const options = summary.options
    .map((option) => `<tr><td>${esc(option.choice)}</td><td class="num">${esc(String(option.count))}</td><td class="num">${esc(groupAmount(option.votingPower))}</td></tr>`)
    .join("");
  const top = summary.topVoters
    .map((voter) => `<li>${esc(voter.wallet)} · ${esc(voter.choice)} · ${esc(groupAmount(voter.votingPower))}</li>`)
    .join("");
  return (
    stamp("live", asOf) +
    `<p class="hint">${summary.voterCount} vote records, ${summary.uniqueWallets} wallets. Ranked winner: ${esc(summary.rankedWinner.status)}. ${esc(summary.rankedWinner.reason)}</p>` +
    `<div class="table-wrap card-like"><table class="compact"><thead><tr><th>Choice</th><th class="num">Votes</th><th class="num">Voting power</th></tr></thead><tbody>${options}</tbody></table></div>` +
    (top ? `<ul class="fill-list">${top}</ul>` : "") +
    `<p class="hint">Source: <a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(sourceUrl)}</a></p>`
  );
}

export function revenueSectionHtml(view: ReturnType<typeof revenueView>, asOf: string): string {
  const rows = view.bySource
    .map(
      (source) =>
        `<tr><td>${esc(source.segmentation)}</td><td>${esc(source.mint)}</td><td class="num">${esc(groupAmount(source.amount))}</td><td class="num">${esc(groupAmount(source.usdcValue))}</td><td class="num">${source.months}</td></tr>`,
    )
    .join("");
  const span = view.firstPeriod && view.lastPeriod ? `${view.firstPeriod} to ${view.lastPeriod}` : "no periods";
  const chart = chartPath(view.monthlyUsdc.map((month) => ({ day: month.period, amount: month.usdcValue })));
  const monthRows = view.monthlyUsdc
    .map((month) => `<tr><td>${esc(month.period)}</td><td class="num">${esc(groupAmount(month.usdcValue))}</td></tr>`)
    .join("");
  const mayNote = view.may2023Present
    ? "The series includes May 2023, the earliest month this request asked for. A month with no published row is omitted, not drawn as zero."
    : "May 2023 is not in this document. The chart starts at the earliest published period. Missing months are omitted, not drawn as zero.";
  const drawing = chart
    ? `<figure class="chart-wrap"><svg class="chart" viewBox="0 0 ${chart.width} ${chart.height}" role="img" aria-label="Monthly DAO income in published USDC value, ${esc(chart.firstDay)} to ${esc(chart.lastDay)}."><polyline points="${esc(chart.points)}" /></svg><figcaption class="hint">Monthly income, published USDC value, ${esc(chart.firstDay)} ${esc(groupAmount(chart.firstAmount))} → ${esc(chart.lastDay)} ${esc(groupAmount(chart.lastAmount))}.</figcaption></figure>`
    : `<p class="hint">No monthly USDC series was drawn.</p>`;
  return (
    stamp(view.dataMode, asOf) +
    `<h3 class="sub-head">Monthly income</h3>` +
    `<p class="hint">${esc(mayNote)}</p>` +
    drawing +
    (monthRows
      ? `<div class="table-wrap card-like"><table class="compact"><thead><tr><th>Period</th><th class="num">USDC value</th></tr></thead><tbody>${monthRows}</tbody></table></div>`
      : "") +
    mcpSlot("income") +
    `<p class="hint">${view.monthCount} recorded periods (${esc(span)}), summed by source and mint. USDC value is the figure galaxy published on the row.</p>` +
    (rows
      ? `<div class="table-wrap card-like"><table class="compact"><thead><tr><th>Source</th><th>Mint</th><th class="num">Amount</th><th class="num">USDC value</th><th class="num">Months</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="hint">The revenue document had no rows.</p>`) +
    `<p class="hint">Source: <a href="${esc(view.source)}" target="_blank" rel="noopener noreferrer">${esc(view.source)}</a></p>` +
    mcpSlot("revenue")
  );
}

function mintLabel(mint: string): string {
  if (mint.endsWith("Dt1v")) return "USDC";
  if (mint.startsWith("ATLAS")) return "ATLAS";
  return mint;
}

export function matchSectionHtml(report: MatchReport): string {
  const matchRows = report.matches
    .map(
      (match) =>
        `<tr><td class="mono">${esc(match.signature)}</td><td>${esc(match.pip)}</td><td>${esc(match.symbol ?? mintLabel(match.mint))}</td><td class="num">${esc(groupAmount(match.amount))}</td><td>${esc(match.confidence)}</td><td>${esc(match.reason)}</td></tr>`,
    )
    .join("");
  const mismatchRows = report.mismatches
    .map(
      (item) =>
        `<tr><td>${esc(item.kind)}</td><td>${esc(item.pip ?? "—")}</td><td class="mono">${esc(item.signature ?? "—")}</td><td>${esc(mintLabel(item.mint))}</td><td class="num">${item.amount === null ? "unknown" : esc(groupAmount(item.amount))}</td><td>${esc(item.detail)}</td></tr>`,
    )
    .join("");
  const unresolved = report.unresolved.map((item) => `<li>${esc(item.detail)}${item.pip ? ` ${esc(item.pip)}` : ""}${item.signature ? ` ${esc(item.signature)}` : ""}</li>`).join("");
  const unknown = report.unknownCells
    .map((cell) => `<li>${esc(cell.pip)} ${esc(mintLabel(cell.mint))}: ${esc(cell.raw)}</li>`)
    .join("");
  return (
    (matchRows
      ? `<div class="table-wrap card-like"><table class="compact"><thead><tr><th>Outflow</th><th>PIP</th><th>Token</th><th class="num">Amount</th><th>Confidence</th><th>Why</th></tr></thead><tbody>${matchRows}</tbody></table></div>`
      : `<p class="hint">No payment is matched.</p>`) +
    `<h3 class="sub-head">Mismatches</h3>` +
    (mismatchRows
      ? `<div class="table-wrap card-like"><table class="compact"><thead><tr><th>Kind</th><th>PIP</th><th>Outflow</th><th>Token</th><th class="num">Amount</th><th>Detail</th></tr></thead><tbody>${mismatchRows}</tbody></table></div>`
      : `<p class="hint">No confirmed mismatch.</p>`) +
    (unresolved ? `<p class="hint">Not confirmed:</p><ul class="fill-list">${unresolved}</ul>` : "") +
    `<p class="hint">${report.blankCells} paid cells are blank, so they are unknown rather than zero.</p>` +
    (unknown ? `<p class="hint">Paid cells that are not a number:</p><ul class="fill-list">${unknown}</ul>` : "") +
    `<ul class="fill-list">${report.notes.map((note) => `<li>${esc(note)}</li>`).join("")}</ul>` +
    mcpSlot("match")
  );
}

export interface HealthRow {
  source: string;
  status: "ok" | "error" | "missing" | "not_requested";
  asOf: string | null;
  detail: string | null;
}

export function dataHealthSectionHtml(rows: readonly HealthRow[], nowMs: number): string {
  const body = rows
    .map((row) => {
      const ago = row.asOf ? updatedAgo(row.asOf, nowMs) : "";
      const when = row.asOf ? `${row.asOf}${ago ? `, ${ago}` : ""}` : "—";
      return `<tr><td>${esc(row.source)}</td><td>${esc(row.status)}</td><td>${esc(when)}</td><td>${esc(row.detail ?? "")}</td></tr>`;
    })
    .join("");
  return (
    `<div class="table-wrap card-like"><table class="compact"><thead><tr><th>Source</th><th>Status</th><th>As of</th><th>Detail</th></tr></thead><tbody>${body}</tbody></table></div>` +
    `<p class="hint">A missing source is left missing. Nothing on this tab is filled in from another source.</p>` +
    mcpSlot("health")
  );
}
