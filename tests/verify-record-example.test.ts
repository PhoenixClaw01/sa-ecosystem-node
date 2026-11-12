import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";

import { base58Decode, base58Encode } from "../src/hub/base58.js";

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../protocol/h2h/examples/phoenix-to-phoenix/verify-record.mjs",
);

const ZERO_SIGNATURE = "1".repeat(64);
const SMALL_ORDER_KEYS = [
  "11111111111111111111111111111111",
  "3ctC68zTqpRDQShoondiQKDHwZDAUjRyxiPNdg8cD6Pe",
  "H242rsh5hzpvDdct56PG5YPQbKUT37EmySQLoQqrYUJr",
] as const;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function payloadFor(author: string) {
  return {
    v: 1,
    id: "kintsugi-example-check",
    created_at: "2026-11-12T00:00:00.000Z",
    author,
    kind: "listing",
    body: "A local fixture for the handshake example.",
    refs: { pip: null, txs: [] },
    prev: null,
  };
}

function runScript(file: string) {
  return spawnSync(process.execPath, [script, file], { encoding: "utf8" });
}

function writeDoc(doc: unknown): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "verify-record-"));
  const file = path.join(dir, "update.json");
  writeFileSync(file, JSON.stringify(doc));
  return { dir, file };
}

function nodeVerify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKey)]),
    format: "der",
    type: "spki",
  });
  return cryptoVerify(null, message, key, signature);
}

describe("phoenix-to-phoenix verify-record example", () => {
  it("exits 0 for a honestly signed record and 1 after a one-character body change", () => {
    const author = nacl.sign.keyPair();
    const approver = nacl.sign.keyPair();
    const payload = payloadFor(base58Encode(author.publicKey));
    const payloadJson = canonical(payload);
    const payloadSha256 = createHash("sha256").update(payloadJson, "utf8").digest("hex");
    const signature = base58Encode(
      nacl.sign.detached(new TextEncoder().encode(`sa-ecosystem-node:hub-update:v1\n${payloadJson}`), author.secretKey),
    );
    const approval = base58Encode(
      nacl.sign.detached(
        new TextEncoder().encode(`sa-ecosystem-node:hub-approval:v1\n${payloadSha256}`),
        approver.secretKey,
      ),
    );
    const honest = {
      payload,
      signature,
      approvals: [{ publicKey: base58Encode(approver.publicKey), signature: approval }],
    };
    const { dir, file } = writeDoc(honest);
    try {
      const ok = runScript(file);
      expect(ok.status).toBe(0);
      const printed = JSON.parse(ok.stdout) as { authorSignatureVerifies: boolean; approvals: { verifies: boolean }[] };
      expect(printed.authorSignatureVerifies).toBe(true);
      expect(printed.approvals[0]?.verifies).toBe(true);

      const tampered = { ...honest, payload: { ...payload, body: "A local fixture for the handshake example!" } };
      writeFileSync(file, JSON.stringify(tampered));
      const bad = runScript(file);
      expect(bad.status).toBe(1);
      const badPrinted = JSON.parse(bad.stdout) as { authorSignatureVerifies: boolean };
      expect(badPrinted.authorSignatureVerifies).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a zero signature on a small-order author that Node's raw verifier would accept", () => {
    const signature = base58Decode(ZERO_SIGNATURE);
    expect(signature).toEqual(new Uint8Array(64));
    for (const wallet of SMALL_ORDER_KEYS) {
      const publicKey = base58Decode(wallet);
      const payload = payloadFor(wallet);
      const payloadJson = canonical(payload);
      const message = new TextEncoder().encode(`sa-ecosystem-node:hub-update:v1\n${payloadJson}`);
      const rawAccepts = nodeVerify(publicKey, message, signature);
      const { dir, file } = writeDoc({ payload, signature: ZERO_SIGNATURE, approvals: [] });
      try {
        const result = runScript(file);
        expect(result.status).toBe(1);
        const printed = JSON.parse(result.stdout) as { authorSignatureVerifies: boolean };
        expect(printed.authorSignatureVerifies).toBe(false);
        if (rawAccepts) {
          expect(printed.authorSignatureVerifies).not.toBe(rawAccepts);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
