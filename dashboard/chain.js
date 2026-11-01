/* Loads the published treasury cache and the public galaxy JSON. Read-only. */
(function () {
  "use strict";

  var cfg = window.SA_DASHBOARD_CONFIG || {};

  function host(id) {
    return document.getElementById(id);
  }

  function fail(id, message) {
    var el = host(id);
    if (!el) return;
    el.replaceChildren();
    var p = document.createElement("p");
    p.className = "hint";
    p.textContent = String(message);
    el.appendChild(p);
  }

  function noteHealth(row) {
    if (window.SA_DASHBOARD_HEALTH) {
      window.SA_DASHBOARD_HEALTH(row);
      return;
    }
    window.SA_DASHBOARD_HEALTH_QUEUE = (window.SA_DASHBOARD_HEALTH_QUEUE || []).concat([row]);
  }

  function api() {
    if (!window.SA_DAO) throw new Error("dao.js did not load.");
    return window.SA_DAO;
  }

  function galaxyBase() {
    var base = String(cfg.galaxyBaseUrl || "https://galaxy.staratlas.com").replace(/\/$/, "");
    if (base.indexOf("https://") !== 0) throw new Error("galaxyBaseUrl must start with https://.");
    return base;
  }

  function cachePath() {
    var url = String(cfg.treasuryCacheUrl || "data/treasury-cache.json");
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.indexOf("//") === 0) {
      throw new Error("treasuryCacheUrl must be a same-origin path.");
    }
    return url;
  }

  function councilOverride() {
    var out = { label: "Council figure, shown beside the calculation." };
    var any = false;
    if (typeof cfg.currentLimitAtlas === "number" && Number.isFinite(cfg.currentLimitAtlas) && cfg.currentLimitAtlas >= 0) {
      out.perPipLimitAtlas = String(cfg.currentLimitAtlas);
      any = true;
    }
    if (typeof cfg.nextQuarterLimitAtlas === "number" && Number.isFinite(cfg.nextQuarterLimitAtlas) && cfg.nextQuarterLimitAtlas >= 0) {
      out.nextQuarterLimitAtlas = String(cfg.nextQuarterLimitAtlas);
      any = true;
    }
    return any ? out : undefined;
  }

  var cacheState = { payload: null, report: null, ecofund: null, error: null };

  function seriesHasPoints(series) {
    return !!(series && series.status === "known" && series.points && series.points.length);
  }

  function balancesAreLive() {
    var nodes = document.querySelectorAll("#wallet-cards .kpi .value, #limit-eco-atlas .value");
    for (var i = 0; i < nodes.length; i++) {
      var text = nodes[i].textContent || "";
      if (/\d/.test(text) && !/loading/i.test(text)) return true;
    }
    return false;
  }

  function plainDate(iso) {
    var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    if (!match) return "\u2014";
    var names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return (names[Number(match[2]) - 1] || match[2]) + " " + Number(match[3]) + ", " + match[1];
  }

  function atlasWhole(amount) {
    if (amount == null || amount === "") return null;
    var n = Number(String(amount).replace(/,/g, ""));
    if (!Number.isFinite(n)) return null;
    return Math.round(n).toLocaleString("en-US");
  }

  function renderEcofund() {
    var el = host("ecofund-host");
    var report = cacheState.ecofund;
    if (!el || !report) return;
    var current = report.currentPerPipLimit || {};
    var limit = atlasWhole(current.amount);
    var next = report.nextQuarter || {};
    var date = plainDate(next.date);
    var notes = ["Five percent of the Ecosystem Fund ATLAS balance after the last refill."];
    if (date !== "\u2014") notes.push("The next quarter is on or about " + date + ". The limit stays until a refill.");
    notes.push("Unpaid PIP amounts are not published, so none are subtracted.");
    var conversion = next.usdcConversionEffectOnAtlasLimit;
    if (conversion && conversion.status === "not_applicable") notes.push("A USDC refill does not change this ATLAS limit.");
    if (report.councilOverride) notes.push("Council figures are in the cards above.");
    if (!limit && !balancesAreLive()) notes.push("The limit is not in the cache yet.");
    var limitHtml = limit ? esc(limit) + ' <span class="unit">ATLAS</span>' : '<span class="missing-mark">\u2014</span>';
    el.innerHTML = '<div class="kpis"><article class="kpi"><div class="label">Computed 5% limit</div><div class="value">' +
      limitHtml + '</div></article><article class="kpi"><div class="label">Next quarter</div><div class="value">' +
      esc(date) + '</div></article></div><p class="hint">' + esc(notes.join(" ")) + "</p>";
  }

  function cacheFailure(error) {
    var message = (error && error.message) || String(error);
    if (/HTTP 404|Not Found|Failed to fetch/i.test(message)) {
      return "Treasury cache file is not published yet. No flows, payments, history, or PIP-23 figures were invented.";
    }
    return message;
  }

  async function loadCache() {
    var targets = ["flows-host", "ledger-host", "history-host", "ecofund-host"];
    try {
      var response = await fetch(cachePath(), { cache: "no-store" });
      if (!response.ok) throw new Error("Treasury cache HTTP " + response.status + ". No flows were invented.");
      var payload = await response.json();
      var dao = api();
      var report = dao.treasuryReport(payload);
      cacheState.payload = payload;
      cacheState.report = report;
      cacheState.ecofund = dao.ecofundReport(payload, councilOverride());
      cacheState.error = null;
      var loading = '<p class="hint">On-chain payment history is still loading into the cache.</p>';
      host("flows-host").innerHTML = report.flows && report.flows.rows && report.flows.rows.length ? publicHtml(dao.flowsSectionHtml(report)) : loading;
      host("ledger-host").innerHTML = report.payments && report.payments.payments && report.payments.payments.length ? publicHtml(dao.paymentsSectionHtml(report)) : loading;
      var historyReady = report.history && (report.history.series || []).some(seriesHasPoints);
      host("history-host").innerHTML = historyReady ? publicHtml(dao.historySectionHtml(report)) : '<p class="hint">History is still loading.</p>';
      renderEcofund();
      noteHealth({ source: "Treasury cache", status: "ok", asOf: report.asOf, detail: "Same-origin treasury cache." });
    } catch (error) {
      var message = cacheFailure(error);
      cacheState.error = message;
      targets.forEach(function (id) { fail(id, message); });
      noteHealth({ source: "Treasury cache", status: "missing", asOf: null, detail: message });
    }
    paintMatch();
  }

  function paintMatch() {
    var el = host("match-host");
    if (!el || !window.SA_DAO || !window.SA_DAO.matchTrackerToPayments) return;
    var sheet = window.SA_SHEET_STATE;
    if (!sheet) return;
    if (!sheet.ok) {
      fail("match-host", sheet.error || "The Tracker was not read, so payments were not matched.");
      return;
    }
    var dao = api();
    var parsed = dao.parseTrackerMoney(sheet.csv || "");
    var payments = [];
    if (cacheState.report && cacheState.report.payments) {
      payments = cacheState.report.payments.payments.filter(function (payment) {
        return payment.direction === "out" && payment.internal === false;
      }).map(function (payment) {
        return { signature: payment.signature, mint: payment.mint, symbol: payment.symbol, amount: payment.amount, time: payment.time };
      });
    }
    var report = dao.matchTrackerToPayments(parsed, payments, {
      chainRead: Boolean(cacheState.report),
      mintComplete: function (mint) { return cacheState.payload ? dao.mintCompleteFromCache(cacheState.payload, mint) : false; }
    });
    var waiting = (report.unresolved || []).some(function (item) { return /not complete|was not read/i.test(item.detail || ""); });
    if (waiting) {
      el.innerHTML = '<p class="hint">Matching starts once the cache is complete.</p>';
      return;
    }
    el.innerHTML = publicHtml(dao.matchSectionHtml(report));
  }

  async function onVote(event) {
    var more = event.target && event.target.closest ? event.target.closest("button.votes-more") : null;
    if (more) {
      var table = more.parentNode && more.parentNode.querySelector(".vote-table");
      if (!table) return;
      var open = table.classList.toggle("is-open");
      more.textContent = open ? "Show less" : "Show more";
      return;
    }
    var button = event.target && event.target.closest ? event.target.closest("button.vote-load") : null;
    if (!button) return;
    var detail = host("vote-detail");
    if (!detail) return;
    var id = button.getAttribute("data-proposal-id") || "";
    detail.replaceChildren();
    var pending = document.createElement("p");
    pending.className = "hint";
    pending.textContent = "Loading the votes file…";
    detail.appendChild(pending);
    try {
      var dao = api();
      var url = dao.votesUrl(galaxyBase(), id);
      var response = await fetch(url);
      if (!response.ok) throw new Error("Votes file HTTP " + response.status + ".");
      var votes = dao.parseVotes(await response.json());
      detail.innerHTML = voteDetailBlock(dao.summarizeVotes(votes, 0), new Date().toISOString());
    } catch (error) {
      detail.replaceChildren();
      var p = document.createElement("p");
      p.className = "hint";
      p.textContent = (error && error.message) || String(error);
      detail.appendChild(p);
    }
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function publicHtml(html) {
    return String(html)
      .replace(/<ul class="src">[\s\S]*?<\/ul>/g, "")
      .replace(/<div class="mcp-slot"[^>]*>\s*<\/div>/g, "")
      .replace(/<details class="mcp">[\s\S]*?<\/details>/g, "")
      .replace(/<p class="hint">Paid cells that are not a number:<\/p><ul class="fill-list">[\s\S]*?<\/ul>/g, "")
      .replace(/>(unknown)</g, "><span class=\"missing-mark\">\u2014</span><")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, function (iso) {
        var then = Date.parse(iso);
        if (Number.isNaN(then)) return iso;
        return new Date(then).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
      })
      .replace(/\b[a-z]{2,}(?:_[a-z0-9]+)+\b/g, function (word) { return word.replace(/_/g, " "); });
  }

  function compactPower(amount) {
    var n = Number(amount);
    if (!Number.isFinite(n)) return "\u2014";
    var sign = n < 0 ? "-" : "";
    var abs = Math.abs(n);
    var units = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
    for (var i = 0; i < units.length; i++) {
      if (abs >= units[i][0]) {
        var text = (abs / units[i][0]).toFixed(1);
        if (text.endsWith(".0")) text = text.slice(0, -2);
        return sign + text + units[i][1];
      }
    }
    var small = abs.toFixed(abs >= 100 ? 0 : 1);
    if (small.endsWith(".0")) small = small.slice(0, -2);
    return sign + small;
  }

  function compactCount(amount) {
    var n = Number(amount);
    if (!Number.isFinite(n)) return "\u2014";
    if (Math.abs(n) >= 100000) return compactPower(amount);
    if (Number.isInteger(n)) return n.toLocaleString("en-US");
    return compactPower(amount);
  }

  function choiceText(choice) {
    if (!choice || choice.count == null || choice.count === "") return "\u2014";
    return compactCount(choice.count);
  }

  function statusText(status) {
    return String(status || "\u2014").replace(/_/g, " ");
  }

  function updatedLabel(asOf) {
    var ago = window.SA_DAO && window.SA_DAO.updatedAgo ? window.SA_DAO.updatedAgo(asOf, Date.now()) : "";
    while (ago.indexOf("updated ") === 0) ago = ago.slice("updated ".length);
    if (ago) return ago;
    var then = Date.parse(asOf);
    if (!asOf || Number.isNaN(then)) return "";
    return new Date(then).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  }

  function votesTableHtml(rows, asOf) {
    var body = rows.map(function (row, index) {
      var power = row.votingPower == null ? "\u2014" : compactPower(row.votingPower);
      return '<tr' + (index >= 10 ? ' class="vote-extra"' : "") + ">" +
        '<td><div class="pip-line"><span class="pip">PIP-' + esc(row.pipNumber) + '</span><button type="button" class="vote-load" data-proposal-id="' + esc(row.id) + '">Votes</button></div><div class="name" title="' + esc(row.title) + '">' + esc(row.title) + "</div></td>" +
        '<td><span class="status none vote-status" title="' + esc(row.status) + '">' + esc(statusText(row.status)) + "</span></td>" +
        '<td class="num">' + esc(choiceText(row.yes)) + "</td>" +
        '<td class="num">' + esc(choiceText(row.no)) + "</td>" +
        '<td class="num">' + esc(choiceText(row.abstain)) + "</td>" +
        '<td class="num">' + esc(power) + "</td></tr>";
    }).join("");
    var more = rows.length > 10 ? '<button type="button" class="vote-load votes-more">Show more</button>' : "";
    return '<p class="asof"><span class="pill snap">Live \u00b7 updated ' + esc(updatedLabel(asOf)) + "</span></p>" +
      '<div class="table-wrap card-like vote-table"><table class="compact votes votes-main"><thead><tr>' +
      '<th>PIP</th><th>Status</th><th class="num">Yes</th><th class="num">No</th><th class="num">Abstain</th><th class="num">Voting power</th>' +
      "</tr></thead><tbody>" + body + "</tbody></table></div>" + more +
      '<div id="vote-detail"></div>';
  }

  function voteDetailBlock(summary, asOf) {
    var options = (summary.options || []).map(function (option) {
      return "<tr><td>" + esc(option.choice) + '</td><td class="num">' + esc(compactCount(option.count)) +
        '</td><td class="num">' + esc(compactPower(option.votingPower)) + "</td></tr>";
    }).join("");
    return '<p class="asof"><span class="pill snap">Live \u00b7 updated ' + esc(updatedLabel(asOf)) + "</span></p>" +
      '<p class="hint">' + esc(summary.voterCount) + " votes, " + esc(summary.uniqueWallets) + " wallets.</p>" +
      '<div class="table-wrap card-like"><table class="compact votes"><thead><tr><th>Choice</th><th class="num">Votes</th><th class="num">Voting power</th></tr></thead><tbody>' +
      options + "</tbody></table></div>";
  }

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var incomeState = { months: [], sources: [], full: false, open: false };

  function moneyNumber(amount) {
    var n = Number(amount);
    return Number.isFinite(n) ? n : null;
  }

  function shortDollar(n) {
    if (!Number.isFinite(n)) return "\u2014";
    var sign = n < 0 ? "-" : "";
    var abs = Math.abs(n);
    if (abs >= 1000000) {
      var millions = abs / 1000000;
      var millionText = millions >= 10 ? String(Math.round(millions)) : millions.toFixed(1);
      if (millionText.endsWith(".0")) millionText = millionText.slice(0, -2);
      return sign + "$" + millionText + "M";
    }
    if (abs >= 1000) {
      var thousands = abs / 1000;
      var thousandText = thousands.toFixed(1);
      if (thousandText.endsWith(".0")) thousandText = String(Math.round(thousands));
      return sign + "$" + thousandText + "K";
    }
    return sign + "$" + String(Math.round(abs));
  }

  function wholeDollar(n) {
    if (!Number.isFinite(n)) return "\u2014";
    var sign = n < 0 ? "-" : "";
    return sign + "$" + Math.abs(Math.round(n)).toLocaleString("en-US");
  }

  function groupDecimal(amount) {
    var s = String(amount == null ? "" : amount);
    if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return s;
    var neg = s.charAt(0) === "-";
    var body = neg ? s.slice(1) : s;
    var parts = body.split(".");
    var whole = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-" : "") + whole + (parts[1] ? "." + parts[1] : "");
  }

  function monthLabel(period) {
    var match = /^(\d{4})-(\d{2})/.exec(String(period || ""));
    if (!match) return String(period || "");
    var name = MONTHS[Number(match[2]) - 1] || match[2];
    return name + " " + match[1];
  }

  function niceStep(max, ticks) {
    var rough = max / Math.max(ticks, 1);
    if (!(rough > 0) || !Number.isFinite(rough)) return 1;
    var exp = Math.floor(Math.log10(rough));
    var pow = Math.pow(10, exp);
    var err = rough / pow;
    var mult = err <= 1 ? 1 : err <= 2 ? 2 : err <= 2.5 ? 2.5 : err <= 5 ? 5 : 10;
    return mult * pow;
  }

  function axisTop(max) {
    if (!(max > 0)) return 1;
    var step = niceStep(max, 4);
    var top = Math.ceil(max / step) * step;
    if (!Number.isFinite(top) || top <= 0) return step;
    return top;
  }

  function axisTicks(top) {
    var step = niceStep(top, 4);
    var count = Math.max(1, Math.round(top / step));
    var ticks = [];
    for (var i = 0; i <= count; i++) ticks.push(top - i * step);
    return ticks.map(function (value) { return Math.round(value * 100) / 100; });
  }

  function incomeScale(months) {
    var values = months.map(function (month) { return moneyNumber(month.usdcValue) || 0; })
      .filter(function (value) { return value > 0; })
      .sort(function (a, b) { return a - b; });
    var peak = values.length ? values[values.length - 1] : 0;
    var typical = values.length ? values[Math.floor(0.9 * (values.length - 1))] : peak;
    var hasOutlier = values.length > 4 && typical > 0 && peak > typical * 2.5;
    var cap = hasOutlier ? axisTop(typical) : axisTop(peak);
    var axisMax = !hasOutlier || incomeState.full ? axisTop(Math.max(peak, 1)) : cap;
    return { hasOutlier: hasOutlier, cap: cap, axisMax: axisMax, peak: peak };
  }

  function incomeChartHtml(months, scale) {
    var ticks = axisTicks(scale.axisMax);
    var yLabels = ticks.map(function (tick) { return "<span>" + esc(shortDollar(tick)) + "</span>"; }).join("");
    var lines = ticks.map(function (tick) {
      var top = scale.axisMax ? (1 - tick / scale.axisMax) * 100 : 100;
      return '<span class="income-gridline" style="top:' + top.toFixed(2) + '%"></span>';
    }).join("");
    var bars = months.map(function (month) {
      var value = moneyNumber(month.usdcValue) || 0;
      var capped = scale.hasOutlier && !incomeState.full && value > scale.cap;
      var height = scale.axisMax ? Math.min(value, scale.axisMax) / scale.axisMax * 100 : 0;
      var label = monthLabel(month.period);
      var tip = label + " \u00b7 " + shortDollar(value);
      var flag = capped ? '<span class="income-cap-label">' + esc(shortDollar(value)) + "</span>" : "";
      return '<div class="income-col' + (capped ? " is-capped" : "") + '" title="' + esc(tip) + '" aria-label="' + esc(tip) + '">' +
        flag + '<span class="income-bar" style="height:' + height.toFixed(2) + '%"></span></div>';
    }).join("");
    var seenYear = {};
    var years = months.map(function (month, index) {
      var year = String(month.period || "").slice(0, 4);
      if (!year || seenYear[year]) return "";
      seenYear[year] = true;
      var pct = ((index + 0.5) / months.length) * 100;
      var place = pct < 6 ? "left:0;transform:none" : pct > 94 ? "left:100%;transform:translateX(-100%)" : "left:" + pct.toFixed(2) + "%";
      return '<span class="income-year" style="' + place + '">' + esc(year) + "</span>";
    }).join("");
    var minWidth = Math.max(months.length * 14, 280);
    return '<div class="income-scroll"><div class="income-layout">' +
      '<div class="income-y">' + yLabels + "</div>" +
      '<div class="income-main" style="min-width:' + minWidth + 'px">' +
      '<div class="income-plot">' + lines + '<div class="income-bars">' + bars + "</div></div>" +
      '<div class="income-x">' + years + "</div></div></div></div>";
  }

  function incomeNote(months, scale) {
    var high = months.filter(function (month) { return (moneyNumber(month.usdcValue) || 0) > scale.cap; });
    if (!high.length) return "";
    var named = high.map(function (month) {
      return monthLabel(month.period) + " is " + shortDollar(moneyNumber(month.usdcValue));
    }).join(", ");
    if (incomeState.full) return "Full scale. " + named + ".";
    return named + ". The axis stops at " + shortDollar(scale.cap) + " so the other months stay readable.";
  }

  function renderIncome() {
    var el = host("revenue-host");
    if (!el) return;
    var months = incomeState.months || [];
    if (!months.length) {
      el.innerHTML = '<p class="hint">No monthly income was published.</p>';
      return;
    }
    var scale = incomeScale(months);
    var note = incomeNote(months, scale);
    var toggle = scale.hasOutlier
      ? '<button type="button" class="vote-load income-scale">' + (incomeState.full ? "Cap the axis" : "Show full scale") + "</button>"
      : "";
    var listed = months.slice().reverse();
    var body = listed.map(function (month, index) {
      var value = moneyNumber(month.usdcValue);
      return "<tr" + (index >= 12 ? ' class="income-extra"' : "") + "><td>" + esc(monthLabel(month.period)) +
        '</td><td class="num">' + esc(wholeDollar(value)) + "</td></tr>";
    }).join("");
    var more = listed.length > 12
      ? '<button type="button" class="vote-load income-more">' + (incomeState.open ? "Show latest 12" : "Show all") + "</button>"
      : "";
    var sources = (incomeState.sources || []).map(function (source) {
      return "<tr><td>" + esc(source.segmentation) + "</td><td>" + esc(source.mint) +
        '</td><td class="num">' + esc(groupDecimal(source.amount)) + '</td><td class="num">' +
        esc(wholeDollar(moneyNumber(source.usdcValue))) + '</td><td class="num">' + esc(source.months) + "</td></tr>";
    }).join("");
    var sourceTable = sources
      ? '<h3 class="sub-head">By source</h3><div class="table-wrap card-like"><table class="compact"><thead><tr><th>Source</th><th>Mint</th><th class="num">Amount</th><th class="num">USDC</th><th class="num">Months</th></tr></thead><tbody>' +
        sources + "</tbody></table></div>"
      : "";
    el.innerHTML = '<div class="income-tools">' + toggle + (note ? '<p class="hint">' + esc(note) + "</p>" : "") + "</div>" +
      incomeChartHtml(months, scale) +
      '<div class="table-wrap card-like income-table' + (incomeState.open ? " is-open" : "") + '"><table class="compact"><thead><tr><th>Period</th><th class="num">USDC</th></tr></thead><tbody>' +
      body + "</tbody></table></div>" + more + sourceTable;
  }

  function onIncomeClick(event) {
    var button = event.target && event.target.closest ? event.target.closest("button") : null;
    if (!button) return;
    if (button.classList.contains("income-scale")) {
      incomeState.full = !incomeState.full;
      renderIncome();
    } else if (button.classList.contains("income-more")) {
      incomeState.open = !incomeState.open;
      renderIncome();
    }
  }

  async function loadGalaxy() {
    try {
      var dao = api();
      var base = galaxyBase();
      var proposalsUrl = base + "/proposals";
      var response = await fetch(proposalsUrl);
      if (!response.ok) throw new Error("Proposals HTTP " + response.status + ".");
      var asOf = new Date().toISOString();
      var proposals = dao.parseProposals(await response.json());
      var galaxyHost = host("galaxy-host");
      galaxyHost.innerHTML = votesTableHtml(dao.proposalVoteTable(proposals), asOf);
      galaxyHost.addEventListener("click", onVote);
      noteHealth({ source: "Galaxy proposals", status: "ok", asOf: asOf, detail: proposalsUrl });
    } catch (error) {
      var proposalError = (error && error.message) || String(error);
      fail("galaxy-host", proposalError);
      noteHealth({ source: "Galaxy proposals", status: "error", asOf: new Date().toISOString(), detail: proposalError });
    }
    try {
      var revenueDao = api();
      var revenueUrl = galaxyBase() + "/dao/treasury";
      var revenueResponse = await fetch(revenueUrl);
      if (!revenueResponse.ok) throw new Error("Revenue HTTP " + revenueResponse.status + ".");
      var fetchedAt = new Date().toISOString();
      var revenueView = revenueDao.revenueView(await revenueResponse.json());
      incomeState.months = revenueView.monthlyUsdc || [];
      incomeState.sources = revenueView.bySource || [];
      renderIncome();
      noteHealth({ source: "Galaxy revenue", status: "ok", asOf: fetchedAt, detail: revenueUrl });
    } catch (error) {
      var revenueError = (error && error.message) || String(error);
      fail("revenue-host", revenueError);
      noteHealth({ source: "Galaxy revenue", status: "error", asOf: new Date().toISOString(), detail: revenueError });
    }
  }

  document.addEventListener("sa-sheet", paintMatch);
  document.addEventListener("sa-balances", renderEcofund);
  var revenueHost = host("revenue-host");
  if (revenueHost) revenueHost.addEventListener("click", onIncomeClick);
  loadCache();
  loadGalaxy();
})();
