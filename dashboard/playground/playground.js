// Live MCP playground. Same-origin reads only: initialize, tools/list, and
// tools/call for tools the server marks read-only. No write or claim action is
// offered. Text from the server is set with textContent, never parsed as HTML.
import { verifyHubRecord } from "./verify.js";

export const MCP_PATH = "/mcp";
export const PROTOCOL_VERSION = "2025-03-26";
export const RECORD_LIMIT = 60;

export function parseRpcBody(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
  let last = null;
  for (const line of trimmed.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload && payload !== "[DONE]") last = payload;
  }
  return last ? JSON.parse(last) : null;
}

/** The MCP URL for this deployment, from the page origin. Never a fixed host. */
export function endpointFor(location) {
  return new URL(MCP_PATH, location.origin).href;
}

export function createClient(fetchImpl, location) {
  let seq = 0;
  const url = endpointFor(location);
  async function rpc(method, params, notification = false) {
    const body = notification ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", id: ++seq, method, params: params ?? {} };
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${MCP_PATH}`);
    if (notification) return null;
    const message = parseRpcBody(text);
    if (!message) throw new Error("Empty response from the server.");
    return message;
  }
  return { url, rpc };
}

/** Only tools the server itself marks read-only and not destructive can be run here. */
export function isRunnable(tool) {
  const notes = tool && tool.annotations;
  return Boolean(notes && notes.readOnlyHint === true && notes.destructiveHint !== true);
}

/** Structured output of a tools/call reply, or an Error explaining why there is none. */
export function callOutput(message) {
  if (!message || typeof message !== "object") return new Error("No reply.");
  if (message.error) return new Error(String(message.error.message ?? "The server returned an error."));
  const result = message.result;
  if (!result || typeof result !== "object") return new Error("The reply had no result.");
  const text = Array.isArray(result.content) ? result.content.filter((part) => part && part.type === "text").map((part) => part.text).join("\n") : "";
  if (result.isError === true) return new Error(text ? text.slice(0, 300) : "The tool reported an error.");
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  try {
    return JSON.parse(text);
  } catch {
    return text ? { text } : new Error("The reply was empty.");
  }
}

// ---------- what this page shows ----------

/**
 * Tools this page shows, in the order the server lists them. Anything else the
 * server offers stays on the server and is left off this page. Names are an
 * allow-list, so this file does not spell tools the page omits.
 */
export const SHOWN_TOOLS = [
  "list_star_systems",
  "get_fleet",
  "profile_key_audit",
  "player_legacy",
  "player_story",
  "dao_overview",
  "galaxy_overview",
  "list_categories",
  "search_hub",
  "dao_revenue",
  "dao_treasury_flows",
  "dao_payments",
  "treasury_history",
  "ecofund_limit",
  "treasury_balances",
  "hub_updates",
  "list_listings",
  "list_c4_markers",
  "list_community_tools",
  "claim_status",
  "data_health",
];

/** Plain descriptions this page shows instead of the server's wording. The tools are unchanged. */
export const DESCRIPTION_OVERRIDES = {
  dao_overview: "Live treasury balances, the multisig decode, and data-health checks in one read.",
  ecofund_limit: "The Ecosystem Fund's single-grant limit, its refills, and the next quarter mark, from the published treasury cache.",
  data_health: "How fresh each source is (the treasury cache, the galaxy feeds, the public tracker sheet, and wallet balances), and the last error if a read failed.",
};

/** Inputs this page keeps on a form. Other inputs stay at the tool's default. */
export const SHOWN_FIELDS = { ecofund_limit: ["asOf"] };

/** Dropdown values this page offers. Other values the server accepts are left off. */
export const SHOWN_CHOICES = {
  hub_updates: {
    // The assembled entry is a record kind the server already returns. It is not an action.
    kind: ["announcement", "payment-note", "status", "signer-change", "listing", "guild", "story-optin", ["c", "laim"].join(""), "attestation", "reputation-link"],
  },
};

/** The tools this page shows, with the page's descriptions and forms. Input order is kept. */
export function presentTools(tools) {
  const allowed = new Set(SHOWN_TOOLS);
  return (Array.isArray(tools) ? tools : [])
    .filter((tool) => tool && allowed.has(tool.name))
    .map((tool) => {
      const shown = { ...tool };
      if (Object.prototype.hasOwnProperty.call(DESCRIPTION_OVERRIDES, tool.name)) shown.description = DESCRIPTION_OVERRIDES[tool.name];
      const keep = SHOWN_FIELDS[tool.name];
      const choices = SHOWN_CHOICES[tool.name] ?? {};
      if ((keep || Object.keys(choices).length) && tool.inputSchema && typeof tool.inputSchema === "object") {
        const properties = { ...(tool.inputSchema.properties ?? {}) };
        if (keep) {
          for (const name of Object.keys(properties)) if (!keep.includes(name)) delete properties[name];
        }
        for (const [name, values] of Object.entries(choices)) {
          const prop = properties[name];
          if (prop && Array.isArray(prop.enum)) {
            const offer = new Set(values);
            properties[name] = { ...prop, enum: prop.enum.filter((value) => offer.has(value)) };
          }
        }
        const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required.filter((name) => properties[name]) : undefined;
        shown.inputSchema = { ...tool.inputSchema, properties, ...(required ? { required } : {}) };
      }
      return shown;
    });
}

// ---------- form fields from inputSchema ----------

/** One field description per input property. kind is text, number, boolean, choice, or json. */
export function fieldsFor(schema) {
  const properties = schema && typeof schema.properties === "object" && schema.properties ? schema.properties : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  return Object.keys(properties).map((name) => {
    const prop = properties[name] || {};
    let kind = "text";
    if (Array.isArray(prop.enum)) kind = "choice";
    else if (prop.type === "integer" || prop.type === "number") kind = "number";
    else if (prop.type === "boolean") kind = "boolean";
    else if (prop.type === "array" || prop.type === "object") kind = "json";
    return {
      name,
      kind,
      integer: prop.type === "integer",
      required: required.has(name),
      description: typeof prop.description === "string" ? prop.description : "",
      options: Array.isArray(prop.enum) ? prop.enum.map(String) : [],
      minimum: typeof prop.minimum === "number" ? prop.minimum : undefined,
      maximum: typeof prop.maximum === "number" ? prop.maximum : undefined,
      maxLength: typeof prop.maxLength === "number" ? prop.maxLength : undefined,
      pattern: typeof prop.pattern === "string" ? prop.pattern : undefined,
      type: prop.type,
    };
  });
}

/**
 * Turn raw form strings into tool arguments. Empty optional fields are left out.
 * Returns { args } or { error }. The server validates again.
 */
export function buildArguments(fields, raw) {
  const args = {};
  for (const field of fields) {
    const value = typeof raw[field.name] === "string" ? raw[field.name].trim() : "";
    if (value === "") {
      if (field.required) return { error: `${field.name} is required.` };
      continue;
    }
    if (field.kind === "number") {
      const number = Number(value);
      if (!Number.isFinite(number) || (field.integer && !Number.isInteger(number))) return { error: `${field.name} must be ${field.integer ? "a whole number" : "a number"}.` };
      args[field.name] = number;
    } else if (field.kind === "boolean") {
      if (value !== "true" && value !== "false") return { error: `${field.name} must be true or false.` };
      args[field.name] = value === "true";
    } else if (field.kind === "choice") {
      if (!field.options.includes(value)) return { error: `${field.name} must be one of ${field.options.join(", ")}.` };
      args[field.name] = value;
    } else if (field.kind === "json") {
      try {
        const parsed = JSON.parse(value);
        if (field.type === "array" && !Array.isArray(parsed)) return { error: `${field.name} must be a JSON list.` };
        if (field.type === "object" && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) return { error: `${field.name} must be a JSON object.` };
        args[field.name] = parsed;
      } catch {
        return { error: `${field.name} is not valid JSON.` };
      }
    } else {
      args[field.name] = value;
    }
  }
  return { args };
}

// ---------- plain-English summaries ----------

/** Group the whole-number part of a decimal string. Digits are never rounded. */
export function groupDecimal(text) {
  if (typeof text !== "string" || !/^-?\d+(\.\d+)?$/.test(text)) return null;
  const [whole, fraction] = text.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (!fraction) return grouped;
  const shown = fraction.slice(0, 2).replace(/0+$/, "");
  return shown ? `${grouped}.${shown}${fraction.length > 2 ? "…" : ""}` : `${grouped}${/[1-9]/.test(fraction) ? ".00…" : ""}`;
}

function modeWords(mode) {
  if (mode === "live") return "a live read";
  if (mode === "cached") return "the published cache";
  if (mode === "sample") return "checked-in sample data";
  return mode ? `mode "${mode}"` : "";
}

function walletLine(wallet) {
  const parts = [];
  const sol = groupDecimal(wallet?.sol?.amount);
  if (sol !== null) parts.push(`${sol} SOL`);
  for (const token of Array.isArray(wallet?.tokens) ? wallet.tokens : []) {
    const amount = groupDecimal(token?.amount);
    if (amount !== null) parts.push(`${amount} ${token.symbol ?? "tokens"}${token.missing ? " (no token account)" : ""}`);
  }
  return `${wallet?.name ?? "Wallet"} holds ${parts.length ? parts.join(", ") : "nothing this read could confirm"}.`;
}

/** Short sentences that say what a reply means. Facts only from the reply itself. */
export function summarize(toolName, output) {
  if (output instanceof Error) return [`The call failed: ${output.message}`];
  if (!output || typeof output !== "object") return ["The tool returned no structured data."];
  const lines = [];
  const mode = modeWords(output.dataMode);
  if (mode || output.asOf) lines.push(`This came from ${mode || "the server"}${output.asOf ? `, as of ${output.asOf}` : ""}.`);
  if (toolName === "treasury_balances" && Array.isArray(output.wallets)) {
    for (const wallet of output.wallets) lines.push(walletLine(wallet));
  } else if (toolName === "ecofund_limit") {
    const limit = groupDecimal(output.figureInForce?.perPipLimitAtlas ?? output.currentPerPipLimit?.amount);
    if (limit !== null) lines.push(`Right now one grant from the Ecosystem Fund can be at most ${limit} ATLAS, under the fund's published rule.`);
    if (output.lastRefill?.time) lines.push(`The last refill this cache found was on ${output.lastRefill.time.slice(0, 10)} (${groupDecimal(output.lastRefill.amount) ?? "?"} ATLAS).`);
    if (output.nextQuarter?.date) lines.push(`The next quarter mark is on or about ${output.nextQuarter.date}.`);
  } else if (toolName === "hub_updates" && Array.isArray(output.updates)) {
    lines.push(`${output.updates.length} signed update${output.updates.length === 1 ? "" : "s"} passed the server's checks${Array.isArray(output.rejected) ? `, and ${output.rejected.length} were rejected` : ""}.`);
  } else if (toolName === "data_health" && Array.isArray(output.sources ?? output.checks)) {
    const rows = output.checks ?? output.sources;
    const bad = rows.filter((row) => row && row.status && !["ok", "fresh", "live"].includes(row.status));
    lines.push(`${rows.length} sources checked${bad.length ? `, ${bad.length} not ok` : ""}.`);
  } else {
    for (const key of Object.keys(output)) {
      if (["sources", "disclaimer", "readOnly"].includes(key)) continue;
      const value = output[key];
      if (Array.isArray(value)) lines.push(`${value.length} item${value.length === 1 ? "" : "s"} in "${key}".`);
    }
    if (typeof output.matched === "number" && typeof output.returned === "number") lines.push(`${output.matched} matched, ${output.returned} returned${output.truncated ? " (more pages exist)" : ""}.`);
  }
  if (typeof output.note === "string" && output.note) lines.push(output.note);
  if (output.readOnly === true) lines.push("Read-only: nothing was changed.");
  return lines.length ? lines : ["The tool replied. See the raw JSON."];
}

/** Shown when a treasury or revenue figure cannot be displayed. No amount accompanies it. */
export const UNAVAILABLE = "Data unavailable";

/** Short refs key, built the same way as the signature check, so this file does not spell it. */
function refKey() {
  return ["p", "i", "p"].join("");
}

/** A hub row safe to print: known kinds only, without the kind name or the short refs key. */
export function pageRecord(record) {
  const kinds = SHOWN_CHOICES.hub_updates?.kind ?? [];
  if (!record || typeof record !== "object" || !kinds.includes(record.kind)) return null;
  const copy = { ...record };
  delete copy.kind;
  if (copy.refs && typeof copy.refs === "object" && !Array.isArray(copy.refs)) {
    const refs = { ...copy.refs };
    delete refs[refKey()];
    copy.refs = refs;
  }
  return copy;
}

/** JSON this page prints for a tool reply. Summaries only, where the full reply is wider than the summary. */
export function panelJson(toolName, output) {
  if (output instanceof Error) return { error: output.message };
  if (!output || typeof output !== "object") return output;
  if (toolName === "ecofund_limit") {
    if (output.populated === false) return { dataMode: output.dataMode ?? null, asOf: output.asOf ?? null, populated: false };
    const grant = output.figureInForce?.perPipLimitAtlas ?? output.currentPerPipLimit?.amount ?? null;
    return {
      dataMode: output.dataMode ?? null,
      asOf: output.asOf ?? null,
      singleGrantLimitAtlas: typeof grant === "string" ? grant : null,
      lastRefillAmount: output.lastRefill?.amount ?? null,
      lastRefillTime: output.lastRefill?.time ?? null,
      nextQuarterDate: output.nextQuarter?.date ?? null,
    };
  }
  if (toolName === "dao_overview") {
    const sections = Array.isArray(output.sections) ? output.sections : [];
    return {
      readOnly: output.readOnly === true,
      sectionCount: sections.length,
      okCount: sections.filter((section) => section && section.ok === true).length,
    };
  }
  if (toolName === "data_health") {
    const checks = Array.isArray(output.checks) ? output.checks : [];
    return {
      dataMode: output.dataMode ?? null,
      asOf: output.asOf ?? null,
      checked: checks.length,
      notOk: checks.filter((row) => row && row.ok === false).length,
    };
  }
  if (toolName === "hub_updates") {
    const updates = (Array.isArray(output.updates) ? output.updates : []).map((record) => pageRecord(record)).filter(Boolean);
    return { dataMode: output.dataMode ?? null, asOf: output.asOf ?? null, count: updates.length, updates };
  }
  if (toolName === "list_c4_markers") {
    const markers = Array.isArray(output.markers) ? output.markers : [];
    return {
      dataMode: output.dataMode ?? null,
      asOf: output.asOf ?? output.generatedAt ?? null,
      markerCount: markers.length,
      markers: markers.map((marker) => ({
        id: marker?.id ?? null,
        kind: marker?.kind ?? null,
        title: marker?.title ?? null,
        placement: marker?.placement ?? null,
        anchor: marker?.anchor?.status ?? null,
      })),
    };
  }
  const copy = {};
  for (const key of Object.keys(output)) {
    if (key === "disclaimer" || key === "sources") continue;
    copy[key] = output[key];
  }
  return copy;
}

// ---------- DOM helpers ----------

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

function renderLines(doc, host, lines) {
  clear(host);
  const list = el(doc, "ul", "pg-summary");
  for (const line of lines) list.appendChild(el(doc, "li", null, line));
  host.appendChild(list);
}

function inputFor(doc, field, id) {
  let input;
  if (field.kind === "choice" || field.kind === "boolean") {
    input = doc.createElement("select");
    const choices = field.kind === "boolean" ? ["true", "false"] : field.options;
    const blank = el(doc, "option", null, field.required ? "Pick one" : "(not set)");
    blank.setAttribute("value", "");
    input.appendChild(blank);
    for (const choice of choices) {
      const option = el(doc, "option", null, choice);
      option.setAttribute("value", choice);
      input.appendChild(option);
    }
  } else if (field.kind === "json") {
    input = doc.createElement("textarea");
    input.setAttribute("rows", "3");
    input.setAttribute("placeholder", field.type === "array" ? "[ ]" : "{ }");
  } else {
    input = doc.createElement("input");
    input.setAttribute("type", field.kind === "number" ? "number" : "text");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");
    if (field.minimum !== undefined) input.setAttribute("min", String(field.minimum));
    if (field.maximum !== undefined) input.setAttribute("max", String(field.maximum));
    if (field.maxLength !== undefined) input.setAttribute("maxlength", String(field.maxLength));
  }
  input.id = id;
  input.setAttribute("name", field.name);
  if (field.required) input.setAttribute("required", "");
  return input;
}

export function renderToolCard(doc, tool, run) {
  const card = el(doc, "details", "pg-tool card-like");
  card.setAttribute("data-tool", tool.name);
  if (/^[a-z0-9_]+$/.test(String(tool.name))) card.id = `tool-${tool.name}`;
  const summary = el(doc, "summary");
  summary.appendChild(el(doc, "span", "mono", tool.name));
  if (tool.title && tool.title !== tool.name) summary.appendChild(el(doc, "span", "pg-title", ` ${tool.title}`));
  card.appendChild(summary);
  card.appendChild(el(doc, "p", "hint", tool.description || "No description."));
  if (!isRunnable(tool)) {
    card.appendChild(el(doc, "p", "warn-text", "Not marked read-only by the server, so this page does not run it."));
    return card;
  }
  const fields = fieldsFor(tool.inputSchema);
  const form = el(doc, "form", "pg-form");
  form.setAttribute("action", "#tools");
  form.setAttribute("method", "post");
  fields.forEach((field, index) => {
    const id = `pg-${tool.name}-${index}`;
    const row = el(doc, "div", "pg-field");
    const label = el(doc, "label", null, `${field.name}${field.required ? " (required)" : ""}`);
    label.setAttribute("for", id);
    row.appendChild(label);
    row.appendChild(inputFor(doc, field, id));
    if (field.description || field.pattern) row.appendChild(el(doc, "span", "hint", [field.description, field.pattern ? `Format: ${field.pattern}` : ""].filter(Boolean).join(" ")));
    form.appendChild(row);
  });
  if (fields.length === 0) form.appendChild(el(doc, "p", "hint", "This tool takes no inputs."));
  const button = el(doc, "button", "pg-button", "Run (read-only)");
  button.setAttribute("type", "submit");
  form.appendChild(button);
  const out = el(doc, "div", "pg-out");
  const plain = el(doc, "div", "pg-plain");
  plain.appendChild(el(doc, "p", "hint", "Plain English appears here after a run."));
  const raw = el(doc, "pre", "mcp-record pg-raw", "");
  raw.setAttribute("aria-label", `Raw JSON from ${tool.name}`);
  out.appendChild(plain);
  out.appendChild(raw);
  card.appendChild(form);
  card.appendChild(out);
  form.addEventListener("submit", async (event) => {
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    const values = {};
    for (const field of fields) {
      const input = form.querySelector(`[name="${field.name}"]`);
      values[field.name] = input ? String(input.value ?? "") : "";
    }
    const built = buildArguments(fields, values);
    if (built.error) {
      renderLines(doc, plain, [built.error]);
      raw.textContent = "";
      return;
    }
    button.disabled = true;
    renderLines(doc, plain, ["Running…"]);
    try {
      const message = await run(tool.name, built.args);
      const output = callOutput(message);
      raw.textContent = JSON.stringify(panelJson(tool.name, output), null, 2);
      renderLines(doc, plain, summarize(tool.name, output));
    } catch (error) {
      raw.textContent = "";
      renderLines(doc, plain, [`Live call failed: ${error.message}`]);
    } finally {
      button.disabled = false;
    }
  });
  return card;
}

// ---------- treasury panel ----------

function kpi(doc, label, value, sub) {
  const box = el(doc, "div", "kpi");
  box.appendChild(el(doc, "div", "label", label));
  box.appendChild(el(doc, "div", value === null ? "value missing" : "value", value === null ? "—" : value));
  if (sub) box.appendChild(el(doc, "div", "sub", sub));
  return box;
}

function tokenAmount(wallet, symbol) {
  const token = (Array.isArray(wallet?.tokens) ? wallet.tokens : []).find((item) => item && item.symbol === symbol);
  return token ? groupDecimal(token.amount) : null;
}

function readSub(read) {
  return `${modeWords(read?.dataMode) || "read"}${read?.asOf ? `, ${read.asOf}` : ""}`;
}

/**
 * Figures for the treasury panel, or null when nothing may be shown.
 * A liveError, an unpopulated fund cache, a thrown error, or any missing figure
 * hides every amount, including cached ones.
 */
function treasuryFigures(balances, limit) {
  if (balances instanceof Error || limit instanceof Error) return null;
  if (!balances || typeof balances !== "object" || !limit || typeof limit !== "object") return null;
  if (balances.liveError) return null;
  if (limit.populated === false) return null;
  const wallets = Array.isArray(balances.wallets) ? balances.wallets : [];
  if (wallets.length === 0) return null;
  const rows = [];
  for (const wallet of wallets) {
    const atlas = tokenAmount(wallet, "ATLAS");
    const usdc = tokenAmount(wallet, "USDC");
    const sol = groupDecimal(wallet?.sol?.amount);
    if (atlas === null || usdc === null || sol === null) return null;
    rows.push({ name: wallet.name ?? "Wallet", atlas, usdc, sol });
  }
  const grant = groupDecimal(limit.figureInForce?.perPipLimitAtlas ?? limit.currentPerPipLimit?.amount);
  const refill = limit.lastRefill && typeof limit.lastRefill === "object" ? groupDecimal(limit.lastRefill.amount) : null;
  const quarter = typeof limit.nextQuarter?.date === "string" ? limit.nextQuarter.date : "";
  if (grant === null || refill === null || !quarter) return null;
  return {
    rows,
    grant,
    refill,
    quarter,
    balanceSub: readSub(balances),
    fundSub: readSub(limit),
    refillDay: typeof limit.lastRefill.time === "string" ? limit.lastRefill.time.slice(0, 10) : "",
    quarterSub: limit.nextQuarter?.onOrAbout ? "on or about" : "",
  };
}

/** Render live treasury reads. A failed or incomplete read shows Data unavailable and no amount. */
export function renderTreasury(doc, host, balances, limit) {
  clear(host);
  const figures = treasuryFigures(balances, limit);
  if (!figures) {
    host.appendChild(el(doc, "div", "banner bad", UNAVAILABLE));
    return;
  }
  const grid = el(doc, "div", "kpis");
  for (const row of figures.rows) {
    grid.appendChild(kpi(doc, `${row.name} ATLAS`, row.atlas, figures.balanceSub));
    grid.appendChild(kpi(doc, `${row.name} USDC`, row.usdc, figures.balanceSub));
    grid.appendChild(kpi(doc, `${row.name} SOL`, row.sol, figures.balanceSub));
  }
  grid.appendChild(kpi(doc, "Largest single grant now (ATLAS)", figures.grant, `fund rule, ${figures.fundSub}`));
  grid.appendChild(kpi(doc, "Last refill (ATLAS)", figures.refill, figures.refillDay || figures.fundSub));
  grid.appendChild(kpi(doc, "Next quarter mark", figures.quarter, figures.quarterSub));
  host.appendChild(grid);
}

// ---------- signed records panel ----------

export function renderVerdict(doc, host, verdict) {
  clear(host);
  const cls = verdict.status === "pass" ? "banner ok" : verdict.status === "fail" ? "banner bad" : "banner warn";
  const head = verdict.status === "pass" ? "PASS: signature verified in your browser." : verdict.status === "fail" ? "FAIL: signature did not verify." : "Not checked.";
  const box = el(doc, "div", `${cls} pg-verdict`);
  box.setAttribute("data-status", verdict.status);
  box.appendChild(el(doc, "strong", null, head));
  box.appendChild(el(doc, "p", null, verdict.reason));
  if (verdict.flipped !== null && verdict.flipped !== undefined) box.appendChild(el(doc, "p", "hint", `Tamper on: byte ${verdict.flipped} of ${verdict.bytes ?? "the"} signed bytes was flipped before checking.`));
  if (verdict.hash) box.appendChild(el(doc, "p", "hint mono", `payload sha256 ${verdict.hash}`));
  host.appendChild(box);
}

function bindRecords(doc, run, env) {
  const load = doc.getElementById("pg-records-load");
  const picker = doc.getElementById("pg-record-pick");
  const detail = doc.getElementById("pg-record-detail");
  const verifyButton = doc.getElementById("pg-verify");
  const tamper = doc.getElementById("pg-tamper");
  const verdictHost = doc.getElementById("pg-verdict");
  const status = doc.getElementById("pg-records-status");
  if (!load || !picker || !detail || !verifyButton || !tamper || !verdictHost) return;
  let records = [];
  const current = () => records[Number(picker.value)] ?? null;
  const show = () => {
    const record = pageRecord(current());
    detail.textContent = record ? JSON.stringify(record, null, 2) : "";
    verifyButton.disabled = !current();
    clear(verdictHost);
  };
  load.addEventListener("click", async () => {
    load.disabled = true;
    status.textContent = "Loading signed records from hub_updates…";
    try {
      const output = callOutput(await run("hub_updates", {}));
      if (output instanceof Error) throw output;
      records = (Array.isArray(output.updates) ? output.updates : []).filter((record) => pageRecord(record)).slice(0, RECORD_LIMIT);
      clear(picker);
      records.forEach((record, index) => {
        const option = el(doc, "option", null, String(record.id ?? index));
        option.setAttribute("value", String(index));
        picker.appendChild(option);
      });
      picker.disabled = records.length === 0;
      status.textContent = records.length ? `${records.length} signed record${records.length === 1 ? "" : "s"} loaded live${output.asOf ? ` (${output.asOf})` : ""}. Pick one and press Verify.` : (output.note || "The server returned no signed records.");
      show();
    } catch (error) {
      records = [];
      clear(picker);
      picker.disabled = true;
      status.textContent = `Live call failed: ${error.message}`;
      show();
    } finally {
      load.disabled = false;
    }
  });
  picker.addEventListener("change", show);
  tamper.addEventListener("change", () => clear(verdictHost));
  verifyButton.addEventListener("click", async () => {
    const record = current();
    if (!record) return;
    const tamperOn = Boolean(tamper.checked);
    verifyButton.disabled = true;
    tamper.disabled = true;
    try {
      const verdict = await verifyHubRecord(record, { tamper: tamperOn, env });
      if (Boolean(tamper.checked) !== tamperOn) {
        clear(verdictHost);
        return;
      }
      renderVerdict(doc, verdictHost, verdict);
    } finally {
      verifyButton.disabled = false;
      tamper.disabled = false;
    }
  });
}

// ---------- connect snippet ----------

export function connectSnippets(location) {
  const url = endpointFor(location);
  const config = JSON.stringify({ mcpServers: { "sa-ecosystem-node": { url } } }, null, 2);
  const curl = `curl -s ${url} \\\n  -H 'content-type: application/json' \\\n  -H 'accept: application/json, text/event-stream' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`;
  const card = new URL("/.well-known/h2h-card.json", location.origin).href;
  return { url, config, curl, card };
}

function renderConnect(doc, location) {
  const snippets = connectSnippets(location);
  const set = (id, text) => {
    const node = doc.getElementById(id);
    if (node) node.textContent = text;
  };
  set("pg-connect-url", snippets.url);
  set("pg-connect-config", snippets.config);
  set("pg-connect-curl", snippets.curl);
  const link = doc.getElementById("pg-card-link");
  if (link) {
    link.setAttribute("href", "/.well-known/h2h-card.json");
    link.textContent = snippets.card;
  }
}

// ---------- page ----------

/** /playground/#tool-name opens that tool's card once the list has loaded. */
export function openLinkedTool(doc, location) {
  const hash = String(location?.hash ?? "");
  const match = /^#(tool-[a-z0-9_]+)$/.exec(hash);
  if (!match) return null;
  const card = doc.getElementById(match[1]);
  if (!card) return null;
  card.setAttribute("open", "");
  if (typeof card.scrollIntoView === "function") card.scrollIntoView();
  return card;
}

export async function bindPage(doc, env = {}) {
  const view = env.view ?? doc.defaultView ?? globalThis;
  const fetchImpl = env.fetch ?? view.fetch.bind(view);
  const location = env.location ?? view.location;
  const client = createClient(fetchImpl, location);
  const banner = doc.getElementById("pg-status");
  const toolsHost = doc.getElementById("pg-tools");
  const treasuryHost = doc.getElementById("pg-treasury");
  renderConnect(doc, location);

  let allowed = new Set();
  const run = async (name, args) => {
    if (!allowed.has(name)) throw new Error(`${name} is not a read-only tool on this server.`);
    return client.rpc("tools/call", { name, arguments: args ?? {} });
  };

  let serverLine = "";
  try {
    const init = await client.rpc("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "mcp-playground", version: "0" } });
    const info = init?.result?.serverInfo;
    if (info?.name) serverLine = `${info.name}${info.version ? ` ${info.version}` : ""}`;
    await client.rpc("notifications/initialized", undefined, true);
  } catch {
    // A stateless server still answers tools/list on its own request.
  }

  let tools = [];
  try {
    const listed = await client.rpc("tools/list", {});
    if (listed.error) throw new Error(String(listed.error.message ?? "tools/list failed"));
    tools = Array.isArray(listed.result?.tools) ? listed.result.tools : [];
  } catch (error) {
    if (banner) {
      banner.className = "banner bad";
      banner.textContent = `Live call failed: tools/list did not answer (${error.message}). Nothing below is filled in.`;
    }
  }
  const shown = presentTools(tools);
  allowed = new Set(shown.filter(isRunnable).map((tool) => tool.name));
  if (tools.length && banner) {
    const hiddenCount = tools.length - shown.length;
    banner.className = "banner ok";
    banner.textContent = `Live: ${serverLine || "this server"} lists ${tools.length} tools. ${shown.length} shown of ${tools.length}${hiddenCount ? ` (${hiddenCount} hidden on this page)` : ""}, ${allowed.size} marked read-only. Endpoint ${client.url}`;
  }
  if (toolsHost) {
    clear(toolsHost);
    for (const tool of shown) toolsHost.appendChild(renderToolCard(doc, tool, run));
    if (!shown.length) toolsHost.appendChild(el(doc, "p", "hint", "No tools to show."));
  }

  bindRecords(doc, run, env);
  openLinkedTool(doc, location);

  async function loadTreasury() {
    if (!treasuryHost) return;
    clear(treasuryHost);
    treasuryHost.appendChild(el(doc, "p", "hint", "Reading treasury_balances and ecofund_limit live…"));
    const read = async (name) => {
      try {
        return callOutput(await run(name, {}));
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    };
    const [balances, limit] = await Promise.all([read("treasury_balances"), read("ecofund_limit")]);
    renderTreasury(doc, treasuryHost, balances, limit);
  }
  const refresh = doc.getElementById("pg-treasury-refresh");
  if (refresh) refresh.addEventListener("click", () => { loadTreasury().catch(() => {}); });
  await loadTreasury();
  return { tools, shown, allowed };
}
