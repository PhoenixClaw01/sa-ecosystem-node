import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";

import { base58Decode, base58Encode } from "../src/hub/base58.js";
import {
  isCanonicalEd25519Point,
  isSmallOrderEd25519Point,
  verifyEd25519Detached,
} from "../src/hub/ed25519-verify.js";
import {
  matchReputationLink,
  reputationLinkConsent,
  reputationLinkMessage,
  type ReputationLink,
} from "../src/hub/reputation-link.js";
import { matchStoryConsent, storyAllowMessage, storyOptInConsent, type StoryOptIn } from "../src/hub/story-optin.js";

const HUB = "https://github.com/example/reputation-hub";
const ZERO_SIGNATURE = "1".repeat(64);
const SMALL_ORDER_KEYS = [
  "11111111111111111111111111111111",
  "3ctC68zTqpRDQShoondiQKDHwZDAUjRyxiPNdg8cD6Pe",
  "H242rsh5hzpvDdct56PG5YPQbKUT37EmySQLoQqrYUJr",
] as const;
const TORSION_26E8 = Buffer.from("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05", "hex");
const TORSION_26E8_SIGN = Buffer.from("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85", "hex");
const NON_CANONICAL_Y = Buffer.from("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", "hex");

function zeroSignature(): Uint8Array {
  return base58Decode(ZERO_SIGNATURE);
}

function link(wallet: string): ReputationLink {
  return {
    action: "link",
    wallet,
    profile: "Pilot",
    date: "2026-11-12",
    signature: ZERO_SIGNATURE,
  };
}

describe("strict ed25519 verification", () => {
  it("rejects the zero signature on every small-order key, including 26e8958f", () => {
    const message = new TextEncoder().encode("consent");
    const signature = zeroSignature();
    expect(signature).toEqual(new Uint8Array(64));
    for (const address of SMALL_ORDER_KEYS) {
      const publicKey = base58Decode(address);
      expect(publicKey).toHaveLength(32);
      expect(isSmallOrderEd25519Point(publicKey)).toBe(true);
      expect(verifyEd25519Detached(message, signature, publicKey)).toBe(false);
    }
    expect(isSmallOrderEd25519Point(TORSION_26E8)).toBe(true);
    expect(isSmallOrderEd25519Point(TORSION_26E8_SIGN)).toBe(true);
    expect(verifyEd25519Detached(message, signature, TORSION_26E8)).toBe(false);
    expect(verifyEd25519Detached(message, signature, TORSION_26E8_SIGN)).toBe(false);
    expect(isCanonicalEd25519Point(NON_CANONICAL_Y)).toBe(false);
    expect(verifyEd25519Detached(message, signature, NON_CANONICAL_Y)).toBe(false);
  });

  it("rejects a small-order R and a scalar that is not below the group order", () => {
    const pair = nacl.sign.keyPair();
    const message = new TextEncoder().encode("a real player sentence");
    const signature = nacl.sign.detached(message, pair.secretKey);
    expect(verifyEd25519Detached(message, signature, pair.publicKey)).toBe(true);

    const smallR = new Uint8Array(signature);
    smallR.set(TORSION_26E8, 0);
    expect(verifyEd25519Detached(message, smallR, pair.publicKey)).toBe(false);

    const groupOrder = (1n << 252n) + 27742317777372353535851937790883648493n;
    let scalar = 0n;
    for (let index = 0; index < 32; index += 1) scalar |= BigInt(signature[32 + index] ?? 0) << (8n * BigInt(index));
    const bumped = scalar + groupOrder;
    const malleable = new Uint8Array(signature);
    for (let index = 0; index < 32; index += 1) malleable[32 + index] = Number((bumped >> (8n * BigInt(index))) & 0xffn);
    expect(verifyEd25519Detached(message, malleable, pair.publicKey)).toBe(false);
    expect(verifyEd25519Detached(message, new Uint8Array(64), pair.publicKey)).toBe(false);
  });

  it("does not treat a zero signature as reputation or story consent", () => {
    for (const wallet of SMALL_ORDER_KEYS) {
      const reputation = link(wallet);
      expect(reputationLinkConsent(reputation, HUB)).toBe("inert");
      expect(matchReputationLink(reputation, HUB)).toBeNull();
      const story: StoryOptIn = { action: "allow", wallet, date: "2026-11-12", signature: ZERO_SIGNATURE };
      expect(storyOptInConsent(story, HUB)).toBe("inert");
      expect(matchStoryConsent(story, HUB)).toBeNull();
    }
    const player = nacl.sign.keyPair();
    const wallet = base58Encode(player.publicKey);
    const text = reputationLinkMessage(wallet, "Pilot", HUB, "legacy", "2026-11-12");
    const signature = base58Encode(nacl.sign.detached(new TextEncoder().encode(text), player.secretKey));
    const honest: ReputationLink = { action: "link", wallet, profile: "Pilot", date: "2026-11-12", signature };
    expect(matchReputationLink(honest, HUB)).toEqual({ action: "link", scope: "legacy" });
    expect(reputationLinkConsent(honest, HUB)).toBe("valid");
    const forged = { ...honest, signature: ZERO_SIGNATURE };
    expect(reputationLinkConsent(forged, HUB)).toBe("inert");
    const allow = storyAllowMessage(wallet, "2026-11-12", HUB, "yes");
    const story: StoryOptIn = {
      action: "allow",
      wallet,
      date: "2026-11-12",
      signature: base58Encode(nacl.sign.detached(new TextEncoder().encode(allow), player.secretKey)),
    };
    expect(matchStoryConsent(story, HUB)).toEqual({ showLinks: true });
  });

  it("rejects every 8-point torsion encoding, both sign bits, including non-canonical y", () => {
    const message = new TextEncoder().encode("consent");
    const signature = zeroSignature();
    const pair = nacl.sign.keyPair();
    const honest = nacl.sign.detached(message, pair.secretKey);
    expect(verifyEd25519Detached(message, honest, pair.publicKey)).toBe(true);

    // Eight subgroup points, sign bit clear, plus the sign-bit encodings of each.
    // y = p and y = p + 1 are the extra non-canonical encodings of y = 0 and y = 1.
    const yValues = [
      "0000000000000000000000000000000000000000000000000000000000000000",
      "0100000000000000000000000000000000000000000000000000000000000000",
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
      "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
      "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
      "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    ];
    const encodings: Uint8Array[] = [];
    for (const hex of yValues) {
      const clear = Buffer.from(hex, "hex");
      const flipped = Buffer.from(clear);
      flipped[31] = (flipped[31] ?? 0) ^ 0x80;
      encodings.push(clear, flipped);
    }
    expect(encodings).toHaveLength(14);
    for (const point of encodings) {
      expect(point).toHaveLength(32);
      const smallOrNonCanonical = !isCanonicalEd25519Point(point) || isSmallOrderEd25519Point(point);
      expect(smallOrNonCanonical).toBe(true);
      expect(verifyEd25519Detached(message, signature, point)).toBe(false);
      const withSmallR = new Uint8Array(honest);
      withSmallR.set(point, 0);
      expect(verifyEd25519Detached(message, withSmallR, pair.publicKey)).toBe(false);
    }
  });
});
