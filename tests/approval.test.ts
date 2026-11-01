import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { hexToBytes } from "../src/bytes.js";
import { APPROVAL_VERIFICATION_STATUS, verifyEd25519Signature } from "../src/stubs/approval.js";
import { canonicalHubUpdateBytes, HUB_UPDATE_IMPLEMENTATION, type SubmitHubUpdate } from "../src/stubs/hub-update.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/ed25519.json", import.meta.url), "utf8")) as {
  messageUtf8: string;
  messageHex: string;
  publicKeyHex: string;
  signatureHex: string;
  otherPublicKeyHex: string;
};

describe("ed25519 fixture", () => {
  const message = hexToBytes(fixture.messageHex);
  const signature = hexToBytes(fixture.signatureHex);
  const publicKey = hexToBytes(fixture.publicKeyHex);

  it("verifies the committed public key and signature", () => {
    expect(new TextDecoder().decode(message)).toBe(fixture.messageUtf8);
    expect(verifyEd25519Signature({ message, signature, publicKey })).toBe(true);
  });

  it("rejects a tampered message, a different key, and a short signature", () => {
    const tampered = new Uint8Array(message);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(verifyEd25519Signature({ message: tampered, signature, publicKey })).toBe(false);
    expect(
      verifyEd25519Signature({
        message,
        signature,
        publicKey: hexToBytes(fixture.otherPublicKeyHex),
      }),
    ).toBe(false);
    expect(
      verifyEd25519Signature({
        message,
        signature: signature.slice(0, 32),
        publicKey,
      }),
    ).toBe(false);
  });

  it("keeps hub submission and approval checks unimplemented", () => {
    expect(HUB_UPDATE_IMPLEMENTATION).toBe("not_implemented");
    expect(APPROVAL_VERIFICATION_STATUS).toBe("not_implemented");
    const unimplemented: SubmitHubUpdate = () => {
      throw new Error("not implemented");
    };
    expect(unimplemented).toThrow("not implemented");
  });
});

describe("canonical hub update bytes", () => {
  it("is stable for the same fields", () => {
    const first = canonicalHubUpdateBytes({
      v: 0,
      ecosystemWallet: "wallet",
      category: "creators",
      title: "Hello",
      body: "Body",
      links: ["https://example.com"],
      imageUrls: [],
    });
    const second = canonicalHubUpdateBytes({
      v: 0,
      title: "Hello",
      body: "Body",
      links: ["https://example.com"],
      imageUrls: [],
      category: "creators",
      ecosystemWallet: "wallet",
    });
    expect(Buffer.from(first).toString("hex")).toBe(Buffer.from(second).toString("hex"));
    expect(new TextDecoder().decode(first)).not.toContain("signature");
  });
});
