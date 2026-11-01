/* Hand-written Solana associated-token-account (ATA) derivation. No dependencies.
   Works in the browser (window.SA_ATA) and in Node 18+ (module.exports).
   ATA = findProgramAddress([owner, tokenProgram, mint], associatedTokenProgram).
   Uses SHA-256 from Web Crypto and a BigInt ed25519 "is this point on the curve" check. */
(function (root) {
  "use strict";
  var ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  var TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  var ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

  function b58decode(s) {
    var zeros = 0;
    while (zeros < s.length && s[zeros] === "1") zeros++;
    var bytes = []; /* little-endian accumulator */
    for (var i = zeros; i < s.length; i++) {
      var carry = ALPHABET.indexOf(s[i]);
      if (carry < 0) throw new Error("Not base58: " + s);
      for (var j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
      while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    var out = new Uint8Array(zeros + bytes.length);
    for (var k = 0; k < bytes.length; k++) out[zeros + k] = bytes[bytes.length - 1 - k];
    return out;
  }

  function b58encode(bytes) {
    var digits = [0];
    for (var i = 0; i < bytes.length; i++) {
      var carry = bytes[i];
      for (var j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
      while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    var out = "", k = 0;
    for (; k < bytes.length && bytes[k] === 0; k++) out += "1";
    if (k === bytes.length) return out;
    for (var d = digits.length - 1; d >= 0; d--) out += ALPHABET[digits[d]];
    return out;
  }

  function key32(s) {
    var b = b58decode(s);
    if (b.length !== 32) throw new Error("Not a 32-byte Solana address: " + s);
    return b;
  }

  /* ed25519 field math */
  var P = (1n << 255n) - 19n;
  var D = (-121665n * inv(121666n)) % P;
  var SQRT_M1 = pow(2n, (P - 1n) / 4n);
  function mod(a) { var r = a % P; return r < 0n ? r + P : r; }
  function pow(b, e) { var r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; }
  function inv(a) { return pow(mod(a), P - 2n); }

  /* Same rule as curve25519-dalek CompressedEdwardsY::decompress (what Solana uses): on curve iff x^2 = u/v has a root. */
  function isOnCurve(bytes) {
    var y = 0n;
    for (var i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
    y = mod(y);
    var y2 = (y * y) % P;
    var u = mod(y2 - 1n);
    var v = mod(D * y2 + 1n);
    var v3 = (v * v % P) * v % P;
    var v7 = (v3 * v3 % P) * v % P;
    var x = (u * v3 % P) * pow(u * v7 % P, (P - 5n) / 8n) % P;
    var vx2 = (v * x % P) * x % P;
    if (vx2 === u) return true;
    if (vx2 === mod(-u)) return true; /* x * sqrt(-1) is the root */
    return false;
  }

  function concat(parts) {
    var len = parts.reduce(function (n, p) { return n + p.length; }, 0);
    var out = new Uint8Array(len), o = 0;
    parts.forEach(function (p) { out.set(p, o); o += p.length; });
    return out;
  }

  function subtle() {
    var c = (typeof globalThis !== "undefined" && globalThis.crypto) || null;
    if (!c || !c.subtle) throw new Error("Web Crypto (crypto.subtle) is not available here.");
    return c.subtle;
  }

  async function findProgramAddress(seeds, programId) {
    var prog = key32(programId);
    var marker = new TextEncoder().encode("ProgramDerivedAddress");
    for (var bump = 255; bump >= 0; bump--) {
      var data = concat(seeds.concat([new Uint8Array([bump]), prog, marker]));
      var hash = new Uint8Array(await subtle().digest("SHA-256", data));
      if (!isOnCurve(hash)) return { address: b58encode(hash), bump: bump };
    }
    throw new Error("No PDA found.");
  }

  async function associatedTokenAddress(owner, mint, tokenProgram) {
    var r = await findProgramAddress([key32(owner), key32(tokenProgram || TOKEN_PROGRAM), key32(mint)], ATA_PROGRAM);
    return r.address;
  }

  var api = { associatedTokenAddress: associatedTokenAddress, findProgramAddress: findProgramAddress, isOnCurve: isOnCurve,
    b58decode: b58decode, b58encode: b58encode, TOKEN_PROGRAM: TOKEN_PROGRAM, ATA_PROGRAM: ATA_PROGRAM };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.SA_ATA = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null));
