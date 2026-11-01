/* Star Atlas DAO Dashboard preview. Static, client-side only. Reads the public Council sheet and the public Solana RPC. */
(function () {
  "use strict";
  var cfg = window.SA_DASHBOARD_CONFIG || {};
  var HEADER_ROW_MARK = "PIP Name";

  /* Tracker column names, whitespace-normalized exactly as the sheet header reads. */
  var C = {
    phase: "PIP Phase",
    start: "Voted Started",
    end: "Vote Ended",
    pip: "PIP",
    name: "PIP Name",
    amount: "Amount",
    type: "Type",
    roi: "DAO ROI What did it accomplish?",
    ecoFund: "Ecosystem Fund?",
    result: "Vote Result",
    votes: "# of Votes",
    pvp: "PVP Voted (M)",
    part: "PVP Participation",
    totalPvp: "Total PVP (M)",
    yes: "Yes",
    no: "No",
    abstain: "Abstain",
    category: "Category",
    term: "SAC Term",
    note: "Note",
    usdcPaid: "Total Amount Paid (USDC)",
    usdcLeft: "Total Amount Left (USDC)",
    atlasPaid: "Total Amount Paid (ATLAS)",
    atlasLeft: "Total Amount Left (ATLAS)",
    msDone: "Completed Milestones",
    msTotal: "Total Payment Milestones"
  };

  var state = { sheetDone: false, walletsPending: 0, usd: { on: false, prices: null, error: null, asOf: null }, health: [] };
  var ecoAtlas = null;

  function $(id) { return document.getElementById(id); }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function q(name) { return "\u2018" + name + "\u2019"; }

  function markReady() {
    if (state.sheetDone && state.walletsPending === 0) document.body.setAttribute("data-ready", "1");
  }

  function noteHealth(row) {
    state.health = state.health.filter(function (item) { return item.source !== row.source; }).concat([row]);
    renderHealth();
  }

  function friendlyWhen(iso) {
    if (!iso) return "\u2014";
    var relative = ago(iso);
    if (relative) return relative;
    var then = Date.parse(iso);
    if (Number.isNaN(then)) return "\u2014";
    return new Date(then).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  }

  function friendlyStatus(status) {
    if (status === "not_requested") return "not checked";
    return String(status || "\u2014").replace(/_/g, " ");
  }

  function plainDetail(text) {
    return String(text || "")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, function (iso) { return friendlyWhen(iso); })
      .replace(/\bnot_requested\b/g, "not checked")
      .replace(/\bnot_applicable\b/g, "not applicable")
      .replace(/\bcouncil_override\b/g, "Council figure")
      .replace(/\bunpaidPips\b/g, "unpaid PIPs")
      .replace(/\bsourceLabel\b/g, "source")
      .replace(/\b[a-z]{2,}(?:_[a-z0-9]+)+\b/g, function (word) { return word.replace(/_/g, " "); });
  }

  function renderHealth() {
    var host = $("health-host");
    if (!host) return;
    var body = state.health.map(function (row) {
      return "<tr><td>" + esc(row.source) + "</td><td>" + esc(friendlyStatus(row.status)) +
        "</td><td>" + esc(friendlyWhen(row.asOf)) + "</td><td>" + esc(plainDetail(row.detail)) + "</td></tr>";
    }).join("");
    host.innerHTML = '<div class="table-wrap card-like"><table class="compact"><thead><tr><th>Source</th><th>Status</th><th>Updated</th><th>Detail</th></tr></thead><tbody>' +
      (body || '<tr><td colspan="4"><span class="missing-mark">\u2014</span></td></tr>') + "</tbody></table></div>";
  }
  window.SA_DASHBOARD_HEALTH = noteHealth;

  function ago(iso) {
    if (!window.SA_DAO || !window.SA_DAO.updatedAgo || !iso) return "";
    return window.SA_DAO.updatedAgo(iso, Date.now());
  }

  function freshAgo(iso) {
    var relative = ago(iso);
    while (relative.indexOf("updated ") === 0) relative = relative.slice("updated ".length);
    return relative;
  }

  /* ---------- CSV ---------- */

  function csvUrl(sheetUrl) {
    var match = String(sheetUrl || "").match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!match) return null;
    var gid = cfg.trackerGid == null ? "" : "&gid=" + encodeURIComponent(cfg.trackerGid);
    return "https://docs.google.com/spreadsheets/d/" + match[1] + "/export?format=csv" + gid;
  }

  function parseCsv(text) {
    var rows = [], row = [], cell = "", inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
        } else cell += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else if (ch !== "\r") cell += ch;
    }
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  function norm(name) { return String(name || "").replace(/\s+/g, " ").trim(); }

  function findHeader(rows) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].some(function (c) { return norm(c) === HEADER_ROW_MARK; })) return i;
    }
    return -1;
  }

  function indexHeaders(header) {
    var map = {};
    header.forEach(function (name, i) { var k = norm(name); if (k && map[k] == null) map[k] = i; });
    return map;
  }

  function makeGetter(map) {
    return function (row, name) {
      var i = map[name];
      if (i == null || i >= row.length) return "";
      return row[i] == null ? "" : String(row[i]).trim();
    };
  }

  /* ---------- numbers ---------- */

  function parseNumber(raw) {
    var s = String(raw || "").trim();
    if (!s) return { empty: true };
    var percent = /%$/.test(s);
    var t = s.replace(/%/g, "").replace(/[$,\s]/g, "");
    if (!/^[-+]?\d+(\.\d+)?$/.test(t)) return { text: s };
    return { value: Number(t), percent: percent };
  }

  function fmt(n, digits) {
    if (n == null || Number.isNaN(n)) return "";
    return n.toLocaleString("en-US", { maximumFractionDigits: digits == null ? 2 : digits });
  }

  function isNA(s) { return /^n\/?a$/i.test(String(s).trim()); }

  function pipNum(s) { var m = String(s).match(/(\d+)/); return m ? Number(m[1]) : -1; }

  /* Sum/average a column. Empty cells and N/A are skipped quietly; "?" or other text is reported by PIP. */
  function summarize(rows, get, col) {
    var vals = [], odd = [], percent = false;
    rows.forEach(function (row) {
      var p = parseNumber(get(row, col));
      if (p.empty) return;
      if (p.text != null) { if (!isNA(p.text)) odd.push({ pip: get(row, C.pip) || get(row, C.name), raw: p.text }); return; }
      vals.push(p.value);
      if (p.percent) percent = true;
    });
    var sum = vals.reduce(function (a, b) { return a + b; }, 0);
    return { col: col, n: vals.length, sum: vals.length ? sum : null, avg: vals.length ? sum / vals.length : null, odd: odd, percent: percent };
  }

  function dash() { return '<span class="missing-mark">\u2014</span>'; }

  function excludedPips(summaries) {
    var seen = {}, out = [];
    summaries.forEach(function (s) {
      if (!s || !s.odd) return;
      s.odd.forEach(function (o) {
        var name = o && o.pip;
        if (!name || seen[name]) return;
        seen[name] = true;
        out.push(name);
      });
    });
    return out;
  }

  function excludeHtml(summaries) {
    var pips = excludedPips(summaries);
    if (!pips.length) return "";
    var label = pips.length > 8 ? pips.slice(0, 8).join(", ") + ", and " + (pips.length - 8) + " more" : pips.join(", ");
    return '<span class="exclude-note">(' + esc(label) + " left out: sheet value isn't a plain number)</span>";
  }

  function withNote(text, summaries) {
    var note = excludeHtml(summaries);
    if (!text) return note;
    if (!note) return text;
    return text + "<br>" + note;
  }

  /* ---------- cards ---------- */

  function kpi(o) {
    var cls = "kpi" + (o.cls ? " " + o.cls : "");
    var valueCls = "value" + (o.valueCls ? " " + o.valueCls : "");
    return '<article class="' + cls + '"' + (o.id ? ' id="' + o.id + '"' : "") + '>' +
      '<div class="label">' + esc(o.label) + "</div>" +
      '<div class="' + valueCls + '">' + o.value + "</div>" +
      (o.sub ? '<div class="sub">' + o.sub + "</div>" : "") +
      (o.fill ? '<div class="fill">' + o.fill + "</div>" : "") +
      "</article>";
  }

  function numValue(n, unit, digits) {
    return esc(fmt(n, digits)) + (unit ? ' <span class="unit">' + esc(unit) + "</span>" : "");
  }

  function amountHtml(text, unit) {
    var shown = text;
    var parsed = parseNumber(text);
    if (parsed.value != null) {
      var digits = unit === "ATLAS" ? 0 : Math.abs(parsed.value) >= 100 ? 2 : 6;
      shown = fmt(parsed.value, digits);
    }
    return esc(shown) + (unit ? '<span class="unit">' + esc(unit) + "</span>" : "");
  }

  function sumCard(label, s, unit, digits, what) {
    if (s.n === 0) {
      return kpi({ label: label, value: "\u2014", valueCls: "missing", sub: withNote(what, [s]) });
    }
    return kpi({ label: label, value: numValue(s.sum, unit, digits),
      sub: withNote(what + " " + esc(s.n + " PIP" + (s.n === 1 ? "" : "s") + " have a number."), [s]) });
  }

  function cellOut(raw, digits) {
    if (!raw || String(raw).trim() === "?") return dash();
    var p = parseNumber(raw);
    if (p.value != null && !p.percent) return esc(fmt(p.value, digits));
    return esc(raw);
  }

  function amountOut(get, row) {
    var a = get(row, C.amount), t = get(row, C.type);
    if (!a || a === "?") return dash();
    return cellOut(a, /atlas/i.test(t) ? 0 : 2) + (t ? " " + esc(t) : "");
  }

  function cleanName(name, pip) {
    var n = String(name || "");
    if (pip) n = n.replace(new RegExp("^" + pip.replace(/[-]/g, "\\-") + ":\\s*", "i"), "");
    return n;
  }

  function resultOut(get, row) {
    var r = get(row, C.result), phase = get(row, C.phase), html;
    if (/^passed$/i.test(r)) html = '<span class="status-box pass"><span class="status pass">Voting Complete \u00b7 Measure Passes</span></span>';
    else if (/^failed$/i.test(r)) html = '<span class="status-box fail"><span class="status fail">Voting Complete \u00b7 Measure Fails</span></span>';
    else if (r) html = '<span class="status none">' + esc(r) + "</span>";
    else html = dash();
    if (/withdrawn/i.test(phase)) html += '<div class="status withdrawn">Withdrawn (Tracker phase)</div>';
    else if (/closed/i.test(phase)) html += '<div class="status none">Tracker phase: Closed</div>';
    return html;
  }

  /* ---------- view 1: payments ---------- */

  function renderPayments(rows, get) {
    var usdcPaid = summarize(rows, get, C.usdcPaid);
    var usdcLeft = summarize(rows, get, C.usdcLeft);
    var atlasPaid = summarize(rows, get, C.atlasPaid);
    var atlasLeft = summarize(rows, get, C.atlasLeft);
    var msDone = summarize(rows, get, C.msDone);
    var msTotal = summarize(rows, get, C.msTotal);

    var msCard;
    var msNote = [msDone, msTotal];
    if (msDone.n === 0 && msTotal.n === 0) {
      msCard = kpi({ label: "Payment milestones done", value: "\u2014", valueCls: "missing", sub: excludeHtml(msNote) });
    } else {
      msCard = kpi({ label: "Payment milestones done",
        value: numValue(msDone.sum || 0, "of " + fmt(msTotal.sum || 0, 0), 0),
        sub: withNote(esc("Adds up " + q(C.msDone) + " (" + msDone.n + " PIPs) and " + q(C.msTotal) + " (" + msTotal.n + " PIPs). Includes non-funding PIPs the sheet marks 1 of 1."), msNote) });
    }

    $("payment-grid").innerHTML = [
      sumCard("USDC paid to PIP authors", usdcPaid, "USDC", 2, esc("Adds up " + q(C.usdcPaid) + ".")),
      sumCard("USDC still to pay", usdcLeft, "USDC", 2, esc("Adds up " + q(C.usdcLeft) + ".")),
      sumCard("ATLAS paid to PIP authors", atlasPaid, "ATLAS", 0, esc("Adds up " + q(C.atlasPaid) + ".")),
      sumCard("ATLAS still to pay", atlasLeft, "ATLAS", 0, esc("Adds up " + q(C.atlasLeft) + ".")),
      msCard
    ].join("");

    var funded = rows.filter(function (row) {
      var a = parseNumber(get(row, C.amount));
      return get(row, C.pip) && /^passed$/i.test(get(row, C.result)) && a.value != null && a.value > 0;
    }).sort(function (a, b) { return pipNum(get(b, C.pip)) - pipNum(get(a, C.pip)); });

    var body = funded.map(function (row) {
      var pip = get(row, C.pip);
      var done = get(row, C.msDone), total = get(row, C.msTotal);
      var milestones = (done && done !== "?") || (total && total !== "?") ? cellOut(done, 0) + " / " + cellOut(total, 0) : dash();
      return "<tr>" +
        '<td><div class="pip">' + esc(pip) + '</div><div class="name">' + esc(cleanName(get(row, C.name), pip)) + "</div></td>" +
        '<td class="num">' + amountOut(get, row) + "</td>" +
        '<td class="num">' + cellOut(get(row, C.usdcPaid), 2) + "</td>" +
        '<td class="num">' + cellOut(get(row, C.usdcLeft), 2) + "</td>" +
        '<td class="num">' + cellOut(get(row, C.atlasPaid), 0) + "</td>" +
        '<td class="num">' + cellOut(get(row, C.atlasLeft), 0) + "</td>" +
        '<td class="num">' + milestones + "</td>" +
        "<td>" + esc(get(row, C.phase)) + "</td>" +
        "</tr>";
    }).join("");
    $("payment-table").innerHTML = "<table><thead><tr><th>PIP</th><th class=\"num\">Approved amount</th><th class=\"num\">USDC paid</th><th class=\"num\">USDC still to pay</th>" +
      "<th class=\"num\">ATLAS paid</th><th class=\"num\">ATLAS still to pay</th><th class=\"num\">Milestones</th><th>Tracker phase</th></tr></thead><tbody>" + body + "</tbody></table>";
  }

  /* ---------- view 2: council ---------- */

  function hasAccomplishment(text) {
    var t = String(text || "").trim();
    return !!t && !/^(n\/a|none)\b/i.test(t);
  }

  function renderCouncil(rows, get) {
    var numbered = rows.filter(function (row) { return get(row, C.pip); });
    var acc = numbered.filter(function (row) { return hasAccomplishment(get(row, C.roi)); }).length;
    var withResult = numbered.filter(function (row) { return get(row, C.result); });
    var passed = withResult.filter(function (row) { return /^passed$/i.test(get(row, C.result)); }).length;
    var failed = withResult.filter(function (row) { return /^failed$/i.test(get(row, C.result)); }).length;
    var votes = summarize(numbered, get, C.votes);
    var pvp = summarize(numbered, get, C.pvp);
    var part = summarize(numbered, get, C.part);
    var atlas = summarize(numbered, get, C.atlasPaid);

    var cards = [
      kpi({ label: "PIPs with an accomplishment written", value: numValue(acc, "of " + numbered.length + " PIPs", 0),
        sub: esc("Counts PIPs where " + q(C.roi) + " has text other than N/A or None.") }),
      sumCard("ATLAS paid to PIP authors", atlas, "ATLAS", 0, esc("Adds up " + q(C.atlasPaid) + ".")),
      kpi({ label: "PIPs that finished voting", value: numValue(withResult.length, "", 0),
        sub: esc(passed + " passed, " + failed + " failed. Counts PIPs with a " + q(C.result) + ".") }),
      votes.n ? kpi({ label: "Votes cast, all PIPs", value: numValue(votes.sum, "votes", 0),
        sub: withNote(esc("Adds up " + q(C.votes) + " (" + votes.n + " PIPs)."), [votes]) })
        : sumCard("Votes cast, all PIPs", votes, "votes", 0, ""),
      pvp.n ? kpi({ label: "Voting power used (PVP)", value: numValue(pvp.sum, "M PVP", 2),
        sub: withNote(esc("Adds up " + q(C.pvp) + ", in millions as the header says."), [pvp]) })
        : sumCard("Voting power used (PVP)", pvp, "M PVP", 2, ""),
      votes.n ? kpi({ label: "Average votes per PIP", value: numValue(votes.avg, "votes", 0),
        sub: withNote(esc("Votes cast \u00f7 " + votes.n + " PIPs that have a number in " + q(C.votes) + "."), [votes]) })
        : kpi({ label: "Average votes per PIP", value: "\u2014", valueCls: "missing", sub: excludeHtml([votes]) }),
      pvp.n ? kpi({ label: "Average voting power per PIP", value: numValue(pvp.avg, "M PVP", 2),
        sub: withNote(esc("Mean of " + q(C.pvp) + " over " + pvp.n + " PIPs."), [pvp]) })
        : kpi({ label: "Average voting power per PIP", value: "\u2014", valueCls: "missing", sub: excludeHtml([pvp]) }),
      part.n ? kpi({ label: "Average turnout", value: numValue(part.avg, part.percent ? "%" : "", 1),
        sub: withNote(esc("Mean of " + q(C.part) + " (share of all voting power that voted) over " + part.n + " PIPs."), [part]) })
        : kpi({ label: "Average turnout", value: "\u2014", valueCls: "missing", sub: excludeHtml([part]) })
    ];
    $("council-grid").innerHTML = cards.join("");

    /* by term */
    var order = [], groups = {};
    numbered.forEach(function (row) {
      var t = get(row, C.term) || "(empty)";
      if (!groups[t]) { groups[t] = []; order.push(t); }
      groups[t].push(row);
    });
    var body = order.map(function (t) {
      var g = groups[t];
      var res = g.filter(function (r) { return get(r, C.result); });
      var p = res.filter(function (r) { return /^passed$/i.test(get(r, C.result)); }).length;
      var v = summarize(g, get, C.votes), pv = summarize(g, get, C.pvp), pa = summarize(g, get, C.part), at = summarize(g, get, C.atlasPaid);
      var label = isNA(t) ? "N/A (before SAC-1)" : t === "(empty)" ? dash() : esc(t);
      return "<tr><td>" + label + "</td>" +
        '<td class="num">' + g.length + "</td>" +
        '<td class="num">' + res.length + "</td>" +
        '<td class="num">' + p + " / " + (res.length - p) + "</td>" +
        '<td class="num">' + (v.n ? esc(fmt(v.sum, 0)) : dash()) + "</td>" +
        '<td class="num">' + (v.n ? esc(fmt(v.avg, 0)) : dash()) + "</td>" +
        '<td class="num">' + (pv.n ? esc(fmt(pv.avg, 1)) : dash()) + "</td>" +
        '<td class="num">' + (pa.n ? esc(fmt(pa.avg, 1)) + (pa.percent ? "%" : "") : dash()) + "</td>" +
        '<td class="num">' + (at.n ? esc(fmt(at.sum, 0)) : dash()) + "</td></tr>";
    }).join("");
    $("term-table").innerHTML = "<table><thead><tr><th>Council term</th><th class=\"num\">PIPs</th><th class=\"num\">Finished voting</th><th class=\"num\">Passed / failed</th>" +
      "<th class=\"num\">Votes cast</th><th class=\"num\">Avg votes</th><th class=\"num\">Avg PVP (M)</th><th class=\"num\">Avg turnout</th><th class=\"num\">ATLAS paid</th></tr></thead><tbody>" +
      body + "</tbody></table>";
  }

  /* The small SAC-1/SAC-2/SAC-3 block typed to the right of the Tracker table. Printed as-is. */
  function renderSheetSummary(rows) {
    var host = $("sheet-summary");
    for (var r = 0; r < rows.length; r++) {
      var c = rows[r].findIndex(function (v, i) { return norm(v) === "SAC-1" && norm(rows[r][i + 1]) === "SAC-2"; });
      if (c < 1) continue;
      var heads = [norm(rows[r][c]), norm(rows[r][c + 1]), norm(rows[r][c + 2])];
      var out = [];
      for (var k = r + 1; k < rows.length; k++) {
        var label = norm(rows[k][c - 1]);
        if (!label) break;
        out.push("<tr><td>" + esc(label) + "</td>" + [0, 1, 2].map(function (j) {
          var v = norm(rows[k][c + j]);
          return '<td class="num">' + (v && v !== "?" ? esc(v) : dash()) + "</td>";
        }).join("") + "<td>" + esc(norm(rows[k][c + 3])) + "</td></tr>");
      }
      if (!out.length) break;
      host.innerHTML = "<table><thead><tr><th>Row label in sheet</th>" + heads.map(function (h) { return '<th class="num">' + esc(h) + "</th>"; }).join("") +
        "<th>Unit</th></tr></thead><tbody>" + out.join("") + "</tbody></table>";
      return;
    }
    $("sheet-summary-wrap").style.display = "none";
  }

  /* ---------- view 3: ecosystem fund limit ---------- */

  function renderLimit() {
    var next = cfg.nextQuarterLimitAtlas;
    var hasNext = !(next == null || next === "");
    $("limit-grid").innerHTML = [
      kpi({ label: "Current limit (5%)", value: numValue(Number(cfg.currentLimitAtlas), "ATLAS", 0),
        sub: esc("Council figure for the current limit.") }),
      hasNext
        ? kpi({ label: "Next quarter limit", cls: "input", value: numValue(Number(next), "ATLAS", 0),
            sub: esc("Council figure for the next quarter.") })
        : kpi({ label: "Next quarter limit", value: "\u2014", valueCls: "missing",
            sub: esc("No next-quarter figure is published.") }),
      kpi({ label: "Ecosystem Fund wallet holds now", id: "limit-eco-atlas", value: "Loading\u2026", valueCls: "loading",
        sub: esc("Live ATLAS balance of the Ecosystem Fund wallet, for context. This is a balance, not the limit.") })
    ].join("");
    paintLimitEco();
  }

  function publishEcoAtlas(res) {
    ecoAtlas = res;
    paintLimitEco();
  }

  function paintLimitEco() {
    var el = $("limit-eco-atlas");
    if (!el || !ecoAtlas) return;
    var res = ecoAtlas;
    var v = el.querySelector(".value");
    var sEl = el.querySelector(".sub");
    if (res.ok && res.amountText) {
      v.className = "value";
      v.innerHTML = amountHtml(res.amountText, "ATLAS");
      sEl.textContent = (res.text || "ATLAS balance") + " This is a balance, not the limit.";
    } else {
      v.className = "value missing";
      v.textContent = "\u2014";
      sEl.textContent = "The Ecosystem Fund ATLAS balance was not read.";
    }
  }

  /* ---------- view 4: balance sheet ---------- */

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function rpcEndpoints() {
    var list = [cfg.rpcUrl].concat(Array.isArray(cfg.rpcFallbackUrls) ? cfg.rpcFallbackUrls : []);
    return list.filter(function (u, i) { return u && list.indexOf(u) === i; });
  }

  /* Public RPCs rate-limit bursts, so calls to each host are spaced out. */
  var hostQueue = {};
  function paced(host) {
    var gap = 350, now = Date.now();
    var next = Math.max(now, (hostQueue[host] || 0));
    hostQueue[host] = next + gap;
    return sleep(next - now);
  }

  /* Methods that free public nodes often gate behind a key; do not retry them when refused. */
  var INDEXED = { getTokenAccountsByOwner: 1, getTokenAccountBalance: 1, getProgramAccounts: 1, getMultipleAccounts: 1 };

  async function rpcOnce(url, method, params) {
    var lastErr, host = hostOf(url);
    for (var attempt = 0; attempt < 3; attempt++) {
      await paced(host);
      try {
        var response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params })
        });
        var text = await response.text();
        var data;
        try { data = JSON.parse(text); } catch (e) { throw new Error("HTTP " + response.status + " " + (text.slice(0, 120) || response.statusText)); }
        if (!response.ok || data.error) {
          var code = data && data.error ? data.error.code : null;
          var msg = data && data.error ? (code != null ? code + " " : "") + (data.error.message || JSON.stringify(data.error)) : "HTTP " + response.status;
          var e2 = new Error(msg);
          if (response.status === 403 || code === 403) e2.forbidden = true;
          else if (code === -32602 && /personal token/i.test(msg)) e2.gated = true;
          else if (response.status === 429 || code === -32005 || code === 429) e2.limited = true;
          throw e2;
        }
        return data.result;
      } catch (err) {
        lastErr = err;
        if (err.forbidden || err.gated) break;
        if (err.limited && INDEXED[method]) { err.gated = true; break; }
        await sleep(1500 * (attempt + 1));
      }
    }
    throw lastErr;
  }

  async function rpc(method, params, purpose) {
    var urls = rpcEndpoints(), errors = [];
    var what = purpose || RPC_LABEL[method] || method;
    state.forbidden = state.forbidden || {};
    state.gated = state.gated || {};
    state.rpcErrors = state.rpcErrors || {};
    state.rpcOk = state.rpcOk || {};
    for (var i = 0; i < urls.length; i++) {
      var host = hostOf(urls[i]);
      if (state.forbidden[host]) { errors.push(host + ": " + state.forbidden[host]); continue; }
      if (state.gated[host + "|" + method]) { errors.push(host + ": " + state.gated[host + "|" + method]); continue; }
      try {
        var result = await rpcOnce(urls[i], method, params);
        (state.rpcOk[host] = state.rpcOk[host] || {})[what] = true;
        return { result: result, url: urls[i] };
      }
      catch (err) {
        var short = String((err && err.message) || err).split(". ")[0].replace(/\.$/, "");
        if (err && err.forbidden) state.forbidden[host] = short;
        if (err && err.gated) state.gated[host + "|" + method] = short;
        (state.rpcErrors[host] = state.rpcErrors[host] || {})[what + " (\u201c" + short + "\u201d)"] = true;
        errors.push(host + ": " + short);
      }
    }
    throw new Error(errors.join("; "));
  }

  var RPC_LABEL = { getBalance: "SOL balances", getTokenAccountsByOwner: "all-token-account lookups", getAccountInfo: "account reads" };
  var label = RPC_LABEL;

  function hostOf(u) { try { return new URL(u).host; } catch (e) { return u; } }

  /* ---- snapshot fallback (balances.json, written by scripts/snapshot-balances.mjs) ---- */

  var snapshotPromise = null;
  function loadSnapshot() {
    if (!snapshotPromise) {
      snapshotPromise = (cfg.balancesSnapshotUrl ? fetch(cfg.balancesSnapshotUrl, { cache: "no-store" }) : Promise.reject(new Error("no snapshot configured")))
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .catch(function () { return null; });
    }
    return snapshotPromise;
  }

  function snapWallet(snap, address) {
    if (!snap || !Array.isArray(snap.wallets)) return null;
    return snap.wallets.find(function (w) { return w.address === address; }) || null;
  }

  function snapDate(snap) {
    var iso = snap && snap.generatedAtUtc;
    if (!iso) return "unknown date";
    return iso.replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, " UTC");
  }

  /* ---- live balances: the same reader the MCP tools use. No polling. ---- */

  function jupiterMint(sym) {
    if (sym === "SOL") return cfg.solMint || "";
    if (sym === "ATLAS") return cfg.atlasMint || "";
    if (sym === "USDC") return cfg.usdcMint || "";
    return "";
  }

  function paintBalanceTile(el, sym, amountText, readAt, sub, cached) {
    var v = el.querySelector(".value");
    var s = el.querySelector(".sub");
    var lab = el.querySelector(".label");
    el.dataset.mint = jupiterMint(sym);
    el.dataset.amount = amountText || "";
    el.dataset.readAt = readAt || "";
    if (!amountText) {
      v.className = "value missing";
      v.textContent = "\u2014";
      s.textContent = "No figure for this token.";
      return;
    }
    v.className = "value";
    v.innerHTML = amountHtml(amountText, sym);
    lab.innerHTML = esc(sym) + (cached ? ' <span class="pill snap">cached</span>' : "");
    s.textContent = sub;
  }

  async function loadLiveBalances() {
    if (state.balanceBusy) return;
    state.balanceBusy = true;
    var button = $("balance-refresh");
    if (button) button.disabled = true;
    var cards = state.balanceCards || [];
    try {
      var read;
      if (!window.SA_DAO || !window.SA_DAO.readBalancesWithFallback || !window.SA_DAO.solanaRpcUrls || !window.SA_DAO.createFallbackRpc || !window.SA_ATA) {
        read = { tiles: [], label: "Balance reader did not load.", asOf: "" };
      } else {
        var urls = window.SA_DAO.solanaRpcUrls(cfg.rpcUrl, (cfg.rpcFallbackUrls || []).join(","));
        var rpc = window.SA_DAO.createFallbackRpc(urls, fetch, { minIntervalMs: 0, attempts: 2 });
        var cache = null;
        try {
          var response = await fetch(cfg.treasuryCacheUrl || "data/treasury-cache.json", { cache: "no-store" });
          cache = response.ok ? await response.json() : null;
        } catch (err) {
          cache = null;
        }
        read = await window.SA_DAO.readBalancesWithFallback({
          rpc: rpc,
          associatedTokenAddress: window.SA_ATA.associatedTokenAddress,
          now: new Date(),
          cacheBalances: cache && cache.balances
        });
      }
      state.tileModes = [];
      var eco = null;
      cards.forEach(function (job) {
        var tiles = job.card.querySelectorAll(".kpi");
        ["ATLAS", "USDC", "SOL"].forEach(function (sym, index) {
          var tile = (read.tiles || []).find(function (item) { return item.wallet === job.address && item.symbol === sym; });
          if (!tile || !tile.amount) {
            paintBalanceTile(tiles[index], sym, "", "", (tile && tile.text) || read.label || "No balance was invented.", false);
            state.tileModes.push("unavailable");
            if (job.eco && sym === "ATLAS") eco = { ok: false };
            return;
          }
          paintBalanceTile(tiles[index], sym, tile.amount, read.asOf || "", tile.text, tile.mode === "cached");
          state.tileModes.push(tile.mode);
          if (job.eco && sym === "ATLAS") {
            eco = { ok: true, amountText: tile.amount, text: tile.text };
          }
        });
      });
      if (eco) publishEcoAtlas(eco);
      else if (!cards.some(function (job) { return job.eco; })) publishEcoAtlas({ ok: false });
      applyUsd();
      document.dispatchEvent(new Event("sa-balances"));
    } finally {
      state.balanceBusy = false;
      if (button) button.disabled = false;
    }
  }

  async function settle(p) {
    try { var r = await p; r.ok = true; return r; }
    catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
  }

  /* ---- tiles ---- */

  function liveAsOf(res) {
    var relative = ago(res.readAt);
    return "Live as of " + res.readAt + (relative ? ", " + relative : "");
  }

  function walletCard(title, address, note) {
    var div = document.createElement("div");
    div.className = "wallet";
    var tile = function (label) { return kpi({ label: label, value: "Loading\u2026", valueCls: "loading", sub: " " }); };
    div.innerHTML = '<div class="wallet-head"><h4>' + esc(title) + '</h4><span class="addr">' + esc(address) + "</span></div>" +
      (note ? '<p class="hint" style="margin:-0.3rem 0 0.6rem">' + esc(note) + "</p>" : "") +
      '<div class="kpis">' + tile("ATLAS") + tile("USDC") + tile("SOL") + "</div>";
    return div;
  }

  /* ---- "Who controls these funds": Squads v3 multisig, read-only ---- */

  function shortKey(k) { return k ? k.slice(0, 4) + "\u2026" + k.slice(-4) : ""; }
  function keyHtml(k) { return '<span class="mono" title="' + esc(k) + '">' + esc(shortKey(k)) + "</span>"; }

  function txStatusHtml(t, threshold) {
    var n = (t.approved || []).length;
    switch (t.status) {
      case "Executed": return '<span class="status pass">Executed</span>';
      case "ExecuteReady": return '<span class="status withdrawn">Approved, not executed yet</span>';
      case "Active": return '<span class="status none">Open: ' + n + " of " + threshold + " approvals</span>";
      case "Draft": return '<span class="status none">Draft</span>';
      case "Rejected": return '<span class="status fail">Rejected</span>';
      case "Cancelled": return '<span class="status none">Cancelled</span>';
      default: return '<span class="status none">' + esc(t.status || "unknown") + "</span>";
    }
  }

  async function readMultisigLive(m) {
    var S = window.SA_SQUADS;
    if (!S) throw new Error("squads.js not loaded");
    var program = m.program || S.PROGRAM;
    var r = await rpc("getAccountInfo", [m.address, { encoding: "base64" }], "multisig reads");
    var v = r.result && r.result.value;
    if (!v) throw new Error("multisig account not found");
    if (v.owner !== program) throw new Error("account is not owned by the Squads v3 program");
    var ms = S.decodeMs(S.b64(v.data[0]));
    var derived = await S.vaultAddress(m.address, m.vaultIndex || 1, program);
    var count = Math.max(0, Number(cfg.multisigRecentTransactions || 5));
    var txs = [];
    for (var i = ms.transactionIndex; i > 0 && i > ms.transactionIndex - count; i--) {
      var addr = await S.transactionAddress(m.address, i, program);
      try {
        var tr = await rpc("getAccountInfo", [addr, { encoding: "base64" }], "multisig reads");
        var tv = tr.result && tr.result.value;
        if (!tv) { txs.push({ index: i, address: addr, missing: true }); continue; }
        var t = S.decodeMsTx(S.b64(tv.data[0]));
        if (t.ms !== m.address) throw new Error("transaction belongs to another multisig");
        t.index = i; t.address = addr;
        txs.push(t);
      } catch (e) {
        txs.push({ index: i, address: addr, error: String((e && e.message) || e).split("; ").pop() });
      }
    }
    return { url: r.url, ms: ms, derivedVault: derived, txs: txs };
  }

  function fromSnapshot(snapMs) {
    return {
      ms: { threshold: snapMs.threshold, members: snapMs.members, transactionIndex: snapMs.transactionIndex, msChangeIndex: snapMs.msChangeIndex },
      derivedVault: snapMs.derivedVault,
      txs: (snapMs.recentTransactions || []).map(function (t) { var c = Object.assign({}, t); return c; })
    };
  }

  function paintMultisig(panel, m, data, source) {
    var ms = data.ms;
    var vaultOk = data.derivedVault && m.vault && data.derivedVault === m.vault;
    var members = ms.members || [];
    var rows = data.txs.map(function (t) {
      if (t.missing) return "<tr><td>#" + t.index + '</td><td colspan="4"><span class="empty">No account at this index (closed or never created).</span></td></tr>';
      if (t.error) return "<tr><td>#" + t.index + '</td><td colspan="4"><span class="status fail">Unavailable</span> <span class="hint">' + esc(t.error) + "</span></td></tr>";
      return "<tr><td>#" + t.index + "</td><td>" + txStatusHtml(t, ms.threshold) + "</td>" +
        '<td class="num">' + (t.approved || []).length + " of " + ms.threshold + "</td>" +
        "<td>" + keyHtml(t.creator) + "</td>" +
        "<td>" + (t.approved || []).map(keyHtml).join(", ") + "</td></tr>";
    }).join("");
    var pending = data.txs.filter(function (t) { return t.status === "ExecuteReady" || t.status === "Active"; });
    panel.innerHTML =
      '<div class="control-head"><h5>Who controls these funds</h5><span class="pill gold">read-only</span>' +
        (source.snapshot ? '<span class="pill snap">Snapshot from ' + esc(source.snapshot) + "</span>" : "") + "</div>" +
      '<p class="hint">' + esc(m.label || "Multisig") + ": Squads v3 multisig <span class=\"addr\">" + esc(m.address) + "</span>. " +
        (vaultOk ? "This wallet is its vault #" + esc(m.vaultIndex || 1) + " (checked: the vault address derived from the multisig matches)."
                 : '<span class="status fail">Vault check failed: derived ' + esc(data.derivedVault || "?") + ", expected " + esc(m.vault || "?") + ".</span>") + "</p>" +
      '<div class="control-grid">' +
        '<div class="mini"><div class="label">Signatures needed to move funds</div><div class="v">' + esc(ms.threshold) + " of " + members.length + "</div></div>" +
        '<div class="mini"><div class="label">Multisig transactions created</div><div class="v">' + esc(ms.transactionIndex) + "</div></div>" +
        '<div class="mini"><div class="label">Member-list changes</div><div class="v">' + esc(ms.msChangeIndex) + "</div></div>" +
        '<div class="mini"><div class="label">Waiting to execute (latest ' + data.txs.length + ")</div><div class=\"v\">" + pending.length + "</div></div>" +
      "</div>" +
      '<div class="members"><div class="label">Member keys (' + members.length + ")</div><ul>" + members.map(function (k) { return '<li class="mono">' + esc(k) + "</li>"; }).join("") + "</ul>" +
        '<p class="hint">Keys only. On-chain data does not say which Council member holds which key, so no names are shown.</p></div>' +
      '<div class="table-wrap"><table class="tx"><thead><tr><th>Multisig tx</th><th>Status</th><th class="num">Approvals</th><th>Created by</th><th>Approved by</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
      '<p class="hint">' + esc(source.text) + " The multisig accounts do not store dates or amounts, so none are shown.</p>";
  }

  async function loadMultisig(panel, m) {
    var res = await settle(readMultisigLive(m));
    if (res.ok) {
      res.readAt = new Date().toISOString();
      paintMultisig(panel, m, res, { text: "Live \u00b7 updated " + (freshAgo(res.readAt) || timeNow()) + "." });
      state.tileModes = state.tileModes || [];
      state.msModes = (state.msModes || []).concat("live");
      return;
    }
    var snap = await loadSnapshot();
    var sm = snap && Array.isArray(snap.multisigs) ? snap.multisigs.find(function (x) { return x.address === m.address && x.threshold != null; }) : null;
    if (sm) {
      paintMultisig(panel, m, fromSnapshot(sm), { snapshot: snapDate(snap), text: "Saved snapshot" + (snap && snap.generatedAtUtc && ago(snap.generatedAtUtc) ? ", " + ago(snap.generatedAtUtc) : "") + "." });
      state.msModes = (state.msModes || []).concat("snapshot");
      return;
    }
    state.msModes = (state.msModes || []).concat("unavailable");
    panel.innerHTML = '<div class="control-head"><h5>Who controls these funds</h5><span class="pill gold">read-only</span></div>' +
      '<p class="hint">' + esc(m.label || "Multisig") + ': Squads v3 multisig <span class="addr">' + esc(m.address) + "</span>.</p>" +
      '<p><span class="status fail">Unavailable</span> <span class="hint">Live read failed.</span></p>';
  }

  function rpcNote() {
    var el = $("rpc-note");
    if (!el) return;
    var modes = state.tileModes || [];
    var count = function (m) { return modes.filter(function (x) { return x === m; }).length; };
    var liveN = count("live"), cachedN = count("cached"), downN = count("unavailable");
    var head = !modes.length ? "Balances have not been read yet."
      : (!downN && !cachedN) ? "Live \u00b7 updated " + timeNow() + "."
      : liveN + " live, " + cachedN + " cached, " + downN + " unavailable.";
    var msm = state.msModes || [];
    var rpcBad = downN || cachedN || msm.some(function (x) { return x !== "live"; });
    var rpcStatus = modes.length > 0 && liveN === modes.length && msm.every(function (x) { return x === "live"; })
      ? "ok"
      : (downN ? "error" : "cached");
    noteHealth({
      source: "Solana RPC",
      status: rpcStatus,
      asOf: new Date().toISOString(),
      detail: liveN + " of " + modes.length + " balance tiles are live, " + cachedN + " cached, " + downN + " unavailable."
    });
    el.className = "banner " + (rpcBad ? "warn" : "ok");
    el.style.display = "";
    el.textContent = head;
  }

  function looksLikeSolana(addr) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr); }

  function renderBalances() {
    var host = $("wallet-cards");
    var w = cfg.wallets || {};
    var list = [
      { title: "DAO Treasury", address: w.treasury, eco: false },
      { title: "Ecosystem Fund", address: w.ecosystemFund, eco: true }
    ];
    var jobs = [];
    list.forEach(function (item) {
      var card = walletCard(item.title, item.address);
      host.appendChild(card);
      jobs.push({ card: card, address: item.address, eco: item.eco });
    });

    var mhost = $("multisig-cards");
    var ms = Array.isArray(cfg.multisigs) ? cfg.multisigs : [];
    var msJobs = [];
    ms.forEach(function (m, i) {
      if (!m || !m.address) return;
      var panel = document.createElement("div");
      panel.className = "control";
      var target = null;
      jobs.forEach(function (j) { if (m.vault && j.address === m.vault) target = j.card; });
      if (target) target.appendChild(panel);
      else {
        var card = document.createElement("div");
        card.className = "wallet";
        card.innerHTML = '<div class="wallet-head"><h4>' + esc(m.label || ("Multisig " + (i + 1))) + "</h4></div>";
        card.appendChild(panel);
        mhost.appendChild(card);
        $("multisig-other-wrap").style.display = "";
      }
      panel.innerHTML = '<div class="control-head"><h5>Who controls these funds</h5><span class="pill gold">read-only</span></div><p class="hint">Loading the multisig\u2026</p>';
      msJobs.push({ panel: panel, m: m });
    });

    state.balanceCards = jobs;
    var refresh = $("balance-refresh");
    if (refresh && !refresh.dataset.bound) {
      refresh.dataset.bound = "1";
      refresh.addEventListener("click", function () { loadLiveBalances().then(rpcNote); });
    }
    state.walletsPending = 1 + msJobs.length;
    var done = function () { state.walletsPending--; if (state.walletsPending === 0) { rpcNote(); markReady(); } };
    loadLiveBalances().then(done, done);
    msJobs.forEach(function (job) {
      loadMultisig(job.panel, job.m).catch(function (err) {
        job.panel.querySelector(".hint").textContent = "Unavailable.";
      }).then(done);
    });
  }

  function applyUsd() {
    document.querySelectorAll("#wallet-cards .kpi").forEach(function (el) {
      var old = el.querySelector(".usd-line");
      if (old) old.remove();
      if (!state.usd.on) return;
      var value = el.querySelector(".value");
      if (!value) return;
      var line = document.createElement("div");
      line.className = "usd-line";
      if (state.usd.error) {
        line.textContent = "Approximate USD unknown. " + state.usd.error;
      } else if (!state.usd.prices) {
        line.textContent = "Approximate USD: waiting for Jupiter.";
      } else if (!el.dataset.amount || !el.dataset.mint) {
        line.textContent = "Approximate USD unknown. The token amount was not a decimal string.";
      } else {
        var price = state.usd.prices[el.dataset.mint];
        var product = price && window.SA_DAO && window.SA_DAO.approximateUsd
          ? window.SA_DAO.approximateUsd(el.dataset.amount, price)
          : null;
        line.textContent = product === null
          ? "Approximate USD unknown. Jupiter did not return a usable price."
          : "Approximate " + product + " USD, " + (ago(state.usd.asOf) || "Jupiter") + ". Not a Council figure.";
      }
      value.insertAdjacentElement("afterend", line);
    });
  }

  async function onUsdToggle() {
    var box = $("usd-toggle");
    state.usd.on = Boolean(box && box.checked);
    if (!state.usd.on) {
      noteHealth({ source: "Jupiter price", status: "not_requested", asOf: null, detail: "The approximate USD toggle is off. No price was requested." });
      applyUsd();
      return;
    }
    var mints = [cfg.atlasMint, cfg.usdcMint, cfg.solMint].filter(Boolean);
    var url = String(cfg.jupiterPriceUrl || "https://lite-api.jup.ag/price/v3");
    if (url.indexOf("https://") !== 0) {
      state.usd.error = "jupiterPriceUrl must start with https://.";
      state.usd.prices = null;
      noteHealth({ source: "Jupiter price", status: "error", asOf: null, detail: state.usd.error });
      applyUsd();
      return;
    }
    try {
      var response = await fetch(url + "?ids=" + encodeURIComponent(mints.join(",")));
      if (!response.ok) throw new Error("Jupiter HTTP " + response.status + ".");
      var parsed = window.SA_DAO.parseJupiterPrices(await response.json(), mints);
      state.usd.prices = parsed.prices;
      state.usd.error = null;
      state.usd.asOf = new Date().toISOString();
      noteHealth({ source: "Jupiter price", status: "ok", asOf: state.usd.asOf, detail: "Approximate USD. A missing price stays —." });
    } catch (error) {
      state.usd.prices = null;
      state.usd.error = (error && error.message) || String(error);
      state.usd.asOf = new Date().toISOString();
      noteHealth({ source: "Jupiter price", status: "error", asOf: state.usd.asOf, detail: state.usd.error + " No price was invented." });
    }
    applyUsd();
  }

  /* ---------- extra: PIP results tracker ---------- */

  function renderResults(rows, get) {
    var numbered = rows.filter(function (row) { return get(row, C.pip); })
      .sort(function (a, b) { return pipNum(get(b, C.pip)) - pipNum(get(a, C.pip)); });
    var body = numbered.map(function (row) {
      var pip = get(row, C.pip);
      var cat = get(row, C.category);
      return "<tr>" +
        '<td><div class="pip">' + esc(pip) + '</div><div class="name">' + esc(cleanName(get(row, C.name), pip)) + "</div>" +
        (cat ? '<div style="margin-top:0.25rem"><span class="pill teal">' + esc(cat) + "</span></div>" : "") + "</td>" +
        '<td class="num">' + cellOut(get(row, C.yes)) + "</td>" +
        '<td class="num">' + cellOut(get(row, C.no)) + "</td>" +
        '<td class="num">' + cellOut(get(row, C.abstain)) + "</td>" +
        '<td class="num">' + cellOut(get(row, C.votes), 0) + "</td>" +
        '<td class="num">' + cellOut(get(row, C.start)) + "</td>" +
        '<td class="num">' + cellOut(get(row, C.end)) + "</td>" +
        '<td class="num">' + amountOut(get, row) + "</td>" +
        "<td>" + resultOut(get, row) + "</td>" +
        "</tr>";
    }).join("");
    $("results-table").innerHTML = "<table><thead><tr><th>PIP</th><th class=\"num\">Yes</th><th class=\"num\">No</th><th class=\"num\">Abstain</th><th class=\"num\">Total votes</th>" +
      "<th class=\"num\">Vote start</th><th class=\"num\">Vote end</th><th class=\"num\">PIP amount</th><th>Final result</th></tr></thead><tbody>" + body + "</tbody></table>";
  }

  /* ---------- extra: treasury history link ---------- */

  function renderHistory() {
    var a = $("ryden-link");
    if (cfg.rydenGraphUrl) { a.href = cfg.rydenGraphUrl; a.textContent = "Open Ryden's graph"; }
    else { a.removeAttribute("href"); a.textContent = "No link set."; }
  }

  /* ---------- galaxy at a glance (existing public MCP) ---------- */

  function mcpUrl() {
    var pre = document.querySelector("#ask pre.mcp-record");
    if (!pre) return "";
    try {
      var parsed = JSON.parse(pre.textContent);
      var url = parsed && parsed.mcpServers && parsed.mcpServers["sa-dao"] && parsed.mcpServers["sa-dao"].url;
      return typeof url === "string" ? url : "";
    } catch (error) {
      return "";
    }
  }

  async function mcpCall(name, args) {
    var url = mcpUrl();
    if (!url) throw new Error("MCP address missing");
    var response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: name, arguments: args || {} } })
    });
    var text = await response.text();
    if (!response.ok) throw new Error("MCP HTTP " + response.status);
    var dataLine = text.split("\n").filter(function (line) { return line.indexOf("data:") === 0; })
      .map(function (line) { return line.slice(5).trim(); }).filter(Boolean)[0];
    var msg = JSON.parse(dataLine || text);
    if (msg.error) throw new Error(msg.error.message || "MCP error");
    var result = msg.result || {};
    if (result.isError) throw new Error("Tool failed");
    if (result.structuredContent) return result.structuredContent;
    var raw = result.content && result.content[0] && result.content[0].text;
    if (!raw) throw new Error("Empty tool result");
    return JSON.parse(raw);
  }

  function countOrDash(n) {
    return typeof n === "number" && Number.isFinite(n) ? esc(fmt(n, 0)) : dash();
  }

  function countTile(label, n, sub) {
    var missing = typeof n !== "number" || !Number.isFinite(n);
    return kpi({ label: label, value: countOrDash(n), valueCls: missing ? "missing" : "", sub: sub || "" });
  }

  function readScope(data) {
    if (!data || data.truncated !== true) return "";
    var activity = data.activity || {};
    var n = typeof activity.systemCount === "number" ? activity.systemCount : data.limit;
    if (typeof n !== "number" || !Number.isFinite(n)) return "In this read.";
    return "In the first " + fmt(n, 0) + " systems.";
  }

  function levelLine(levels) {
    if (!levels || typeof levels !== "object") return "";
    return Object.keys(levels).sort(function (a, b) {
      var na = Number(String(a).replace(/\D/g, ""));
      var nb = Number(String(b).replace(/\D/g, ""));
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return a < b ? -1 : a > b ? 1 : 0;
    }).map(function (key) {
      var n = levels[key];
      if (typeof n !== "number" || !Number.isFinite(n)) return "";
      return fmt(n, 0) + " at " + key.replace(/-/g, " ");
    }).filter(Boolean).join(", ");
  }

  function gameTiles(data) {
    var activity = data && data.activity || {};
    var scope = readScope(data);
    var levels = levelLine(activity.starbaseLevels);
    var starbaseSub = [scope, levels ? levels + "." : ""].filter(Boolean).join(" ");
    return countTile("Star systems", data && data.total) +
      countTile("Starbases", activity.starbaseCount, esc(starbaseSub)) +
      countTile("Celestial bodies", activity.celestialBodyCount, esc(scope));
  }

  function failedGameTiles() {
    return countTile("Star systems") + countTile("Starbases") + countTile("Celestial bodies");
  }

  function proposalTile(proposal) {
    if (!proposal || typeof proposal.pipNumber !== "number" || !Number.isInteger(proposal.pipNumber)) {
      return kpi({ label: "Latest PIP", value: dash(), valueCls: "missing" });
    }
    var title = typeof proposal.title === "string" ? proposal.title : "";
    var status = typeof proposal.status === "string" ? proposal.status.replace(/_/g, " ") : "";
    var sub = esc(title);
    if (status) sub += (sub ? " · " : "") + esc(status);
    return kpi({ label: "Latest PIP", value: esc("PIP-" + proposal.pipNumber), sub: sub });
  }

  async function latestProposal() {
    var cursor = "";
    var best = null;
    var guard = 0;
    while (guard < 8) {
      guard += 1;
      var args = { limit: 20 };
      if (cursor) args.cursor = cursor;
      var page = await mcpCall("list_proposals", args);
      var list = page && page.proposals;
      if (!Array.isArray(list)) throw new Error("No proposal list");
      list.forEach(function (proposal) {
        if (!proposal || typeof proposal.pipNumber !== "number" || !Number.isInteger(proposal.pipNumber)) return;
        if (!best || proposal.pipNumber > best.pipNumber) best = proposal;
      });
      if (!page.truncated) return best;
      if (typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor === cursor) throw new Error("Proposal page did not advance");
      cursor = page.nextCursor;
    }
    throw new Error("Proposal list was too long");
  }

  function renderCommunity() {
    var grid = $("community-grid");
    if (!grid) return;
    var labels = ["Star systems", "Starbases", "Celestial bodies", "Latest PIP"];
    grid.innerHTML = labels.map(function (label) {
      return kpi({ label: label, value: "Loading\u2026", valueCls: "loading" });
    }).join("");
    var game = mcpCall("galaxy_overview", { limit: 20 }).then(gameTiles).catch(failedGameTiles);
    var dao = latestProposal().then(proposalTile).catch(function () {
      return kpi({ label: "Latest PIP", value: dash(), valueCls: "missing" });
    });
    Promise.all([game, dao]).then(function (parts) { grid.innerHTML = parts[0] + parts[1]; });
  }

  /* ---------- sources ---------- */

  function renderSources() {
    var w = cfg.wallets || {};
    var galaxy = String(cfg.galaxyBaseUrl || "https://galaxy.staratlas.com").replace(/\/$/, "");
    function walletLink(address, label) {
      if (!address) return esc(label);
      return '<a href="https://solscan.io/account/' + encodeURIComponent(address) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + "</a>";
    }
    $("sources-body").innerHTML = "<ul class=\"plain-sources\">" +
      "<li>Council PIP Tracker: <a href=\"" + esc(cfg.sheetUrl) + "\" target=\"_blank\" rel=\"noopener noreferrer\">Star Atlas DAO Council sheet</a>.</li>" +
      "<li>DAO wallets: " + walletLink(w.treasury, "DAO Treasury") + " and " + walletLink(w.ecosystemFund, "Ecosystem Fund") + ".</li>" +
      "<li>Galaxy proposals and revenue: <a href=\"" + esc(galaxy) + "\" target=\"_blank\" rel=\"noopener noreferrer\">" + esc(galaxy.replace(/^https:\/\//, "")) + "</a>.</li>" +
      "<li>Treasury history cache, refreshed every few hours.</li>" +
      "<li>Read-only <a href=\"#ask\">Star Atlas DAO MCP</a>.</li>" +
      "</ul>";
  }

  /* ---------- sheet load ---------- */

  function applySheet(text, label, kind, loadedFrom) {
    var rows = parseCsv(text.replace(/^\uFEFF/, ""));
    var h = findHeader(rows);
    if (h < 0) throw new Error("No header row containing " + HEADER_ROW_MARK + ".");
    var map = indexHeaders(rows[h]);
    state.map = map;
    var get = makeGetter(map);
    var records = rows.slice(h + 1).filter(function (row) { return get(row, C.pip) || get(row, C.name); });
    var readAt = new Date().toISOString();
    window.SA_SHEET_STATE = { ok: true, csv: text, asOf: readAt };
    document.dispatchEvent(new Event("sa-sheet"));
    var b = $("source-banner");
    b.className = "banner " + kind;
    if (kind === "ok") b.textContent = "Live \u00b7 updated " + timeNow();
    else if (cfg.fixture) b.textContent = "Sample data \u00b7 not live";
    else b.textContent = "Saved copy \u00b7 updated " + (cfg.localCsvSavedOn || "earlier");
    noteHealth({ source: "Council sheet", status: kind === "ok" ? "ok" : "error", asOf: readAt, detail: loadedFrom || label });
    renderPayments(records, get);
    renderCouncil(records, get);
    renderSheetSummary(rows);
    renderResults(records, get);
    renderSources(loadedFrom);
  }

  function timeNow() {
    return new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  }

  async function loadSheet() {
    if (cfg.fixture) {
      var fx = await fetch(cfg.localCsvFallback);
      applySheet(await fx.text(), "FIXTURE / sample data. Not live Council numbers.", "warn", "fixture file");
      return;
    }
    var url = csvUrl(cfg.sheetUrl);
    try {
      var response = await fetch(url);
      if (!response.ok) throw new Error("sheet export HTTP " + response.status);
      var text = await response.text();
      if (text.indexOf(HEADER_ROW_MARK) === -1) throw new Error("sheet export did not contain " + HEADER_ROW_MARK);
      state.sourceReads = state.sourceReads || {};
      state.sourceReads.sheet = new Date().toISOString();
      applySheet(text, "Live: public Council sheet, Tracker tab, loaded " + timeNow() + " (your local time), " + (ago(state.sourceReads.sheet) || "updated just now") + ".", "ok", "live export, " + timeNow());
    } catch (err) {
      if (!cfg.localCsvFallback) throw err;
      var fb = await fetch(cfg.localCsvFallback);
      if (!fb.ok) throw new Error("live sheet failed (" + (err.message || err) + ") and fallback CSV HTTP " + fb.status);
      state.sourceReads = state.sourceReads || {};
      state.sourceReads.sheet = cfg.localCsvSavedOn ? cfg.localCsvSavedOn + "T00:00:00.000Z" : "";
      applySheet(await fb.text(), "Live sheet could not be loaded (" + (err.message || err) + "). Showing the copy of the same public export saved " +
        (cfg.localCsvSavedOn || "with this preview") + (ago(state.sourceReads.sheet) ? ", " + ago(state.sourceReads.sheet) : "") + ". Not sample data, but may be out of date.", "warn", "saved copy from " + (cfg.localCsvSavedOn || "?"));
    }
  }

  /* ---------- tabs: scroll spy, gold underline on the section in view ---------- */

  function initTabs() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll("#tabs .tab"));
    var sections = tabs.map(function (t) { return document.querySelector(t.getAttribute("href")); });
    function setActive(id) {
      tabs.forEach(function (t) { t.classList.toggle("active", t.getAttribute("href") === "#" + id); });
    }
    function onScroll() {
      var y = window.scrollY + 90, current = sections[0] && sections[0].id;
      sections.forEach(function (s) { if (s && s.offsetTop <= y) current = s.id; });
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) current = sections[sections.length - 1].id;
      setActive(current);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  renderLimit();
  renderHistory();
  renderCommunity();
  renderSources();
  renderBalances();
  initTabs();
  noteHealth({ source: "Jupiter price", status: "not_requested", asOf: null, detail: "The approximate USD toggle is off. No price was requested." });
  var usdBox = $("usd-toggle");
  if (usdBox) usdBox.addEventListener("change", function () { onUsdToggle().catch(function () {}); });
  loadSheet().catch(function (err) {
    window.SA_SHEET_STATE = { ok: false, csv: "", asOf: null, error: (err && err.message) || String(err) };
    document.dispatchEvent(new Event("sa-sheet"));
    noteHealth({ source: "Council sheet", status: "error", asOf: new Date().toISOString(), detail: window.SA_SHEET_STATE.error });
    var b = $("source-banner");
    b.className = "banner bad";
    b.textContent = "The Council sheet could not be loaded.";
  }).then(function () { state.sheetDone = true; markReady(); });
})();
