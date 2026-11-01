#!/usr/bin/env node
/* Snapshot DAO wallet balances into balances.json. No server, no key, no paid API.
   Reads the wallet list and mints from ../config.js, queries a public Solana RPC with
   getBalance and getTokenAccountsByOwner (all token accounts, not just the standard one),
   and marks which account is the standard associated token account (ATA).
   A failed read is written as null with the error text. Nothing is estimated.

   Usage:  node scripts/snapshot-balances.mjs            (from the dashboard folder)
   Env:    RPC_URL   default config.js rpcUrl (https://solana-rpc.publicnode.com)
           RPC_FALLBACK_URLS  comma-separated, default: config.js rpcFallbackUrls (tried when RPC_URL fails a call)
           OUT       default ./balances.json (next to index.html)
   Also snapshots each Squads v3 multisig in config.js (threshold, member keys, latest transactions). */
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { Module } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function evaluateScript(filename, localRequire) {
  const source = readFileSync(filename, "utf8");
  const compiled = vm.runInThisContext(Module.wrap(source), { filename });
  const current = { exports: {} };
  compiled.call(current.exports, current.exports, localRequire, current, filename, path.dirname(filename));
  return current.exports;
}

/* ata.js and squads.js assign module.exports inside a browser script.
   The dashboard package is "type": "module", so Node's require() returns an empty
   namespace and associatedTokenAddress / b64 are not functions. Load them with the
   CommonJS wrapper instead. */
export function loadDashboardCrypto(dashboardRoot = root) {
  const ataPath = path.join(dashboardRoot, "ata.js");
  const squadsPath = path.join(dashboardRoot, "squads.js");
  const ata = evaluateScript(ataPath, () => {
    throw new Error("dashboard/ata.js cannot load another file.");
  });
  const squads = evaluateScript(squadsPath, (specifier) => {
    if (specifier === "./ata.js") return ata;
    throw new Error(`dashboard/squads.js cannot load ${specifier}.`);
  });
  return { ATA: ata, SQUADS: squads };
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

async function main() {
const { ATA, SQUADS } = loadDashboardCrypto();

const sandbox = { window: {} };
vm.runInNewContext(await readFile(path.join(root, "config.js"), "utf8"), sandbox);
const cfg = sandbox.window.SA_DASHBOARD_CONFIG;

const RPC_URL = process.env.RPC_URL || cfg.rpcUrl || "https://solana-rpc.publicnode.com";
const FALLBACKS = (process.env.RPC_FALLBACK_URLS != null ? process.env.RPC_FALLBACK_URLS.split(",") : (cfg.rpcFallbackUrls || []))
  .map((u) => u.trim()).filter((u) => u && u !== RPC_URL);
const OUT = process.env.OUT || path.join(root, "balances.json");
const MINTS = { ATLAS: cfg.atlasMint, USDC: cfg.usdcMint };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpcAt(url, method, params) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ? `${data.error.code} ${data.error.message}` : `HTTP ${res.status}`);
      return data.result;
    } catch (err) {
      last = err;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw last;
}

/* Primary first, then fallbacks. Returns the result and which host answered. */
async function rpcWithSource(method, params) {
  const errors = [];
  for (const url of [RPC_URL, ...FALLBACKS]) {
    try { return { result: await rpcAt(url, method, params), host: new URL(url).host }; }
    catch (e) { errors.push(`${new URL(url).host}: ${String(e.message).split(". ")[0]}`); }
  }
  throw new Error(errors.join("; "));
}
async function rpc(method, params) { return (await rpcWithSource(method, params)).result; }

async function walletSnapshot(key, label, address) {
  const out = { key, label, address, sol: null, tokens: {}, errors: [] };
  try {
    const r = await rpc("getBalance", [address]);
    out.sol = { amount: r.value / 1e9, lamports: r.value, slot: r.context.slot };
  } catch (e) { out.errors.push(`SOL: ${e.message}`); }
  for (const [sym, mint] of Object.entries(MINTS)) {
    await sleep(400);
    try {
      const standard = await ATA.associatedTokenAddress(address, mint);
      const r = await rpc("getTokenAccountsByOwner", [address, { mint }, { encoding: "jsonParsed" }]);
      const accounts = r.value.map((a) => ({
        address: a.pubkey,
        amount: a.account.data.parsed.info.tokenAmount.uiAmountString,
        isStandard: a.pubkey === standard
      }));
      const total = accounts.reduce((s, a) => s + Number(a.amount), 0);
      const std = accounts.find((a) => a.isStandard);
      const others = accounts.filter((a) => !a.isStandard);
      out.tokens[sym] = {
        mint,
        total,
        standardAccount: standard,
        standardAccountExists: !!std,
        standardAmount: std ? Number(std.amount) : 0,
        otherAccounts: others.length,
        otherAmount: others.reduce((s, a) => s + Number(a.amount), 0),
        accounts,
        slot: r.context.slot
      };
    } catch (e) {
      out.tokens[sym] = null;
      out.errors.push(`${sym}: ${e.message}`);
    }
  }
  return out;
}

const list = [
  ["treasury", "DAO Treasury", cfg.wallets.treasury],
  ["ecosystemFund", "Ecosystem Fund", cfg.wallets.ecosystemFund]
];

const wallets = [];
for (const [key, label, address] of list) wallets.push(await walletSnapshot(key, label, address));

/* Squads v3 multisigs: threshold, member keys, vault check, latest transactions. Read-only. */
async function multisigSnapshot(m) {
  const program = m.program || SQUADS.PROGRAM;
  const out = { label: m.label, address: m.address, program, vault: m.vault, vaultIndex: m.vaultIndex || 1, threshold: null, errors: [] };
  try {
    const { result: r, host } = await rpcWithSource("getAccountInfo", [m.address, { encoding: "base64" }]);
    if (!r.value) throw new Error("multisig account not found");
    if (r.value.owner !== program) throw new Error("account is not owned by the Squads v3 program");
    const ms = SQUADS.decodeMs(SQUADS.b64(r.value.data[0]));
    Object.assign(out, {
      readVia: host, slot: r.context.slot,
      threshold: ms.threshold, members: ms.members, transactionIndex: ms.transactionIndex, msChangeIndex: ms.msChangeIndex,
      authorityIndex: ms.authorityIndex
    });
    out.derivedVault = await SQUADS.vaultAddress(m.address, out.vaultIndex, program);
    out.vaultMatches = out.derivedVault === m.vault;
    out.recentTransactions = [];
    const count = Math.max(0, Number(cfg.multisigRecentTransactions || 5));
    for (let i = ms.transactionIndex; i > 0 && i > ms.transactionIndex - count; i--) {
      await sleep(500);
      const address = await SQUADS.transactionAddress(m.address, i, program);
      try {
        const t = await rpc("getAccountInfo", [address, { encoding: "base64" }]);
        if (!t.value) { out.recentTransactions.push({ index: i, address, missing: true }); continue; }
        const d = SQUADS.decodeMsTx(SQUADS.b64(t.value.data[0]));
        if (d.ms !== m.address) throw new Error("transaction belongs to another multisig");
        out.recentTransactions.push({ index: i, address, status: d.status, creator: d.creator, approved: d.approved,
          rejected: d.rejected, cancelled: d.cancelled, instructionIndex: d.instructionIndex, executedIndex: d.executedIndex });
      } catch (e) {
        out.recentTransactions.push({ index: i, address, error: e.message });
        out.errors.push(`tx #${i}: ${e.message}`);
      }
    }
  } catch (e) { out.errors.push(e.message); }
  return out;
}

const multisigs = [];
for (const m of (cfg.multisigs || []).filter((x) => x && x.address)) { await sleep(500); multisigs.push(await multisigSnapshot(m)); }

const snapshot = {
  generatedAtUtc: new Date().toISOString(),
  rpcUrl: RPC_URL,
  rpcFallbackUrls: FALLBACKS,
  method: "getBalance + getTokenAccountsByOwner (jsonParsed). Totals include every token account the wallet owns for that mint. Multisigs: getAccountInfo on the Squads v3 multisig and its latest transaction accounts, decoded by squads.js.",
  wallets,
  multisigs
};
await writeFile(OUT, JSON.stringify(snapshot, null, 2) + "\n");
console.log(`Wrote ${OUT} at ${snapshot.generatedAtUtc}`);
for (const w of wallets) {
  console.log(`${w.label}: SOL ${w.sol ? w.sol.amount : "n/a"}; ` +
    Object.entries(w.tokens).map(([s, t]) => `${s} ${t ? t.total + (t.otherAccounts ? ` (${t.otherAccounts} non-standard)` : "") : "n/a"}`).join("; ") +
    (w.errors.length ? `; errors: ${w.errors.join(" | ")}` : ""));
}
for (const m of multisigs) {
  console.log(`${m.label}: ${m.threshold != null ? `${m.threshold} of ${m.members.length}, txIndex ${m.transactionIndex}, vault match ${m.vaultMatches}; latest: ` +
    m.recentTransactions.map((t) => `#${t.index} ${t.status || (t.missing ? "missing" : "error")}`).join(", ") : "n/a"}` +
    (m.errors.length ? `; errors: ${m.errors.join(" | ")}` : ""));
}
if (wallets.some((w) => w.errors.length) || multisigs.some((m) => m.errors.length)) process.exitCode = 1;
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
