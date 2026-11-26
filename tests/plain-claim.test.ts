import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Window } from "happy-dom";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";

import { buildAttestationDraft, bindClaimPage, buildClaimDraft, claimCanonicalHash } from "../dashboard/plain/claim/claim.js";
import { base58Encode } from "../src/hub/base58.js";
import { buildPlayerAttestationDraft, buildPlayerClaimDraft } from "../src/hub/player-discord-flow.js";
import { normalizeHubRepo } from "../src/hub/story-optin.js";
import { authorSignatureValid, hubUpdateHash } from "../src/hub/update.js";
import { opaqueVerifierState } from "../src/hub/verifier/proof.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACCOUNT = "123456789012345678";

function fields(wallet: string, profile: string) {
  return {
    wallet,
    profile,
    hub: "https://github.com/Owner/Repo.git",
    listingId: "booth-north",
    nonce: "nonce-1111",
    expiresAt: "2027-04-01T00:00:00.000Z",
    createdAt: "2026-10-31T00:00:00.000Z",
  };
}

describe("plain claim page", () => {
  it("matches the node signing message and does not publish", async () => {
    const pair = nacl.sign.keyPair();
    const wallet = base58Encode(pair.publicKey);
    const profile = base58Encode(nacl.sign.keyPair().publicKey);
    const input = fields(wallet, profile);
    expect(buildClaimDraft(input)?.message.utf8).toBe(buildPlayerClaimDraft(input)?.message.utf8);
    expect(buildClaimDraft({ ...input, hub: "http://github.com/owner/repo" })).toBeNull();
    expect(normalizeHubRepo("https://github.com/Owner/Repo.git")).toBe(buildClaimDraft(input)?.payload.claim?.hubId);

    const proof = {
      v: 1,
      method: "discord",
      account: ACCOUNT,
      salt: "salt-value-1",
      wallet,
      nonce: input.nonce,
      state: opaqueVerifierState(new Uint8Array(32).fill(9)),
    };
    const claim = buildClaimDraft(input);
    const prev = await claimCanonicalHash(claim);
    expect(prev).toBe(hubUpdateHash(buildPlayerClaimDraft(input)!.payload));
    const browser = await buildAttestationDraft(input, proof, prev);
    const node = buildPlayerAttestationDraft({
      proof,
      hub: input.hub,
      issuedAt: input.createdAt,
      expiresAt: input.expiresAt,
      prev,
    });
    expect(browser?.message.utf8).toBe(node?.message.utf8);
    expect(JSON.stringify(browser)).not.toContain(`"${ACCOUNT}"`);
    expect(JSON.stringify(browser)).not.toContain("salt-value-1");

    const html = readFileSync(path.join(ROOT, "dashboard/plain/claim/index.html"), "utf8");
    const source = readFileSync(path.join(ROOT, "dashboard/plain/claim/claim.js"), "utf8");
    const home = readFileSync(path.join(ROOT, "dashboard/plain/index.html"), "utf8");
    expect(html).toContain("This page does not publish");
    expect(html).not.toContain("Star Atlas");
    expect(html).toContain("operator machine");
    expect(html).not.toMatch(/\son\w+=/);
    expect(source).not.toMatch(/\bfetch\s*\(|innerHTML|submit_hub_update|\/submit|DISCORD_CLIENT_SECRET|discord\.com\/api/);
    expect(home).toContain('href="/plain/claim/"');
    expect(home).toContain(">Claim a player listing</a>");
    const config = JSON.parse(readFileSync(path.join(ROOT, "dashboard/vercel.json"), "utf8")) as {
      headers: { source: string; headers: { key: string; value: string }[] }[];
    };
    const policy = config.headers.find((item) => item.source === "/plain/(.*)")?.headers.find((item) => item.key === "Content-Security-Policy");
    expect(policy?.value).toContain("connect-src 'self'");
    expect(policy?.value).not.toContain("discord.com");

    const window = new Window({ url: "https://preview.example/plain/claim/", settings: { disableJavaScriptFileLoading: true } });
    window.document.write(html.replace(/<script[\s\S]*?<\/script>/gi, ""));
    const doc = window.document;
    const address = wallet;
    bindClaimPage(doc, {
      wallet: {
        publicKey: { toString: () => address },
        async connect() {},
        async signMessage(bytes: Uint8Array) {
          return { signature: nacl.sign.detached(bytes, pair.secretKey) };
        },
      },
    });
    for (const [id, value] of Object.entries({
      wallet: address,
      hub: input.hub,
      "listing-id": input.listingId,
      profile,
      nonce: input.nonce,
      expires: input.expiresAt,
      "created-at": input.createdAt,
    })) {
      const inputNode = doc.getElementById(id) as { value: string } | null;
      if (inputNode) inputNode.value = value;
    }
    doc.getElementById("prepare")?.dispatchEvent(new window.Event("click"));
    expect(doc.getElementById("claim-message")?.textContent).toBe(claim?.message.utf8);
    doc.getElementById("sign-claim")?.dispatchEvent(new window.Event("click"));
    await window.happyDOM.waitUntilComplete();
    const signed = JSON.parse(doc.getElementById("claim-file")?.textContent || "null") as { signature: string } | null;
    expect(signed).not.toBeNull();
    expect(authorSignatureValid(buildPlayerClaimDraft(input)!.payload, signed!.signature)).toBe(true);
    expect(doc.getElementById("claim-status")?.textContent).toMatch(/Nothing was published/);

    const proofText = JSON.stringify(proof);
    const proofInput = doc.getElementById("proof-file");
    Object.defineProperty(proofInput, "files", { configurable: true, value: [{ name: "proof.json" }] });
    Object.defineProperty(window, "FileReader", {
      configurable: true,
      writable: true,
      value: class {
        result = "";
        listeners: Array<() => void> = [];
        addEventListener(_type: string, fn: () => void) {
          this.listeners.push(fn);
        }
        readAsText() {
          this.result = proofText;
          this.listeners.forEach((fn) => fn());
        }
      },
    });
    proofInput?.dispatchEvent(new window.Event("change"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(doc.getElementById("attestation-message")?.textContent).toBe(browser?.message.utf8);
    expect(doc.getElementById("attestation-message")?.textContent).not.toContain(ACCOUNT);
    doc.getElementById("sign-attestation")?.dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const attested = JSON.parse(doc.getElementById("attestation-file")?.textContent || "null") as { signature: string } | null;
    expect(authorSignatureValid(node!.payload, attested!.signature)).toBe(true);
    expect(doc.body.textContent).not.toContain("test-secret");
    window.close();
  });
});
