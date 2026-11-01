/* Hand-written, read-only decoder for Squads Protocol v3 multisig accounts. No dependencies.
   Manual decode validated against live accounts.
   Needs ata.js (SA_ATA.findProgramAddress, b58encode/b58decode). Works in the browser (window.SA_SQUADS) and Node 18+.

   Ms (discriminator 4676096cfed71f78): threshold u16 @8, authorityIndex u16 @10, transactionIndex u32 @12,
     msChangeIndex u32 @16, bump u8 @20, createKey Pubkey @21, allowExternalExecute bool @53, keys Vec<Pubkey> @54.
   MsTransaction (discriminator b69768d8ff01139d): creator @8, ms @40, transactionIndex u32 @72, authorityIndex u32 @76,
     authorityBump u8 @80, status u8 @81, instructionIndex u8 @82, bump u8 @83, approved Vec<Pubkey> @84,
     rejected Vec<Pubkey>, cancelled Vec<Pubkey>, executedIndex u8.
   Vault PDA: ["squad", ms, u32 LE index, "authority"]. Transaction PDA: ["squad", ms, u32 LE index, "transaction"]. */
(function (root) {
  "use strict";
  var ATA = (typeof module !== "undefined" && module.exports && typeof require === "function") ? require("./ata.js") : root.SA_ATA;
  var PROGRAM = "SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu";
  var MS_DISC = "4676096cfed71f78";
  var TX_DISC = "b69768d8ff01139d";
  var STATUS = ["Draft", "Active", "ExecuteReady", "Executed", "Rejected", "Cancelled"];

  function b64(s) {
    if (typeof atob === "function") {
      var bin = atob(s), out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(s, "base64"));
  }
  function hex(bytes) { return Array.prototype.map.call(bytes, function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
  function u16(d, o) { return d[o] | (d[o + 1] << 8); }
  function u32(d, o) { return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16)) + d[o + 3] * 16777216; }
  function key(d, o) { return ATA.b58encode(d.subarray(o, o + 32)); }
  function need(d, n) { if (d.length < n) throw new Error("account data too short"); }

  function decodeMs(d) {
    if (hex(d.subarray(0, 8)) !== MS_DISC) throw new Error("not a Squads v3 multisig account");
    need(d, 58);
    var n = u32(d, 54), members = [];
    need(d, 58 + n * 32);
    for (var i = 0; i < n; i++) members.push(key(d, 58 + i * 32));
    return {
      threshold: u16(d, 8), authorityIndex: u16(d, 10), transactionIndex: u32(d, 12), msChangeIndex: u32(d, 16),
      createKey: key(d, 21), allowExternalExecute: !!d[53], members: members
    };
  }

  function decodeMsTx(d) {
    if (hex(d.subarray(0, 8)) !== TX_DISC) throw new Error("not a Squads v3 transaction account");
    need(d, 88);
    var o = 84;
    function vec() {
      need(d, o + 4); var n = u32(d, o); o += 4; var r = [];
      need(d, o + n * 32);
      for (var i = 0; i < n; i++) { r.push(key(d, o)); o += 32; }
      return r;
    }
    var approved = vec(), rejected = vec(), cancelled = vec();
    return {
      creator: key(d, 8), ms: key(d, 40), transactionIndex: u32(d, 72), authorityIndex: u32(d, 76),
      status: STATUS[d[81]] || ("unknown(" + d[81] + ")"), instructionIndex: d[82],
      approved: approved, rejected: rejected, cancelled: cancelled, executedIndex: d.length > o ? d[o] : null
    };
  }

  function le32(n) { return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]); }
  var enc = new TextEncoder();
  async function pda(ms, index, kind, program) {
    var r = await ATA.findProgramAddress([enc.encode("squad"), ATA.b58decode(ms), le32(index), enc.encode(kind)], program || PROGRAM);
    return r.address;
  }
  function vaultAddress(ms, index, program) { return pda(ms, index, "authority", program); }
  function transactionAddress(ms, index, program) { return pda(ms, index, "transaction", program); }

  var api = { PROGRAM: PROGRAM, STATUS: STATUS, decodeMs: decodeMs, decodeMsTx: decodeMsTx, b64: b64,
    vaultAddress: vaultAddress, transactionAddress: transactionAddress };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.SA_SQUADS = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null));
