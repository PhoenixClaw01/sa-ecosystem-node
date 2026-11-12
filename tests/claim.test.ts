import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";

import { isPublicUpdate, renderHubUpdate } from "../dashboard/plain/plain.js";
import { publicClaimRow, selectPublicUpdates } from "../src/dao/hub.js";
import { base58Decode, base58Encode } from "../src/hub/base58.js";
import { parseClaim } from "../src/hub/claim.js";
import { resolveClaimDirectory } from "../src/hub/claim-resolve.js";
import {
  CLAIM_PROFILE_CONCURRENCY,
  createProfileKeyChecker,
  profileVerdictFromAccount,
  resetProfileKeyCache,
} from "../src/hub/claim-profile.js";
import { runClaimCli } from "../src/hub/claim-cli.js";
import type { GuildListing } from "../src/hub/guild.js";
import type { Listing } from "../src/hub/listing.js";
import {
  HUB_APPROVAL_DOMAIN,
  HUB_UPDATE_DOMAIN,
  canonicalHubPayload,
  hubUpdateHash,
  verifyHubUpdates,
  type HubUpdatePayload,
} from "../src/hub/update.js";
import { PLAYER_PROFILE_PROGRAM_ID, PROFILE_DISCRIMINATOR, PROFILE_KEY_OFFSET, PROFILE_KEY_STRIDE } from "../src/legacy/programs.js";
import { runAttestCli } from "../src/hub/attest-cli.js";
import { listenLoopback, LOOPBACK_HOST, runPlayerFlowCli } from "../src/hub/player-flow-cli.js";
import {
  buildPlayerAttestationDraft,
  buildPlayerClaimDraft,
  readyPlayerPack,
  writePlayerPack,
} from "../src/hub/player-discord-flow.js";
import { createPlayerExchange, exchangeListenTarget } from "../src/hub/player-exchange.js";
import { discordAuthorizeUrl, discordIdentify, discordPkce, discordVerifierConfig } from "../src/hub/verifier/discord-oauth.js";
import { opaqueVerifierState } from "../src/hub/verifier/proof.js";
import { fetchPostedCode, postContainsCode } from "../src/hub/verifier/x-proof.js";
import { sharedMissWindow } from "../src/legacy/gate.js";

const HUB = "https://github.com/owner/repo";
const OTHER_HUB = "https://github.com/other/repo";
const NOW = new Date("2026-10-31T12:00:00.000Z");

function signer() {
  const pair = nacl.sign.keyPair();
  const publicKey = base58Encode(pair.publicKey);
  return {
    publicKey,
    secret: pair.secretKey,
    sign(payload: HubUpdatePayload) {
      const message = new TextEncoder().encode(HUB_UPDATE_DOMAIN + canonicalHubPayload(payload));
      return base58Encode(nacl.sign.detached(message, pair.secretKey));
    },
    approve(body: HubUpdatePayload) {
      const message = new TextEncoder().encode(HUB_APPROVAL_DOMAIN + hubUpdateHash(body));
      return base58Encode(nacl.sign.detached(message, pair.secretKey));
    },
  };
}

type Key = ReturnType<typeof signer>;

function document(author: Key, body: HubUpdatePayload, approvers: Key[] = []) {
  return {
    payload: body,
    signature: author.sign(body),
    approvals: approvers.map((approver) => ({ publicKey: approver.publicKey, signature: approver.approve(body) })),
  };
}

function chain(parts: { author: Key; payload: HubUpdatePayload; approvers?: Key[] }[]) {
  let prev: string | null = null;
  return parts.map((part) => {
    const payload = { ...part.payload, prev };
    const doc = document(part.author, payload, part.approvers ?? []);
    prev = hubUpdateHash(payload);
    return doc;
  });
}

function base(author: string, over: Partial<HubUpdatePayload>): HubUpdatePayload {
  return {
    v: 1,
    id: over.id ?? "update-1",
    created_at: over.created_at ?? "2026-10-31T00:00:00.000Z",
    author,
    kind: over.kind ?? "announcement",
    body: over.body ?? "Note.",
    refs: { pip: null, txs: [] },
    prev: over.prev ?? null,
    ...(over.listing ? { listing: over.listing } : {}),
    ...(over.guild ? { guild: over.guild } : {}),
    ...(over.claim ? { claim: over.claim } : {}),
    ...(over.attestation ? { attestation: over.attestation } : {}),
    ...(over.change ? { change: over.change } : {}),
  };
}

function shop(over: Partial<Listing> = {}): Listing {
  return {
    stream: "hybrid",
    category: "ip_and_business",
    title: "North booth",
    owner: "North Booth",
    url: "https://example.com/north",
    status: "available",
    asOf: "2026-10-01",
    expiresAt: "2026-12-30",
    listingId: "booth-north",
    ...over,
  };
}

function hall(over: Partial<GuildListing> = {}): GuildListing {
  return {
    name: "East Hall",
    description: "A public group page.",
    links: ["https://example.com/east"],
    ...over,
  };
}

function playerClaim(wallet: string, over: Record<string, unknown> = {}) {
  return {
    action: "claim" as const,
    wallet,
    hubId: HUB,
    nonce: "nonce-1111",
    expiresAt: "2027-04-01T00:00:00.000Z",
    subject: "player" as const,
    identity: { type: "listing" as const, listingId: "booth-north" },
    playerProfile: "profile-placeholder",
    ...over,
  };
}

async function settle(
  docs: ReturnType<typeof chain>,
  allow: string[],
  profile: (wallet: string, profileAddress: string) => Promise<"match" | "mismatch" | "unavailable"> = async () => "match",
  trusted: string[] = [],
) {
  const checked = verifyHubUpdates(docs, new Set(allow), 1, undefined, { hubId: HUB });
  const directory = await resolveClaimDirectory(checked.updates, {
    hubId: HUB,
    now: NOW,
    trustedVerifiers: new Set(trusted),
    profile: async (wallet, profileAddress) => profile(wallet, profileAddress),
  });
  return { checked, directory };
}

function profileBytes(keys: { wallet: Uint8Array; expiry: bigint }[], keyCount = keys.length): Uint8Array {
  const data = new Uint8Array(PROFILE_KEY_OFFSET + PROFILE_KEY_STRIDE * Math.max(keys.length, 1));
  data.set(PROFILE_DISCRIMINATOR, 0);
  data[28] = keyCount & 0xff;
  data[29] = (keyCount >> 8) & 0xff;
  keys.forEach((key, index) => {
    const offset = PROFILE_KEY_OFFSET + index * PROFILE_KEY_STRIDE;
    data.set(key.wallet, offset);
    writeI64(data, offset + 64, key.expiry);
  });
  return data;
}

function writeI64(data: Uint8Array, offset: number, value: bigint): void {
  let rest = value < 0n ? value + 0x10000000000000000n : value;
  for (let index = 0; index < 8; index += 1) {
    data[offset + index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
}

describe("listing claims", () => {
  it("refuses a player claim on someone else's profile and keeps the curator listing", async () => {
    const curator = signer();
    const player = signer();
    const profile = signer();
    const docs = chain([
      {
        author: curator,
        approvers: [curator],
        payload: base(curator.publicKey, { id: "list-1", kind: "listing", listing: shop(), body: "Listed." }),
      },
      {
        author: player,
        payload: base(player.publicKey, {
          id: "claim-1",
          created_at: "2026-10-31T01:00:00.000Z",
          kind: "claim",
          body: "Claim for this listing.",
          claim: playerClaim(player.publicKey, { playerProfile: profile.publicKey }),
        }),
      },
      {
        author: player,
        payload: base(player.publicKey, {
          id: "edit-1",
          created_at: "2026-10-31T02:00:00.000Z",
          kind: "listing",
          body: "Updated.",
          listing: shop({ url: "https://example.com/taken" }),
        }),
      },
    ]);
    const { directory } = await settle(docs, [curator.publicKey], async () => "mismatch");
    expect(directory.claims.map((claim) => claim.state)).toEqual(["profile_mismatch"]);
    expect(directory.picks.get("list-1")).toEqual({ claimed: false });
    expect(directory.picks.has("edit-1")).toBe(false);
  });

  it("lets a player claim a new listing id when the profile key matches", async () => {
    const player = signer();
    const profile = signer();
    const docs = chain([
      {
        author: player,
        payload: base(player.publicKey, {
          id: "claim-1",
          kind: "claim",
          body: "Claim for this listing.",
          claim: playerClaim(player.publicKey, { playerProfile: profile.publicKey }),
        }),
      },
      {
        author: player,
        payload: base(player.publicKey, {
          id: "edit-1",
          created_at: "2026-10-31T01:00:00.000Z",
          kind: "listing",
          body: "Opened.",
          listing: shop({ stream: "player" }),
        }),
      },
    ]);
    const { directory } = await settle(docs, [], async () => "match");
    expect(directory.claims[0]).toMatchObject({ state: "active", profile: "match" });
    expect(directory.picks.get("edit-1")).toEqual({ claimed: true });
  });

  it("does not let a player take a curator listing without a countersign", async () => {
    const curator = signer();
    const player = signer();
    const profile = signer();
    const docs = chain([
      {
        author: curator,
        approvers: [curator],
        payload: base(curator.publicKey, { id: "list-1", kind: "listing", listing: shop(), body: "Listed." }),
      },
      {
        author: player,
        payload: base(player.publicKey, {
          id: "claim-1",
          created_at: "2026-10-31T01:00:00.000Z",
          kind: "claim",
          body: "Claim for this listing.",
          claim: playerClaim(player.publicKey, { playerProfile: profile.publicKey }),
        }),
      },
    ]);
    const { directory } = await settle(docs, [curator.publicKey], async () => "match");
    expect(directory.claims[0]?.state).toBe("pending_countersign");
    expect(directory.picks.get("list-1")).toEqual({ claimed: false });
  });

  it("keeps a guild claim inactive until curators countersign", async () => {
    const curator = signer();
    const leader = signer();
    const docs = chain([
      {
        author: leader,
        payload: base(leader.publicKey, {
          id: "claim-1",
          kind: "claim",
          body: "Claim for this listing.",
          claim: {
            action: "claim",
            wallet: leader.publicKey,
            hubId: HUB,
            nonce: "guildnonce1",
            expiresAt: "2027-04-01T00:00:00.000Z",
            subject: "guild",
            identity: { type: "guild", name: "East Hall" },
            discord: { note: "Our invite is public.", invite: "https://discord.gg/east-hall" },
          },
        }),
      },
    ]);
    const waiting = await settle(docs, [curator.publicKey]);
    expect(waiting.directory.claims[0]).toMatchObject({
      state: "pending_countersign",
      discord: "self-attested, unverified",
    });
    expect(waiting.directory.claims[0]?.discordHandle).toBeUndefined();

    const signed = chain([
      {
        author: leader,
        approvers: [curator],
        payload: base(leader.publicKey, {
          id: "claim-1",
          kind: "claim",
          body: "Claim for this listing.",
          claim: {
            action: "claim",
            wallet: leader.publicKey,
            hubId: HUB,
            nonce: "guildnonce1",
            expiresAt: "2027-04-01T00:00:00.000Z",
            subject: "guild",
            identity: { type: "guild", name: "East Hall" },
          },
        }),
      },
      {
        author: leader,
        payload: base(leader.publicKey, {
          id: "guild-1",
          created_at: "2026-10-31T01:00:00.000Z",
          kind: "guild",
          body: "Group page.",
          guild: hall(),
        }),
      },
    ]);
    const active = await settle(signed, [curator.publicKey]);
    expect(active.directory.claims[0]?.state).toBe("active");
    expect(active.directory.picks.get("guild-1")).toEqual({ claimed: true });
  });

  it("ignores a claim replayed onto another hub and an expired claim", async () => {
    const player = signer();
    const profile = signer();
    const foreign = chain([
      {
        author: player,
        payload: base(player.publicKey, {
          id: "claim-foreign",
          kind: "claim",
          body: "Claim for this listing.",
          claim: playerClaim(player.publicKey, { playerProfile: profile.publicKey, hubId: OTHER_HUB, nonce: "otherhub1" }),
        }),
      },
    ]);
    const expired = chain([
      {
        author: player,
        payload: base(player.publicKey, {
          id: "claim-old",
          kind: "claim",
          body: "Claim for this listing.",
          claim: playerClaim(player.publicKey, {
            playerProfile: profile.publicKey,
            expiresAt: "2026-10-01T00:00:00.000Z",
            nonce: "expired-1",
          }),
        }),
      },
    ]);
    const foreignResult = await settle(foreign, []);
    const expiredResult = await settle(expired, []);
    expect(foreignResult.directory.claims[0]?.state).toBe("hub_mismatch");
    expect(expiredResult.directory.claims[0]?.state).toBe("expired");
  });

  it("rejects a claimant change to a frozen listing field", () => {
    const curator = signer();
    const owner = signer();
    const docs = chain([
      {
        author: curator,
        approvers: [curator],
        payload: base(curator.publicKey, { id: "list-1", kind: "listing", listing: shop(), body: "Listed." }),
      },
      {
        author: owner,
        approvers: [curator],
        payload: base(owner.publicKey, {
          id: "claim-1",
          created_at: "2026-10-31T01:00:00.000Z",
          kind: "claim",
          body: "Claim for this listing.",
          claim: {
            action: "claim",
            wallet: owner.publicKey,
            hubId: HUB,
            nonce: "business-2",
            expiresAt: "2027-04-01T00:00:00.000Z",
            subject: "business",
            identity: { type: "listing", listingId: "booth-north" },
          },
        }),
      },
      {
        author: owner,
        payload: base(owner.publicKey, {
          id: "retitle",
          created_at: "2026-10-31T02:00:00.000Z",
          kind: "listing",
          body: "Renamed.",
          listing: shop({ title: "South booth", image: { url: "https://example.com/logo.png", alt: "North booth" } }),
        }),
      },
    ]);
    const checked = verifyHubUpdates(docs, new Set([curator.publicKey]), 1, undefined, { hubId: HUB });
    expect(checked.updates.map((update) => update.id)).toEqual(["list-1", "claim-1"]);
    expect(checked.rejected).toEqual([{ id: "retitle", reason: "claim_scope" }]);
  });

  it("rejects a claimant edit of another identity or of the signer set", async () => {
    const player = signer();
    const profile = signer();
    const docs = chain([
      {
        author: player,
        payload: base(player.publicKey, {
          id: "claim-1",
          kind: "claim",
          body: "Claim for this listing.",
          claim: playerClaim(player.publicKey, { playerProfile: profile.publicKey }),
        }),
      },
      {
        author: player,
        payload: base(player.publicKey, {
          id: "other-id",
          created_at: "2026-10-31T01:00:00.000Z",
          kind: "listing",
          body: "Wrong booth.",
          listing: shop({ listingId: "booth-south", title: "South booth" }),
        }),
      },
      {
        author: player,
        payload: base(player.publicKey, {
          id: "signers",
          created_at: "2026-10-31T02:00:00.000Z",
          kind: "signer-change",
          body: "Add me.",
          change: { op: "add", publicKey: profile.publicKey, set: "default" },
        }),
      },
    ]);
    const checked = verifyHubUpdates(docs, new Set<string>(), 1, undefined, { hubId: HUB });
    expect(checked.updates.map((update) => update.id)).toEqual(["claim-1"]);
    expect(checked.rejected).toEqual([
      { id: "other-id", reason: "claim_scope" },
      { id: "signers", reason: "unknown_signer" },
    ]);
  });

  it("caps a wallet at one identity and keeps chain order on a fork", async () => {
    const player = signer();
    const profile = signer();
    const rival = signer();
    const first = base(player.publicKey, {
      id: "claim-1",
      created_at: "2026-10-31T01:00:00.000Z",
      kind: "claim",
      body: "Claim for this listing.",
      claim: playerClaim(player.publicKey, { playerProfile: profile.publicKey, nonce: "first-claim" }),
    });
    const second = base(player.publicKey, {
      id: "claim-2",
      created_at: "2026-10-31T02:00:00.000Z",
      kind: "claim",
      body: "Claim for this listing.",
      claim: playerClaim(player.publicKey, {
        playerProfile: profile.publicKey,
        nonce: "secondclaim",
        identity: { type: "listing", listingId: "booth-south" },
      }),
    });
    const linked = chain([
      { author: player, payload: first },
      { author: player, payload: second },
    ]);
    const capped = await settle(linked, []);
    expect(capped.directory.claims.map((claim) => claim.state)).toEqual(["active", "wallet_cap"]);

    const early = { ...first, created_at: "2026-10-31T00:00:00.000Z", id: "claim-early" };
    const late = base(rival.publicKey, {
      id: "claim-late",
      created_at: "2026-10-31T03:00:00.000Z",
      kind: "claim",
      body: "Claim for this listing.",
      claim: playerClaim(rival.publicKey, { playerProfile: profile.publicKey, nonce: "late-claim1" }),
    });
    const fork = [document(rival, { ...late, prev: null }), document(player, { ...early, prev: null })];
    const checked = verifyHubUpdates(fork, new Set<string>(), 1, undefined, { hubId: HUB });
    expect(checked.updates.map((update) => update.id)).toEqual(["claim-early"]);
    expect(checked.rejected).toEqual([{ id: "claim-late", reason: "broken_chain" }]);
  });

  it("lets a threshold revoke restore the curator listing", async () => {
    const curator = signer();
    const owner = signer();
    const docs = chain([
      {
        author: curator,
        approvers: [curator],
        payload: base(curator.publicKey, { id: "list-1", kind: "listing", listing: shop(), body: "Listed." }),
      },
      {
        author: owner,
        approvers: [curator],
        payload: base(owner.publicKey, {
          id: "claim-1",
          created_at: "2026-10-31T01:00:00.000Z",
          kind: "claim",
          body: "Claim for this listing.",
          claim: {
            action: "claim",
            wallet: owner.publicKey,
            hubId: HUB,
            nonce: "business-1",
            expiresAt: "2027-04-01T00:00:00.000Z",
            subject: "business",
            identity: { type: "listing", listingId: "booth-north" },
          },
        }),
      },
      {
        author: owner,
        payload: base(owner.publicKey, {
          id: "edit-1",
          created_at: "2026-10-31T02:00:00.000Z",
          kind: "listing",
          body: "New page.",
          listing: shop({ url: "https://example.com/ours" }),
        }),
      },
      {
        author: curator,
        approvers: [curator],
        payload: base(curator.publicKey, {
          id: "revoke-1",
          created_at: "2026-10-31T03:00:00.000Z",
          kind: "claim",
          body: "Revoke the claim.",
          claim: {
            action: "revoke",
            wallet: owner.publicKey,
            hubId: HUB,
            nonce: "revoke-111",
            expiresAt: "2027-04-01T00:00:00.000Z",
            subject: "business",
            identity: { type: "listing", listingId: "booth-north" },
            targetId: "claim-1",
          },
        }),
      },
    ]);
    const { directory } = await settle(docs, [curator.publicKey]);
    expect(directory.claims[0]?.state).toBe("revoked");
    expect(directory.picks.get("list-1")).toEqual({ claimed: false });
    expect(directory.picks.has("edit-1")).toBe(false);
  });

  it("hides a raw handle unless the claim opts in", async () => {
    const player = signer();
    const profile = signer();
    const docs = chain([
      {
        author: player,
        payload: base(player.publicKey, {
          id: "claim-1",
          kind: "claim",
          body: "Claim for this listing.",
          claim: playerClaim(player.publicKey, {
            playerProfile: profile.publicKey,
            x: { handle: "northbooth", proofUrl: "https://x.com/northbooth/status/123" },
          }),
        }),
      },
    ]);
    const hidden = await settle(docs, []);
    expect(hidden.directory.claims[0]?.xHandle).toBeUndefined();
    expect(hidden.directory.claims[0]?.x).toBe("self-attested, unverified");
  });
});

describe("verifier attestations", () => {
  it("rejects a forged attestation and leaves an untrusted one self-attested", async () => {
    const verifier = signer();
    const player = signer();
    const profile = signer();
    const payload = base(verifier.publicKey, {
      id: "attest-1",
      kind: "attestation",
      body: "Verifier attestation.",
      attestation: {
        action: "attest",
        wallet: player.publicKey,
        hubId: HUB,
        nonce: "attest-111",
        issuedAt: "2026-10-31T00:00:00.000Z",
        expiresAt: "2027-04-01T00:00:00.000Z",
        method: "discord",
        verifierId: "dock-verifier",
        handleCommitment: "ab".repeat(32),
      },
    });
    const signed = document(verifier, payload);
    signed.signature = base58Encode(nacl.sign.detached(new TextEncoder().encode("forged"), verifier.secret));
    const forged = verifyHubUpdates([signed], new Set<string>(), 1, undefined, { hubId: HUB });
    expect(forged.updates).toEqual([]);
    expect(forged.rejected).toEqual([{ id: "attest-1", reason: "bad_signature" }]);

    const docs = chain([
      {
        author: player,
        payload: base(player.publicKey, {
          id: "claim-1",
          kind: "claim",
          body: "Claim for this listing.",
          claim: playerClaim(player.publicKey, { playerProfile: profile.publicKey }),
        }),
      },
      { author: verifier, payload },
    ]);
    const untrusted = await settle(docs, []);
    expect(untrusted.directory.claims[0]?.discord).toBe("absent");
    const trusted = await settle(docs, [], async () => "match", [verifier.publicKey]);
    expect(trusted.directory.claims[0]?.discord).toBe("verified");
  });

  it("drops expired, revoked, cross-hub, and wrong-wallet attestations", async () => {
    const verifier = signer();
    const player = signer();
    const other = signer();
    const profile = signer();
    const attest = (over: Record<string, unknown>, id: string, author = verifier) =>
      base(author.publicKey, {
        id,
        kind: "attestation",
        body: "Verifier attestation.",
        attestation: {
          action: "attest",
          wallet: player.publicKey,
          hubId: HUB,
          nonce: `${id}-nonce`,
          issuedAt: "2026-10-31T00:00:00.000Z",
          expiresAt: "2027-04-01T00:00:00.000Z",
          method: "x",
          verifierId: "dock-verifier",
          handleCommitment: "cd".repeat(32),
          ...over,
        },
      });
    const claim = base(player.publicKey, {
      id: "claim-1",
      kind: "claim",
      body: "Claim for this listing.",
      claim: playerClaim(player.publicKey, { playerProfile: profile.publicKey }),
    });
    const expired = await settle(
      chain([
        { author: player, payload: claim },
        { author: verifier, payload: attest({ expiresAt: "2026-10-01T00:00:00.000Z" }, "attest-old") },
      ]),
      [],
      async () => "match",
      [verifier.publicKey],
    );
    expect(expired.directory.claims[0]?.x).toBe("expired");

    const revoked = await settle(
      chain([
        { author: player, payload: claim },
        { author: verifier, payload: attest({}, "attest-1") },
        {
          author: player,
          payload: base(player.publicKey, {
            id: "revoke-att",
            created_at: "2026-10-31T03:00:00.000Z",
            kind: "attestation",
            body: "Revoke attestation.",
            attestation: {
              action: "revoke",
              wallet: player.publicKey,
              hubId: HUB,
              nonce: "revoke-att1",
              issuedAt: "2026-10-31T03:00:00.000Z",
              expiresAt: "2027-04-01T00:00:00.000Z",
              method: "x",
              verifierId: "dock-verifier",
              targetId: "attest-1",
            },
          }),
        },
      ]),
      [],
      async () => "match",
      [verifier.publicKey],
    );
    expect(revoked.directory.claims[0]?.x).toBe("revoked");

    const replay = await settle(
      chain([
        { author: player, payload: claim },
        { author: verifier, payload: attest({ hubId: OTHER_HUB }, "attest-other") },
      ]),
      [],
      async () => "match",
      [verifier.publicKey],
    );
    expect(replay.directory.claims[0]?.x).toBe("absent");

    const mismatch = await settle(
      chain([
        { author: player, payload: claim },
        { author: verifier, payload: attest({ wallet: other.publicKey }, "attest-other-wallet") },
      ]),
      [],
      async () => "match",
      [verifier.publicKey],
    );
    expect(mismatch.directory.claims[0]?.x).toBe("absent");
  });
});

describe("profile key check", () => {
  it("matches a current key and refuses another wallet or an expired key", () => {
    const wallet = signer();
    const other = signer();
    const bytes = base58Decode(wallet.publicKey);
    const live = profileBytes([{ wallet: bytes, expiry: -1n }]);
    expect(profileVerdictFromAccount(PLAYER_PROFILE_PROGRAM_ID, live, wallet.publicKey, NOW.getTime())).toBe("match");
    expect(profileVerdictFromAccount(PLAYER_PROFILE_PROGRAM_ID, live, other.publicKey, NOW.getTime())).toBe("mismatch");
    const expired = profileBytes([{ wallet: bytes, expiry: 1n }]);
    expect(profileVerdictFromAccount(PLAYER_PROFILE_PROGRAM_ID, expired, wallet.publicKey, NOW.getTime())).toBe("mismatch");
    expect(profileVerdictFromAccount("11111111111111111111111111111111", live, wallet.publicKey, NOW.getTime())).toBe(
      "mismatch",
    );
    const truncated = profileBytes([], 40);
    expect(profileVerdictFromAccount(PLAYER_PROFILE_PROGRAM_ID, truncated, wallet.publicKey, NOW.getTime())).toBe(
      "unavailable",
    );
  });
});

describe("claim command", () => {
  it("builds an unsigned claim and verifies a signed one", () => {
    const player = signer();
    const profile = signer();
    const directory = mkdtempSync(path.join(tmpdir(), "hub-claim-"));
    const builtPath = path.join(directory, "claim.json");
    const signedPath = path.join(directory, "claim.signed.json");
    const built = runClaimCli([
      "build",
      "--wallet",
      player.publicKey,
      "--hub",
      HUB,
      "--subject",
      "player",
      "--listing-id",
      "booth-north",
      "--profile",
      profile.publicKey,
      "--nonce",
      "cli-nonce1",
      "--expires",
      "2027-04-01T00:00:00.000Z",
      "--created-at",
      "2026-10-31T00:00:00.000Z",
      "--id",
      "claim-cli",
      "--out",
      builtPath,
    ]);
    expect(built.code, built.stderr).toBe(0);
    const keyPath = path.join(directory, "key.json");
    writeFileSync(keyPath, JSON.stringify(Array.from(player.secret)));
    const signed = runClaimCli(["sign", "--payload", builtPath, "--key-path", keyPath, "--out", signedPath]);
    expect(signed.code, signed.stderr).toBe(0);
    const verified = runClaimCli(["verify", "--file", signedPath, "--hub", HUB]);
    expect(verified.code, verified.stderr).toBe(0);
    expect(verified.stdout).toContain(player.publicKey);
    const wrongHub = runClaimCli(["verify", "--file", signedPath, "--hub", OTHER_HUB]);
    expect(wrongHub.code).toBe(1);
    expect(readFileSync(signedPath, "utf8")).not.toContain(JSON.stringify(Array.from(player.secret)));
  });
});

describe("optional verifier module", () => {
  it("stays disabled until Discord env is set, and identify is the only scope", async () => {
    expect(discordVerifierConfig({})).toBeNull();
    const config = discordVerifierConfig({
      DISCORD_CLIENT_ID: "123456789012345678",
      DISCORD_CLIENT_SECRET: "test-secret-value",
      DISCORD_REDIRECT_URI: "http://127.0.0.1:8788/discord",
    });
    expect(config).not.toBeNull();
    const pkce = discordPkce(new Uint8Array(32).fill(3));
    const url = discordAuthorizeUrl(config!, "state-1111", pkce.challenge);
    expect(url).toContain("scope=identify");
    expect(url).toContain("code_challenge_method=S256");
    expect(url).toContain(`code_challenge=${encodeURIComponent(pkce.challenge)}`);
    expect(url).not.toContain(pkce.verifier);
    expect(url).not.toContain("guilds");
    expect(url).not.toContain("test-secret-value");
    const identity = await discordIdentify(config!, "code-1234", pkce.verifier, (async (input, init) => {
      const target = String(input);
      if (target.includes("oauth2/token")) {
        const raw = init?.body;
        const body = raw instanceof URLSearchParams ? raw.toString() : String(raw ?? "");
        expect(body).toContain(`code_verifier=${pkce.verifier}`);
        expect(body).not.toContain(pkce.challenge);
      }
      const payload = target.includes("oauth2/token")
        ? { access_token: "token-value", scope: "identify" }
        : { id: "123456789012345678" };
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as typeof fetch);
    expect(identity.id).toBe("123456789012345678");
    expect(postContainsCode("posted code ABCDEFGH today", "ABCDEFGH")).toBe(true);
    expect(postContainsCode("posted code ABCDEFGH today", "ZZZZZZZZ")).toBe(false);
  });
});

describe("red-team regressions", () => {
  it("drops claims, attestations, and inactive claimant edits from the public update list", async () => {
    const player = signer();
    const profile = signer();
    const docs = chain([
      {
        author: player,
        payload: base(player.publicKey, {
          id: "claim-1",
          kind: "claim",
          body: "Unverified claim text https://example.com/secret",
          claim: playerClaim(player.publicKey, { playerProfile: profile.publicKey }),
        }),
      },
      {
        author: player,
        payload: base(player.publicKey, {
          id: "edit-1",
          created_at: "2026-10-31T01:00:00.000Z",
          kind: "listing",
          body: "Inactive listing text.",
          listing: shop({ stream: "hybrid", url: "https://example.com/hijack" }),
        }),
      },
    ]);
    const { checked, directory } = await settle(docs, [], async () => "mismatch");
    const shown = selectPublicUpdates(checked.updates, directory.picks);
    expect(shown).toEqual([]);
    expect(JSON.stringify(shown)).not.toContain("hijack");
  });

  it("does not let a player claim replace a later curator listing url", async () => {
    const curator = signer();
    const player = signer();
    const profile = signer();
    const docs = chain([
      {
        author: player,
        payload: base(player.publicKey, {
          id: "claim-1",
          kind: "claim",
          body: "Claim for this listing.",
          claim: playerClaim(player.publicKey, { playerProfile: profile.publicKey }),
        }),
      },
      {
        author: player,
        payload: base(player.publicKey, {
          id: "edit-1",
          created_at: "2026-10-31T01:00:00.000Z",
          kind: "listing",
          body: "Player page.",
          listing: shop({ stream: "player", url: "https://example.com/player" }),
        }),
      },
      {
        author: curator,
        approvers: [curator],
        payload: base(curator.publicKey, {
          id: "list-1",
          created_at: "2026-10-31T02:00:00.000Z",
          kind: "listing",
          body: "Curator page.",
          listing: shop({ url: "https://example.com/curator" }),
        }),
      },
    ]);
    const { directory } = await settle(docs, [curator.publicKey], async () => "match");
    expect(directory.claims[0]?.state).toBe("pending_countersign");
    expect(directory.picks.get("list-1")?.claimed).toBe(false);
    expect(directory.picks.has("edit-1")).toBe(false);
  });

  it("freezes the url on a player-subject listing", () => {
    const player = signer();
    const profile = signer();
    const docs = chain([
      {
        author: player,
        payload: base(player.publicKey, {
          id: "claim-1",
          kind: "claim",
          body: "Claim for this listing.",
          claim: playerClaim(player.publicKey, { playerProfile: profile.publicKey }),
        }),
      },
      {
        author: player,
        payload: base(player.publicKey, {
          id: "edit-1",
          created_at: "2026-10-31T01:00:00.000Z",
          kind: "listing",
          body: "Opened.",
          listing: shop({ stream: "player", url: "https://example.com/player" }),
        }),
      },
      {
        author: player,
        payload: base(player.publicKey, {
          id: "edit-2",
          created_at: "2026-10-31T02:00:00.000Z",
          kind: "listing",
          body: "Moved.",
          listing: shop({ stream: "player", url: "https://example.com/moved" }),
        }),
      },
    ]);
    const checked = verifyHubUpdates(docs, new Set<string>(), 1, undefined, { hubId: HUB, now: NOW });
    expect(checked.updates.map((update) => update.id)).toEqual(["claim-1", "edit-1"]);
    expect(checked.rejected).toEqual([{ id: "edit-2", reason: "claim_scope" }]);
  });

  it("holds an identity when the earlier profile read is unavailable", async () => {
    const first = signer();
    const second = signer();
    const profile = signer();
    const otherProfile = signer();
    let calls = 0;
    const docs = chain([
      {
        author: first,
        payload: base(first.publicKey, {
          id: "claim-1",
          kind: "claim",
          body: "Claim for this listing.",
          claim: playerClaim(first.publicKey, { playerProfile: profile.publicKey, nonce: "hold-claim1" }),
        }),
      },
      {
        author: second,
        payload: base(second.publicKey, {
          id: "claim-2",
          created_at: "2026-10-31T01:00:00.000Z",
          kind: "claim",
          body: "Claim for this listing.",
          claim: playerClaim(second.publicKey, { playerProfile: otherProfile.publicKey, nonce: "hold-claim2" }),
        }),
      },
    ]);
    const { directory } = await settle(docs, [], async (wallet) => {
      calls += 1;
      return wallet === first.publicKey ? "unavailable" : "match";
    });
    expect(calls).toBe(1);
    expect(directory.claims.map((claim) => claim.state)).toEqual(["pending_profile", "superseded"]);
    expect(directory.claims.some((claim) => claim.active)).toBe(false);
  });

  it("lets a wallet renew after an expired claim and ignores a replayed hub id", async () => {
    const player = signer();
    const profile = signer();
    const docs = chain([
      {
        author: player,
        payload: base(player.publicKey, {
          id: "claim-old",
          kind: "claim",
          body: "Claim for this listing.",
          claim: playerClaim(player.publicKey, {
            playerProfile: profile.publicKey,
            expiresAt: "2026-10-01T00:00:00.000Z",
            nonce: "old-claim1",
          }),
        }),
      },
      {
        author: player,
        payload: base(player.publicKey, {
          id: "claim-new",
          created_at: "2026-10-31T01:00:00.000Z",
          kind: "claim",
          body: "Claim for this listing.",
          claim: playerClaim(player.publicKey, { playerProfile: profile.publicKey, nonce: "new-claim1" }),
        }),
      },
    ]);
    const { directory } = await settle(docs, [], async () => "match");
    expect(directory.claims.map((claim) => [claim.updateId, claim.state])).toEqual([
      ["claim-old", "expired"],
      ["claim-new", "active"],
    ]);
    const replay = chain([
      {
        author: player,
        payload: base(player.publicKey, {
          id: "claim-foreign",
          kind: "claim",
          body: "Claim for this listing.",
          claim: playerClaim(player.publicKey, { playerProfile: profile.publicKey, hubId: OTHER_HUB, nonce: "foreign-11" }),
        }),
      },
      {
        author: player,
        payload: base(player.publicKey, {
          id: "edit-foreign",
          created_at: "2026-10-31T01:00:00.000Z",
          kind: "listing",
          body: "Should not publish.",
          listing: shop({ stream: "player" }),
        }),
      },
    ]);
    const checked = verifyHubUpdates(replay, new Set<string>(), 1, undefined, { hubId: HUB, now: NOW });
    expect(checked.updates.map((update) => update.id)).toEqual(["claim-foreign"]);
    expect(checked.rejected).toEqual([{ id: "edit-foreign", reason: "unknown_signer" }]);
  });

  it("treats only a subject-authored attestation as self-attested and hides untrusted handles", async () => {
    const player = signer();
    const stranger = signer();
    const profile = signer();
    const claim = playerClaim(player.publicKey, { playerProfile: profile.publicKey, showHandles: true });
    const docs = chain([
      {
        author: player,
        payload: base(player.publicKey, { id: "claim-1", kind: "claim", body: "Claim for this listing.", claim }),
      },
      {
        author: stranger,
        payload: base(stranger.publicKey, {
          id: "attest-stranger",
          created_at: "2026-10-31T01:00:00.000Z",
          kind: "attestation",
          body: "Verifier attestation.",
          attestation: {
            action: "attest",
            wallet: player.publicKey,
            hubId: HUB,
            nonce: "stranger-11",
            issuedAt: "2026-10-31T01:00:00.000Z",
            expiresAt: "2027-04-01T00:00:00.000Z",
            method: "discord",
            verifierId: "dock-verifier",
            handleCommitment: "ab".repeat(32),
            handle: "notshown",
          },
        }),
      },
    ]);
    const untrusted = await settle(docs, []);
    expect(untrusted.directory.claims[0]?.discord).toBe("absent");
    expect(untrusted.directory.claims[0]?.discordHandle).toBeUndefined();
    const subject = chain([
      {
        author: player,
        payload: base(player.publicKey, { id: "claim-1", kind: "claim", body: "Claim for this listing.", claim }),
      },
      {
        author: player,
        payload: base(player.publicKey, {
          id: "attest-self",
          created_at: "2026-10-31T01:00:00.000Z",
          kind: "attestation",
          body: "Verifier attestation.",
          attestation: {
            action: "attest",
            wallet: player.publicKey,
            hubId: HUB,
            nonce: "self-attest1",
            issuedAt: "2026-10-31T01:00:00.000Z",
            expiresAt: "2027-04-01T00:00:00.000Z",
            method: "discord",
            verifierId: "dock-verifier",
            handleCommitment: "cd".repeat(32),
          },
        }),
      },
    ]);
    const authored = await settle(subject, []);
    expect(authored.directory.claims[0]?.discord).toBe("self-attested, unverified");
  });

  it("rejects a raw Discord snowflake and an attestation handle without consent", () => {
    expect(
      parseClaim({
        action: "claim",
        wallet: signer().publicKey,
        hubId: HUB,
        nonce: "snow-1111",
        expiresAt: "2027-04-01T00:00:00.000Z",
        subject: "player",
        identity: { type: "listing", listingId: "booth-north" },
        playerProfile: signer().publicKey,
        discord: { note: "A public note.", handle: "12345678901234567" },
      }),
    ).toBeNull();
    const player = signer();
    const verifier = signer();
    const docs = chain([
      {
        author: verifier,
        payload: base(verifier.publicKey, {
          id: "attest-handle",
          kind: "attestation",
          body: "Verifier attestation.",
          attestation: {
            action: "attest",
            wallet: player.publicKey,
            hubId: HUB,
            nonce: "handle-111",
            issuedAt: "2026-10-31T00:00:00.000Z",
            expiresAt: "2027-04-01T00:00:00.000Z",
            method: "discord",
            verifierId: "dock-verifier",
            handleCommitment: "ef".repeat(32),
            handle: "northbooth",
          },
        }),
      },
    ]);
    const checked = verifyHubUpdates(docs, new Set<string>(), 1, undefined, { hubId: HUB, now: NOW });
    expect(checked.rejected).toEqual([{ id: "attest-handle", reason: "claim_scope" }]);
  });

  it("caps one identity per profile and ignores a non-auth profile key", async () => {
    const player = signer();
    const other = signer();
    const profile = signer();
    const shared = chain([
      {
        author: player,
        payload: base(player.publicKey, {
          id: "claim-a",
          kind: "claim",
          body: "Claim for this listing.",
          claim: playerClaim(player.publicKey, { playerProfile: profile.publicKey, nonce: "shared-pro1" }),
        }),
      },
      {
        author: other,
        payload: base(other.publicKey, {
          id: "claim-b",
          created_at: "2026-10-31T01:00:00.000Z",
          kind: "claim",
          body: "Claim for this listing.",
          claim: playerClaim(other.publicKey, {
            playerProfile: profile.publicKey,
            nonce: "shared-pro2",
            identity: { type: "listing", listingId: "booth-south" },
          }),
        }),
      },
    ]);
    const capped = await settle(shared, [], async () => "match");
    expect(capped.directory.claims.map((claim) => claim.state)).toEqual(["active", "profile_cap"]);

    const bytes = base58Decode(player.publicKey);
    const scoped = new Uint8Array(PROFILE_KEY_OFFSET + PROFILE_KEY_STRIDE * 2);
    scoped.set(PROFILE_DISCRIMINATOR, 0);
    scoped[28] = 2;
    scoped.set(bytes, PROFILE_KEY_OFFSET + PROFILE_KEY_STRIDE);
    expect(profileVerdictFromAccount(PLAYER_PROFILE_PROGRAM_ID, scoped, player.publicKey, NOW.getTime())).toBe("mismatch");
    scoped.set(base58Decode(PLAYER_PROFILE_PROGRAM_ID), PROFILE_KEY_OFFSET + PROFILE_KEY_STRIDE + 32);
    scoped[PROFILE_KEY_OFFSET + PROFILE_KEY_STRIDE + 72] = 1;
    writeI64(scoped, PROFILE_KEY_OFFSET + PROFILE_KEY_STRIDE + 64, -1n);
    expect(profileVerdictFromAccount(PLAYER_PROFILE_PROGRAM_ID, scoped, player.publicKey, NOW.getTime())).toBe("match");
  });

  it("omits wallets on claims that are not active", () => {
    const waiting = publicClaimRow({
      updateId: "claim-1",
      identity: "id:booth-north",
      identityType: "listing",
      listingId: "booth-north",
      subject: "player",
      wallet: "WalletAddress111111111111111111111111111",
      state: "pending_countersign",
      active: false,
      profile: "match",
      discord: "absent",
      x: "absent",
      showHandles: false,
      note: "Waiting.",
    });
    expect(waiting.wallet).toBeUndefined();
    const live = publicClaimRow({
      updateId: "claim-1",
      identity: "id:booth-north",
      identityType: "listing",
      subject: "player",
      wallet: "WalletAddress111111111111111111111111111",
      state: "active",
      active: true,
      profile: "match",
      discord: "absent",
      x: "absent",
      showHandles: false,
      note: "Live.",
    });
    expect(live.wallet).toBe("WalletAddress111111111111111111111111111");
  });

  it("keeps claim profile reads off the player_legacy miss window", async () => {
    resetProfileKeyCache();
    const now = Date.now();
    for (let index = 0; index < 30; index += 1) sharedMissWindow.permit(`legacy-${index}`, now);
    expect(sharedMissWindow.permit("legacy-extra", now)).toBe(false);
    const wallet = signer();
    const bytes = profileBytes([{ wallet: base58Decode(wallet.publicKey), expiry: -1n }]);
    const checker = createProfileKeyChecker({
      async call<T>() {
        return { value: { owner: PLAYER_PROFILE_PROGRAM_ID, data: [Buffer.from(bytes).toString("base64"), "base64"] } } as T;
      },
      async batch() {
        return [];
      },
    });
    expect(await checker.walletIsProfileKey(wallet.publicKey, signer().publicKey, NOW.getTime())).toBe("match");
  });

  it("requires the status path handle and a final status URL", async () => {
    const html = new Response("code ABCDEFGH is posted", { status: 200 });
    Object.defineProperty(html, "url", { value: "https://evil.example/phish" });
    expect(
      await fetchPostedCode("https://x.com/northbooth/status/123", "ABCDEFGH", "northbooth", async () => html),
    ).toBe(false);
    expect(
      await fetchPostedCode("https://x.com/othername/status/123", "ABCDEFGH", "northbooth", async () => new Response("ABCDEFGH")),
    ).toBe(false);
  });

  it("rejects an OAuth state that does not match the wallet and nonce", async () => {
    const wallet = signer().publicKey;
    const previous = {
      id: process.env.DISCORD_CLIENT_ID,
      secret: process.env.DISCORD_CLIENT_SECRET,
      redirect: process.env.DISCORD_REDIRECT_URI,
    };
    process.env.DISCORD_CLIENT_ID = "123456789012345678";
    process.env.DISCORD_CLIENT_SECRET = "test-secret-value";
    process.env.DISCORD_REDIRECT_URI = "http://127.0.0.1:8788/discord";
    const opened = await runAttestCli(["discord-url", "--wallet", wallet, "--nonce", "nonce-1111"]);
    expect(opened.code, opened.stderr).toBe(0);
    expect(opened.stdout).toContain("code_challenge_method=S256");
    expect(opened.stdout).not.toContain(wallet);
    const state = /discord-code\): (\S+)/.exec(opened.stderr)?.[1] ?? "";
    const mismatched = await runAttestCli([
      "discord-code",
      "--code",
      "code-1234",
      "--state",
      state,
      "--wallet",
      wallet,
      "--nonce",
      "other-nonce1",
    ]);
    process.env.DISCORD_CLIENT_ID = previous.id;
    process.env.DISCORD_CLIENT_SECRET = previous.secret;
    process.env.DISCORD_REDIRECT_URI = previous.redirect;
    expect(mismatched.code).toBe(1);
    expect(mismatched.stderr).toMatch(/state/);
  });

  it("does not render a claim on the plain page", () => {
    const doc = {
      createElement(tag: string) {
        const node = {
          tag,
          className: "",
          textContent: "",
          childNodes: [] as { textContent: string }[],
          appendChild(child: { textContent: string }) {
            this.childNodes.push(child);
            this.textContent += child.textContent;
          },
          setAttribute() {},
        };
        return node;
      },
    };
    expect(isPublicUpdate({ kind: "claim", body: "secret" })).toBe(false);
    expect(isPublicUpdate({ kind: "attestation", body: "secret" })).toBe(false);
    const card = renderHubUpdate(doc, { kind: "claim", body: "https://example.com/secret-claim" });
    expect(card.textContent).toBe("");
    expect(card.textContent).not.toContain("secret");
  });

  it("does not let a profile mismatch reserve the profile", async () => {
    const attacker = signer();
    const owner = signer();
    const profile = signer();
    const docs = chain([
      {
        author: attacker,
        payload: base(attacker.publicKey, {
          id: "claim-a",
          kind: "claim",
          body: "Claim for this listing.",
          claim: playerClaim(attacker.publicKey, { playerProfile: profile.publicKey, nonce: "mismatch-a1" }),
        }),
      },
      {
        author: owner,
        payload: base(owner.publicKey, {
          id: "claim-b",
          created_at: "2026-10-31T01:00:00.000Z",
          kind: "claim",
          body: "Claim for this listing.",
          claim: playerClaim(owner.publicKey, {
            playerProfile: profile.publicKey,
            nonce: "match-own1",
            identity: { type: "listing", listingId: "booth-south" },
          }),
        }),
      },
    ]);
    const { directory } = await settle(docs, [], async (wallet) => (wallet === attacker.publicKey ? "mismatch" : "match"));
    expect(directory.claims.map((claim) => claim.state)).toEqual(["profile_mismatch", "active"]);
  });

  it("lets a countersigned claim and a threshold resolve pass an unfinished profile read", async () => {
    const player = signer();
    const owner = signer();
    const curator = signer();
    const profile = signer();
    const countersigned = chain([
      {
        author: player,
        payload: base(player.publicKey, {
          id: "claim-1",
          kind: "claim",
          body: "Claim for this listing.",
          claim: playerClaim(player.publicKey, { playerProfile: profile.publicKey, nonce: "hold-sign1" }),
        }),
      },
      {
        author: owner,
        approvers: [curator],
        payload: base(owner.publicKey, {
          id: "claim-2",
          created_at: "2026-10-31T01:00:00.000Z",
          kind: "claim",
          body: "Claim for this listing.",
          claim: {
            action: "claim",
            wallet: owner.publicKey,
            hubId: HUB,
            nonce: "biz-signed1",
            expiresAt: "2027-04-01T00:00:00.000Z",
            subject: "business",
            identity: { type: "listing", listingId: "booth-north" },
          },
        }),
      },
    ]);
    const signed = await settle(countersigned, [curator.publicKey], async () => "unavailable");
    expect(signed.directory.claims.map((claim) => claim.state)).toEqual(["pending_profile", "active"]);

    const second = signer();
    const resolved = chain([
      {
        author: player,
        payload: base(player.publicKey, {
          id: "claim-1",
          kind: "claim",
          body: "Claim for this listing.",
          claim: playerClaim(player.publicKey, { playerProfile: profile.publicKey, nonce: "hold-res1" }),
        }),
      },
      {
        author: second,
        payload: base(second.publicKey, {
          id: "claim-2",
          created_at: "2026-10-31T01:00:00.000Z",
          kind: "claim",
          body: "Claim for this listing.",
          claim: playerClaim(second.publicKey, { playerProfile: profile.publicKey, nonce: "hold-res2" }),
        }),
      },
      {
        author: curator,
        approvers: [curator],
        payload: base(curator.publicKey, {
          id: "resolve-1",
          created_at: "2026-10-31T02:00:00.000Z",
          kind: "claim",
          body: "Resolve the claim.",
          claim: {
            action: "resolve",
            wallet: second.publicKey,
            hubId: HUB,
            nonce: "resolve-111",
            expiresAt: "2027-04-01T00:00:00.000Z",
            subject: "player",
            identity: { type: "listing", listingId: "booth-north" },
            resolveId: "claim-2",
          },
        }),
      },
    ]);
    const named = await settle(resolved, [curator.publicKey], async (wallet) =>
      wallet === player.publicKey ? "unavailable" : "match",
    );
    expect(named.directory.claims.map((claim) => claim.state)).toEqual(["pending_profile", "active"]);
  });

  it("caches an unavailable profile read briefly and caps concurrent reads", async () => {
    resetProfileKeyCache();
    let calls = 0;
    let clock = 1_000;
    const wallet = signer().publicKey;
    const profile = signer().publicKey;
    const checker = createProfileKeyChecker(
      {
        async call() {
          calls += 1;
          throw new Error("down");
        },
        async batch() {
          return [];
        },
      },
      () => clock,
    );
    expect(await checker.walletIsProfileKey(wallet, profile, NOW.getTime())).toBe("unavailable");
    expect(await checker.walletIsProfileKey(wallet, profile, NOW.getTime())).toBe("unavailable");
    expect(calls).toBe(1);
    clock += 31_000;
    expect(await checker.walletIsProfileKey(wallet, profile, NOW.getTime())).toBe("unavailable");
    expect(calls).toBe(2);

    resetProfileKeyCache();
    let active = 0;
    let peak = 0;
    const limited = createProfileKeyChecker({
      async call() {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        throw new Error("down");
      },
      async batch() {
        return [];
      },
    });
    await Promise.all(
      Array.from({ length: 8 }, () => signer().publicKey).map((address) =>
        limited.walletIsProfileKey(signer().publicKey, address, NOW.getTime()),
      ),
    );
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(CLAIM_PROFILE_CONCURRENCY);
  });
});

const DISCORD_ACCOUNT = "123456789012345678";
const PLAYER_FIELDS = {
  hub: HUB,
  listingId: "booth-north",
  nonce: "nonce-1111",
  expiresAt: "2027-04-01T00:00:00.000Z",
  createdAt: "2026-10-31T00:00:00.000Z",
};

function playerFields(wallet: string, profile: string) {
  return { ...PLAYER_FIELDS, wallet, profile };
}

function discordProofFor(wallet: string, nonce = PLAYER_FIELDS.nonce) {
  const salt = "salt-value-1";
  return {
    v: 1 as const,
    method: "discord" as const,
    account: DISCORD_ACCOUNT,
    salt,
    wallet,
    nonce,
    state: opaqueVerifierState(new Uint8Array(32).fill(9)),
  };
}

function signUtf8(secret: Uint8Array, utf8: string): string {
  return base58Encode(nacl.sign.detached(new TextEncoder().encode(utf8), secret));
}

describe("player discord claim flow", () => {
  it("keeps Discord off the public server and leaves a stock node unchanged", () => {
    const roots = ["src/server.ts", "src/http.ts", "src/handler.ts", "src/runtime.ts", "src/public-mcp.ts", "src/public-mcp-entry.ts"];
    for (const file of roots) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toContain("discord-oauth");
      expect(text).not.toContain("player-exchange");
      expect(text).not.toContain("player-flow");
      expect(text).not.toContain("player-discord-flow");
    }
    const bundle = readFileSync("dashboard/api/mcp.js", "utf8");
    expect(bundle).not.toContain("oauth2/token");
    expect(bundle).not.toContain("DISCORD_CLIENT_SECRET");
    expect(discordVerifierConfig({})).toBeNull();
    expect(exchangeListenTarget("http://127.0.0.1:8788/discord")).toEqual({
      host: "127.0.0.1",
      port: 8788,
      callbackPath: "/discord",
    });
    expect(exchangeListenTarget("https://example.com/discord")).toBeNull();
    expect(exchangeListenTarget("http://localhost:8788/discord")).toBeNull();
  });

  it("binds the exchange listener to loopback", async () => {
    const bound = await listenLoopback(0, async () => new Response("ok"));
    expect(bound.address).toBe(LOOPBACK_HOST);
    await bound.close();
  });

  it("writes a signed claim and player attestation only after a profile match", async () => {
    const player = signer();
    const profile = signer();
    const fields = playerFields(player.publicKey, profile.publicKey);
    const proof = discordProofFor(player.publicKey);
    const claim = buildPlayerClaimDraft(fields);
    expect(claim).not.toBeNull();
    const attestation = buildPlayerAttestationDraft({
      proof,
      hub: fields.hub,
      issuedAt: fields.createdAt,
      expiresAt: fields.expiresAt,
      prev: hubUpdateHash(claim!.payload),
    });
    expect(attestation).not.toBeNull();
    expect(JSON.stringify(attestation)).not.toContain(`"${DISCORD_ACCOUNT}"`);
    expect(JSON.stringify(attestation)).not.toContain(proof.salt);
    const packed = readyPlayerPack({
      fields,
      proof,
      claimSignature: signUtf8(player.secret, claim!.message.utf8),
      attestationSignature: signUtf8(player.secret, attestation!.message.utf8),
      profile: "match",
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const directory = mkdtempSync(path.join(tmpdir(), "player-pack-"));
    const files = writePlayerPack(directory, packed.pack);
    expect(files).toEqual(["claim.signed.json", "attest.signed.json", "proof.json"]);
    const claimText = readFileSync(path.join(directory, "claim.signed.json"), "utf8");
    const attestText = readFileSync(path.join(directory, "attest.signed.json"), "utf8");
    expect(claimText).not.toContain(DISCORD_ACCOUNT);
    expect(attestText).not.toContain(DISCORD_ACCOUNT);
    expect(attestText).not.toContain(proof.salt);
    expect(readFileSync(path.join(directory, "proof.json"), "utf8")).toContain(DISCORD_ACCOUNT);
    const checked = verifyHubUpdates(
      [JSON.parse(claimText), JSON.parse(attestText)],
      new Set<string>(),
      1,
      undefined,
      { hubId: HUB, now: NOW },
    );
    expect(checked.rejected).toEqual([]);
    const resolved = await resolveClaimDirectory(checked.updates, {
      hubId: HUB,
      now: NOW,
      trustedVerifiers: new Set(),
      profile: async () => "match",
    });
    expect(resolved.claims[0]?.state).toBe("active");
    expect(resolved.claims[0]?.profile).toBe("match");
    expect(resolved.claims[0]?.discord).toBe("self-attested, unverified");

    const mismatch = readyPlayerPack({
      fields,
      proof,
      claimSignature: signUtf8(player.secret, claim!.message.utf8),
      attestationSignature: signUtf8(player.secret, attestation!.message.utf8),
      profile: "mismatch",
    });
    expect(mismatch).toEqual({ ok: false, reason: "profile_mismatch" });
    const unavailable = readyPlayerPack({
      fields,
      proof,
      claimSignature: packed.pack.claim.signature,
      attestationSignature: packed.pack.attestation.signature,
      profile: "unavailable",
    });
    expect(unavailable).toEqual({ ok: false, reason: "profile_unavailable" });
  });

  it("refuses a claim whose expiry is already past", () => {
    const player = signer();
    const profile = signer();
    const fields = { ...playerFields(player.publicKey, profile.publicKey), expiresAt: "2020-01-01T00:00:00.000Z" };
    const proof = discordProofFor(player.publicKey);
    const claim = buildPlayerClaimDraft(fields);
    const attestation = buildPlayerAttestationDraft({
      proof,
      hub: fields.hub,
      issuedAt: fields.createdAt,
      expiresAt: fields.expiresAt,
      prev: hubUpdateHash(claim!.payload),
    });
    const packed = readyPlayerPack({
      fields,
      proof,
      claimSignature: signUtf8(player.secret, claim!.message.utf8),
      attestationSignature: signUtf8(player.secret, attestation!.message.utf8),
      profile: "match",
      nowMs: NOW.getTime(),
    });
    expect(packed).toEqual({ ok: false, reason: "expired" });
  });

  it("chains a verifier attestation after the player signature when the profile matches", async () => {
    const player = signer();
    const verifier = signer();
    const profile = signer();
    const fields = playerFields(player.publicKey, profile.publicKey);
    const proof = discordProofFor(player.publicKey);
    const out = mkdtempSync(path.join(tmpdir(), "player-verifier-"));
    const proofPath = path.join(out, "proof.json");
    writeFileSync(proofPath, JSON.stringify(proof));
    const keyPath = path.join(out, "verifier.json");
    writeFileSync(keyPath, JSON.stringify(Array.from(verifier.secret)));
    const claim = buildPlayerClaimDraft(fields);
    const attestation = buildPlayerAttestationDraft({
      proof,
      hub: fields.hub,
      issuedAt: fields.createdAt,
      expiresAt: fields.expiresAt,
      prev: hubUpdateHash(claim!.payload),
    });
    const ready = path.join(out, "ready");
    const result = await runPlayerFlowCli(
      [
        "pack",
        "--wallet",
        player.publicKey,
        "--hub",
        fields.hub,
        "--listing-id",
        fields.listingId,
        "--profile",
        profile.publicKey,
        "--nonce",
        fields.nonce,
        "--expires",
        fields.expiresAt,
        "--created-at",
        fields.createdAt,
        "--claim-signature",
        signUtf8(player.secret, claim!.message.utf8),
        "--attest-signature",
        signUtf8(player.secret, attestation!.message.utf8),
        "--proof-file",
        proofPath,
        "--verifier-key",
        keyPath,
        "--verifier-id",
        "hub-verifier",
        "--out",
        ready,
      ],
      { profile: { async walletIsProfileKey() { return "match"; } } },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('"published":false');
    const names = readdirSync(ready).sort();
    expect(names).toEqual(["attest.signed.json", "attest.verifier.signed.json", "claim.signed.json", "proof.json"]);
    const docs = names.filter((name) => name.endsWith(".signed.json")).map((name) => JSON.parse(readFileSync(path.join(ready, name), "utf8")));
    const checked = verifyHubUpdates(docs, new Set<string>(), 1, undefined, { hubId: HUB, now: NOW });
    expect(checked.rejected).toEqual([]);
    const resolved = await resolveClaimDirectory(checked.updates, {
      hubId: HUB,
      now: NOW,
      trustedVerifiers: new Set([verifier.publicKey]),
      profile: async () => "match",
    });
    expect(resolved.claims[0]?.discord).toBe("verified");
    expect(readFileSync(path.join(ready, "attest.verifier.signed.json"), "utf8")).not.toContain(DISCORD_ACCOUNT);
    expect(readFileSync(keyPath, "utf8")).not.toBe(readFileSync(path.join(ready, "attest.verifier.signed.json"), "utf8"));
  });

  it("refuses to publish from the loopback exchange and keeps the client secret there", async () => {
    const player = signer();
    const profile = signer();
    const out = mkdtempSync(path.join(tmpdir(), "player-exchange-"));
    const seen: string[] = [];
    const opened = createPlayerExchange({
      env: {
        DISCORD_CLIENT_ID: "123456789012345678",
        DISCORD_CLIENT_SECRET: "test-secret-value",
        DISCORD_REDIRECT_URI: "http://127.0.0.1:8788/discord",
      },
      outDir: out,
      now: () => NOW.getTime(),
      profile: { async walletIsProfileKey() { return "match"; } },
      fetchImpl: (async (input, init) => {
        const url = String(input);
        seen.push(url);
        const raw = init?.body;
        const body = typeof raw === "string" ? raw : raw instanceof URLSearchParams ? raw.toString() : "";
        if (url.includes("oauth2/token")) {
          expect(body).toContain("client_secret=test-secret-value");
          expect(body).toContain("code_verifier=");
          const verifier = new URLSearchParams(body).get("code_verifier") ?? "";
          expect(verifier).not.toContain("test-secret-value");
          expect(verifier.length).toBeGreaterThanOrEqual(43);
        }
        expect(url).not.toContain("test-secret-value");
        if (url.includes("oauth2/token")) {
          return new Response(JSON.stringify({ access_token: "token-value", scope: "identify" }), { status: 200 });
        }
        return new Response(JSON.stringify({ id: seen.filter((item) => item.includes("users/@me")).length > 1 ? "999999999999999999" : DISCORD_ACCOUNT }), { status: 200 });
      }) as typeof fetch,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const headers = {
      "content-type": "application/json",
      "x-player-flow": "1",
      origin: "http://127.0.0.1:8788",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    };
    const begun = await opened.handle(new Request("http://127.0.0.1:8788/begin", {
      method: "POST",
      headers,
      body: JSON.stringify(playerFields(player.publicKey, profile.publicKey)),
    }));
    const started = (await begun.json()) as { authorizeUrl?: string };
    expect(begun.status).toBe(200);
    expect(started.authorizeUrl).toContain("scope=identify");
    expect(started.authorizeUrl).toContain("code_challenge_method=S256");
    expect(started.authorizeUrl).not.toContain("guilds");
    expect(started.authorizeUrl).not.toContain("test-secret-value");
    expect(started.authorizeUrl).not.toContain(player.publicKey);
    const state = new URL(started.authorizeUrl ?? "").searchParams.get("state") ?? "";
    expect(Buffer.from(state, "base64url").toString("utf8")).not.toContain(player.publicKey);
    const callback = await opened.handle(new Request(`http://127.0.0.1:8788/discord?code=code-1234&state=${encodeURIComponent(state)}`, {
      headers: {
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
    }));
    expect(callback.status).toBe(302);
    const replay = await opened.handle(new Request(`http://127.0.0.1:8788/discord?code=code-5678&state=${encodeURIComponent(state)}`, {
      headers: {
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
    }));
    expect(replay.status).toBe(400);
    expect(await replay.text()).toMatch(/already used/);
    const fetchCallback = await opened.handle(new Request(`http://127.0.0.1:8788/discord?code=code-9999&state=${encodeURIComponent(state)}`, {
      headers: {
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
      },
    }));
    expect(fetchCallback.status).toBe(403);
    const crossHome = await opened.handle(new Request("http://127.0.0.1:8788/", {
      headers: {
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
    }));
    expect(crossHome.status).toBe(403);
    const session = new URL(callback.headers.get("location") ?? "", "http://127.0.0.1:8788").searchParams.get("session");
    const messages = await opened.handle(new Request("http://127.0.0.1:8788/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({ session }),
    }));
    const drafts = (await messages.json()) as {
      wallet: string;
      claim: { message: { utf8: string } };
      attestation: { message: { utf8: string } };
    };
    expect(messages.status).toBe(200);
    expect(JSON.stringify(drafts)).not.toContain(DISCORD_ACCOUNT);
    expect(JSON.stringify(drafts)).not.toContain("test-secret-value");
    expect(JSON.stringify(drafts)).not.toContain("token-value");
    const finished = await opened.handle(new Request("http://127.0.0.1:8788/finish", {
      method: "POST",
      headers,
      body: JSON.stringify({
        session,
        claimSignature: signUtf8(player.secret, drafts.claim.message.utf8),
        attestationSignature: signUtf8(player.secret, drafts.attestation.message.utf8),
      }),
    }));
    const result = (await finished.json()) as { published: boolean; profile: string; files: string[]; note: string };
    expect(finished.status).toBe(200);
    expect(result.published).toBe(false);
    expect(result.profile).toBe("match");
    expect(result.files).toContain("claim.signed.json");
    expect(JSON.stringify(result)).not.toContain(DISCORD_ACCOUNT);
    expect(JSON.stringify(result)).not.toContain("test-secret-value");
    expect(seen.some((url) => url.includes("oauth2/token"))).toBe(true);
    const cross = await opened.handle(new Request("http://127.0.0.1:8788/finish", {
      method: "POST",
      headers: {
        ...headers,
        origin: "https://example.com",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
      },
      body: JSON.stringify({ session, claimSignature: "x", attestationSignature: "y" }),
    }));
    expect(cross.status).toBe(403);

    const blocked = createPlayerExchange({
      env: {
        DISCORD_CLIENT_ID: "123456789012345678",
        DISCORD_CLIENT_SECRET: "test-secret-value",
        DISCORD_REDIRECT_URI: "https://example.com/discord",
      },
      outDir: out,
      profile: { async walletIsProfileKey() { return "match"; } },
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toMatch(/127\.0\.0\.1/);
    const disabled = await runPlayerFlowCli(["exchange", "--out", out], { env: {} });
    expect(disabled.code).toBe(1);
    expect(disabled.stderr).toMatch(/disabled/);
    expect(readdirSync(out)).toEqual(["attest.signed.json", "claim.signed.json", "proof.json"]);
  });

  it("does not write files when the profile does not match", async () => {
    const player = signer();
    const profile = signer();
    const out = mkdtempSync(path.join(tmpdir(), "player-mismatch-"));
    const fields = playerFields(player.publicKey, profile.publicKey);
    const proof = discordProofFor(player.publicKey);
    const claim = buildPlayerClaimDraft(fields);
    const attestation = buildPlayerAttestationDraft({
      proof,
      hub: fields.hub,
      issuedAt: fields.createdAt,
      expiresAt: fields.expiresAt,
      prev: hubUpdateHash(claim!.payload),
    });
    const proofPath = path.join(out, "incoming-proof.json");
    writeFileSync(proofPath, JSON.stringify(proof));
    const result = await runPlayerFlowCli(
      [
        "pack",
        "--wallet",
        player.publicKey,
        "--hub",
        fields.hub,
        "--listing-id",
        fields.listingId,
        "--profile",
        profile.publicKey,
        "--nonce",
        fields.nonce,
        "--expires",
        fields.expiresAt,
        "--created-at",
        fields.createdAt,
        "--claim-signature",
        signUtf8(player.secret, claim!.message.utf8),
        "--attest-signature",
        signUtf8(player.secret, attestation!.message.utf8),
        "--proof-file",
        proofPath,
        "--out",
        path.join(out, "ready"),
      ],
      { profile: { async walletIsProfileKey() { return "mismatch"; } } },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Nothing was written/);
    expect(readdirSync(out)).toEqual(["incoming-proof.json"]);
    const prepare = runPlayerFlowCli([
      "prepare",
      "--wallet",
      player.publicKey,
      "--hub",
      "https://github.com/Owner/Repo.git",
      "--listing-id",
      fields.listingId,
      "--profile",
      profile.publicKey,
      "--nonce",
      fields.nonce,
      "--expires",
      fields.expiresAt,
      "--created-at",
      fields.createdAt,
    ]);
    const prepared = await prepare;
    expect(prepared.code).toBe(0);
    const drafted = JSON.parse(prepared.stdout) as { message: { utf8: string } };
    expect(drafted.message.utf8).toBe(buildPlayerClaimDraft({ ...fields, hub: "https://github.com/Owner/Repo.git" })?.message.utf8);
    expect(prepared.stderr).toMatch(/Nothing was published/);
  });
});

