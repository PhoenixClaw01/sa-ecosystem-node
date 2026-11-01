"use strict";
var SA_DAO = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/dao/browser-entry.ts
  var browser_entry_exports = {};
  __export(browser_entry_exports, {
    addDecimalStrings: () => addDecimalStrings,
    approximateUsd: () => approximateUsd,
    chartPath: () => chartPath,
    createFallbackRpc: () => createFallbackRpc,
    dataHealthSectionHtml: () => dataHealthSectionHtml,
    ecofundReport: () => ecofundReport,
    ecofundSectionHtml: () => ecofundSectionHtml,
    flowsSectionHtml: () => flowsSectionHtml,
    formatRaw: () => formatRaw,
    historySectionHtml: () => historySectionHtml,
    liveReadStamp: () => liveReadStamp,
    matchSectionHtml: () => matchSectionHtml,
    matchTrackerToPayments: () => matchTrackerToPayments,
    mintCompleteFromCache: () => mintCompleteFromCache,
    monthlyIncome: () => monthlyIncome,
    parseJupiterPrices: () => parseJupiterPrices,
    parseProposals: () => parseProposals,
    parseRevenue: () => parseRevenue,
    parseTrackerMoney: () => parseTrackerMoney,
    parseVotes: () => parseVotes,
    paymentsSectionHtml: () => paymentsSectionHtml,
    proposalTableHtml: () => proposalTableHtml,
    proposalVoteTable: () => proposalVoteTable,
    readBalancesWithFallback: () => readBalancesWithFallback,
    revenueSectionHtml: () => revenueSectionHtml,
    revenueView: () => revenueView,
    solanaRpcUrls: () => solanaRpcUrls,
    summarizeRevenue: () => summarizeRevenue,
    summarizeVotes: () => summarizeVotes,
    treasuryReport: () => treasuryReport,
    updatedAgo: () => updatedAgo,
    voteDetailHtml: () => voteDetailHtml,
    votesUrl: () => votesUrl
  });

  // src/errors.ts
  var UserInputError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "UserInputError";
    }
  };
  var SafeClientError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "SafeClientError";
    }
  };
  function publicErrorMessage(error) {
    const raw = error instanceof Error ? error.message : "Request failed";
    const redacted = raw.replace(/https?:\/\/\S+/g, "[rpc]").split("\n").filter((line) => !/^\s*at\s+/.test(line)).join(" ").replace(/\s+/g, " ").trim();
    const message = redacted || "Request failed";
    return message.length > 500 ? `${message.slice(0, 500)}\u2026` : message;
  }

  // src/dao/amount.ts
  function parseUiAmount(value, decimals, label = "amount") {
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
  function formatRaw(raw, decimals) {
    const negative = raw < 0n;
    const abs2 = negative ? -raw : raw;
    const scale = 10n ** BigInt(decimals);
    const whole = abs2 / scale;
    const frac = abs2 % scale;
    let text = whole.toString();
    if (frac !== 0n) {
      text += `.${frac.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
    }
    return negative ? `-${text}` : text;
  }
  function formatScaled(numerator, denominator, decimals) {
    if (denominator <= 0n) throw new Error("denominator must be positive.");
    const negative = numerator < 0n;
    const abs2 = negative ? -numerator : numerator;
    const div = denominator * 10n ** BigInt(decimals);
    const whole = abs2 / div;
    let rem = abs2 % div;
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
    if (!exact) text += "\u2026";
    return { text: negative ? `-${text}` : text, exact };
  }
  function addDecimalStrings(values) {
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
  function compareDecimal(left, right) {
    const sum = addDecimalStrings([left, right.startsWith("-") ? right.slice(1) : `-${right}`]);
    if (sum === "0") return 0;
    return sum.startsWith("-") ? -1 : 1;
  }
  function utcDay(unixSeconds) {
    return new Date(unixSeconds * 1e3).toISOString().slice(0, 10);
  }
  function utcMonth(unixSeconds) {
    return new Date(unixSeconds * 1e3).toISOString().slice(0, 7);
  }
  function dayBefore(isoDay) {
    const time = Date.parse(`${isoDay}T00:00:00Z`);
    if (Number.isNaN(time)) throw new Error(`Bad day ${isoDay}.`);
    return new Date(time - 864e5).toISOString().slice(0, 10);
  }
  function monthEnd(month) {
    const match = /^(\d{4})-(\d{2})$/.exec(month);
    if (!match) throw new Error(`Bad month ${month}.`);
    const year = Number(match[1]);
    const mon = Number(match[2]);
    const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
    return `${month}-${String(last).padStart(2, "0")}`;
  }
  function isoFromUnix(unixSeconds) {
    return new Date(unixSeconds * 1e3).toISOString();
  }

  // src/dao/freshness.ts
  function liveReadStamp(iso) {
    const then = Date.parse(iso);
    if (!iso || Number.isNaN(then)) return "";
    const date = new Date(then);
    const hours = String(date.getUTCHours()).padStart(2, "0");
    const minutes = String(date.getUTCMinutes()).padStart(2, "0");
    return `live, read at ${hours}:${minutes} UTC`;
  }
  function updatedAgo(asOf, nowMs) {
    const then = Date.parse(asOf);
    if (!asOf || Number.isNaN(then)) return "";
    const seconds = Math.max(0, Math.floor((nowMs - then) / 1e3));
    if (seconds < 45) return "updated just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return `updated ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 48) {
      return `updated ${hours} hour${hours === 1 ? "" : "s"} ago`;
    }
    const days = Math.floor(hours / 24);
    return `updated ${days} day${days === 1 ? "" : "s"} ago`;
  }

  // src/dao/wallets.ts
  var DAO_TREASURY_ADDRESS = "CuwnarNh7FEqZMmffFjRyWj54RecyS7zwFg1CxfzNudi";
  var ECOSYSTEM_FUND_ADDRESS = "BxKehkp298nQunu8BWxh5U6VvfphFyjEB3t7USst7Uag";
  var WALLET_SOURCE_URL = "https://star-atlas-dao.gitbook.io/knowledge-base/overview/treasury";
  var PIP23_URL = "https://govern.staratlas.com/proposals/0ecf2928-15df-497e-8b67-d87eda030d5a";
  var PIP4_URL = "https://star-atlas-dao.gitbook.io/knowledge-base/archive/foundational-pips/pip-4-star-atlas-ecosystem-fund";
  var ATLAS_MINT = "ATLASXmbPQxBUYbxPsV97usA3fPQYEqzQBUHgiFCUsXx";
  var ATLAS_DECIMALS = 8;
  var USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  var USDC_SOURCE_URL = "https://developers.circle.com/stablecoins/usdc-contract-addresses";
  var GALAXY_VOTES_PATH = "/proposals/votes";
  var NATIVE_MINT = "native";
  var SOL_DECIMALS = 9;
  var PIP23_QUARTER_DATES = [
    { month: 3, day: 31 },
    { month: 6, day: 20 },
    { month: 9, day: 30 },
    { month: 12, day: 31 }
  ];
  var USDC_REFILL_THRESHOLD = "500000";
  var TRACKED_WALLETS = [
    { role: "dao_treasury", address: DAO_TREASURY_ADDRESS, name: "DAO Treasury" },
    { role: "ecosystem_fund", address: ECOSYSTEM_FUND_ADDRESS, name: "Ecosystem Fund" }
  ];
  function roleOf(address) {
    return TRACKED_WALLETS.find((wallet) => wallet.address === address)?.role;
  }
  function walletByRole(role) {
    const wallet = TRACKED_WALLETS.find((item) => item.role === role);
    if (!wallet) throw new Error(`Unknown wallet role ${role}.`);
    return wallet;
  }
  function symbolForMint(mint) {
    if (mint === ATLAS_MINT) return "ATLAS";
    if (mint === USDC_MINT) return "USDC";
    if (mint === NATIVE_MINT) return "SOL";
    return null;
  }
  function solscanTx(signature) {
    return `https://solscan.io/tx/${signature}`;
  }

  // src/dao/aggregate.ts
  var MONTH = /^\d{4}-\d{2}$/;
  var DAY = /^\d{4}-\d{2}-\d{2}$/;
  function emptyBucket() {
    return {
      externalInRaw: 0n,
      externalOutRaw: 0n,
      internalInRaw: 0n,
      internalOutRaw: 0n,
      unattributedRaw: 0n,
      feeRaw: 0n
    };
  }
  function resolveRole(input) {
    if (!input) return void 0;
    if (input === "dao_treasury" || input === "ecosystem_fund") return input;
    const role = roleOf(input);
    if (!role) {
      throw new UserInputError("wallet must be dao_treasury, ecosystem_fund, or one of those two published addresses.");
    }
    return role;
  }
  function resolveMint(input) {
    if (!input) return void 0;
    const upper = input.toUpperCase();
    if (upper === "ATLAS") return ATLAS_MINT;
    if (upper === "USDC") return USDC_MINT;
    if (upper === "SOL" || input === NATIVE_MINT) return NATIVE_MINT;
    if (input === ATLAS_MINT || input === USDC_MINT) return input;
    throw new UserInputError("mint must be ATLAS, USDC, or SOL.");
  }
  function assertMonth(value, label) {
    if (!value) return void 0;
    if (!MONTH.test(value)) throw new UserInputError(`${label} must be YYYY-MM.`);
    return value;
  }
  function assertDay(value, label) {
    if (!value) return void 0;
    if (!DAY.test(value)) throw new UserInputError(`${label} must be YYYY-MM-DD.`);
    return value;
  }
  function cursorComplete(cache, role, mint) {
    if (!cache.discovery) return false;
    if (mint === ATLAS_MINT && role === "dao_treasury") {
      const wallet = cache.cursors.find((cursor) => cursor.role === role && cursor.kind === "wallet");
      const sample = cache.atlasScan?.assumption === "holds" && (cache.atlasScan?.undatedCount ?? 1) === 0;
      return Boolean(wallet?.reachedEnd && wallet.gaps.length === 0 && sample);
    }
    if (mint === NATIVE_MINT) {
      const wallet = cache.cursors.find((cursor) => cursor.role === role && cursor.kind === "wallet");
      return Boolean(wallet?.reachedEnd && wallet.gaps.length === 0 && wallet.reconciled === true);
    }
    const token = cache.cursors.find((cursor) => cursor.role === role && cursor.kind === "token" && cursor.mint === mint);
    if (!token) return !cache.tokenAccounts.some((account) => account.role === role && account.mint === mint);
    return token.reachedEnd && token.gaps.length === 0 && token.reconciled === true;
  }
  function addAmount(bucket, movement, amount) {
    if (amount === 0n) return;
    if (movement.attribution === "unattributed") {
      bucket.unattributedRaw += amount;
      return;
    }
    const inbound = amount > 0n;
    const abs2 = inbound ? amount : -amount;
    if (movement.internal) {
      if (inbound) bucket.internalInRaw += abs2;
      else bucket.internalOutRaw += abs2;
      return;
    }
    if (inbound) bucket.externalInRaw += abs2;
    else bucket.externalOutRaw += abs2;
  }
  function addMovement(bucket, movement) {
    if (movement.mint === NATIVE_MINT) {
      const fee = BigInt(movement.feeRaw ?? "0");
      if (fee > 0n) bucket.feeRaw += fee;
      addAmount(bucket, movement, BigInt(movement.transferRaw ?? "0"));
      return;
    }
    addAmount(bucket, movement, BigInt(movement.deltaRaw));
  }
  function ui(raw, decimals) {
    return formatRaw(raw, decimals);
  }
  function decimalsFor(cache, mint, movements) {
    const movement = movements.find((item) => item.mint === mint);
    if (movement) return movement.decimals;
    const account = cache.tokenAccounts.find((item) => item.mint === mint);
    if (account) return account.decimals;
    if (mint === NATIVE_MINT) return 9;
    if (mint === ATLAS_MINT) return 8;
    if (mint === USDC_MINT) return 6;
    return 0;
  }
  function scanBounds(scan) {
    const days = Object.keys(scan.days).sort();
    const minDay = days[0];
    const maxDay = days[days.length - 1];
    if (!minDay || !maxDay) return null;
    return { minDay, maxDay };
  }
  function balanceAtEndOf(scan, day, minDay, maxDay) {
    if (day < minDay || day > maxDay) return null;
    const activity = Object.keys(scan.days).filter((item) => item >= minDay && item <= day).sort();
    const latest = activity[activity.length - 1];
    if (!latest) return null;
    const snapshot = scan.snapshots[latest];
    if (!snapshot) return null;
    return BigInt(snapshot.postRaw);
  }
  function treasuryAtlasInflow(cache, month, movements) {
    const scan = cache.atlasScan;
    if (!scan) return { status: "unknown", reason: "The ATLAS token-account scan has not started." };
    if (scan.undatedCount > 0) {
      return { status: "unknown", reason: "The ATLAS scan has signatures with no block time, so a month cannot be closed." };
    }
    if (scan.assumption === "failed") {
      return {
        status: "unknown",
        reason: "A sampled ATLAS-account transaction decreased the treasury outside the vault-wallet set. Inflows are withheld."
      };
    }
    if (scan.assumption !== "holds") {
      return { status: "unknown", reason: "The ATLAS outflow sample has not been checked yet. Inflows are withheld." };
    }
    const bounds = scanBounds(scan);
    if (!bounds) return { status: "unknown", reason: "The ATLAS scan has no dated signatures." };
    const startDay = `${month}-01`;
    const endDay = monthEnd(month);
    const through = endDay <= bounds.maxDay ? endDay : bounds.maxDay;
    if (through < startDay) return { status: "unknown", reason: "That month is outside the scanned ATLAS range." };
    let startRaw = null;
    if (bounds.minDay < startDay) {
      startRaw = balanceAtEndOf(scan, dayBefore(startDay), bounds.minDay, bounds.maxDay);
      if (startRaw === null) return { status: "unknown", reason: "The balance at the start of the month is not in the cache." };
    } else if (scan.reachedEnd && scan.opening && utcMonth(scan.opening.blockTime) === month) {
      startRaw = BigInt(scan.opening.preRaw);
    } else {
      return { status: "unknown", reason: "The ATLAS scan has not reached the start of this month." };
    }
    const endRaw = balanceAtEndOf(scan, through, bounds.minDay, bounds.maxDay);
    if (endRaw === null) return { status: "unknown", reason: "The balance at the end of the scanned window is missing." };
    const window = movements.filter((movement) => {
      const day = utcDay(movement.blockTime);
      return day >= startDay && day <= through;
    });
    let parsedNet = 0n;
    let parsedExternalIn = 0n;
    for (const movement of window) parsedNet += BigInt(movement.deltaRaw);
    for (const movement of window) {
      if (movement.direction === "in" && !movement.internal && movement.attribution === "counterparty") {
        parsedExternalIn += BigInt(movement.deltaRaw);
      }
    }
    const residual = endRaw - startRaw - parsedNet;
    if (residual < 0n) {
      return {
        status: "unknown",
        reason: "The balance rose by less than the parsed transactions. An outflow may be missing, so the inflow is withheld."
      };
    }
    return {
      status: "known",
      amountRaw: parsedExternalIn + residual,
      through,
      monthClosed: through === endDay
    };
  }
  var FLOW_MINTS = [ATLAS_MINT, USDC_MINT, NATIVE_MINT];
  function buildFlows(cache, query) {
    const roleFilter = resolveRole(query.wallet);
    const mintFilter = resolveMint(query.mint);
    const from = assertMonth(query.from, "from");
    const to = assertMonth(query.to, "to");
    const roles = roleFilter ? [roleFilter] : ["dao_treasury", "ecosystem_fund"];
    const mints = mintFilter ? [mintFilter] : [...FLOW_MINTS];
    const rows = [];
    const omitted = [];
    for (const role of roles) {
      for (const mint of mints) {
        const movements = cache.movements.filter((movement) => movement.role === role && movement.mint === mint);
        const decimals = decimalsFor(cache, mint, movements);
        const months = /* @__PURE__ */ new Set();
        for (const movement of movements) months.add(utcMonth(movement.blockTime));
        if (mint === ATLAS_MINT && role === "dao_treasury" && cache.atlasScan) {
          for (const day of Object.keys(cache.atlasScan.days)) months.add(day.slice(0, 7));
          if (cache.atlasScan.opening) months.add(utcMonth(cache.atlasScan.opening.blockTime));
        }
        const ordered = [...months].filter((month) => (!from || month >= from) && (!to || month <= to)).sort();
        if (ordered.length === 0 && !cursorComplete(cache, role, mint)) {
          omitted.push({ role, mint, reason: coverageReason(cache, role, mint) });
          continue;
        }
        for (const month of ordered) {
          const monthMovements = movements.filter((movement) => utcMonth(movement.blockTime) === month);
          const bucket = emptyBucket();
          for (const movement of monthMovements) addMovement(bucket, movement);
          const parsedReady = cursorComplete(cache, role, mint) || query.allowPartial === true;
          if (!parsedReady && !(mint === ATLAS_MINT && role === "dao_treasury")) {
            omitted.push({ role, mint, reason: coverageReason(cache, role, mint) });
            break;
          }
          let externalIn = ui(bucket.externalInRaw, decimals);
          let externalInStatus = "known";
          let externalInReason;
          let method = "parsed";
          let through;
          let monthClosed = true;
          let complete = cursorComplete(cache, role, mint);
          if (mint === ATLAS_MINT && role === "dao_treasury") {
            method = "residual";
            const inferred = treasuryAtlasInflow(cache, month, monthMovements);
            through = inferred.through;
            monthClosed = inferred.monthClosed ?? false;
            if (inferred.status === "known" && inferred.amountRaw !== void 0) {
              externalIn = ui(inferred.amountRaw, decimals);
              complete = true;
            } else {
              externalIn = null;
              externalInStatus = "unknown";
              externalInReason = inferred.reason;
              complete = false;
              if (!query.allowPartial) {
                if (!omitted.some((item) => item.role === role && item.mint === mint)) {
                  omitted.push({ role, mint, reason: inferred.reason ?? "ATLAS inflow is unknown." });
                }
                continue;
              }
            }
          }
          rows.push({
            month,
            through: through ?? monthEnd(month),
            monthClosed,
            wallet: walletByRole(role).address,
            role,
            mint,
            symbol: symbolForMint(mint),
            decimals,
            method,
            complete,
            externalIn,
            externalInStatus,
            externalInReason: externalInReason ?? null,
            externalOut: ui(bucket.externalOutRaw, decimals),
            internalIn: ui(bucket.internalInRaw, decimals),
            internalOut: ui(bucket.internalOutRaw, decimals),
            unattributed: ui(bucket.unattributedRaw, decimals),
            fees: mint === NATIVE_MINT ? ui(bucket.feeRaw, decimals) : "0"
          });
        }
      }
    }
    if (!query.allowPartial) {
      const kept = [];
      const seen = /* @__PURE__ */ new Set();
      for (const row of rows) {
        if (!row.complete) {
          const key = `${row.role}:${row.mint}`;
          if (!seen.has(key)) {
            seen.add(key);
            omitted.push({ role: row.role, mint: row.mint, reason: row.externalInReason ?? coverageReason(cache, row.role, row.mint) });
          }
          continue;
        }
        kept.push(row);
      }
      return { rows: kept, omitted, notes: FLOW_NOTES };
    }
    return { rows, omitted, notes: FLOW_NOTES };
  }
  function coverageReason(cache, role, mint) {
    if (!cache.discovery) return "Token accounts have not been discovered. Run npm run refresh-treasury.";
    if (mint === ATLAS_MINT && role === "dao_treasury") {
      if (cache.atlasScan?.assumption === "failed") return "The ATLAS sample found an outflow outside the vault-wallet transactions.";
      if (cache.atlasScan?.assumption !== "holds") return "The ATLAS account sample is not checked, so treasury ATLAS coverage is incomplete.";
      return "The DAO Treasury wallet signature backfill is incomplete.";
    }
    return `The ${symbolForMint(mint) ?? mint} backfill for ${role} is incomplete or did not reconcile to the RPC balance.`;
  }
  var FLOW_NOTES = [
    "USDC, Ecosystem Fund ATLAS, and SOL are sums of parsed balance changes.",
    "DAO Treasury ATLAS inflows are the balance change minus parsed treasury ATLAS movements. That residual is published only when a sample of the other ATLAS-account signatures did not decrease the balance.",
    "Internal means the counterparty is the other published wallet. Unattributed means the counterparty amounts did not add up, and those amounts are not folded into inflows or outflows."
  ];
  function buildPayments(cache, query) {
    const roleFilter = resolveRole(query.wallet);
    const mintFilter = resolveMint(query.mint);
    const from = assertMonth(query.from, "from");
    const to = assertMonth(query.to, "to");
    const direction = query.direction ?? "out";
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new UserInputError("limit must be from 1 to 500.");
    if (!Number.isInteger(offset) || offset < 0) throw new UserInputError("offset must be a non-negative integer.");
    const omitted = [];
    const selected = cache.movements.filter((movement) => {
      if (roleFilter && movement.role !== roleFilter) return false;
      if (mintFilter && movement.mint !== mintFilter) return false;
      if (!mintFilter && movement.mint !== ATLAS_MINT && movement.mint !== USDC_MINT && movement.mint !== NATIVE_MINT) {
        return false;
      }
      const month = utcMonth(movement.blockTime);
      if (from && month < from) return false;
      if (to && month > to) return false;
      if (direction !== "all" && movement.direction !== direction) return false;
      if (!query.includeInternal && movement.internal) return false;
      if (!query.includeFees && movement.attribution === "fee") return false;
      return true;
    });
    const visible = selected.filter((movement) => {
      const ready = cursorComplete(cache, movement.role, movement.mint);
      if (!ready && !query.allowPartial) {
        const key = `${movement.role}:${movement.mint}`;
        if (!omitted.some((item) => `${item.role}:${item.mint}` === key)) {
          omitted.push({ role: movement.role, mint: movement.mint, reason: coverageReason(cache, movement.role, movement.mint) });
        }
        return false;
      }
      return true;
    });
    visible.sort((left, right) => right.blockTime - left.blockTime || right.slot - left.slot || left.signature.localeCompare(right.signature));
    const page = visible.slice(offset, offset + limit);
    return {
      total: visible.length,
      offset,
      limit,
      truncated: offset + page.length < visible.length,
      omitted,
      payments: page.map((movement) => ({
        signature: movement.signature,
        solscanUrl: solscanTx(movement.signature),
        blockTime: movement.blockTime,
        time: isoFromUnix(movement.blockTime),
        wallet: movement.wallet,
        role: movement.role,
        mint: movement.mint,
        symbol: movement.symbol,
        amountRaw: (movement.mint === NATIVE_MINT ? BigInt(movement.transferRaw ?? movement.deltaRaw) : BigInt(movement.deltaRaw)).toString().replace(/^-/, ""),
        amount: formatRaw(
          movement.mint === NATIVE_MINT ? abs(BigInt(movement.transferRaw ?? movement.deltaRaw)) : abs(BigInt(movement.deltaRaw)),
          movement.decimals
        ),
        direction: movement.direction,
        internal: movement.internal,
        attribution: movement.attribution,
        counterparties: movement.counterparties,
        complete: cursorComplete(cache, movement.role, movement.mint)
      })),
      notes: [
        "Payments default to external outflows. Internal vault-to-vault transfers and SOL network fees are omitted unless requested.",
        "DAO Treasury ATLAS rows are complete only after the vault-wallet backfill and the ATLAS-account outflow sample both pass. The sample is not a fetch of every fee drip."
      ]
    };
  }
  function abs(value) {
    return value < 0n ? -value : value;
  }
  function buildHistory(cache, query) {
    const roleFilter = resolveRole(query.wallet);
    const mintFilter = resolveMint(query.mint);
    const from = assertDay(query.from, "from");
    const to = assertDay(query.to, "to");
    const granularity = query.granularity ?? "month";
    if (granularity !== "day" && granularity !== "month") throw new UserInputError("granularity must be day or month.");
    const roles = roleFilter ? [roleFilter] : ["dao_treasury", "ecosystem_fund"];
    const mints = mintFilter ? [mintFilter] : [...FLOW_MINTS];
    const series = [];
    const omitted = [];
    for (const role of roles) {
      for (const mint of mints) {
        if (mint === ATLAS_MINT && role === "dao_treasury") {
          const built = atlasSnapshotSeries(cache, granularity, from, to);
          if (built.status === "unknown") {
            if (query.allowPartial) {
              series.push({ role, wallet: walletByRole(role).address, mint, symbol: "ATLAS", ...built });
            } else omitted.push({ role, mint, reason: built.reason });
            continue;
          }
          series.push({ role, wallet: walletByRole(role).address, mint, symbol: "ATLAS", method: "end_of_day_snapshot", ...built });
          continue;
        }
        if (!cursorComplete(cache, role, mint) && !query.allowPartial) {
          omitted.push({ role, mint, reason: coverageReason(cache, role, mint) });
          continue;
        }
        const points = replaySeries(
          cache.movements.filter((movement) => movement.role === role && movement.mint === mint),
          granularity,
          from,
          to
        );
        series.push({
          role,
          wallet: walletByRole(role).address,
          mint,
          symbol: symbolForMint(mint),
          method: "replay",
          status: "known",
          complete: cursorComplete(cache, role, mint),
          points
        });
      }
    }
    return {
      granularity,
      series,
      omitted,
      notes: [
        "DAO Treasury ATLAS is the end-of-day post-balance of the last signature that day, carried across days with no signatures.",
        "Other series replay parsed post-balances. A series is omitted when its backfill is incomplete unless allowPartial is set."
      ]
    };
  }
  function replaySeries(movements, granularity, from, to) {
    const sorted = [...movements].sort((left, right) => left.blockTime - right.blockTime || left.slot - right.slot);
    if (sorted.length === 0) return [];
    const decimals = sorted[0]?.decimals ?? 0;
    const byDay = /* @__PURE__ */ new Map();
    for (const movement of sorted) {
      byDay.set(utcDay(movement.blockTime), BigInt(movement.postRaw));
    }
    const days = [...byDay.keys()].sort();
    const first = days[0];
    const last = days[days.length - 1];
    if (!first || !last) return [];
    const points = [];
    let cursor = first;
    let balance = byDay.get(first) ?? 0n;
    while (cursor <= last) {
      const next = byDay.get(cursor);
      if (next !== void 0) balance = next;
      const emit = granularity === "day" || cursor === last || cursor === monthEnd(cursor.slice(0, 7));
      if (emit && (!from || cursor >= from) && (!to || cursor <= to)) {
        points.push({ day: cursor, amount: formatRaw(balance, decimals), amountRaw: balance.toString() });
      }
      cursor = utcDay(Math.floor(Date.parse(`${cursor}T00:00:00Z`) / 1e3) + 86400);
    }
    return points;
  }
  function atlasSnapshotSeries(cache, granularity, from, to) {
    const scan = cache.atlasScan;
    if (!scan || scan.assumption !== "holds" || scan.undatedCount > 0) {
      return {
        status: "unknown",
        complete: false,
        reason: scan ? coverageReason(cache, "dao_treasury", ATLAS_MINT) : "The ATLAS token-account scan has not started."
      };
    }
    const bounds = scanBounds(scan);
    if (!bounds) return { status: "unknown", complete: false, reason: "The ATLAS scan has no dated signatures." };
    const decimals = Object.values(scan.snapshots)[0]?.decimals ?? 8;
    const points = [];
    let cursor = bounds.minDay;
    let balance = null;
    while (cursor <= bounds.maxDay) {
      const activity = scan.days[cursor];
      if (activity) {
        const snapshot = scan.snapshots[cursor];
        if (!snapshot) {
          return { status: "unknown", complete: false, reason: `The ${cursor} ATLAS snapshot transaction was not read.` };
        }
        balance = BigInt(snapshot.postRaw);
      }
      if (balance !== null && (!from || cursor >= from) && (!to || cursor <= to)) {
        const emit = granularity === "day" || cursor === bounds.maxDay || cursor === monthEnd(cursor.slice(0, 7));
        if (emit) points.push({ day: cursor, amount: formatRaw(balance, decimals), amountRaw: balance.toString() });
      }
      cursor = utcDay(Math.floor(Date.parse(`${cursor}T00:00:00Z`) / 1e3) + 86400);
    }
    return { status: "known", complete: scan.reachedEnd, points };
  }

  // src/dao/types.ts
  var CACHE_SCHEMA_VERSION = 1;

  // src/dao/cache-json.ts
  function parseTreasuryCache(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SafeClientError("The treasury cache was not an object. No balances were invented.");
    }
    const cache = parsed;
    if (cache.schemaVersion !== CACHE_SCHEMA_VERSION) {
      throw new SafeClientError("The treasury cache schema is not version 1. No balances were invented.");
    }
    if (typeof cache.generatedAt !== "string" || cache.generatedAt.length < 4) {
      throw new SafeClientError("The treasury cache has no generatedAt timestamp.");
    }
    if (!Array.isArray(cache.movements) || !Array.isArray(cache.balances) || !Array.isArray(cache.cursors)) {
      throw new SafeClientError("The treasury cache is missing movements, balances, or cursors.");
    }
    if (!Array.isArray(cache.tokenAccounts)) {
      throw new SafeClientError("The treasury cache is missing token account discovery.");
    }
    return cache;
  }

  // src/dao/ecofund.ts
  var REFILL_DETECTION = "Internal ATLAS transfer from the DAO Treasury wallet to the Ecosystem Fund wallet. PIP-23 does not put an on-chain tag on a refill, so every transfer of this shape is listed. A transfer that is not a refill can be overridden.";
  function findRefills(movements) {
    const refills = movements.filter(
      (movement) => movement.role === "ecosystem_fund" && movement.mint === ATLAS_MINT && movement.direction === "in" && movement.internal && movement.attribution === "counterparty" && movement.counterparties.length === 1 && movement.counterparties[0] === DAO_TREASURY_ADDRESS
    );
    refills.sort((left, right) => left.blockTime - right.blockTime || left.slot - right.slot || left.signature.localeCompare(right.signature));
    return refills.map((movement) => ({
      signature: movement.signature,
      blockTime: movement.blockTime,
      time: new Date(movement.blockTime * 1e3).toISOString(),
      amountRaw: movement.deltaRaw.replace(/^-/, ""),
      amount: formatRaw(BigInt(movement.deltaRaw), movement.decimals),
      balanceBeforeRaw: movement.preRaw,
      balanceBefore: formatRaw(BigInt(movement.preRaw), movement.decimals),
      balanceAfterRaw: movement.postRaw,
      balanceAfter: formatRaw(BigInt(movement.postRaw), movement.decimals),
      decimals: movement.decimals,
      solscanUrl: solscanTx(movement.signature),
      detection: REFILL_DETECTION
    }));
  }
  function nextQuarterDate(asOf) {
    const time = Date.parse(asOf);
    if (Number.isNaN(time)) throw new UserInputError("asOf is not a timestamp.");
    const date = new Date(time);
    const today = utcDay(Math.floor(time / 1e3));
    const startYear = date.getUTCFullYear();
    const candidates = [];
    for (const year of [startYear, startYear + 1]) {
      for (const quarter of PIP23_QUARTER_DATES) {
        candidates.push(
          `${year}-${String(quarter.month).padStart(2, "0")}-${String(quarter.day).padStart(2, "0")}`
        );
      }
    }
    const next = candidates.find((candidate) => candidate >= today);
    if (!next) throw new Error("No PIP-23 quarter date followed that timestamp.");
    return next;
  }
  function perPipLimit(balanceAfterRaw, decimals) {
    const formatted = formatScaled(balanceAfterRaw * 5n, 100n, decimals);
    return {
      rawNumerator: (balanceAfterRaw * 5n).toString(),
      rawDenominator: "100",
      amount: formatted.exact ? formatted.text : null,
      exact: formatted.exact,
      rule: "5% of the Ecosystem Fund ATLAS balance after the last refill transaction (PIP-23 section c)."
    };
  }
  function atlasRefillAmount(treasuryRaw, fundRaw, decimals) {
    const below = 4n * fundRaw < treasuryRaw;
    if (!below) {
      return {
        due: false,
        amount: formatRaw(0n, decimals),
        exact: true,
        onChainRounding: "not_applicable",
        reason: "Ecosystem Fund ATLAS is at least 20% of treasury ATLAS plus fund ATLAS, so PIP-23 sends no ATLAS."
      };
    }
    const numerator = treasuryRaw - 4n * fundRaw;
    const remainder = numerator % 5n;
    if (remainder !== 0n) {
      return {
        due: true,
        amount: null,
        exact: false,
        onChainRounding: "unknown",
        remainderRaw: remainder.toString(),
        reason: "PIP-23 section b gives R = (treasury - 4 \xD7 fund) / 5, but this remainder is not an integer raw amount and the PIP does not state a rounding mode."
      };
    }
    return {
      due: true,
      amount: formatRaw(numerator / 5n, decimals),
      exact: true,
      onChainRounding: "exact",
      remainderRaw: "0",
      reason: "PIP-23 section b: if fund ATLAS is under 20% of (treasury + fund), send enough ATLAS that the fund is 20% of that total. R = (treasury - 4 \xD7 fund) / 5."
    };
  }
  function usdcRefillAmount(treasuryRaw, decimals) {
    const threshold = parseUiAmount(USDC_REFILL_THRESHOLD, decimals, "USDC threshold");
    if (treasuryRaw <= threshold) {
      return {
        due: false,
        amount: formatRaw(0n, decimals),
        exact: true,
        onChainRounding: "not_applicable",
        threshold: USDC_REFILL_THRESHOLD,
        reason: "PIP-23 sends no USDC unless the DAO Treasury holds more than 500,000 USDC."
      };
    }
    const excess = treasuryRaw - threshold;
    const remainder = excess % 5n;
    if (remainder !== 0n) {
      return {
        due: true,
        amount: null,
        exact: false,
        onChainRounding: "unknown",
        remainderRaw: remainder.toString(),
        threshold: USDC_REFILL_THRESHOLD,
        reason: "PIP-23 section b sends 20% of DAO Treasury USDC above 500,000. This remainder is not an integer raw amount and the PIP does not state a rounding mode."
      };
    }
    return {
      due: true,
      amount: formatRaw(excess / 5n, decimals),
      exact: true,
      onChainRounding: "exact",
      remainderRaw: "0",
      threshold: USDC_REFILL_THRESHOLD,
      reason: "PIP-23 section b: 20% of DAO Treasury USDC above 500,000. Fund USDC is not part of this test; PIP-4's combined test was replaced."
    };
  }
  function share(fundRaw, treasuryRaw) {
    const total = fundRaw + treasuryRaw;
    if (total === 0n) {
      return { fraction: null, percent: null, belowTwentyPercent: null, reason: "Both ATLAS balances are zero." };
    }
    const fraction = formatScaled(fundRaw, total, 0);
    const percent = formatScaled(fundRaw * 100n, total, 0);
    return {
      fraction: fraction.exact ? fraction.text : null,
      percent: percent.exact ? percent.text : null,
      belowTwentyPercent: 4n * fundRaw < treasuryRaw
    };
  }
  function evaluateEcofund(input) {
    const last = input.refills[input.refills.length - 1] ?? null;
    const currentLimit = last ? perPipLimit(BigInt(last.balanceAfterRaw), last.decimals) : {
      amount: null,
      exact: false,
      rule: "5% of the balance after the last refill.",
      status: "unknown",
      reason: "No treasury-to-fund ATLAS refill is in the parsed cache, so the 5% basis is unknown."
    };
    const balanceBlock = input.balances ? {
      asOf: input.balances.fetchedAt,
      dataMode: "cached",
      treasuryAtlas: formatRaw(input.balances.treasuryAtlasRaw, input.balances.atlasDecimals),
      ecosystemFundAtlas: formatRaw(input.balances.fundAtlasRaw, input.balances.atlasDecimals),
      treasuryUsdc: formatRaw(input.balances.treasuryUsdcRaw, input.balances.usdcDecimals),
      ecosystemFundUsdc: input.balances.fundUsdcRaw === null ? { status: "unknown", reason: "No Ecosystem Fund USDC balance is in the cache." } : formatRaw(input.balances.fundUsdcRaw, input.balances.usdcDecimals),
      fundShareOfCombinedAtlas: share(input.balances.fundAtlasRaw, input.balances.treasuryAtlasRaw)
    } : {
      status: "unknown",
      reason: "The cache has no RPC balances. Run npm run refresh-treasury. Current balances were not invented."
    };
    const atlasNext = input.balances ? atlasRefillAmount(input.balances.treasuryAtlasRaw, input.balances.fundAtlasRaw, input.balances.atlasDecimals) : { due: null, amount: null, status: "unknown", reason: "Current ATLAS balances are not in the cache." };
    const usdcNext = input.balances ? usdcRefillAmount(input.balances.treasuryUsdcRaw, input.balances.usdcDecimals) : { due: null, amount: null, status: "unknown", reason: "Current USDC balance is not in the cache." };
    let nextLimit;
    if (!last) {
      nextLimit = { status: "unknown", reason: "There is no parsed refill, so there is no 5% basis to carry forward." };
    } else if (!input.balances) {
      nextLimit = {
        status: "partial",
        ifNoAtlasRefill: currentLimit,
        reason: "Without current balances this node cannot tell whether the next quarter would refill ATLAS. The limit does not change until a refill transaction."
      };
    } else if (!atlasNext.due) {
      nextLimit = {
        status: "known",
        amount: "amount" in currentLimit ? currentLimit.amount : null,
        sameAsCurrent: true,
        reason: "No ATLAS refill is due on these balances. PIP-23 keeps the current 5% limit until the next refill transaction."
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
        reason: "Projected 5% of (current fund ATLAS + the ATLAS refill computed from cached balances). This is not a forecast of balances on the quarter date."
      };
    }
    const usdcEffect = input.balances && usdcNext.due ? {
      status: "unknown",
      reason: "PIP-23 says continuous-funding USDC is converted to ATLAS in a timely manner. It does not state a rate or a venue, so the effect on the ATLAS limit is unknown."
    } : { status: "not_applicable", reason: "No USDC refill is due, or USDC balances are unavailable." };
    const remaining = remainingAfterUnpaid(input.unpaidPips, input.balances);
    const override = input.councilOverride ? {
      source: "council_supplied",
      label: input.councilOverride.label,
      perPipLimitAtlas: input.councilOverride.perPipLimitAtlas ?? null,
      nextQuarterLimitAtlas: input.councilOverride.nextQuarterLimitAtlas ?? null,
      note: input.councilOverride.note ?? null,
      replacesComputed: false
    } : null;
    const computedPerPip = "amount" in currentLimit ? currentLimit.amount : null;
    const figureInForce = override?.perPipLimitAtlas ? { perPipLimitAtlas: override.perPipLimitAtlas, source: "council_override", label: override.label } : computedPerPip ? { perPipLimitAtlas: computedPerPip, source: "pip23" } : { perPipLimitAtlas: null, source: "unknown", reason: "No computed limit and no Council override." };
    return {
      wallets: {
        daoTreasury: DAO_TREASURY_ADDRESS,
        ecosystemFund: ECOSYSTEM_FUND_ADDRESS,
        source: WALLET_SOURCE_URL
      },
      rule: {
        pip: "PIP-23",
        galaxyStatus: "Voting_Complete_Measure_Passes",
        source: PIP23_URL,
        replaced: { pip: "PIP-4", source: PIP4_URL, note: "PIP-23 says it replaces PIP-4 in its entirety. The PIP-4 USDC formula is not applied." },
        perPipLimit: "No Ecosystem Fund PIP shall exceed 5% of the Balance After of the last refill transaction.",
        atlasRefill: "On a quarter, if Ecosystem Fund ATLAS is under 20% of (DAO Treasury ATLAS + Ecosystem Fund ATLAS), send ATLAS so the fund is 20% of that total.",
        usdcRefill: "If DAO Treasury USDC is more than 500,000, send 20% of the amount above 500,000. Otherwise send no USDC.",
        quarters: "on or about Mar 31, Jun 20, Sep 30, and Dec 31 (June 20 is copied from PIP-23, not normalized).",
        unknown: [
          "USDC-to-ATLAS conversion rate and venue.",
          "Rounding when a refill is not an integer raw amount.",
          "The list of unpaid PIPs. PIP-23 does not publish one."
        ]
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
        usdcConversionEffectOnAtlasLimit: usdcEffect
      },
      remainingAfterUnpaidPips: remaining,
      councilOverride: override,
      figureInForce
    };
  }
  function remainingAfterUnpaid(unpaid, balances) {
    if (!unpaid) {
      return {
        status: "unknown",
        reason: "PIP-23 does not publish unpaid PIP amounts. Pass unpaidPips, each with a sourceLabel. An omitted list is unknown, not zero."
      };
    }
    if (!balances) {
      return { status: "unknown", reason: "Unpaid PIPs were supplied, but the Ecosystem Fund ATLAS balance is not in the cache." };
    }
    let sum = 0n;
    const rows = unpaid.map((row) => {
      const raw = parseUiAmount(row.amountAtlas, balances.atlasDecimals, `${row.pip} amount`);
      sum += raw;
      return { pip: row.pip, amountAtlas: row.amountAtlas, sourceLabel: row.sourceLabel, source: "council_supplied" };
    });
    const remaining = balances.fundAtlasRaw - sum;
    return {
      status: "known",
      source: "council_supplied",
      note: "Fund ATLAS balance minus the caller-supplied unpaid amounts. PIP-23 does not define this subtraction; the inputs are labelled and are not chain data.",
      unpaid: rows,
      unpaidAtlas: formatRaw(sum, balances.atlasDecimals),
      fundAtlas: formatRaw(balances.fundAtlasRaw, balances.atlasDecimals),
      remainingAtlas: formatRaw(remaining, balances.atlasDecimals)
    };
  }

  // src/dao/galaxy.ts
  var PROPOSAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function assertProposalId(id) {
    if (!PROPOSAL_ID.test(id)) {
      throw new SafeClientError("proposalId must be the galaxy proposal UUID. Refusing to build a URL from anything else.");
    }
    return id.toLowerCase();
  }
  function stringField(row, key) {
    const value = row[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new SafeClientError(`A galaxy record is missing ${key}.`);
    }
    return value;
  }
  function decimalField(value, label) {
    if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return value;
    if (typeof value === "number" && Number.isFinite(value)) {
      const text = Object.is(value, -0) ? "0" : String(value);
      if (/^-?\d+(\.\d+)?$/.test(text)) return text;
      throw new SafeClientError(`${label} could not be read without rounding.`);
    }
    throw new SafeClientError(`${label} is not a decimal number.`);
  }
  function parseProposals(payload) {
    if (!Array.isArray(payload)) {
      throw new SafeClientError("galaxy /proposals was not a list. No proposals were invented.");
    }
    return payload.map((item) => {
      if (!item || typeof item !== "object") throw new SafeClientError("A proposal record was not an object.");
      const row = item;
      const pipNumber = row.pipNumber;
      if (typeof pipNumber !== "number" || !Number.isInteger(pipNumber)) {
        throw new SafeClientError("A proposal is missing pipNumber.");
      }
      const choices = row.voteOptionsMaxChoices;
      const winners = row.voteWinners;
      if (typeof choices !== "number" || typeof winners !== "number") {
        throw new SafeClientError(`PIP-${pipNumber} is missing vote option fields.`);
      }
      return {
        id: assertProposalId(stringField(row, "id")),
        pipNumber,
        title: stringField(row, "title"),
        brief: typeof row.brief === "string" ? row.brief : "",
        categories: Array.isArray(row.categories) ? row.categories.filter((c) => typeof c === "string") : [],
        status: stringField(row, "status"),
        authorPublicKey: typeof row.authorPublicKey === "string" ? row.authorPublicKey : "",
        createdAt: stringField(row, "createdAt"),
        updatedAt: stringField(row, "updatedAt"),
        votingStartsAt: stringField(row, "votingStartsAt"),
        votingEndsAt: stringField(row, "votingEndsAt"),
        voteOptionsMaxChoices: choices,
        voteWinners: winners,
        voteData: parseVoteData(row.voteData)
      };
    });
  }
  function parseVoteData(value) {
    if (value == null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new SafeClientError("Proposal voteData was not an object.");
    }
    const out = {};
    for (const [choice, raw] of Object.entries(value)) {
      if (!raw || typeof raw !== "object") throw new SafeClientError(`voteData.${choice} was not an object.`);
      const row = raw;
      out[choice] = {
        count: decimalField(row.count, `voteData.${choice}.count`),
        pvp: decimalField(row.pvp, `voteData.${choice}.pvp`)
      };
    }
    return out;
  }
  function parseVotes(payload) {
    if (!Array.isArray(payload)) {
      throw new SafeClientError("The votes file was not a list. No tallies were invented.");
    }
    return payload.map((item) => {
      if (!item || typeof item !== "object") throw new SafeClientError("A vote record was not an object.");
      const row = item;
      return {
        id: stringField(row, "id"),
        proposalId: assertProposalId(stringField(row, "proposalId")),
        walletPublicKey: stringField(row, "walletPublicKey"),
        voteResult: stringField(row, "voteResult"),
        votingPower: decimalField(row.votingPower, "votingPower"),
        createdAt: stringField(row, "createdAt")
      };
    });
  }
  function summarizeVotes(votes, topN) {
    const grouped = /* @__PURE__ */ new Map();
    for (const vote of votes) {
      const list = grouped.get(vote.voteResult) ?? [];
      list.push(vote.votingPower);
      grouped.set(vote.voteResult, list);
    }
    const options = [...grouped.entries()].map(([choice, powers]) => ({
      choice,
      count: powers.length,
      votingPower: addDecimalStrings(powers.length > 0 ? powers : ["0"])
    })).sort((left, right) => compareDecimal(right.votingPower, left.votingPower) || left.choice.localeCompare(right.choice));
    const ranked = [...votes].sort(
      (left, right) => compareDecimal(right.votingPower, left.votingPower) || left.walletPublicKey.localeCompare(right.walletPublicKey)
    );
    return {
      voterCount: votes.length,
      uniqueWallets: new Set(votes.map((vote) => vote.walletPublicKey)).size,
      options,
      topVoters: ranked.slice(0, topN).map((vote) => ({
        wallet: vote.walletPublicKey,
        choice: vote.voteResult,
        votingPower: vote.votingPower,
        createdAt: vote.createdAt
      })),
      rankedWinner: {
        status: "unknown",
        reason: "The votes file records a choice and voting power for each signature. It does not define a ranked-choice winner. This tool does not invent one. list_proposals includes the published voteWinners and voteOptionsMaxChoices."
      }
    };
  }
  function parseRevenue(payload) {
    if (!Array.isArray(payload)) {
      throw new SafeClientError("galaxy /dao/treasury was not a list. No revenue was invented.");
    }
    return payload.map((item) => {
      if (!item || typeof item !== "object") throw new SafeClientError("A revenue row was not an object.");
      const row = item;
      return {
        segmentation: stringField(row, "segmentation"),
        recorded_period: stringField(row, "recorded_period"),
        mint: stringField(row, "mint"),
        amount: decimalField(row.amount, "amount"),
        usdcValue: decimalField(row.usdc_value, "usdc_value")
      };
    });
  }
  function summarizeRevenue(rows) {
    const months = /* @__PURE__ */ new Map();
    for (const row of rows) {
      const list = months.get(row.recorded_period) ?? [];
      list.push(row);
      months.set(row.recorded_period, list);
    }
    const bySourceMap = /* @__PURE__ */ new Map();
    for (const row of rows) {
      const key = `${row.segmentation}\0${row.mint}`;
      const list = bySourceMap.get(key) ?? [];
      list.push(row);
      bySourceMap.set(key, list);
    }
    return {
      months: [...months.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([period, periodRows]) => ({
        period,
        sources: periodRows.map((row) => ({
          segmentation: row.segmentation,
          mint: row.mint,
          amount: row.amount,
          usdcValue: row.usdcValue
        }))
      })),
      bySource: [...bySourceMap.entries()].map(([, sourceRows]) => {
        const first = sourceRows[0];
        if (!first) throw new SafeClientError("Empty revenue group.");
        return {
          segmentation: first.segmentation,
          mint: first.mint,
          amount: addDecimalStrings(sourceRows.map((row) => row.amount)),
          usdcValue: addDecimalStrings(sourceRows.map((row) => row.usdcValue)),
          months: sourceRows.length
        };
      })
    };
  }
  function votesUrl(base, id) {
    return `${base}${GALAXY_VOTES_PATH}/${assertProposalId(id)}.json`;
  }

  // src/dao/dashboard-view.ts
  var DECIMAL = /^-?\d+(\.\d+)?$/;
  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => {
      const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
      return map[ch] ?? ch;
    });
  }
  function groupAmount(amount) {
    if (!DECIMAL.test(amount)) return amount;
    const negative = amount.startsWith("-");
    const body = negative ? amount.slice(1) : amount;
    const [whole, frac] = body.split(".");
    const grouped = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${negative ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
  }
  function showAmount(amount, status) {
    if (status === "unknown" || amount == null || amount === "") return "unknown";
    return groupAmount(amount);
  }
  function chartPath(points, width = 640, height = 200) {
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
      const x = points.length === 1 ? width / 2 : pad + index / (points.length - 1) * (width - pad * 2);
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
      max
    };
  }
  function cacheSources(rpc) {
    return [
      { url: WALLET_SOURCE_URL, note: "Published DAO Treasury and Ecosystem Fund addresses." },
      { url: PIP23_URL, note: "PIP-23 names the same two wallets and states the Ecosystem Fund rules." },
      { url: rpc, note: "Public Solana read RPC recorded on the cache. The URL is redacted." },
      { url: "https://solscan.io/tx/", note: "Transaction links are built from signatures. Solscan is not queried." }
    ];
  }
  function balancesFrom(cache) {
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
      fetchedAt: treasuryAtlas.fetchedAt
    };
  }
  function treasuryReport(payload) {
    const cache = parseTreasuryCache(payload);
    const flows = buildFlows(cache, {});
    const payments = buildPayments(cache, { limit: 200 });
    const history = buildHistory(cache, { granularity: "month" });
    return {
      dataMode: "cached",
      asOf: cache.generatedAt,
      completeness: cache.completeness === "partial" ? "partial" : "complete",
      partialReason: cache.partialReason ?? null,
      sources: cacheSources(typeof cache.rpc === "string" ? cache.rpc : "[missing rpc]"),
      flows,
      payments,
      history,
      notes: [
        "A row is omitted when the cache cannot support it. Omission is not a zero.",
        "DAO Treasury ATLAS inflows stay unknown until the signature scan covers the month and the outflow sample holds.",
        ...cache.completeness === "partial" && cache.partialReason ? [cache.partialReason] : []
      ]
    };
  }
  function ecofundReport(payload, councilOverride) {
    const cache = parseTreasuryCache(payload);
    const fundCursor = cache.cursors.find(
      (cursor) => cursor.role === "ecosystem_fund" && cursor.kind === "token" && cursor.mint === ATLAS_MINT
    );
    const balances = balancesFrom(cache);
    const evaluated = evaluateEcofund({
      refills: findRefills(cache.movements),
      balances,
      councilOverride,
      asOf: balances?.fetchedAt ?? cache.generatedAt,
      movementsComplete: Boolean(fundCursor?.reachedEnd && fundCursor.gaps.length === 0 && fundCursor.reconciled === true)
    });
    return {
      dataMode: "cached",
      asOf: cache.generatedAt,
      completeness: cache.completeness === "partial" ? "partial" : "complete",
      sources: [
        ...cacheSources(typeof cache.rpc === "string" ? cache.rpc : "[missing rpc]"),
        { url: PIP23_URL, note: "Refill rule, 5% limit, and quarter dates." },
        { url: PIP4_URL, note: "Replaced in its entirety by PIP-23. Not used for these numbers." },
        { url: USDC_SOURCE_URL, note: "Circle's published Solana USDC mint." }
      ],
      ...evaluated
    };
  }
  function oneChoice(options, name) {
    const hits = options.filter((option) => option.choice.toLowerCase() === name);
    if (hits.length !== 1) return null;
    return { count: hits[0]?.count ?? "", votingPower: hits[0]?.votingPower ?? "" };
  }
  function proposalVoteTable(proposals) {
    return [...proposals].sort((left, right) => right.pipNumber - left.pipNumber || left.title.localeCompare(right.title)).map((proposal) => {
      const ranked = proposal.voteOptionsMaxChoices > 1 || proposal.voteWinners > 1;
      const options = proposal.voteData ? Object.entries(proposal.voteData).map(([choice, row]) => ({
        choice,
        count: row.count,
        votingPower: row.pvp
      })) : [];
      const named = /* @__PURE__ */ new Set(["yes", "no", "abstain"]);
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
          status: "unknown",
          reason: "galaxy voteData publishes a count and voting power for each choice. It does not publish the electorate, so turnout is not a percentage."
        },
        winner: ranked ? {
          status: "unknown",
          reason: "voteOptionsMaxChoices or voteWinners is greater than 1. The votes file does not define a ranked-choice winner, so none is declared."
        } : {
          status: "not_declared",
          reason: "Counts and voting power are galaxy's published voteData. This page does not pick a winner from them."
        }
      };
    });
  }
  function monthlyIncome(payload) {
    const summary = summarizeRevenue(parseRevenue(payload));
    const months = summary.months.map((month) => ({
      period: month.period,
      usdcValue: addDecimalStrings(month.sources.map((source) => source.usdcValue))
    }));
    return {
      months,
      earliestPublished: months[0]?.period ?? null,
      may2023Present: months.some((month) => month.period.startsWith("2023-05"))
    };
  }
  function revenueView(payload) {
    const summary = summarizeRevenue(parseRevenue(payload));
    const income = monthlyIncome(payload);
    const first = summary.months[0];
    const last = summary.months[summary.months.length - 1];
    return {
      dataMode: "live",
      source: "https://galaxy.staratlas.com/dao/treasury",
      bySource: summary.bySource,
      monthCount: summary.months.length,
      firstPeriod: first?.period ?? null,
      lastPeriod: last?.period ?? null,
      monthlyUsdc: income.months,
      may2023Present: income.may2023Present
    };
  }
  function sourceList(sources) {
    return `<ul class="src">${sources.map((source) => `<li><a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.url)}</a> ${esc(source.note)}</li>`).join("")}</ul>`;
  }
  function stamp(dataMode, asOf, completeness) {
    const label = completeness === "partial" ? "Partial cache" : dataMode === "cached" ? "Cached" : "Live";
    const ago = updatedAgo(asOf, Date.now());
    const relative = ago ? ` <span class="pill">${esc(ago)}</span>` : "";
    return `<p class="asof"><span class="pill snap">${esc(label)} as of ${esc(asOf)}</span>${relative}</p>`;
  }
  function mcpSlot(panel) {
    return `<div class="mcp-slot" data-mcp-panel="${esc(panel)}"></div>`;
  }
  function flowsSectionHtml(report) {
    const rows = report.flows.rows.map((row) => {
      return `<tr><td>${esc(row.month)}</td><td>${esc(row.role)}</td><td>${esc(row.symbol ?? row.mint)}</td><td class="num">${esc(showAmount(row.externalIn, row.externalInStatus))}</td><td class="num">${esc(groupAmount(row.externalOut))}</td><td class="num">${esc(groupAmount(row.internalIn))}</td><td class="num">${esc(groupAmount(row.internalOut))}</td><td>${esc(row.method)}</td><td>${esc(row.through)}</td></tr>`;
    }).join("");
    const omitted = report.flows.omitted.map((item) => `<li>${esc(item.role)} ${esc(symbolForMint(item.mint) ?? item.mint)}: ${esc(item.reason)}</li>`).join("");
    const table = rows ? `<div class="table-wrap card-like"><table class="compact"><thead><tr><th>Month</th><th>Wallet</th><th>Token</th><th class="num">External in</th><th class="num">External out</th><th class="num">Internal in</th><th class="num">Internal out</th><th>Method</th><th>Through</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="hint">No complete monthly flow rows are in this cache.</p>`;
    return stamp(report.dataMode, report.asOf, report.completeness) + table + (omitted ? `<p class="hint">Withheld, not shown as zero:</p><ul class="fill-list">${omitted}</ul>` : "") + `<ul class="fill-list">${report.flows.notes.map((note) => `<li>${esc(note)}</li>`).join("")}</ul>` + sourceList(report.sources) + mcpSlot("flows");
  }
  function paymentsSectionHtml(report) {
    const rows = report.payments.payments.map((payment) => {
      const counterparty = payment.counterparties[0] ? `${payment.counterparties[0].slice(0, 4)}\u2026${payment.counterparties[0].slice(-4)}` : "\u2014";
      return `<tr><td>${esc(payment.time)}</td><td>${esc(payment.role)}</td><td>${esc(payment.symbol ?? payment.mint)}</td><td class="num">${esc(groupAmount(payment.amount))}</td><td>${esc(payment.direction)}</td><td class="mono">${esc(counterparty)}</td><td><a href="${esc(payment.solscanUrl)}" target="_blank" rel="noopener noreferrer">solscan</a></td></tr>`;
    }).join("");
    const omitted = report.payments.omitted.map((item) => `<li>${esc(item.role)} ${esc(symbolForMint(item.mint) ?? item.mint)}: ${esc(item.reason)}</li>`).join("");
    const table = rows ? `<div class="table-wrap card-like"><table class="compact"><thead><tr><th>Time</th><th>Wallet</th><th>Token</th><th class="num">Amount</th><th>Direction</th><th>Counterparty</th><th>Tx</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="hint">No external outflows are published from this cache.</p>`;
    const more = report.payments.truncated ? `<p class="hint">Showing ${report.payments.payments.length} of ${report.payments.total}. The cache has more.</p>` : `<p class="hint">${report.payments.total} external outflow${report.payments.total === 1 ? "" : "s"}.</p>`;
    return stamp(report.dataMode, report.asOf, report.completeness) + table + more + (omitted ? `<ul class="fill-list">${omitted}</ul>` : "") + sourceList(report.sources) + mcpSlot("payments");
  }
  function seriesChart(series) {
    if (!("points" in series) || series.status !== "known") {
      const reason = "reason" in series ? series.reason : "This series is unknown.";
      return `<p class="hint">${esc(series.role)} ${esc(series.symbol ?? series.mint)}: ${esc(reason)}</p>`;
    }
    const chart = chartPath(series.points);
    const caption = `${series.role} ${series.symbol ?? series.mint}, month-end, ${series.method}`;
    const drawing = chart ? `<figure class="chart-wrap"><svg class="chart" viewBox="0 0 ${chart.width} ${chart.height}" role="img" aria-label="${esc(caption)}. ${esc(groupAmount(chart.min))} to ${esc(groupAmount(chart.max))}."><polyline points="${esc(chart.points)}" /></svg><figcaption class="hint">${esc(caption)}. ${esc(chart.firstDay)} ${esc(groupAmount(chart.firstAmount))} \u2192 ${esc(chart.lastDay)} ${esc(groupAmount(chart.lastAmount))}. Low ${esc(groupAmount(chart.min))}, high ${esc(groupAmount(chart.max))}.</figcaption></figure>` : `<p class="hint">${esc(caption)}. The amounts are listed below. A line was not drawn.</p>`;
    const rows = series.points.map((point) => `<tr><td>${esc(point.day)}</td><td class="num">${esc(groupAmount(point.amount))}</td></tr>`).join("");
    return drawing + `<div class="table-wrap card-like"><table class="compact"><thead><tr><th>Day</th><th class="num">${esc(series.symbol ?? "Amount")}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  function historySectionHtml(report) {
    const preferred = report.history.series.find((series) => series.role === "dao_treasury" && series.mint === ATLAS_MINT && series.status === "known") ?? report.history.series.find((series) => series.status === "known");
    const charts = preferred ? seriesChart(preferred) : `<p class="hint">No complete balance series is in this cache, so no line is drawn.</p>`;
    const others = report.history.series.filter((series) => series !== preferred).map((series) => {
      if (series.status !== "known" || !("points" in series)) {
        const reason = "reason" in series ? series.reason : "unknown";
        return `<li>${esc(series.role)} ${esc(series.symbol ?? series.mint)}: ${esc(reason)}</li>`;
      }
      const end = series.points[series.points.length - 1];
      return `<li>${esc(series.role)} ${esc(series.symbol ?? series.mint)}: ${series.points.length} points${end ? `, last ${esc(end.day)} ${esc(groupAmount(end.amount))}` : ""}.</li>`;
    }).join("");
    const omitted = report.history.omitted.map((item) => `<li>${esc(item.role)} ${esc(symbolForMint(item.mint) ?? item.mint)}: ${esc(item.reason)}</li>`).join("");
    return stamp(report.dataMode, report.asOf, report.completeness) + charts + (others ? `<p class="hint">Other series in this cache:</p><ul class="fill-list">${others}</ul>` : "") + (omitted ? `<p class="hint">Withheld, not shown as zero:</p><ul class="fill-list">${omitted}</ul>` : "") + `<ul class="fill-list">${report.history.notes.map((note) => `<li>${esc(note)}</li>`).join("")}</ul>` + sourceList(report.sources) + mcpSlot("history");
  }
  function fieldAmount(value) {
    if (!value || typeof value !== "object") return "unknown";
    const row = value;
    if (row.status === "unknown") return "unknown";
    if (row.exact === false || row.amount == null) return "unknown";
    if (typeof row.amount === "string") return groupAmount(row.amount);
    return "unknown";
  }
  function ecofundSectionHtml(report) {
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
    return stamp(report.dataMode, report.asOf, report.completeness) + `<div class="kpis"><article class="kpi"><div class="label">Computed 5% limit</div><div class="value">${esc(currentText)}${currentText === "unknown" ? "" : '<span class="unit">ATLAS</span>'}</div><div class="sub">${esc(currentReason)}</div></article><article class="kpi"><div class="label">Next quarter</div><div class="value">${esc(report.nextQuarter.date)}</div><div class="sub">On or about this date. Limit ${esc(nextAmount)}${nextAmount === "unknown" ? "" : " ATLAS"}. ${esc(String(next.reason ?? ""))}</div></article><article class="kpi"><div class="label">ATLAS refill</div><div class="value">${esc(fieldAmount(atlas))}${fieldAmount(atlas) === "unknown" ? "" : '<span class="unit">ATLAS</span>'}</div><div class="sub">${esc("reason" in atlas ? String(atlas.reason ?? "") : "")}</div></article><article class="kpi"><div class="label">USDC refill</div><div class="value">${esc(fieldAmount(usdc))}${fieldAmount(usdc) === "unknown" ? "" : '<span class="unit">USDC</span>'}</div><div class="sub">${esc("reason" in usdc ? String(usdc.reason ?? "") : "")}</div></article><article class="kpi"><div class="label">After unpaid PIPs</div><div class="value">${esc(remainingText)}${remainingText === "unknown" ? "" : '<span class="unit">ATLAS</span>'}</div><div class="sub">${esc(remaining.reason ?? remaining.note ?? "")}</div></article><article class="kpi"><div class="label">Figure in force</div><div class="value">${esc(inForceText)}${inForceText === "unknown" ? "" : '<span class="unit">ATLAS</span>'}</div><div class="sub">${esc(inForce.source)}${"label" in inForce && inForce.label ? " \u2014 " + esc(String(inForce.label)) : ""}</div></article></div>` + (override ? `<p class="hint">Council override (${esc(override.label)}): per-PIP ${esc(override.perPipLimitAtlas ? groupAmount(override.perPipLimitAtlas) : "not supplied")}, next quarter ${esc(override.nextQuarterLimitAtlas ? groupAmount(override.nextQuarterLimitAtlas) : "not supplied")}. The computed figure stays above. ${esc(override.note ?? "")}</p>` : `<p class="hint">No Council override was supplied. The computed figure is the one in force when it is known.</p>`) + `<p class="hint">USDC converted to ATLAS: ${esc(report.nextQuarter.usdcConversionEffectOnAtlasLimit.status)}. ${esc(report.nextQuarter.usdcConversionEffectOnAtlasLimit.reason)}</p><ul class="fill-list">${report.rule.unknown.map((item) => `<li>Unknown in PIP-23: ${esc(item)}</li>`).join("")}</ul><p class="hint">Refills found in the cache: ${report.refills.length}. Fund ATLAS movement backfill complete: ${report.movementsComplete ? "yes" : "no"}.</p>` + sourceList(report.sources) + mcpSlot("limit");
  }
  function choiceCell(choice) {
    if (!choice) return "unknown";
    return `${esc(groupAmount(choice.count))} votes<br>${esc(groupAmount(choice.votingPower))} voting power`;
  }
  function proposalTableHtml(proposals, asOf, sourceUrl) {
    const rows = proposalVoteTable(proposals);
    const body = rows.map((row) => {
      const other = row.other.length ? `<br>${row.other.map((option) => `${esc(option.choice)}: ${esc(groupAmount(option.count))} votes, ${esc(groupAmount(option.votingPower))} voting power`).join("<br>")}` : "";
      const power = row.votingPower === null ? "unknown" : esc(groupAmount(row.votingPower));
      return `<tr><td><div class="pip">PIP-${esc(row.pipNumber)}</div><div class="name">${esc(row.title)}</div></td><td>${esc(row.status)}</td><td class="num">${choiceCell(row.yes)}</td><td class="num">${choiceCell(row.no)}</td><td class="num">${choiceCell(row.abstain)}</td><td class="num">${power}${other}</td><td>unknown. ${esc(row.turnout.reason)}</td><td>${esc(row.winner.status)}. ${esc(row.winner.reason)}</td><td><button type="button" class="vote-load" data-proposal-id="${esc(row.id)}">Load votes file</button></td></tr>`;
    }).join("");
    return stamp("live", asOf) + `<div class="table-wrap card-like"><table><thead><tr><th>PIP</th><th>Status</th><th class="num">Yes</th><th class="num">No</th><th class="num">Abstain</th><th class="num">Voting power</th><th>Turnout</th><th>Winner</th><th>Votes file</th></tr></thead><tbody>${body}</tbody></table></div><p class="hint">Yes, No, and Abstain are the published voteData fields, matched without regard to capital letters. Voting power is the sum of the published choice totals. Turnout is unknown because galaxy does not publish the electorate. A ranked-choice winner is not declared. The votes file for one proposal loads only when you ask.</p><p class="hint">Source: <a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(sourceUrl)}</a></p><div id="vote-detail"></div>` + mcpSlot("results");
  }
  function voteDetailHtml(votes, asOf, sourceUrl) {
    const summary = summarizeVotes([...votes], 5);
    const options = summary.options.map((option) => `<tr><td>${esc(option.choice)}</td><td class="num">${esc(String(option.count))}</td><td class="num">${esc(groupAmount(option.votingPower))}</td></tr>`).join("");
    const top = summary.topVoters.map((voter) => `<li>${esc(voter.wallet)} \xB7 ${esc(voter.choice)} \xB7 ${esc(groupAmount(voter.votingPower))}</li>`).join("");
    return stamp("live", asOf) + `<p class="hint">${summary.voterCount} vote records, ${summary.uniqueWallets} wallets. Ranked winner: ${esc(summary.rankedWinner.status)}. ${esc(summary.rankedWinner.reason)}</p><div class="table-wrap card-like"><table class="compact"><thead><tr><th>Choice</th><th class="num">Votes</th><th class="num">Voting power</th></tr></thead><tbody>${options}</tbody></table></div>` + (top ? `<ul class="fill-list">${top}</ul>` : "") + `<p class="hint">Source: <a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(sourceUrl)}</a></p>`;
  }
  function revenueSectionHtml(view, asOf) {
    const rows = view.bySource.map(
      (source) => `<tr><td>${esc(source.segmentation)}</td><td>${esc(source.mint)}</td><td class="num">${esc(groupAmount(source.amount))}</td><td class="num">${esc(groupAmount(source.usdcValue))}</td><td class="num">${source.months}</td></tr>`
    ).join("");
    const span = view.firstPeriod && view.lastPeriod ? `${view.firstPeriod} to ${view.lastPeriod}` : "no periods";
    const chart = chartPath(view.monthlyUsdc.map((month) => ({ day: month.period, amount: month.usdcValue })));
    const monthRows = view.monthlyUsdc.map((month) => `<tr><td>${esc(month.period)}</td><td class="num">${esc(groupAmount(month.usdcValue))}</td></tr>`).join("");
    const mayNote = view.may2023Present ? "The series includes May 2023, the earliest month this request asked for. A month with no published row is omitted, not drawn as zero." : "May 2023 is not in this document. The chart starts at the earliest published period. Missing months are omitted, not drawn as zero.";
    const drawing = chart ? `<figure class="chart-wrap"><svg class="chart" viewBox="0 0 ${chart.width} ${chart.height}" role="img" aria-label="Monthly DAO income in published USDC value, ${esc(chart.firstDay)} to ${esc(chart.lastDay)}."><polyline points="${esc(chart.points)}" /></svg><figcaption class="hint">Monthly income, published USDC value, ${esc(chart.firstDay)} ${esc(groupAmount(chart.firstAmount))} \u2192 ${esc(chart.lastDay)} ${esc(groupAmount(chart.lastAmount))}.</figcaption></figure>` : `<p class="hint">No monthly USDC series was drawn.</p>`;
    return stamp(view.dataMode, asOf) + `<h3 class="sub-head">Monthly income</h3><p class="hint">${esc(mayNote)}</p>` + drawing + (monthRows ? `<div class="table-wrap card-like"><table class="compact"><thead><tr><th>Period</th><th class="num">USDC value</th></tr></thead><tbody>${monthRows}</tbody></table></div>` : "") + mcpSlot("income") + `<p class="hint">${view.monthCount} recorded periods (${esc(span)}), summed by source and mint. USDC value is the figure galaxy published on the row.</p>` + (rows ? `<div class="table-wrap card-like"><table class="compact"><thead><tr><th>Source</th><th>Mint</th><th class="num">Amount</th><th class="num">USDC value</th><th class="num">Months</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="hint">The revenue document had no rows.</p>`) + `<p class="hint">Source: <a href="${esc(view.source)}" target="_blank" rel="noopener noreferrer">${esc(view.source)}</a></p>` + mcpSlot("revenue");
  }
  function mintLabel(mint) {
    if (mint.endsWith("Dt1v")) return "USDC";
    if (mint.startsWith("ATLAS")) return "ATLAS";
    return mint;
  }
  function matchSectionHtml(report) {
    const matchRows = report.matches.map(
      (match) => `<tr><td class="mono">${esc(match.signature)}</td><td>${esc(match.pip)}</td><td>${esc(match.symbol ?? mintLabel(match.mint))}</td><td class="num">${esc(groupAmount(match.amount))}</td><td>${esc(match.confidence)}</td><td>${esc(match.reason)}</td></tr>`
    ).join("");
    const mismatchRows = report.mismatches.map(
      (item) => `<tr><td>${esc(item.kind)}</td><td>${esc(item.pip ?? "\u2014")}</td><td class="mono">${esc(item.signature ?? "\u2014")}</td><td>${esc(mintLabel(item.mint))}</td><td class="num">${item.amount === null ? "unknown" : esc(groupAmount(item.amount))}</td><td>${esc(item.detail)}</td></tr>`
    ).join("");
    const unresolved = report.unresolved.map((item) => `<li>${esc(item.detail)}${item.pip ? ` ${esc(item.pip)}` : ""}${item.signature ? ` ${esc(item.signature)}` : ""}</li>`).join("");
    const unknown = report.unknownCells.map((cell) => `<li>${esc(cell.pip)} ${esc(mintLabel(cell.mint))}: ${esc(cell.raw)}</li>`).join("");
    return (matchRows ? `<div class="table-wrap card-like"><table class="compact"><thead><tr><th>Outflow</th><th>PIP</th><th>Token</th><th class="num">Amount</th><th>Confidence</th><th>Why</th></tr></thead><tbody>${matchRows}</tbody></table></div>` : `<p class="hint">No payment is matched.</p>`) + `<h3 class="sub-head">Mismatches</h3>` + (mismatchRows ? `<div class="table-wrap card-like"><table class="compact"><thead><tr><th>Kind</th><th>PIP</th><th>Outflow</th><th>Token</th><th class="num">Amount</th><th>Detail</th></tr></thead><tbody>${mismatchRows}</tbody></table></div>` : `<p class="hint">No confirmed mismatch.</p>`) + (unresolved ? `<p class="hint">Not confirmed:</p><ul class="fill-list">${unresolved}</ul>` : "") + `<p class="hint">${report.blankCells} paid cells are blank, so they are unknown rather than zero.</p>` + (unknown ? `<p class="hint">Paid cells that are not a number:</p><ul class="fill-list">${unknown}</ul>` : "") + `<ul class="fill-list">${report.notes.map((note) => `<li>${esc(note)}</li>`).join("")}</ul>` + mcpSlot("match");
  }
  function dataHealthSectionHtml(rows, nowMs) {
    const body = rows.map((row) => {
      const ago = row.asOf ? updatedAgo(row.asOf, nowMs) : "";
      const when = row.asOf ? `${row.asOf}${ago ? `, ${ago}` : ""}` : "\u2014";
      return `<tr><td>${esc(row.source)}</td><td>${esc(row.status)}</td><td>${esc(when)}</td><td>${esc(row.detail ?? "")}</td></tr>`;
    }).join("");
    return `<div class="table-wrap card-like"><table class="compact"><thead><tr><th>Source</th><th>Status</th><th>As of</th><th>Detail</th></tr></thead><tbody>${body}</tbody></table></div><p class="hint">A missing source is left missing. Nothing on this tab is filled in from another source.</p>` + mcpSlot("health");
  }

  // src/dao/live-balance.ts
  var TOKEN_DECIMALS = {
    [ATLAS_MINT]: ATLAS_DECIMALS,
    [USDC_MINT]: 6
  };
  async function liveBalanceSlots(associatedTokenAddress) {
    const slots = [];
    for (const wallet of TRACKED_WALLETS) {
      slots.push({
        wallet: wallet.address,
        role: wallet.role,
        name: wallet.name,
        kind: "sol",
        symbol: "SOL",
        mint: NATIVE_MINT,
        address: wallet.address,
        decimals: SOL_DECIMALS
      });
      for (const mint of [ATLAS_MINT, USDC_MINT]) {
        const symbol = symbolForMint(mint);
        if (symbol !== "ATLAS" && symbol !== "USDC") {
          throw new SafeClientError("A tracked mint has no symbol.");
        }
        slots.push({
          wallet: wallet.address,
          role: wallet.role,
          name: wallet.name,
          kind: "token",
          symbol,
          mint,
          address: await associatedTokenAddress(wallet.address, mint),
          decimals: TOKEN_DECIMALS[mint] ?? 0
        });
      }
    }
    return slots;
  }
  function lamportsOf(account) {
    if (!account || typeof account !== "object") return null;
    const lamports = account.lamports;
    if (typeof lamports !== "number" || !Number.isSafeInteger(lamports) || lamports < 0) return null;
    return lamports;
  }
  function tokenAmountOf(account) {
    if (!account || typeof account !== "object") return null;
    const data = account.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const info = data.parsed?.info;
    const mint = info?.mint;
    const amount = info?.tokenAmount?.amount;
    const decimals = info?.tokenAmount?.decimals;
    if (typeof mint !== "string" || typeof amount !== "string" || !/^\d+$/.test(amount) || typeof decimals !== "number") return null;
    return { mint, amount, decimals };
  }
  function parseMultipleAccountsBalances(slots, value) {
    if (!Array.isArray(value) || value.length !== slots.length) {
      throw new SafeClientError("getMultipleAccounts did not return one entry per balance account. No balance was invented.");
    }
    return slots.map((slot, index) => {
      const account = value[index];
      if (slot.kind === "sol") {
        if (account === null) {
          return {
            wallet: slot.wallet,
            role: slot.role,
            name: slot.name,
            symbol: slot.symbol,
            mint: slot.mint,
            amountRaw: "0",
            amount: "0",
            decimals: slot.decimals,
            missing: false,
            tokenAccount: null
          };
        }
        const lamports = lamportsOf(account);
        if (lamports === null) {
          throw new SafeClientError(`SOL balance for ${slot.name} was not a safe integer. No balance was invented.`);
        }
        return {
          wallet: slot.wallet,
          role: slot.role,
          name: slot.name,
          symbol: slot.symbol,
          mint: slot.mint,
          amountRaw: String(lamports),
          amount: formatRaw(BigInt(lamports), slot.decimals),
          decimals: slot.decimals,
          missing: false,
          tokenAccount: null
        };
      }
      if (account === null) {
        return {
          wallet: slot.wallet,
          role: slot.role,
          name: slot.name,
          symbol: slot.symbol,
          mint: slot.mint,
          amountRaw: "0",
          amount: "0",
          decimals: slot.decimals,
          missing: true,
          tokenAccount: slot.address
        };
      }
      const token = tokenAmountOf(account);
      if (!token || token.mint !== slot.mint) {
        throw new SafeClientError(
          `Token balance for ${slot.name} ${slot.symbol} was unreadable. No balance was invented.`
        );
      }
      return {
        wallet: slot.wallet,
        role: slot.role,
        name: slot.name,
        symbol: slot.symbol,
        mint: slot.mint,
        amountRaw: token.amount,
        amount: formatRaw(BigInt(token.amount), token.decimals),
        decimals: token.decimals,
        missing: false,
        tokenAccount: slot.address
      };
    });
  }
  var BALANCE_NOTE = "Standard associated token account only. Other token accounts for the same mint were not listed.";
  function cachedRawBalance(balances, wallet, mint) {
    const row = balances.find((item) => item.wallet === wallet && item.mint === mint);
    if (!row || typeof row.amountRaw !== "string" || !/^\d+$/.test(row.amountRaw) || typeof row.decimals !== "number") return null;
    if (typeof row.fetchedAt !== "string" || Number.isNaN(Date.parse(row.fetchedAt))) return null;
    return { amountRaw: row.amountRaw, decimals: row.decimals, fetchedAt: row.fetchedAt };
  }
  function tokenRow(row) {
    return {
      mint: row.mint,
      symbol: row.symbol,
      tokenAccount: row.tokenAccount ?? "",
      amountRaw: row.amountRaw,
      amount: row.amount,
      decimals: row.decimals,
      standardAccount: true,
      missing: row.missing
    };
  }
  function groupBalances(rows, fetchedAt) {
    return TRACKED_WALLETS.map((wallet) => {
      const mine = rows.filter((row) => row.wallet === wallet.address);
      const sol = mine.find((row) => row.symbol === "SOL");
      if (!sol) throw new SafeClientError(`SOL balance for ${wallet.name} was missing. No balance was invented.`);
      return {
        role: wallet.role,
        name: wallet.name,
        address: wallet.address,
        sol: { amountRaw: sol.amountRaw, amount: sol.amount },
        tokens: mine.filter((row) => row.symbol !== "SOL").map(tokenRow),
        fetchedAt,
        note: BALANCE_NOTE
      };
    });
  }
  async function readTrackedBalances(rpc, associatedTokenAddress, fetchedAt) {
    const slots = await liveBalanceSlots(associatedTokenAddress);
    const result = await rpc.call("getMultipleAccounts", [
      slots.map((slot) => slot.address),
      { encoding: "jsonParsed", commitment: "confirmed" }
    ]);
    return groupBalances(parseMultipleAccountsBalances(slots, result?.value), fetchedAt);
  }
  function balancesFromCacheRows(balances) {
    const rows = [];
    let asOf = null;
    for (const wallet of TRACKED_WALLETS) {
      for (const mint of [NATIVE_MINT, ATLAS_MINT, USDC_MINT]) {
        const cached = cachedRawBalance(balances, wallet.address, mint);
        if (!cached) return null;
        const parsedAt = Date.parse(cached.fetchedAt);
        if (asOf === null || parsedAt < Date.parse(asOf)) asOf = cached.fetchedAt;
        const symbol = symbolForMint(mint);
        if (symbol !== "SOL" && symbol !== "ATLAS" && symbol !== "USDC") return null;
        rows.push({
          wallet: wallet.address,
          role: wallet.role,
          name: wallet.name,
          symbol,
          mint,
          amountRaw: cached.amountRaw,
          amount: formatRaw(BigInt(cached.amountRaw), cached.decimals),
          decimals: cached.decimals,
          missing: false,
          tokenAccount: mint === NATIVE_MINT ? null : ""
        });
      }
    }
    if (!asOf) return null;
    return { wallets: groupBalances(rows, asOf), asOf };
  }
  function tileText(input) {
    if (input.mode === "unavailable") {
      const why = input.liveError ? `Live balance read failed (${input.liveError}). ` : "";
      return `${why}No cached balance was available. No balance was invented.`;
    }
    if (input.mode === "cached") {
      const ago = input.asOf ? updatedAgo(input.asOf, input.nowMs) : "";
      return ago || "Cached value";
    }
    const stamp2 = input.asOf ? liveReadStamp(input.asOf) : "";
    if (input.symbol === "SOL") return `${stamp2}. Native SOL.`;
    if (input.missing) return `${stamp2}. No standard token account, so the balance there is 0.`;
    return `${stamp2}. Standard token account.`;
  }
  function tilesFor(wallets, mode, asOf, nowMs, liveError) {
    const symbols = ["ATLAS", "USDC", "SOL"];
    const tiles = [];
    for (const wallet of mode === "unavailable" ? TRACKED_WALLETS : wallets) {
      for (const symbol of symbols) {
        const live = wallets.find((item) => item.address === wallet.address);
        const token = symbol === "SOL" ? null : live?.tokens.find((item) => item.symbol === symbol);
        const amount = mode === "unavailable" ? null : symbol === "SOL" ? live?.sol.amount ?? null : token?.amount ?? null;
        const missing = symbol !== "SOL" && token?.missing === true;
        tiles.push({
          wallet: wallet.address,
          symbol,
          amount,
          missing,
          mode: amount === null ? "unavailable" : mode,
          text: tileText({ symbol, missing, mode: amount === null ? "unavailable" : mode, asOf, nowMs, liveError })
        });
      }
    }
    return tiles;
  }
  async function readBalancesWithFallback(input) {
    const nowMs = input.now.getTime();
    const fetchedAt = input.now.toISOString();
    try {
      const wallets = await readTrackedBalances(input.rpc, input.associatedTokenAddress, fetchedAt);
      const label = liveReadStamp(fetchedAt);
      return {
        ok: true,
        mode: "live",
        asOf: fetchedAt,
        wallets,
        tiles: tilesFor(wallets, "live", fetchedAt, nowMs, null),
        liveError: null,
        label
      };
    } catch (error) {
      const liveError = publicErrorMessage(error);
      const cached = input.cacheBalances ? balancesFromCacheRows(input.cacheBalances) : null;
      if (!cached) {
        const label2 = `Live balance read failed (${liveError}). No cached balance was available. No balance was invented.`;
        return {
          ok: false,
          mode: "unavailable",
          asOf: null,
          wallets: [],
          tiles: tilesFor([], "unavailable", null, nowMs, liveError),
          liveError,
          label: label2
        };
      }
      const label = updatedAgo(cached.asOf, nowMs) || "Cached value";
      return {
        ok: true,
        mode: "cached",
        asOf: cached.asOf,
        wallets: cached.wallets,
        tiles: tilesFor(cached.wallets, "cached", cached.asOf, nowMs, liveError),
        liveError,
        label
      };
    }
  }

  // src/hub/base58.ts
  var ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function base58Decode(text) {
    if (text.length === 0 || text.length > 128) throw new Error("Invalid base58.");
    const bytes = [0];
    for (const char of text) {
      const value = ALPHABET.indexOf(char);
      if (value < 0) throw new Error("Invalid base58.");
      let carry = value;
      for (let index = 0; index < bytes.length; index += 1) {
        carry += (bytes[index] ?? 0) * 58;
        bytes[index] = carry & 255;
        carry >>= 8;
      }
      while (carry > 0) {
        bytes.push(carry & 255);
        carry >>= 8;
      }
    }
    for (let index = 0; text[index] === "1" && index < text.length - 1; index += 1) bytes.push(0);
    return Uint8Array.from(bytes.reverse());
  }

  // src/legacy/programs.ts
  var PLAYER_PROFILE_PROGRAM_ID = "pprofELXjL5Kck7Jn5hCpwAL82DpTkSYBENzahVtbc9";
  var PROFILE_FACTION_PROGRAM_ID = "pFACSRuobDmvfMKq1bAzwj27t6d2GJhSCHb1VcfnRmq";
  var SAGE_STARBASED_PROGRAM_ID = "SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE";
  var SAGE_LEGACY_PROGRAM_ID = "SAGEqqFewepDHH6hMDcmWy7yjHPpyKLDnRXKb3Ki8e6";
  var PROFILE_DISCRIMINATOR = Uint8Array.of(184, 101, 165, 188, 95, 63, 127, 188);
  var PLAYER_NAME_DISCRIMINATOR = Uint8Array.of(102, 9, 241, 98, 96, 196, 212, 161);
  var FACTION_DISCRIMINATOR = Uint8Array.of(14, 149, 119, 243, 145, 240, 79, 227);
  var FLEET_DISCRIMINATOR = Uint8Array.of(109, 207, 251, 48, 106, 2, 136, 163);
  var PROFILE_KEY_OFFSET = 30;
  var PROFILE_KEY_STRIDE = 80;
  var MAX_PROFILE_KEY_SLOTS = 4;
  var PLAYER_NAME_PROFILE_OFFSET = 9;
  var FACTION_PROFILE_OFFSET = 9;
  var FACTION_SLICE_LENGTH = 43;
  var FLEET_OWNER_OFFSET = 41;
  var FLEET_SLICE_LENGTH = 202;
  var PROFILE_SLICE_LENGTH = PROFILE_KEY_OFFSET + PROFILE_KEY_STRIDE * MAX_PROFILE_KEY_SLOTS;
  var PROGRAM_RULES = [
    {
      id: PLAYER_PROFILE_PROGRAM_ID,
      maxSlice: PROFILE_SLICE_LENGTH,
      discriminators: [
        {
          bytes: PROFILE_DISCRIMINATOR,
          pubkeyOffsets: Array.from({ length: MAX_PROFILE_KEY_SLOTS }, (_, slot) => PROFILE_KEY_OFFSET + slot * PROFILE_KEY_STRIDE)
        },
        { bytes: PLAYER_NAME_DISCRIMINATOR, pubkeyOffsets: [PLAYER_NAME_PROFILE_OFFSET] }
      ]
    },
    {
      id: PROFILE_FACTION_PROGRAM_ID,
      maxSlice: FACTION_SLICE_LENGTH,
      discriminators: [{ bytes: FACTION_DISCRIMINATOR, pubkeyOffsets: [FACTION_PROFILE_OFFSET] }]
    },
    {
      id: SAGE_STARBASED_PROGRAM_ID,
      maxSlice: FLEET_SLICE_LENGTH,
      discriminators: [{ bytes: FLEET_DISCRIMINATOR, pubkeyOffsets: [FLEET_OWNER_OFFSET] }]
    },
    {
      id: SAGE_LEGACY_PROGRAM_ID,
      maxSlice: FLEET_SLICE_LENGTH,
      discriminators: [{ bytes: FLEET_DISCRIMINATOR, pubkeyOffsets: [FLEET_OWNER_OFFSET] }]
    }
  ];
  function bytesEqual(left, right) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  }
  function parseMemcmp(filter) {
    if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
      throw new SafeClientError("getProgramAccounts filters must be memcmp filters.");
    }
    const keys = Object.keys(filter);
    if (keys.length !== 1 || keys[0] !== "memcmp") {
      throw new SafeClientError("getProgramAccounts filters must be memcmp filters.");
    }
    const memcmp = filter.memcmp;
    if (!memcmp || typeof memcmp !== "object" || Array.isArray(memcmp)) {
      throw new SafeClientError("getProgramAccounts filters must be memcmp filters.");
    }
    const memcmpKeys = Object.keys(memcmp);
    if (memcmpKeys.length !== 2 || !memcmpKeys.includes("offset") || !memcmpKeys.includes("bytes")) {
      throw new SafeClientError("getProgramAccounts memcmp filters take an offset and bytes.");
    }
    const offset = memcmp.offset;
    const encoded = memcmp.bytes;
    if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
      throw new SafeClientError("getProgramAccounts memcmp offset is not allowed.");
    }
    if (typeof encoded !== "string") {
      throw new SafeClientError("getProgramAccounts memcmp bytes are not base58.");
    }
    try {
      return { offset, bytes: base58Decode(encoded) };
    } catch {
      throw new SafeClientError("getProgramAccounts memcmp bytes are not base58.");
    }
  }
  function assertProgramAccountsParams(params) {
    if (params.length !== 2 || typeof params[0] !== "string") {
      throw new SafeClientError("getProgramAccounts needs a program id and a filter config.");
    }
    const rule = PROGRAM_RULES.find((item) => item.id === params[0]);
    if (!rule) {
      throw new SafeClientError("getProgramAccounts is limited to the Player Profile, Profile Faction, and SAGE programs.");
    }
    const config = params[1];
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new SafeClientError("getProgramAccounts needs a filter config.");
    }
    const record = config;
    for (const key of Object.keys(record)) {
      if (key !== "encoding" && key !== "commitment" && key !== "filters" && key !== "dataSlice") {
        throw new SafeClientError("getProgramAccounts config has a field this node does not send.");
      }
    }
    if (record.encoding !== "base64") {
      throw new SafeClientError("getProgramAccounts encoding must be base64.");
    }
    if (record.commitment !== void 0 && record.commitment !== "confirmed") {
      throw new SafeClientError("getProgramAccounts commitment must be confirmed.");
    }
    const slice = record.dataSlice;
    if (!slice || typeof slice !== "object" || Array.isArray(slice)) {
      throw new SafeClientError("getProgramAccounts requires a dataSlice.");
    }
    const sliceOffset = slice.offset;
    const sliceLength = slice.length;
    if (sliceOffset !== 0 || typeof sliceLength !== "number" || !Number.isInteger(sliceLength) || sliceLength < 1 || sliceLength > rule.maxSlice) {
      throw new SafeClientError("getProgramAccounts dataSlice is outside the allowed range.");
    }
    if (!Array.isArray(record.filters) || record.filters.length !== 2) {
      throw new SafeClientError("getProgramAccounts requires a discriminator filter and one pubkey filter.");
    }
    const parsed = record.filters.map((filter) => parseMemcmp(filter));
    const discriminator = parsed.find((filter) => filter.offset === 0);
    const pubkey = parsed.find((filter) => filter.offset !== 0);
    if (!discriminator || !pubkey) {
      throw new SafeClientError("getProgramAccounts requires a discriminator filter and one pubkey filter.");
    }
    const discRule = rule.discriminators.find((item) => bytesEqual(item.bytes, discriminator.bytes));
    if (!discRule || discriminator.bytes.length !== 8) {
      throw new SafeClientError("getProgramAccounts discriminator is not one this node searches.");
    }
    if (!discRule.pubkeyOffsets.includes(pubkey.offset) || pubkey.bytes.length !== 32) {
      throw new SafeClientError("getProgramAccounts pubkey filter is not at an allowed offset.");
    }
  }

  // src/dao/rpc.ts
  var ALLOWED_METHODS = /* @__PURE__ */ new Set([
    "getSignaturesForAddress",
    "getTransaction",
    "getTokenAccountsByOwner",
    "getTokenAccountBalance",
    "getBalance",
    "getAccountInfo",
    "getMultipleAccounts",
    "getProgramAccounts"
  ]);
  function assertReadMethod(method) {
    if (!method.startsWith("get") || !ALLOWED_METHODS.has(method)) {
      throw new SafeClientError(`Refusing Solana RPC method ${method}. This node only sends read methods.`);
    }
  }
  function isRateLimitedMessage(message) {
    return /too many requests|rate limit/i.test(message);
  }
  function isRateLimitedPayload(payload) {
    const items = Array.isArray(payload) ? payload : [payload];
    return items.some((item) => {
      if (!item || typeof item !== "object" || !("error" in item)) return false;
      const message = String(item.error?.message ?? "");
      return isRateLimitedMessage(message);
    });
  }
  function isOfficialPublicRpc(url) {
    return rpcHost(url) === "api.mainnet-beta.solana.com";
  }
  function signaturePage(result) {
    if (Array.isArray(result)) return result;
    if (!result || typeof result !== "object") return void 0;
    const signatures = result.signatures;
    if (Array.isArray(signatures)) return signatures;
    return void 0;
  }
  function beforeCursor(method, params) {
    if (method !== "getSignaturesForAddress") return null;
    const config = params[1];
    if (!config || typeof config !== "object") return null;
    const before = config.before;
    return typeof before === "string" && before.length > 0 ? before : null;
  }
  async function readHttpFailure(response) {
    const text = await response.text();
    let message = `HTTP ${response.status}`;
    try {
      const payload = JSON.parse(text);
      if (payload.error?.message) message = payload.error.message;
    } catch {
      if (text.trim()) message = `HTTP ${response.status}`;
    }
    return {
      message,
      rateLimited: isRateLimitedMessage(message),
      indexedRefusal: /personal token|indexed request/i.test(message)
    };
  }
  function sleep(ms) {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  var PUBLIC_SOLANA_RPC_URLS = [
    "https://solana-rpc.publicnode.com",
    "https://api.mainnet-beta.solana.com"
  ];
  function rpcHost(url) {
    try {
      return new URL(url).host;
    } catch {
      return "rpc";
    }
  }
  function solanaRpcUrls(primary, extra) {
    const raw = [primary, ...extra ? extra.split(",") : [], ...PUBLIC_SOLANA_RPC_URLS];
    const seen = /* @__PURE__ */ new Set();
    const urls = [];
    for (const item of raw) {
      const trimmed = item.trim().replace(/\/$/, "");
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      urls.push(trimmed);
    }
    return urls;
  }
  function nextWait(wait) {
    if (wait <= 0) return 0;
    return Math.min(wait * 2, 2e4);
  }
  function createRpcClient(url, fetchImpl = fetch, options) {
    const host = rpcHost(url);
    let gap = options?.minIntervalMs ?? 200;
    const attempts = options?.attempts ?? 4;
    async function post(body, timeoutMs) {
      const capped = timeoutMs !== void 0;
      const budget = timeoutMs ?? options?.timeoutMs ?? 45e3;
      if (!(budget > 0)) {
        throw new SafeClientError("Solana RPC read stopped because the time budget ran out.");
      }
      const started = Date.now();
      let wait = gap;
      let lastDetail = "no response";
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const left = capped ? budget - (Date.now() - started) : budget;
        if (left <= 0) {
          throw new SafeClientError("Solana RPC read stopped because the time budget ran out.");
        }
        await sleep(wait);
        const signalMs = capped ? budget - (Date.now() - started) : budget;
        if (signalMs <= 0) {
          throw new SafeClientError("Solana RPC read stopped because the time budget ran out.");
        }
        let response;
        try {
          response = await fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(signalMs)
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "network error";
          lastDetail = message.replace(/https?:\/\/\S+/g, "[rpc]");
          wait = nextWait(wait);
          continue;
        }
        if (!response.ok) {
          const failure = await readHttpFailure(response);
          if (failure.indexedRefusal) {
            throw new SafeClientError(`Solana RPC refused an indexed read (${host}).`);
          }
          if (response.status === 403 || response.status === 408 || response.status === 429 || response.status >= 500 || failure.rateLimited) {
            lastDetail = failure.message || `HTTP ${response.status}`;
            wait = gap <= 0 ? 0 : nextWait(Math.max(wait, gap));
            gap = Math.max(gap, wait);
            continue;
          }
          throw new SafeClientError(`Solana RPC HTTP ${response.status} from ${host}.`);
        }
        const payload = await response.json();
        if (isRateLimitedPayload(payload)) {
          lastDetail = "JSON-RPC rate limit";
          wait = gap <= 0 ? 0 : nextWait(Math.max(wait, gap));
          gap = Math.max(gap, wait);
          continue;
        }
        gap = Math.max(options?.minIntervalMs ?? 200, Math.floor(gap * 0.8));
        return payload;
      }
      throw new SafeClientError(`Solana RPC read failed after retries (${host}: ${lastDetail}).`);
    }
    function unwrap(payload, id) {
      if (!payload || typeof payload !== "object") {
        throw new SafeClientError("Solana RPC returned an unexpected payload.");
      }
      const body = payload;
      if (body.error) {
        throw new SafeClientError(`Solana RPC error: ${body.error.message ?? "request failed"}.`);
      }
      if (body.id !== void 0 && body.id !== id) {
        throw new SafeClientError("Solana RPC response id did not match the request.");
      }
      return body.result;
    }
    function assertCall(method, params) {
      assertReadMethod(method);
      if (method !== "getProgramAccounts") return;
      if (typeof globalThis.window !== "undefined") {
        throw new SafeClientError("getProgramAccounts runs on the server. The public mainnet RPC refuses browser calls.");
      }
      if (!isOfficialPublicRpc(url)) {
        throw new SafeClientError("getProgramAccounts is sent only to the public mainnet RPC.");
      }
      assertProgramAccountsParams(params);
    }
    return {
      async call(method, params, callOptions) {
        assertCall(method, params);
        const payload = await post({ jsonrpc: "2.0", id: 1, method, params }, callOptions?.timeoutMs);
        return unwrap(payload, 1);
      },
      async batch(requests) {
        if (requests.length === 0) return [];
        for (const request of requests) assertCall(request.method, request.params);
        const payload = await post(
          requests.map((request, index) => ({
            jsonrpc: "2.0",
            id: index,
            method: request.method,
            params: request.params
          }))
        );
        if (!Array.isArray(payload)) {
          throw new SafeClientError("Solana RPC batch did not return a list.");
        }
        const byId = /* @__PURE__ */ new Map();
        for (const item of payload) {
          if (!item || typeof item !== "object" || typeof item.id !== "number") {
            throw new SafeClientError("Solana RPC batch item had no id.");
          }
          byId.set(item.id, item);
        }
        return requests.map((_, index) => {
          const item = byId.get(index);
          if (!item) throw new SafeClientError("Solana RPC batch omitted a response.");
          return unwrap(item, index);
        });
      }
    };
  }
  function createFallbackRpc(urls, fetchImpl = fetch, options) {
    if (urls.length === 0) {
      throw new SafeClientError("No public Solana RPC URL was configured.");
    }
    const clients = urls.map((url) => ({ url, rpc: createRpcClient(url, fetchImpl, options) }));
    async function attempt(method, params, run) {
      const errors = [];
      const before = beforeCursor(method, params);
      let emptyBeforePages = 0;
      for (const client of clients) {
        try {
          const result = await run(client.rpc);
          if (method === "getSignaturesForAddress") {
            const rows = signaturePage(result);
            if (!rows) {
              errors.push(`Solana RPC error: getSignaturesForAddress returned an unexpected shape (${rpcHost(client.url)}).`);
              continue;
            }
            if (before && rows.length === 0) {
              emptyBeforePages += 1;
              if (isOfficialPublicRpc(client.url)) return rows;
              continue;
            }
            return rows;
          }
          if (method === "getTransaction" && result === null) continue;
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : "request failed";
          errors.push(message);
        }
      }
      if (method === "getTransaction" && errors.length === 0) return null;
      if (before && emptyBeforePages === clients.length && errors.length === 0) return [];
      throw new SafeClientError(
        errors.length > 0 ? `Public Solana RPC refused the read. ${errors.join(" | ")}` : "Public Solana RPC refused the read."
      );
    }
    return {
      call(method, params, callOptions) {
        return attempt(method, params, (rpc) => rpc.call(method, params, callOptions));
      },
      async batch(requests) {
        const results = [];
        for (const request of requests) {
          results.push(await attempt(request.method, request.params, (rpc) => rpc.call(request.method, request.params)));
        }
        return results;
      }
    };
  }

  // src/dao/payment-match.ts
  var DECIMAL2 = /^\d+(\.\d+)?$/;
  function norm(value) {
    return value.replace(/\s+/g, " ").trim();
  }
  function parseCsv(text) {
    const rows = [];
    let row = [];
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
  function parseMoney(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return { amount: null, blank: true, raw: trimmed };
    const text = trimmed.replace(/[$,\s]/g, "");
    if (/^n\/?a$/i.test(text) || text === "?" || text === "-" || text === "\u2014") {
      return { amount: null, blank: false, raw: trimmed };
    }
    if (!DECIMAL2.test(text)) return { amount: null, blank: false, raw: trimmed };
    return { amount: text, blank: false, raw: trimmed };
  }
  function parseTrackerMoney(csv) {
    const table = parseCsv(csv.replace(/^\uFEFF/, ""));
    const headerIndex = table.findIndex((cells) => cells.some((cell) => norm(cell) === "PIP Name"));
    const header = headerIndex >= 0 ? table[headerIndex] : void 0;
    if (!header) {
      return { rows: [], unknownCells: [], blankCells: 0 };
    }
    const index = /* @__PURE__ */ new Map();
    header.forEach((name, i) => {
      const key = norm(name);
      if (key && !index.has(key)) index.set(key, i);
    });
    const pipCol = index.get("PIP");
    const usdcCol = index.get("Total Amount Paid (USDC)");
    const atlasCol = index.get("Total Amount Paid (ATLAS)");
    const rows = [];
    const unknownCells = [];
    let blankCells = 0;
    if (pipCol === void 0) return { rows, unknownCells, blankCells };
    for (const cells of table.slice(headerIndex + 1)) {
      const pip = (cells[pipCol] ?? "").trim();
      if (!pip) continue;
      const usdc = parseMoney(usdcCol === void 0 ? "" : cells[usdcCol] ?? "");
      const atlas = parseMoney(atlasCol === void 0 ? "" : cells[atlasCol] ?? "");
      for (const [mint, cell] of [
        [USDC_MINT, usdc],
        [ATLAS_MINT, atlas]
      ]) {
        if (cell.blank) blankCells += 1;
        else if (cell.amount === null) unknownCells.push({ pip, mint, raw: cell.raw });
      }
      rows.push({ pip, usdcPaid: usdc.amount, atlasPaid: atlas.amount });
    }
    return { rows, unknownCells, blankCells };
  }
  function paidFor(row, mint) {
    if (mint === USDC_MINT) return row.usdcPaid;
    if (mint === ATLAS_MINT) return row.atlasPaid;
    return null;
  }
  function symbolFor(mint, fallback) {
    if (fallback) return fallback;
    if (mint === USDC_MINT) return "USDC";
    if (mint === ATLAS_MINT) return "ATLAS";
    return mint;
  }
  function matchTrackerToPayments(parsed, payments, options) {
    const notes = [
      "A match is recorded only when a Tracker paid amount equals a chain outflow, or when one remaining paid amount equals the sum of the remaining outflows.",
      "A blank cell is unknown. It is not treated as zero."
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
            detail: "The treasury cache was not read, so no payment was matched and none is listed as a mismatch."
          }
        ],
        unknownCells: parsed.unknownCells,
        blankCells: parsed.blankCells,
        notes
      };
    }
    const matches = [];
    const mismatches = [];
    const unresolved = [];
    const mints = [USDC_MINT, ATLAS_MINT];
    for (const mint of mints) {
      const complete = options.mintComplete(mint);
      const outflows = payments.filter((payment) => payment.mint === mint && DECIMAL2.test(payment.amount));
      const rows = parsed.rows.map((row) => ({ pip: row.pip, amount: paidFor(row, mint) })).filter((row) => row.amount !== null && compareDecimal(row.amount, "0") > 0);
      const usedRows = /* @__PURE__ */ new Set();
      const usedPays = /* @__PURE__ */ new Set();
      const blockedRows = /* @__PURE__ */ new Set();
      outflows.forEach((payment, payIndex) => {
        const candidates = rows.map((row, rowIndex) => ({ row, rowIndex })).filter((item) => !usedRows.has(item.rowIndex) && compareDecimal(item.row.amount, payment.amount) === 0);
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
            reason: "This outflow equals that PIP's paid amount, and no other open PIP has the same paid amount."
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
            detail: `More than one PIP lists this paid amount (${candidates.map((item) => item.row.pip).join(", ")}), so the outflow is not assigned.`
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
              reason: "The scan for this mint is complete. These remaining outflows add up to the only remaining PIP paid amount. They are not matched one by one."
            });
          }
          continue;
        }
      }
      for (const payment of leftPays) {
        const detail = complete ? "No Tracker paid amount equals this outflow." : "The scan for this mint is not complete, so this outflow is not called a mismatch.";
        const item = {
          mint,
          pip: null,
          signature: payment.signature,
          amount: payment.amount,
          detail
        };
        if (complete) mismatches.push({ kind: "outflow_without_sheet", ...item });
        else unresolved.push(item);
      }
      for (const row of leftRows) {
        const claimed = matches.some((match) => match.pip === row.pip && match.mint === mint) || complete && leftRows.length === 1 && leftPays.length > 1 && compareDecimal(addDecimalStrings(leftPays.map((payment) => payment.amount)), row.amount) === 0;
        if (claimed) continue;
        const detail = complete ? "No chain outflow equals this paid amount." : "The scan for this mint is not complete, so this paid amount is not called a mismatch.";
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
      notes
    };
  }
  function mintCompleteFromCache(payload, mint) {
    if (!payload || typeof payload !== "object") return false;
    const cursors = payload.cursors;
    if (!Array.isArray(cursors)) return false;
    const relevant = cursors.filter((cursor) => {
      if (!cursor || typeof cursor !== "object") return false;
      const row = cursor;
      return row.kind === "token" && row.mint === mint;
    });
    if (relevant.length === 0) return false;
    return relevant.every(
      (cursor) => cursor.reachedEnd === true && Array.isArray(cursor.gaps) && cursor.gaps.length === 0 && cursor.reconciled === true
    );
  }

  // src/dao/usd.ts
  var DECIMAL3 = /^\d+(\.\d+)?$/;
  function numberToDecimal(value) {
    if (!Number.isFinite(value) || value < 0 || Object.is(value, -0)) return null;
    const text = value.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
    if (!DECIMAL3.test(text)) return null;
    if (Number(text) !== value) return null;
    return text;
  }
  function parseJupiterPrices(payload, mints) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new SafeClientError("Jupiter price response was not an object. No price was invented.");
    }
    const body = payload;
    const prices = {};
    for (const mint of mints) {
      const row = body[mint];
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        prices[mint] = null;
        continue;
      }
      const usdPrice = row.usdPrice;
      if (typeof usdPrice === "string" && DECIMAL3.test(usdPrice)) prices[mint] = usdPrice;
      else if (typeof usdPrice === "number") prices[mint] = numberToDecimal(usdPrice);
      else prices[mint] = null;
    }
    return { prices, source: "https://lite-api.jup.ag/price/v3" };
  }
  function approximateUsd(amount, usdPrice) {
    if (!DECIMAL3.test(amount) || !DECIMAL3.test(usdPrice)) return null;
    const [leftWhole, leftFrac = ""] = amount.split(".");
    const [rightWhole, rightFrac = ""] = usdPrice.split(".");
    const scale = leftFrac.length + rightFrac.length;
    const product = BigInt(`${leftWhole}${leftFrac}`) * BigInt(`${rightWhole}${rightFrac}`);
    return formatRaw(product, scale);
  }
  return __toCommonJS(browser_entry_exports);
})();
