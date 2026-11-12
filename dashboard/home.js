// Front page: what powers the DAO. Live, same-origin, read-only MCP calls only.
// A failed read shows "Data unavailable" and no number. Nothing here is invented.
import { callOutput, createClient, groupDecimal, PROTOCOL_VERSION, renderTreasury } from "./playground/playground.js";

/** Heading of the featured tools section. Change this one line to rename it. */
export const FEATURED_HEADING = "Built by the ecosystem";

/** Outbound page for the 3D view. The only site this page may frame, and only after a click. */
export const C4_LIVE_URL = "https://ses.aephia.com/C4Live/";
export const MONTHS_SHOWN = 12;

/** Public profile of the C4 Live creator, used for the credit link on the page. */
export const C4_CREATOR_URL = "https://x.com/Siphaawal";

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

function unavailable(doc, host, what, error) {
  clear(host);
  host.appendChild(el(doc, "div", "banner bad", `Data unavailable: the live ${what} read failed (${error.message}). No figure is shown.`));
}

/** Exact decimal addition on strings, so totals are never rounded floats. */
export function addDecimal(a, b) {
  const parse = (text) => {
    if (typeof text !== "string" || !/^\d+(\.\d+)?$/.test(text)) return null;
    const [whole, fraction = ""] = text.split(".");
    return { whole, fraction };
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  const places = Math.max(x.fraction.length, y.fraction.length);
  const big = (p) => BigInt(p.whole + p.fraction.padEnd(places, "0"));
  const sum = (big(x) + big(y)).toString().padStart(places + 1, "0");
  if (places === 0) return sum;
  const whole = sum.slice(0, sum.length - places);
  const fraction = sum.slice(sum.length - places).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Round a non-negative decimal string to cents, half up, exactly. Returns "$1,234.57" or "—". */
export function formatUsd(text) {
  if (typeof text !== "string" || !/^\d+(\.\d+)?$/.test(text)) return "—";
  const [whole, fraction = ""] = text.split(".");
  let cents = BigInt(whole + fraction.padEnd(2, "0").slice(0, 2));
  if ((fraction[2] ?? "0") >= "5") cents += 1n;
  const raw = cents.toString().padStart(3, "0");
  const grouped = raw.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${grouped}.${raw.slice(-2)}`;
}

/** Monthly rows: { period, bySource: {name: usdcValue}, total } using galaxy's published USDC values. */
export function revenueMonths(output, limit = MONTHS_SHOWN) {
  const months = Array.isArray(output?.months) ? output.months : [];
  const names = new Set();
  const rows = months.map((month) => {
    const bySource = {};
    let total = "0";
    for (const row of Array.isArray(month?.sources) ? month.sources : []) {
      const name = String(row?.segmentation ?? "Other");
      names.add(name);
      const value = typeof row?.usdcValue === "string" ? row.usdcValue : null;
      if (value === null) continue;
      bySource[name] = bySource[name] === undefined ? value : addDecimal(bySource[name], value);
      total = addDecimal(total, value) ?? total;
    }
    return { period: String(month?.period ?? "").slice(0, 7), bySource, total };
  });
  rows.sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0));
  return { names: [...names].sort(), rows: rows.slice(0, limit) };
}

export function renderRevenue(doc, host, output) {
  if (output instanceof Error) return unavailable(doc, host, "revenue", output);
  clear(host);
  const bySource = Array.isArray(output?.bySource) ? output.bySource : [];
  if (bySource.length === 0) {
    host.appendChild(el(doc, "div", "banner warn", "Data unavailable: the revenue feed replied with no rows."));
    return;
  }
  host.appendChild(el(doc, "p", "hint", `Live read${output.asOf ? ` at ${output.asOf}` : ""}. USDC values are the figures the feed published for each month.`));
  const grid = el(doc, "div", "kpis");
  for (const row of bySource) {
    const box = el(doc, "div", "kpi");
    box.appendChild(el(doc, "div", "label", `${row.segmentation} (${row.mint})`));
    const value = formatUsd(row.usdcValue);
    box.appendChild(el(doc, "div", value === "—" ? "value missing" : "value", value));
    const months = typeof row.months === "number" ? `${row.months} month${row.months === 1 ? "" : "s"}` : "all months";
    box.appendChild(el(doc, "div", "sub", `${groupDecimal(row.amount) ?? "—"} ${row.mint} over ${months} in the feed`));
    grid.appendChild(box);
  }
  host.appendChild(grid);
  const { names, rows } = revenueMonths(output);
  if (rows.length === 0) return;
  host.appendChild(el(doc, "h3", "sub-head", `Latest ${rows.length} months in the feed, by source (USDC value, rounded to cents)`));
  const wrap = el(doc, "div", "table-wrap card-like");
  const table = el(doc, "table", "compact");
  const head = el(doc, "tr");
  head.appendChild(el(doc, "th", null, "Month"));
  for (const name of names) head.appendChild(el(doc, "th", "num", name));
  head.appendChild(el(doc, "th", "num", "Total"));
  const thead = el(doc, "thead");
  thead.appendChild(head);
  table.appendChild(thead);
  const body = el(doc, "tbody");
  for (const row of rows) {
    const tr = el(doc, "tr");
    tr.appendChild(el(doc, "td", null, row.period));
    for (const name of names) tr.appendChild(el(doc, "td", "num", row.bySource[name] === undefined ? "—" : formatUsd(row.bySource[name])));
    tr.appendChild(el(doc, "td", "num", formatUsd(row.total)));
    body.appendChild(tr);
  }
  table.appendChild(body);
  wrap.appendChild(table);
  host.appendChild(wrap);
}

export function renderGalaxyLine(doc, host, output) {
  clear(host);
  if (output instanceof Error) {
    host.appendChild(el(doc, "p", "warn-text", `Data unavailable: the live Atlas Kit read failed (${output.message}).`));
    return;
  }
  const systems = typeof output?.total === "number" ? output.total : null;
  const starbases = typeof output?.activity?.starbaseCount === "number" ? output.activity.starbaseCount : null;
  if (systems === null) {
    host.appendChild(el(doc, "p", "warn-text", "Data unavailable: the Atlas Kit read returned no system count."));
    return;
  }
  const sample = output.truncated && starbases !== null ? ` Starbases counted in the first ${output.limit ?? starbases} systems: ${starbases}.` : starbases !== null ? ` Starbases: ${starbases}.` : "";
  host.appendChild(el(doc, "p", "hint", `Live through Atlas Kit on the z.ink test realm: ${systems} star systems.${sample}`));
}

export function renderToolCount(doc, host, listed) {
  clear(host);
  if (listed instanceof Error) {
    host.appendChild(el(doc, "p", "warn-text", `Data unavailable: tools/list failed (${listed.message}).`));
    return;
  }
  host.appendChild(el(doc, "p", "hint", `Live: this node serves ${listed.length} read-only tools right now.`));
}

function bindC4(doc) {
  const button = doc.getElementById("c4-load");
  const frameHost = doc.getElementById("c4-frame");
  if (!button || !frameHost) return;
  button.addEventListener("click", () => {
    if (frameHost.firstChild) return;
    const frame = doc.createElement("iframe");
    frame.setAttribute("src", C4_LIVE_URL);
    frame.setAttribute("title", "C4 Live 3D galaxy view");
    frame.setAttribute("loading", "lazy");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.className = "c4-frame";
    frameHost.appendChild(frame);
    button.hidden = true;
  });
}

export async function bindHome(doc, env = {}) {
  const view = env.view ?? doc.defaultView ?? globalThis;
  const client = createClient(env.fetch ?? view.fetch.bind(view), env.location ?? view.location);
  const heading = doc.getElementById("featured-heading");
  if (heading) heading.textContent = FEATURED_HEADING;
  bindC4(doc);
  try {
    await client.rpc("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "dao-portal", version: "0" } });
    await client.rpc("notifications/initialized", undefined, true);
  } catch {
    // A stateless server still answers each call on its own.
  }
  const call = async (name, args) => {
    try {
      return callOutput(await client.rpc("tools/call", { name, arguments: args }));
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };
  const list = async () => {
    try {
      const message = await client.rpc("tools/list", {});
      if (message.error) throw new Error(String(message.error.message ?? "tools/list failed"));
      return Array.isArray(message.result?.tools) ? message.result.tools : [];
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };
  const [revenue, galaxy, listed, balances, limit] = await Promise.all([
    call("dao_revenue", {}),
    call("galaxy_overview", { limit: 500 }),
    list(),
    call("treasury_balances", {}),
    call("ecofund_limit", {}),
  ]);
  const at = (id) => doc.getElementById(id);
  if (at("revenue-host")) renderRevenue(doc, at("revenue-host"), revenue);
  if (at("atlas-kit-live")) renderGalaxyLine(doc, at("atlas-kit-live"), galaxy);
  if (at("playground-live")) renderToolCount(doc, at("playground-live"), listed);
  if (at("treasury-host")) renderTreasury(doc, at("treasury-host"), balances, limit);
  return { revenue, galaxy, listed, balances, limit };
}

if (globalThis.document && globalThis.document.getElementById("revenue-host")) {
  bindHome(globalThis.document).catch(() => {});
}
