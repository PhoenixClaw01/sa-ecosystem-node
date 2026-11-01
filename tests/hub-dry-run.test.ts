import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { readHubUpdates } from "../src/dao/hub.js";
import { loadSignerAllowlist } from "../src/hub/allowlist.js";
import { base58Decode, base58Encode } from "../src/hub/base58.js";
import { runKeygenCli } from "../src/hub/keygen-cli.js";
import { runSignCli } from "../src/hub/sign-cli.js";
import { formatHubStoreManifest, runStoreInitCli } from "../src/hub/store-init-cli.js";
import {
  HUB_APPROVAL_DOMAIN,
  HUB_UPDATE_DOMAIN,
  hubApprovalMessageText,
  hubApprovalSigningMessage,
  hubUpdateHash,
  verifyHubUpdates,
  type HubUpdatePayload,
} from "../src/hub/update.js";
import { READ_ONLY_TOOLS } from "../src/server.js";

const ROLES = ["Falkor", "GaliaMeta DAC", "Phoenix bus", "Phoenix Collective"] as const;

interface Wallet {
  label: string;
  publicKey: string;
  entry: string;
  file: string;
  secretKey: Uint8Array;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync(
    "git",
    ["-c", "user.email=hub-dry-run@example.com", "-c", "user.name=hub-dry-run", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "git failed");
  return (result.stdout ?? "").trim();
}

function publish(store: string, updates: readonly string[]): { commit: string; manifestHash: string } {
  writeFileSync(path.join(store, "hub-manifest.json"), formatHubStoreManifest(updates));
  git(store, ["add", "-A"]);
  git(store, ["commit", "-m", "Publish signed hub updates"]);
  const commit = git(store, ["rev-parse", "HEAD"]);
  const manifestHash = createHash("sha256").update(readFileSync(path.join(store, "hub-manifest.json"))).digest("hex");
  return { commit, manifestHash };
}

/**
 * What Phantom signMessage does: detached ed25519 over the exact bytes.
 * The secret stays in this helper. The attach command receives only the address and signature.
 */
function phantomSignMessage(message: Uint8Array, secretKey: Uint8Array): { hex: string; base64: string; base58: string } {
  const signature = nacl.sign.detached(message, secretKey);
  expect(nacl.sign.detached.verify(message, signature, secretKey.subarray(32))).toBe(true);
  return {
    hex: Buffer.from(signature).toString("hex"),
    base64: Buffer.from(signature).toString("base64"),
    base58: base58Encode(signature),
  };
}

describe("hub signer dry run", () => {
  it("runs throwaway wallet approvals through the pinned store", async () => {
    expect(READ_ONLY_TOOLS).toContain("hub_updates");
    expect(READ_ONLY_TOOLS).not.toContain("submit_hub_update");
    const shipped = readFileSync(path.resolve("hub/signers.json"), "utf8");
    expect(loadConfig({}).hubApprovalThreshold).toBe(1);

    const scratch = mkdtempSync(path.join(tmpdir(), "hub-dry-run-"));
    try {
      const inside = runKeygenCli(["--label", "Phoenix Collective", "--out", "phoenix-collective.keypair.json"]);
      expect(inside.code).toBe(1);
      expect(inside.stdout).toBe("");
      expect(inside.stderr).toMatch(/inside this repository/);
      expect(existsSync(path.resolve("phoenix-collective.keypair.json"))).toBe(false);

      const link = path.join(scratch, "into-repo");
      symlinkSync(path.resolve("hub"), link);
      const linked = runKeygenCli(["--label", "Phoenix Collective", "--out", path.join(link, "agent.keypair.json")]);
      expect(linked.code).toBe(1);
      expect(linked.stdout).toBe("");
      expect(existsSync(path.resolve("hub/agent.keypair.json"))).toBe(false);

      const nested = runStoreInitCli(["--dir", path.resolve("public-hub-store")]);
      expect(nested.code).toBe(1);
      expect(nested.stdout).toBe("");
      expect(existsSync(path.resolve("public-hub-store"))).toBe(false);

      const wallets: Wallet[] = ROLES.map((label) => {
        const file = path.join(scratch, `${label.replace(/\s+/g, "-").toLowerCase()}.keypair.json`);
        const result = runKeygenCli(["--label", label, "--out", file]);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stderr).toBe("");
        const [publicKey, entry, blank] = result.stdout.split("\n");
        expect(blank).toBe("");
        expect(entry).toBe(JSON.stringify({ label, publicKey }));
        const secretText = readFileSync(file, "utf8");
        expect(result.stdout.includes(secretText.trim())).toBe(false);
        expect(result.stdout.includes("[")).toBe(false);
        expect(statSync(file).mode & 0o777).toBe(0o600);
        const bytes = JSON.parse(secretText) as number[];
        expect(bytes).toHaveLength(64);
        expect(base58Encode(Uint8Array.from(bytes.slice(32)))).toBe(publicKey);
        return { label, publicKey: publicKey ?? "", entry: entry ?? "", file, secretKey: Uint8Array.from(bytes) };
      });
      expect(new Set(wallets.map((wallet) => wallet.publicKey)).size).toBe(4);

      const outsiderFile = path.join(scratch, "outsider.keypair.json");
      const outsiderMade = runKeygenCli(["--label", "Outsider", "--out", outsiderFile]);
      expect(outsiderMade.code, outsiderMade.stderr).toBe(0);
      const outsiderKey = Uint8Array.from(JSON.parse(readFileSync(outsiderFile, "utf8")) as number[]);
      const outsider = { publicKey: outsiderMade.stdout.split("\n")[0] ?? "", file: outsiderFile, secretKey: outsiderKey };

      const signersPath = path.join(scratch, "signers.json");
      writeFileSync(
        signersPath,
        `${JSON.stringify({ v: 1, signers: wallets.map((wallet) => JSON.parse(wallet.entry) as unknown) }, null, 2)}\n`,
      );
      const allowlist = loadSignerAllowlist(signersPath);
      expect([...allowlist]).toEqual(wallets.map((wallet) => wallet.publicKey));
      expect(allowlist.has(outsider.publicKey)).toBe(false);

      const store = path.join(scratch, "public-store");
      const init = runStoreInitCli(["--dir", store]);
      expect(init.code, init.stderr).toBe(0);
      expect(init.stdout).toBe("Wrote README.md, hub-manifest.json, and updates/.\n");
      const readme = readFileSync(path.join(store, "README.md"), "utf8");
      expect(readme).toContain(HUB_UPDATE_DOMAIN.trim());
      expect(readme).toContain(HUB_APPROVAL_DOMAIN.trim());
      expect(readme).toContain("hub-manifest.json");
      expect(readme).toContain("HUB_STORE_MANIFEST_HASH");
      expect(readme).not.toMatch(/Falkor|Council|PIP-|signMessage|keypair/);
      expect(JSON.parse(readFileSync(path.join(store, "hub-manifest.json"), "utf8"))).toEqual({ v: 1, updates: [] });
      expect(existsSync(path.join(store, "manifest.json"))).toBe(false);

      git(store, ["init", "-b", "main"]);
      const emptyPin = publish(store, []);
      const emptyRead = await readPinned(store, emptyPin, signersPath, "1");
      expect(emptyRead.updates).toEqual([]);
      expect(emptyRead.note).toMatch(/no updates/);
      expect(JSON.stringify(emptyRead)).not.toContain(scratch);

      const collective = wallets[3];
      const falkor = wallets[0];
      const galiameta = wallets[1];
      const bus = wallets[2];
      if (!collective || !falkor || !galiameta || !bus) throw new Error("missing wallet");

      const payloadPath = path.join(scratch, "update.json");
      const signedPath = path.join(scratch, "update.signed.json");
      writeFileSync(
        payloadPath,
        JSON.stringify({
          v: 1,
          id: "dry-run-1",
          created_at: "2026-10-29T21:00:00.000Z",
          author: collective.publicKey,
          kind: "status",
          body: "Testnet dry run.",
          refs: { pip: null, txs: [] },
          prev: null,
        }),
      );
      const signed = runSignCli(["--keypair", collective.file, "--payload", payloadPath, "--out", signedPath]);
      expect(signed.code, signed.stderr).toBe(0);
      expect(signed.stdout).toBe("");
      expect(signed.stderr).toBe(`Signed dry-run-1 as ${collective.publicKey}\n`);
      expect(signed.stderr.includes(readFileSync(collective.file, "utf8").slice(0, 24))).toBe(false);

      const printed = runSignCli(["--print-approval", signedPath]);
      expect(printed.code, printed.stderr).toBe(0);
      expect(printed.stderr).toBe("");
      const [hexLine, utf8Line, extraLine] = printed.stdout.split("\n");
      expect(extraLine).toBe("");
      const messageHex = (hexLine ?? "").slice("hex:".length);
      const messageText = JSON.parse((utf8Line ?? "").slice("utf8:".length)) as string;
      const signedDocument = JSON.parse(readFileSync(signedPath, "utf8")) as { payload: HubUpdatePayload };
      const message = hubApprovalSigningMessage(signedDocument.payload);
      expect(messageText).toBe(hubApprovalMessageText(signedDocument.payload));
      expect(messageText.startsWith(HUB_APPROVAL_DOMAIN)).toBe(true);
      expect(Buffer.from(messageHex, "hex").equals(Buffer.from(message))).toBe(true);

      const transfer = nacl.sign.detached(new TextEncoder().encode("transfer 1 SOL"), falkor.secretKey);
      const notATransfer = runSignCli([
        "--approve",
        signedPath,
        "--public-key",
        falkor.publicKey,
        "--signature",
        base58Encode(transfer),
        "--out",
        path.join(scratch, "transfer.json"),
      ]);
      expect(notATransfer.code).toBe(1);
      expect(notATransfer.stdout).toBe("");
      expect(existsSync(path.join(scratch, "transfer.json"))).toBe(false);

      const onePath = attach(signedPath, falkor, "hex", path.join(scratch, "one.json"), message);
      const oneDoc = JSON.parse(readFileSync(onePath, "utf8")) as unknown;
      const oneChecked = verifyHubUpdates([oneDoc], allowlist, 1);
      expect(oneChecked.updates.map((update) => update.approvalCount)).toEqual([1]);
      expect(oneChecked.updates[0]?.selfApproved).toBe(false);
      expect(verifyHubUpdates([oneDoc], allowlist, 2).rejected).toEqual([{ id: "dry-run-1", reason: "below_threshold" }]);

      const again = runSignCli([
        "--approve",
        onePath,
        "--public-key",
        falkor.publicKey,
        "--signature",
        phantomSignMessage(message, falkor.secretKey).hex,
        "--out",
        path.join(scratch, "again.json"),
      ]);
      expect(again.code).toBe(1);
      expect(again.stderr).toMatch(/already approved/);

      const duplicated = JSON.parse(readFileSync(onePath, "utf8")) as { approvals: { publicKey: string; signature: string }[] };
      duplicated.approvals.push(duplicated.approvals[0] ?? { publicKey: "", signature: "" });
      expect(verifyHubUpdates([duplicated], allowlist, 2).rejected).toEqual([{ id: "dry-run-1", reason: "below_threshold" }]);

      for (const wallet of wallets) {
        const dest = path.join(scratch, `single-${wallet.label.replace(/\s+/g, "-")}.json`);
        attach(signedPath, wallet, "hex", dest, message);
        const doc = JSON.parse(readFileSync(dest, "utf8")) as unknown;
        expect(verifyHubUpdates([doc], allowlist, 2).rejected).toEqual([{ id: "dry-run-1", reason: "below_threshold" }]);
      }

      const pairs: [Wallet, Wallet][] = [];
      for (let left = 0; left < wallets.length; left += 1) {
        for (let right = left + 1; right < wallets.length; right += 1) {
          const first = wallets[left];
          const second = wallets[right];
          if (first && second) pairs.push([first, second]);
        }
      }
      expect(pairs).toHaveLength(6);
      for (const [first, second] of pairs) {
        const mid = path.join(scratch, `pair-${first.publicKey.slice(0, 6)}.json`);
        const dest = path.join(scratch, `pair-${first.publicKey.slice(0, 6)}-${second.publicKey.slice(0, 6)}.json`);
        attach(signedPath, first, "hex", mid, message);
        attach(mid, second, "base58", dest, message);
        const doc = JSON.parse(readFileSync(dest, "utf8")) as unknown;
        const includesAuthor = first.publicKey === collective.publicKey || second.publicKey === collective.publicKey;
        const checked = verifyHubUpdates([doc], allowlist, 2);
        if (includesAuthor) {
          expect(checked.rejected, `${first.label} + ${second.label}`).toEqual([{ id: "dry-run-1", reason: "below_threshold" }]);
          const allowed = verifyHubUpdates([doc], allowlist, 2, undefined, { allowAuthorApproval: true });
          expect(allowed.rejected, `${first.label} + ${second.label} allowed`).toEqual([]);
          expect(allowed.updates[0]?.approvalCount).toBe(2);
          expect(allowed.updates[0]?.selfApproved).toBe(false);
        } else {
          expect(checked.rejected, `${first.label} + ${second.label}`).toEqual([]);
          expect(checked.updates.map((update) => update.approvalCount)).toEqual([2]);
          expect(checked.updates[0]?.selfApproved).toBe(false);
        }
      }

      const agentPath = path.join(scratch, "agent-approved.json");
      const agent = runSignCli(["--keypair", collective.file, "--approve", signedPath, "--out", agentPath]);
      expect(agent.code, agent.stderr).toBe(0);
      const agentDoc = JSON.parse(readFileSync(agentPath, "utf8")) as {
        payload: HubUpdatePayload;
        approvals: { publicKey: string; signature: string }[];
      };
      const agentApproval = agentDoc.approvals[0];
      expect(agentApproval?.publicKey).toBe(collective.publicKey);
      expect(
        nacl.sign.detached.verify(
          hubApprovalSigningMessage(agentDoc.payload),
          base58Decode(agentApproval?.signature ?? ""),
          base58Decode(collective.publicKey),
        ),
      ).toBe(true);
      const agentAlone = verifyHubUpdates([JSON.parse(readFileSync(agentPath, "utf8")) as unknown], allowlist, 1);
      expect(agentAlone.rejected).toEqual([]);
      expect(agentAlone.updates[0]?.selfApproved).toBe(true);
      expect(agentAlone.updates[0]?.approvalCount).toBe(1);
      const agentAndFalkor = attach(agentPath, falkor, "base64", path.join(scratch, "agent-falkor.json"), message);
      const mixedDoc = JSON.parse(readFileSync(agentAndFalkor, "utf8")) as unknown;
      const mixed = verifyHubUpdates([mixedDoc], allowlist, 2);
      expect(mixed.rejected).toEqual([{ id: "dry-run-1", reason: "below_threshold" }]);
      const mixedAllowed = verifyHubUpdates([mixedDoc], allowlist, 2, undefined, { allowAuthorApproval: true });
      expect(mixedAllowed.rejected).toEqual([]);
      expect(mixedAllowed.updates[0]?.approvalCount).toBe(2);
      expect(mixedAllowed.updates[0]?.selfApproved).toBe(false);

      copyUpdate(store, "updates/dry-run-1.json", onePath);
      const singlePin = publish(store, ["updates/dry-run-1.json"]);
      const thresholdOne = await readPinned(store, singlePin, signersPath, "1");
      expect(thresholdOne.updates.map((update) => [update.id, update.approvalCount, update.signer])).toEqual([
        ["dry-run-1", 1, collective.publicKey],
      ]);
      expect(JSON.stringify(thresholdOne)).not.toContain(scratch);
      const thresholdTwoEarly = await readPinned(store, singlePin, signersPath, "2");
      expect(thresholdTwoEarly.updates).toEqual([]);
      expect(thresholdTwoEarly.rejected).toEqual([{ id: "dry-run-1", reason: "below_threshold" }]);

      const falkorGaliameta = path.join(scratch, "falkor-galiameta.json");
      attach(onePath, galiameta, "base64", falkorGaliameta, message);
      copyUpdate(store, "updates/dry-run-1.json", falkorGaliameta);
      const twoPin = publish(store, ["updates/dry-run-1.json"]);
      const anyTwo = await readPinned(store, twoPin, signersPath, "2");
      expect(anyTwo.updates.map((update) => update.approvalCount)).toEqual([2]);
      expect(anyTwo.rejected).toEqual([]);
      await expect(
        readHubUpdates(
          { repo: store, commit: twoPin.commit, manifestPath: "hub-manifest.json", manifestHash: "0".repeat(64) },
          allowlist,
          2,
        ),
      ).rejects.toThrow(/manifest hash did not match/);
      await expect(
        readHubUpdates(
          { repo: store, commit: "ab".repeat(20), manifestPath: "hub-manifest.json", manifestHash: twoPin.manifestHash },
          allowlist,
          2,
        ),
      ).rejects.toThrow(/could not be read|did not match/);
      expect(() => loadConfig({ HUB_GIT_REPO: store })).toThrow(/together/);

      const busCollective = path.join(scratch, "bus-collective.json");
      attach(attach(signedPath, bus, "hex", path.join(scratch, "bus-only.json"), message), collective, "hex", busCollective, message);
      copyUpdate(store, "updates/dry-run-1.json", busCollective);
      const otherPair = publish(store, ["updates/dry-run-1.json"]);
      const otherRead = await readPinned(store, otherPair, signersPath, "2");
      expect(otherRead.updates).toEqual([]);
      expect(otherRead.rejected).toEqual([{ id: "dry-run-1", reason: "below_threshold" }]);

      const good = JSON.parse(readFileSync(falkorGaliameta, "utf8")) as { payload: HubUpdatePayload };
      const replayPayload = {
        ...good.payload,
        body: "Replay.",
        created_at: "2026-10-29T22:00:00.000Z",
        prev: hubUpdateHash(good.payload),
      };
      const replaySigned = path.join(scratch, "replay.signed.json");
      writeFileSync(path.join(scratch, "replay.json"), JSON.stringify(replayPayload));
      expect(
        runSignCli(["--keypair", collective.file, "--payload", path.join(scratch, "replay.json"), "--out", replaySigned]).code,
      ).toBe(0);
      const replayMessage = hubApprovalSigningMessage(replayPayload);
      const replayApproved = attach(
        attach(replaySigned, falkor, "hex", path.join(scratch, "replay.one.json"), replayMessage),
        galiameta,
        "hex",
        path.join(scratch, "replay.two.json"),
        replayMessage,
      );

      const outsiderPayload = {
        ...good.payload,
        id: "outsider-1",
        author: outsider.publicKey,
        body: "Not on the list.",
        created_at: "2026-10-29T22:30:00.000Z",
        prev: hubUpdateHash(good.payload),
      };
      const outsiderSigned = path.join(scratch, "outsider.signed.json");
      writeFileSync(path.join(scratch, "outsider.json"), JSON.stringify(outsiderPayload));
      expect(runSignCli(["--keypair", outsider.file, "--payload", path.join(scratch, "outsider.json"), "--out", outsiderSigned]).code).toBe(0);
      const outsiderMessage = hubApprovalSigningMessage(outsiderPayload);
      const outsiderApproved = attach(
        attach(outsiderSigned, falkor, "hex", path.join(scratch, "outsider.one.json"), outsiderMessage),
        galiameta,
        "hex",
        path.join(scratch, "outsider.two.json"),
        outsiderMessage,
      );

      copyUpdate(store, "updates/dry-run-1.json", falkorGaliameta);
      copyUpdate(store, "updates/tampered.json", falkorGaliameta);
      const tampered = JSON.parse(readFileSync(path.join(store, "updates/tampered.json"), "utf8")) as { payload: { body: string } };
      tampered.payload.body = "Tampered";
      writeFileSync(path.join(store, "updates/tampered.json"), `${JSON.stringify(tampered, null, 2)}\n`);
      copyUpdate(store, "updates/replay.json", replayApproved);
      copyUpdate(store, "updates/outsider.json", outsiderApproved);
      const badPin = publish(store, [
        "updates/dry-run-1.json",
        "updates/tampered.json",
        "updates/replay.json",
        "updates/outsider.json",
      ]);
      const rejected = await readPinned(store, badPin, signersPath, "2");
      expect(rejected.updates.map((update) => update.body)).toEqual(["Testnet dry run."]);
      expect(rejected.rejected).toEqual([
        { id: "dry-run-1", reason: "bad_signature" },
        { id: "dry-run-1", reason: "replayed_id" },
        { id: "outsider-1", reason: "unknown_signer" },
      ]);
      expect(JSON.stringify(rejected)).not.toContain(scratch);

      expect(readFileSync(path.resolve("hub/signers.json"), "utf8")).toBe(shipped);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});

function copyUpdate(store: string, relative: string, source: string): void {
  const dest = path.join(store, relative);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(source));
}

function attach(
  source: string,
  wallet: Wallet,
  encoding: "hex" | "base64" | "base58",
  dest: string,
  message: Uint8Array,
): string {
  const signed = phantomSignMessage(message, wallet.secretKey);
  const secretText = readFileSync(wallet.file, "utf8");
  const argv = ["--approve", source, "--public-key", wallet.publicKey, "--signature", signed[encoding], "--out", dest];
  expect(argv.join("\n").includes(secretText.trim())).toBe(false);
  const result = runSignCli(argv);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr.includes(secretText.slice(0, 24))).toBe(false);
  const saved = JSON.parse(readFileSync(dest, "utf8")) as { approvals: { publicKey: string; signature: string }[] };
  const last = saved.approvals[saved.approvals.length - 1];
  expect(last?.publicKey).toBe(wallet.publicKey);
  expect(last?.signature).toBe(signed.base58);
  return dest;
}

function readPinned(
  store: string,
  pin: { commit: string; manifestHash: string },
  signersPath: string,
  threshold: string,
) {
  const config = loadConfig({
    HUB_GIT_REPO: store,
    HUB_GIT_COMMIT: pin.commit,
    HUB_STORE_MANIFEST: "hub-manifest.json",
    HUB_STORE_MANIFEST_HASH: pin.manifestHash,
    HUB_APPROVAL_THRESHOLD: threshold,
    HUB_SIGNERS_PATH: signersPath,
  });
  return readHubUpdates(
    {
      repo: config.hubGitRepo,
      commit: config.hubGitCommit,
      manifestPath: config.hubStoreManifest,
      manifestHash: config.hubStoreManifestHash,
      manifestFallback: config.hubStoreManifestFallback,
    },
    loadSignerAllowlist(config.hubSignersPath),
    config.hubApprovalThreshold,
  );
}
