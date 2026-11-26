import { createPublicKey, verify as cryptoVerify } from "node:crypto";

/**
 * Detached ed25519 check used for player consent and hub approvals.
 * Node's verifier accepts a cofactored equation, so a small-order public key
 * or a small-order R can make an all-zero signature look valid.
 * These points, and the non-canonical encodings of the same y values, are
 * rejected before that call. S must be canonical (S < L).
 */

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
/** 2^255 - 19. A point encoding whose y is not strictly below this is not canonical. */
const FIELD_PRIME = (1n << 255n) - 19n;
/** Order of the ed25519 base point. A signature scalar at or above this is not canonical. */
const GROUP_ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;

/**
 * y coordinates of the torsion subgroup, sign bit clear.
 * The eight points are these y values with either sign bit, except the two
 * non-canonical rows (y = p and y = p + 1), which are the extra encodings of
 * y = 0 and y = 1. The sign bit is ignored, so both encodings of each point match.
 * The 26e8958f… point is the third row.
 */
const SMALL_ORDER_Y = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
].map((hex) => Buffer.from(hex, "hex"));

function readLittleEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let index = 0; index < bytes.length; index += 1) {
    value |= BigInt(bytes[index] ?? 0) << (8n * BigInt(index));
  }
  return value;
}

/** Lower 255 bits are y. Canonical means y < 2^255 - 19. */
export function isCanonicalEd25519Point(point: Uint8Array): boolean {
  if (point.length !== 32) return false;
  return (readLittleEndian(point) & ((1n << 255n) - 1n)) < FIELD_PRIME;
}

/** True for a small-order point, including a non-canonical encoding and either sign bit. */
export function isSmallOrderEd25519Point(point: Uint8Array): boolean {
  if (point.length !== 32) return false;
  const last = (point[31] ?? 0) & 0x7f;
  for (const candidate of SMALL_ORDER_Y) {
    if (candidate[31] !== last) continue;
    let matches = true;
    for (let index = 0; index < 31; index += 1) {
      if (point[index] !== candidate[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function pointAccepted(point: Uint8Array): boolean {
  return isCanonicalEd25519Point(point) && !isSmallOrderEd25519Point(point);
}

/**
 * Verify a detached ed25519 signature.
 * Returns false for a bad length, a non-canonical point, a small-order public
 * key or R, or a scalar S that is not strictly below the group order.
 */
export function verifyEd25519Detached(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  if (!pointAccepted(publicKey)) return false;
  if (!pointAccepted(signature.subarray(0, 32))) return false;
  if (readLittleEndian(signature.subarray(32)) >= GROUP_ORDER) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]),
      format: "der",
      type: "spki",
    });
    return cryptoVerify(null, message, key, signature);
  } catch {
    return false;
  }
}
