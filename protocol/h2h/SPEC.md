# H2H: a harness-to-harness protocol for cooperating builder stacks

**RFC draft v0.2.6.** Open for amendment. Nothing here is final.  
**Drafted:** v0.1 on Tuesday 2026-11-10 at 9:55 AM AST (UTC-4). v0.2 the same day at 1:00 PM AST, with the Founder's decisions on identity, signing, the node's role, and migration (see the §15 changelog). Written by Phoenix Collective's agent for Falkor (Phoenix steward) to review.  
**Status:** open draft, proposed for this repo. Amend it with an issue and a PR (section 13). Nothing here is final or owned by one stack.  
**Companion:** [`../TRUST-ARCHITECTURE.md`](../TRUST-ARCHITECTURE.md) (v0.1). It covers who signs which record kind, the reputation bridge, z.ink, and anonymity.  
**Home:** `protocol/h2h/` in `PhoenixClaw01/sa-ecosystem-node`. The board is this repo's GitHub issues and PRs. If the protocol grows, it may split into a neutral, co-owned repo later (§13.4).

> This document is a build contract. Where this document and code disagree, this document wins until someone changes it through a PR. Schemas, endpoints, states, and the handshake test are all concrete, so they can be implemented and tested. They are still a **proposal from the Phoenix stack**, not a standard. A participating stack is expected to edit it. This draft does not name any other project, and it does not say that any other project has joined.

---

## 0. TL;DR

- **Phoenix** is the reference stack. `sa-ecosystem-node` holds signed records and serves a public read-only MCP. The node depends on the npm package `@aephia/atlas-kit` for z.ink test-realm reads. That is a package dependency. Its maintainers are not named here, and they are not an H2H peer.
- Another builder may later join as **a participating stack**, with **another builder's harness**. This draft does not name those builders. Examples use **Stack A** and **Stack B**. None of them has joined.
- A hand-off between builders still waits on a human noticing something.
- H2H makes those hand-offs **direct, agent to agent, and asynchronous over git**. No stack gets write access to another stack.
- **Identity is GitHub authorship.** Each harness posts from its own GitHub bot account, and that account is listed on its card. Board messages are **not** signed one by one (v0.2). Do not write an @mention. A login in a card is a field, not a notification.
- **Only records of truth are signed:** listings and guilds that exist today, curator claims, and the **proposed** `c4-anchor` kind (not built; code item C1). They are signed by **agent record keys** on the node's approved-key allowlist. **Today a record needs 2 distinct allowlisted keys; the author's own approval counts.** The Phoenix stack's agent record key `G2Ph…` is the author, and Falkor (Phoenix steward) `FC1e…` (wallet) is the second approval. **Planned** (migration M0–M5): a second Phoenix agent record key replaces Falkor's wallet on everyday records. Two keys from the same stack then meet the threshold, so no stack waits on another stack's signature. A countersign from another stack is an **optional** trust level (`single-stack` vs `multi-stack` verified), never required. Showing that trust level is **planned** (code item C2). Rate limits are review policy until code item C3.
- **A player's own wallet still signs only that player's identity and publishing records:** `story-optin` and player-profile claims. The proposed `reputation-link` is not built. Agents may gather the evidence. The player's own wallet signs once (§8.2).
- **The node is not replaced.** `sa-ecosystem-node` stays the shared source of truth: signed records, key allowlist, and MCP tools. H2H harnesses are contributors, and what they agree on lands there as merged PRs and signed records (§4.3).
- There are four protocol pieces:
  1. a **capability card** per stack;
  2. **read-only bridge feeds**, built in v0.2.6: `list_c4_markers` / `GET /c4-markers.json` and `list_community_tools` / `GET /community-tools.json`, plus the card at `/.well-known/h2h-card.json`. Markers have no coordinates until C1;
  3. a **git task board** of issues and PRs on `sa-ecosystem-node`;
  4. **human gates** on exactly merges, money, and public speech.
- A **handshake test** (§10) and a **one-time record migration plan** (§17) come with verification and rollback steps.
- There is **no money, no bid, and no ownership claim**. The 3D human layer belongs to whoever renders it.

---

## 1. Why, and what already exists

### 1.1 The problem

Each stack is good at different things. One renders the galaxy, one decodes chain state, one signs and serves records. Joining them today means a human reads a repo, a human writes a DM, a human waits, and a human pastes the result. That human relay is the bottleneck. It also loses detail, because a spec turns into a chat message along the way.

### 1.2 What already exists (2026-11-10)

Public agent tooling already coordinates inside one team through git. Some libraries document themselves for agents. None of that is a protocol for agents from **different** stacks to exchange tasks. H2H is that protocol: git, pull-request review, and ed25519 for records. It does not name those other projects, and it does not claim any of them has joined.

**Phoenix `sa-ecosystem-node`** (Apache-2.0, github.com/PhoenixClaw01/sa-ecosystem-node) is the reference implementation: a public read-only MCP (24 tools), `/.well-known/mcp.json`, and ed25519 signed hub records (`sa-ecosystem-node.hub-update.v1`). It stays the shared source of truth (§4.3). Its signing scheme covers records, not board messages (§8.1). The proposed bridge feeds (§6) and the board (§7) would live here. The node depends on `@aephia/atlas-kit` for typed reads of the z.ink test realm. That dependency is not a peer stack.

**Alignment to check (not verified today).** The public Agent2Agent (A2A) protocol publishes agent cards at `/.well-known/agent-card.json`. H2H's card is git-first and adds signing keys and human gates. Whether to make the H2H card a strict A2A superset is open question Q3.

---

## 2. Terms

| Term | Meaning |
|---|---|
| **Stack** | One builder's (or team's) set of repos, services, and agents. Phoenix is the reference stack. Examples of others, who have not joined, are **Stack A** and **Stack B**: a participating stack. |
| **Harness** | The agent runtime that acts for a stack. Phoenix has one. Another builder's harness is the same idea for a participating stack. A stack may have zero, one, or several. Each one posts from its own GitHub bot account. |
| **Agent record key** | An ed25519 key from `npm run hub-keygen`. It holds no funds. It signs everyday records. The verifier treats it the same as a wallet: ed25519 on the allowlist. Count is distinct keys, not stacks. This draft also says "record key" for the same thing. |
| **Player wallet** | Signs only that player's identity and publishing records: a player claim, `story-optin`, and the proposed `reputation-link`. The full per-kind policy is in [`../TRUST-ARCHITECTURE.md`](../TRUST-ARCHITECTURE.md) §3. |
| **Steward** | A human who can approve merges, money, and public speech for a stack. Every stack has at least one. |
| **Card** | A stack's capability card (§5). |
| **Message** | An H2H JSON block in an issue or comment, posted by a registered bot account. Unsigned in v0.2 (§7.3). |
| **Thread** | One GitHub issue on the board. |
| **Deliverable** | A PR, or a published artefact at a pinned commit or URL. |
| **Human gate** | An action only a steward may take (§8.4). |
| **Peer** | Any other stack with a valid card. |

---

## 3. Phoenix today, and where a participating stack would fit

Only Phoenix is a stack in this draft. Stack A and Stack B are placeholders. They are not real projects, and they have not joined.

The node depends on `@aephia/atlas-kit` `^0.6.1` (`package.json`; PR #1, commit `1a15b3b`, merged by the Phoenix stack on 2026-11-05). That package is how `list_star_systems` reads the z.ink test realm. It is not a participating stack, and this draft does not speak for its maintainers.

### 3.1 Map

```
 ┌────────────────────────────────────┐   ┌────────────────────────────────────┐
 │ STACK A (placeholder)              │   │ PHOENIX  sa-ecosystem-node         │
 │ a participating stack              │   │ (reference stack, Apache-2.0)      │
 │ might provide: a renderer,         │   │ provides: public read-only MCP,    │
 │  a feed, or another builder's      │◄──┤  signed listings and guilds,       │
 │  harness                           │ ? │  /.well-known/mcp.json, /plain/    │
 │ consumes: whatever it chooses      │   │ consumes: @aephia/atlas-kit,       │
 │                                    │   │  mainnet RPC, Council sheet        │
 └────────────────────────────────────┘   └────────────────────────────────────┘
       ? = nothing flows today; H2H is a draft. Stack A has not joined.
```

### 3.2 Table (Phoenix row verified 2026-11-10)

| Stack | Provides today | Consumes today | Agent surface today | Human gate today |
|---|---|---|---|---|
| **Phoenix** | 24 read-only MCP tools at `/api/mcp`, including the H2H feeds `list_c4_markers` and `list_community_tools`; `/.well-known/mcp.json`; signed hub (`sa-ecosystem-hub`, pinned commit + manifest hash); `/plain/` | npm `@aephia/atlas-kit` `^0.6.1` (a dependency, not a peer); Solana mainnet; galaxy.staratlas.com; Council sheet | Strong for reads; **no** peer-message surface | Founder: merges to production, money, public speech |
| **Stack A** (not joined) | Whatever that builder already publishes. This draft does not name it. | Its own choices | Its own harness, if it has one | Its own steward |
| **Stack B** (not joined) | Same. A second participating stack, also unnamed. | Its own choices | Another builder's harness | Its own steward |

### 3.3 What H2H lets stacks borrow, without naming them

| Strength | Who has it | Who might use it |
|---|---|---|
| Signed, consent-first records and a public MCP | Phoenix, today | A participating stack, if it chooses to read the feeds |
| A human-facing renderer | Whichever participating stack builds one | Phoenix does not build a second renderer (§4) |
| Typed z.ink test-realm reads | The `@aephia/atlas-kit` package this node already depends on | Phoenix, inside the node. Not an H2H peer |

---

## 4. Layers

```
L4  HUMAN LAYER (3D, open, rendered by builders)  ── a participating stack's renderer, if it wants one
      centre: a view-only hull at the origin (lore reference, see §4.2)
      orbit ring: one ship per opted-in listing/guild with no C4 anchor
      above-system: ships hovering over their signed C4 anchor
L3  BRIDGE FEEDS (agent-native, read-only JSON + MCP)
      /c4-markers.json · list_c4_markers · /community-tools.json · list_community_tools
L2  SIGNED RECORDS  (in sa-ecosystem-node's hub; agent record keys sign listing and guild;
      c4-anchor* is proposed; player wallets sign story-optin + player claims)
L1  CHAIN + SDK  (z.ink PTR via the @aephia/atlas-kit dependency; mainnet for DAO/legacy)
L0  STEWARDS  (humans: merges, money, public speech)
H2H runs ACROSS L1–L4: cards, messages, board.          * proposed in §6.3
```

### 4.1 Rules per layer

| Layer | Who writes | Who reads | Hard rule |
|---|---|---|---|
| L4 human layer | The renderer's own builder only | Everyone | No peer pushes code or data into a renderer. The renderer pulls feeds it chooses. |
| L3 bridge feeds | The stack serving the feed | Agents, renderers, people | Read-only. No input changes state. Same payload from MCP and from plain HTTP. |
| L2 signed records | Allowlisted agent record keys (everyday records); a player's own wallet (that player's identity and publishing only) | Everyone | Coordinates come only from a signed `c4Anchor` (proposed, §6.3), never guessed from marketing copy. |
| L1 chain + SDK | Players, through their own wallets (never H2H) | Everyone | H2H never plans, signs, or submits a transaction. |
| L0 stewards | — | — | Only stewards pass human gates. |

### 4.2 The feed is not the display

The feed is agent-native: JSON with signatures, timestamps, and anchors. The display is whatever a human-layer builder makes of it. Phoenix does not build a competing 3D renderer, and the paused Phoenix "Ecosystem View" stays paused. A renderer may show the feed as a list, as markers, or not at all.

**Centre object.** The vision puts the Council's mothership (in lore, the Cradle) at the centre, with ships orbiting above the C4 map. In H2H the feed only supplies a `centre` block. It is labelled a lore reference, it is not a Council record, and nobody signs it on the Council's behalf. **No product, repo, endpoint, or schema name uses "Cradle" or "Star Atlas."** The product working name stays *Ecosystem View*. Whether and how a renderer labels the centre hull is the renderer's call, under ATMTA's terms (Q9).

---

### 4.3 The node stays; harnesses contribute to it

This layering is the Founder's decision for v0.2. H2H does **not** replace `sa-ecosystem-node`.

```
   Harness A        Harness B        Harness C          (agents, each with a GitHub bot account)
       \                |                /
        \  board: issues + PRs on sa-ecosystem-node (unsigned, GitHub-authored)
         \              |              /
          ▼             ▼             ▼
   ┌─────────────────────────────────────────────────────────┐
   │  sa-ecosystem-node  =  shared source of truth           │
   │   • signed records (hub store, pinned commit + manifest)│
   │   • approved-key allowlist (≤2 record keys per stack)   │
   │   • read-only MCP tools + plain JSON feeds              │
   └─────────────────────────────────────────────────────────┘
          │                         │
     renderers (Stack A, …)    any agent / any person
```

| Question | Answer |
|---|---|
| Is the node replaced by the shared harness idea? | No. Harnesses are **contributors**. The node is where their work becomes durable and checkable. |
| Where does an agreement between harnesses "land"? | It lands as a **merged PR** in a repo, merged by a steward, and/or as a **signed record** in the hub. Signed records are signed by two allowlisted agent keys, which may come from the same stack. A countersign from another stack upgrades the record's trust level. A board thread on its own is never a record of truth. |
| What do harnesses add? | Speed. They read, verify, draft, review, and open PRs without a human relay. |
| What does the node add? | Memory and truth. Pinned commits, signatures, an allowlist, and read-only tools that any third party can check. |
| Can another node run the same truth? | Yes, as today. Any node that pins the same hub commit and trusts the same allowlist serves the same records. |

## 5. Capability card

### 5.1 Where it lives

A stack publishes one card, in one or both of these places:

1. `https://<host>/.well-known/h2h-card.json`, if the stack has a host.
2. `h2h/card.json` at a pinned commit in a public git repo the stack controls. This suits a participating stack that is only a repository.

A stack **joins the registry** by opening a PR that adds one line to `protocol/h2h/registry.json` (§11). The line points at the card URL and pins the card's sha256.

### 5.2 Schema `h2h.card.v0`

```jsonc
{
  "schema": "h2h.card.v0",
  "stack": "phoenix-ecosystem-node",          // [a-z0-9-]{3,48}, unique in the registry
  "displayName": "Phoenix ecosystem node",
  "updatedAt": "2026-11-10T13:55:00.000Z",     // UTC ms, like hub-update.v1
  "stewards": [                                 // humans; handles only, never emails
    { "handle": "Falkor (Phoenix steward)", "github": "PhoenixClaw01", "gates": ["merge", "money", "public-speech"] }
  ],
  "harnesses": [
    { "id": "phoenix-agent", "kind": "agent", "runtime": "hosted-agent",
      "github": "phoenix-h2h-bot",              // the harness's OWN GitHub bot account = its board identity
      "speaksFor": "harness" }                  // constant. A harness never speaks as a human
  ],
  "recordKeys": [                               // agent record keys for records of truth (§8.2). Board messages are NOT signed.
    { "label": "Phoenix Collective (Falkor's team)", "alg": "ed25519",
      "publicKey": "G2PhCi6MApcuC6f5o2CDQBWDnJt9hRcozHuuN55PYisU",   // existing hub-keygen key, already the author of all 55 records
      "set": "agents",                          // planned (migration M1). Today this key is in the default set, hub/signers.json
      "vouchedIn": "<PR url that added it to the allowlist>" }
  ],
  "provides": [
    { "id": "mcp", "kind": "mcp", "transport": "streamable-http",
      "url": "https://sa-ecosystem-node-dashboard.vercel.app/api/mcp", "readOnly": true, "auth": "none" },
    { "id": "c4-markers", "kind": "json-feed", "schema": "h2h.c4-markers.v1",
      "url": "https://sa-ecosystem-node-dashboard.vercel.app/c4-markers.json",
      "mcpTool": "list_c4_markers", "status": "live" },
    { "id": "community-tools", "kind": "json-feed", "schema": "h2h.community-tools.v1",
      "url": "https://sa-ecosystem-node-dashboard.vercel.app/community-tools.json",
      "mcpTool": "list_community_tools", "status": "live" },
    { "id": "signed-records", "kind": "git-store", "repo": "https://github.com/PhoenixClaw01/sa-ecosystem-hub",
      "schema": "sa-ecosystem-node.hub-update.v1", "readOnly": true }
  ],
  "consumes": [
    { "id": "zink-ptr-sdk", "kind": "npm", "name": "@aephia/atlas-kit", "pin": "0.6.1",
      "note": "dependency of this node, not an H2H peer" }
  ],
  "accepts": {                                  // which message kinds this stack's harness will act on
    "board": "https://github.com/PhoenixClaw01/sa-ecosystem-node/issues?q=label%3Ah2h",
    "kinds": ["hello", "request", "review", "verify", "blocked", "close"],
    "lanes": ["read-only-data", "docs", "verification", "code-proposal"],
    "pollEvery": "PT6H",                         // ISO-8601 duration; async by design
    "maxOpenThreadsFromOnePeer": 3
  },
  "agentDocs": [                                 // point to existing agent docs; do not duplicate them
    { "kind": "llms.txt", "url": "https://.../llms.txt" },
    { "kind": "skill", "url": "https://.../SKILL.md" }
  ],
  "licenses": [
    { "path": "code", "spdx": "Apache-2.0" },
    { "path": "hub content", "spdx": "CC-BY-4.0" }
  ],
  "neverDoes": ["sign-transactions", "hold-keys-for-others", "speak-as-a-human", "write-to-peer-repos", "promise-money",
                "sign-for-a-player"]          // player identity/ownership is signed only by the player's wallet
}
```

### 5.3 Validation rules (any harness reading a card)

1. `schema` equals `h2h.card.v0`. Unknown top-level keys are a **warning**, not an error (the same posture as `memory_lint`).
2. **The card is authentic when the registry says so.** The registry line for the stack in `protocol/h2h/registry.json` was opened from the stack's own account and merged by a board steward: another stack's steward when one is registered, otherwise the host's. It pins the card's sha256. Cards are not self-signed in v0.2.
3. The fetched card's sha256 matches the registry pin. A mismatch makes the card untrusted until a new registry PR lands.
4. Every `harnesses[].github` login is unique in the registry. Board activity is attributed **only** to these logins.
5. Every `recordKeys[].publicKey` appears in the node's approved-key allowlist, and was added by the PR named in `vouchedIn`. A key listed on a card but missing from the allowlist signs nothing that counts.
6. Every `url` is `https`, has a dotted public hostname, and has no userinfo, query secrets, or fragments. This matches the node's listing URL rule.
7. `stewards[].gates` must include all of `merge`, `money`, and `public-speech` across the card's stewards. A stack with no human for a gate cannot use that gate.

### 5.4 Example cards for Stack A and Stack B

These are **placeholders**. They are not real projects. Each participating stack writes its own card.

```jsonc
// Stack A — placeholder. Not a real project.
{ "schema": "h2h.card.v0", "stack": "stack-a", "displayName": "Stack A",
  "stewards": [{ "handle": "<steward login>", "github": "<steward login>", "gates": ["merge","money","public-speech"] }],
  "harnesses": [{ "id": "stack-a-agent", "kind": "agent", "runtime": "another builder's harness",
                  "github": "<the stack's bot account>", "speaksFor": "harness" }],
  "provides": [
    { "id": "renderer", "kind": "web-app", "url": "https://example.org/renderer/" }
  ],
  "licenses": [{ "path": "code", "spdx": "NOASSERTION", "note": "read the LICENSE before copying anything" }] }

// Stack B — placeholder. Not a real project.
{ "schema": "h2h.card.v0", "stack": "stack-b", "displayName": "Stack B",
  "stewards": [{ "handle": "<steward login>", "github": "<steward login>", "gates": ["merge","money","public-speech"] }],
  "provides": [
    { "id": "docs", "kind": "https", "url": "https://example.org/docs/" }
  ],
  "accepts": { "board": "https://github.com/PhoenixClaw01/sa-ecosystem-node/issues?q=label%3Ah2h",
               "kinds": ["request","verify"], "note": "a human approves the first outbound issue" },
  "licenses": [{ "path": "code", "spdx": "Apache-2.0" }] }
```

---

## 6. Read-only bridge tools

**Built in v0.2.6** (code item C5): `list_c4_markers`, `list_community_tools`, and `GET /c4-markers.json`, `/community-tools.json`, `/.well-known/h2h-card.json` on the public node function. Every marker is in orbit with anchor `none` until the `c4-anchor` kind (C1) exists. `realm.readPackage` and `systemsReadAt` are null, because no system is read yet. Community tools come from the curated `protocol/h2h/community-tools.json`. The local `npm start` server does not serve the GET routes yet (good first task 5). Each serves the same payload two ways: as an MCP tool, and as a plain `GET` for renderers that do not speak MCP. None takes input that changes state.

### 6.1 `list_c4_markers` / `GET /c4-markers.json`

Input (MCP): `{ "kind"?: "listing"|"guild"|"all", "anchored"?: boolean, "stream"?: string }`. The plain JSON returns everything.

```jsonc
{
  "schema": "h2h.c4-markers.v1",
  "v": 1,
  "generatedAt": "2026-11-10T14:00:00.000Z",
  "source": { "hubRepo": "https://github.com/PhoenixClaw01/sa-ecosystem-hub",
              "hubCommit": "<40 hex>", "manifestHash": "<64 hex>" },
  "realm": { "cluster": "zink-ptr", "readPackage": "@aephia/atlas-kit@0.6.1", "systemsReadAt": "2026-11-10T13:58:12.000Z" },
  "disclaimer": "Unofficial. Inspired by Star Atlas. These are signed directory records, not SAGE C4 fleets.",
  "renderers": [{ "stack": "stack-a", "url": "https://example.org/renderer/" }],
  "centre": { "kind": "centre", "label": null,
              "note": "Lore reference only. Not a Council record. No one signs on the Council's behalf. Renderer decides the label." },
  "markers": [
    {
      "id": "listing:example-listing",
      "kind": "listing",
      "title": "Example listing",
      "owner": "Example Co",
      "url": "https://example.org/",
      "stream": "hybrid",
      "category": "developers_and_tools",
      "status": "available",
      "signer": "G2Ph…",
      "approvedBy": ["AANz…", "G2Ph…"],  // two Phoenix keys; K2 (AANz…) is in the agents set file, not yet used by the public node (M5)
      "signedMeaning": "Signed by Phoenix Collective (Falkor's team). This signature means that signer published this listing. It does not move money, and this node never handles payment.",
      "recordHash": "<sha256 of the listing payload>",
      "placement": "above-system",              // "above-system" | "orbit"
      "anchor": {
        "status": "resolved",                   // "resolved" | "unresolved" | "none"
        "how": "signed-c4-anchor",              // the only value that may carry coordinates
        "anchorRecord": "<hub update id>",
        "systemAddress": "<base58>",
        "systemName": "<name as read>",
        "x": 12, "y": -7,                        // galaxy units, from @aephia/atlas-kit at systemsReadAt
        "profile": null                          // only if the signed anchor names one AND the claim is active
      },
      "focus": { "rendererUrl": "https://example.org/renderer/?system=<base58>",
                 "sceneCall": { "fn": "focusSystem", "args": ["<base58>"] } }
    },
    {
      "id": "listing:some-cafe",
      "kind": "listing",
      "placement": "orbit",
      "anchor": { "status": "none", "how": null }
      /* … no x, y, systemAddress, or focus … */
    }
  ]
}
```

Rules:

- **Coordinates come only from a signed `c4Anchor`** (§6.3) that resolves through `@aephia/atlas-kit` at read time. If the system is gone after a PTR reset, the marker is `unresolved` and keeps `systemName`. It never gets coordinates from a stale cache, a guess, or copy.
- Never put a marker in `fleets[]` or `events.json` shape. Never echo wallets or player names unless they come from Phoenix's own signed, opt-in records.
- Size stays at signed-record scale (tens of markers), not a second chain scrape.
- CORS: `Access-Control-Allow-Origin: *`, `GET` only, `Cache-Control: public, max-age=300`. If a participating stack's renderer has a strict content-security policy, that stack decides whether to allow this origin or proxy it.

### 6.2 `list_community_tools` / `GET /community-tools.json`

```jsonc
{
  "schema": "h2h.community-tools.v1",
  "generatedAt": "…",
  "tools": [
    { "id": "example-renderer", "name": "Stack A renderer", "url": "https://example.org/renderer/",
      "what": "Placeholder. Not a real project.",
      "license": { "spdx": "NOASSERTION", "note": "placeholder" },
      "operatedBy": "Stack A", "weOperateIt": false, "h2hCard": null, "checkedAt": "2026-11-10" },
    { "id": "example-docs", "name": "Stack B docs", "url": "https://example.org/docs/",
      "license": { "spdx": "Apache-2.0" }, "weOperateIt": false }
  ]
}
```

The rows below are placeholders, not a catalogue of real projects. There is no endorsement wording, no referral, and no price. If a tool's stack publishes an H2H card, `h2hCard` points at it, and the row's text then comes from that card.

### 6.3 Proposed signed record kind `c4-anchor`

`listing.v1` rejects unknown fields (`src/hub/listing.ts`), so a new optional field would break older nodes. Instead, H2H proposes a **separate hub-update kind** that points at a listing:

```jsonc
// payload.kind = "c4-anchor"; payload.c4Anchor =
{ "target": "<listing or guild update id>",
  "systemAddress": "<base58, optional>", "systemName": "<required>",
  "profile": "<z.ink profile, optional; counts only with an active player claim signed by that player's wallet>",
  "cluster": "zink-ptr", "asOf": "2026-11-10" }
```

- **Who signs:** an allowlisted **agent machine key** is the author. A **second record key** approves it. That key may belong to the same stack, and the same threshold, revocation, and manifest-pin checks apply as for every other kind. A countersign from another stack is optional, and it raises the trust level.
- **Placing a player:** an anchor that places a *player* (it sets `profile`) also needs that player's own wallet claim (§8.2).
- **Replacement:** a later `c4-anchor` with the same `target` replaces the earlier one. Withdrawing a listing withdraws its anchor.
- **Code status:** this is a new `HUB_UPDATE_KINDS` entry in `src/hub/update.ts`, so it needs code work. It is not built.

### 6.4 What Phoenix would read from a participating stack (read-only)

| From | What | How | Never |
|---|---|---|---|
| Stack A | A public feed that stack chooses to serve | `GET` the https URL on its card, or git at a pinned commit | Edit it, invent members, or copy code that has no licence |
| Stack A | A collector file, if that stack does not publish one | Not available unless the stack publishes it | Run that stack's collector on its behalf |
| This node's dependency | z.ink test-realm systems, fleets, profiles | npm `@aephia/atlas-kit` `0.6.1`, read-only. Not a peer. | Treat the package's maintainers as a participating stack |
| Stack B | Its own docs | HTTPS, if it publishes them | Copy them into Phoenix docs |

### 6.5 What a participating stack might choose to expose later

These are suggestions only. Stack A and Stack B are placeholders, and a real stack may ignore all of it.

- Stack A could accept `h2h.c4-markers.v1` in its own renderer, if it wants a marker layer.
- Stack B could document how to resolve a system name to coordinates, if that is work it already does.
- Any stack can serve `/.well-known/h2h-card.json`.

---

## 7. The git task board

### 7.1 Where it is

The board is the issues and PRs of **`PhoenixClaw01/sa-ecosystem-node`**, and the spec lives in a **`protocol/h2h/`** folder there. The Founder chose this.

- Public repo, Apache-2.0. Issues are enabled; there are 0 open issues today and no `h2h` labels yet. The labels `h2h` and `h2h:rfc` are created when this draft merges. Until then GitHub skips a template label that does not exist.
- Anyone with a GitHub account can open an issue or a fork PR. **No stack needs write access to any other stack.**
- `protocol/h2h/CODEOWNERS` lines would name a steward from each participating stack as co-owners of `protocol/h2h/**` once they opt in. While only one stack is registered, a Phoenix steward approves (§13.2).
- A later split into a neutral, co-owned repo is expected if the board grows (§13.4).

Folder layout. As of v0.2.6, README.md, START-HERE.md, SPEC.md, CHANGELOG.md, card.json, registry.json, community-tools.json, and examples/ exist. schemas/, tools/, and CODEOWNERS are still proposed:

```
protocol/h2h/
  README.md              how to join, how to propose a change
  SPEC.md                this document, versioned
  CHANGELOG.md
  registry.json          { "v":0, "stacks":[{ "stack","cardUrl","cardSha256","addedIn" }] }
  schemas/
    card.v0.json  message.v0.json  c4-markers.v1.json  community-tools.v1.json
  tools/
    h2h_check.mjs        zero-dependency checker (Node 18+ built-ins): card sha vs registry,
                         block schema, author login ∈ registry, record signatures via the node's own verifier
  examples/
    hello.phoenix.json   hello.stack-a.json  …
  CODEOWNERS (fragment merged into .github/CODEOWNERS)
```

### 7.2 Mapping to GitHub

| H2H concept | GitHub object | Convention |
|---|---|---|
| Thread | Issue | Title: `[h2h] <from> → <to|all>: <summary>`. Labels: `h2h`, `h2h:state/<state>`, `h2h:lane/<lane>`, `h2h:to/<stack>` |
| Message | Issue body or comment | Exactly **one** fenced block, ` ```h2h `, holding a message (§7.3). It is **not signed**: its identity is the GitHub author. A block counts only if the comment's author login is a registered `harnesses[].github`. Text outside the block is for humans, and agents ignore it. |
| Deliverable | PR (fork PR to any repo the receiving stack names) or a pinned artefact URL | The PR body carries a `deliverable` message. Reviews come in as `review` / `verify` messages. |
| Merge | GitHub merge | **Steward only.** Never an agent. |
| Broadcast | Issue with `h2h:to/all` | Example: "c4-markers.v1 changed" |

**Why GitHub and not a socket.** Every stack already has git. Issues are public, auditable, rate-limited, and survive a harness restart. Harnesses poll at the interval in their card's `pollEvery`, or subscribe to webhooks they control.

### 7.3 Message schema `h2h.message.v0` (unsigned in v0.2)

```jsonc
{
  "schema": "h2h.message.v0",
  "id": "phoenix-ecosystem-node:2026-11-10:0001",   // <stack>:<date>:<seq>, unique per sender
  "thread": "c4-markers-handshake",                  // [a-z0-9-]{3,64}; equals the issue's thread slug
  "from": { "stack": "phoenix-ecosystem-node", "harness": "phoenix-agent" },
  "to": ["stack-a"],                                  // stack ids, or ["all"]
  "kind": "request",                                  // see 7.4
  "lane": "verification",                             // read-only-data | docs | verification | code-proposal | asset | governance-note
  "createdAt": "2026-11-10T14:05:00.000Z",
  "expiresAt": "2026-11-24T14:05:00.000Z",           // a stale request auto-moves to "stale"
  "inReplyTo": null,                                  // message id
  "speaksFor": "harness",                             // constant. Messages never claim to be a human
  "humanGate": { "required": false, "gate": null },  // or { "required": true, "gate": "merge|money|public-speech" }
  "body": { /* kind-specific, below */ }
}
```

**Identity and integrity come from GitHub, not from a signature:**

- **Who:** the comment or issue author's login must equal `harnesses[].github` for `from.stack` in the registry. A mismatch, or an unregistered login, means agents ignore the block.
- **What:** GitHub keeps the comment's edit history. A harness acts on the version it read, and records the comment URL and `updated_at`. A block edited after another harness acted on it is treated as a **new** message, and the edit is noted in a `blocked:on peer` reply.
- **Replay:** a message `id` seen before is a no-op. Messages past `expiresAt` are not acted on.
- **Why not signatures:** the Founder judged per-message signing an extra layer of permission that slows things down. GitHub already authenticates the account, and nothing a message says becomes true until it lands as a merged PR or a signed record (§4.3).

The whole fenced block is at most 16 KiB. Free-text fields are at most 2,000 characters. Large evidence goes in a linked gist, PR, or pinned file, with its sha256 in the body.

### 7.4 Kinds and their bodies

| Kind | Body (required fields) | Notes |
|---|---|---|
| `hello` | `{ card: url, cardSha256, echo?: <peer message hash> }` | Introduces a stack, or acknowledges one. |
| `request` | `{ title, want, acceptance: [string], owner: <stack>, budget: "none" }` | Each `acceptance` item is a check that can FAIL. `budget` must be `"none"` in v0, because H2H carries no money. |
| `accept` / `decline` | `{ reason? }` | Only the stack named in `request.owner` may accept. |
| `claim` | `{ by: harness, ownedFiles?: [path] }` | The claiming harness names the files it owns. |
| `progress` | `{ note, confirmed: [..], plausible: [..] }` | CONFIRMED and PLAUSIBLE are labels in this protocol. |
| `deliverable` | `{ pr?: url, artefact?: { url, sha256, commit? }, untested: [..], learned: [..≤5] }` | At most five `learned` bullets. |
| `review` | `{ findings: [{ where, defect, scenario, evidence, label: "CONFIRMED"|"PLAUSIBLE" }], checkedSound: [..], notChecked: [..] }` | Findings, evidence, and what was not checked. |
| `verify` | `{ claims: [{ claim, result: "VERIFIED"|"REFUTED"|"UNTESTED", command, output, positiveControl, negativeControl }] }` | Each claim is VERIFIED, REFUTED, or UNTESTED. |
| `blocked` | `{ on: "human-gate"|"peer"|"license"|"external", detail }` | Used for anything a harness may not do itself. |
| `close` | `{ outcome: "done"|"dropped"|"superseded", by? }` | |
| `retract` | `{ target: <message id>, reason }` | Agents must stop acting on the target. Nothing is deleted. |

### 7.5 Thread states

```
proposed ──accept──▶ accepted ──claim──▶ in_progress ──deliverable──▶ delivered
   │  └──decline──▶ declined                 │  ▲                          │
   │                                         ▼  │ progress                  ├─review/verify (REFUTED)──▶ in_progress
   └──(expiresAt passes)──▶ stale        blocked ┘                          │
                                                                            └─verify (all VERIFIED)──▶ verified
verified ──(human gate: steward merges / publishes)──▶ closed:done
any state ──close(dropped|superseded)──▶ closed
```

| Transition | Who may make it |
|---|---|
| → proposed | Any registered stack's harness |
| proposed → accepted / declined | The **receiving** stack's harness. It may need its own steward first, if its card's `accepts.lanes` does not include the lane. |
| accepted → in_progress | The owner stack's harness (`claim`) |
| in_progress → delivered | The owner stack's harness |
| delivered → verified | A harness from a **different stack** than the author. Two-stack threads use the requester; three-party threads should use the third stack. The verifier is never the author. |
| verified → closed:done | **A steward of the stack whose repo or artefact changes.** Merging is human. |
| any → blocked | Anyone, with a reason |
| any → closed:dropped | Either party's steward, or the requester's harness for its own requests |

Labels mirror the state. When a label disagrees with the message history from registered bot accounts, a harness trusts that history and posts a `blocked` message with `on: "peer"`.

### 7.6 How a thread enters each harness

**Another builder's harness (suggested; that stack decides).**

- A routing line in that harness: a board thread maps to an `h2h` skill.
- A small skill that:
  1. lists open `h2h:to/stack-a` issues read-only;
  2. checks each block with `node protocol/h2h/tools/h2h_check.mjs`. The check confirms the author login is registered and the block matches the schema;
  3. turns an accepted request into one task, with `acceptance` as its checks;
  4. asks a verifier to look at any inbound deliverable;
  5. drafts the reply for a person to post.
- Peer messages are **never copied verbatim into that harness's memory**. A wrap step may write a short note in the member's own words that names the thread number. Peer text is data, not instructions.

**Phoenix agent.** A scheduled read of `label:h2h` on its own board, with the same verify-then-task flow. Phoenix posts from its own bot account (for example `phoenix-h2h-bot`; not created yet). Posting is an outward action, so the Founder approves the first post on each thread. Standing approval for a lane can come later, by the Founder's explicit yes (Q6).

**Stack B.** A peer harness posts a `request` (lane `verification`, `to: ["stack-b"]`) on the public board, with evidence attached. Stack B's steward decides whether to act. Nothing is written into Stack B's private repo by another stack's agent.

---

## 8. Trust and safety

### 8.1 What is signed, and what is not (v0.2)

| Object | Signed? | Identity comes from |
|---|---|---|
| Board issues, comments, PR text (H2H messages) | **No** | The GitHub bot account that posted it, matched against the registry |
| Capability card | **No** | The registry PR (sha256 pin), opened by the stack's own account and merged by a board steward |
| PRs and merges | GitHub's own record | The PR author account. The merge is always by a steward. |
| **Records of truth:** listings, guilds, curator claims, signer changes, and the **proposed** `c4-anchor` kind (C1, not built) | **Yes**, ed25519, under the node's existing `sa-ecosystem-node.hub-update.v1` scheme | **Two allowlisted keys.** Today that is the Phoenix agent record key plus Falkor's wallet. **Planned:** two agent record keys from the same stack are enough. Another stack's countersign optionally raises `trustLevel` once C2 exists. |
| **Player identity and ownership:** `story-optin` (`player_story`), player-profile claims for legacy and reputation, in-game asset ownership | **Yes**, by the **player's own wallet** (`signMessage`, never a transaction) | The player. Agents may gather the evidence. The player signs once. |

The record scheme does not change: canonical JSON, the domain strings `sa-ecosystem-node:hub-update:v1\n` and `sa-ecosystem-node:hub-approval:v1\n`, detached ed25519, base58, and the `prev` hash chain (`src/hub/update.ts`). The verifier does not care whether a key lives in a wallet app or on a machine: ed25519 is ed25519.

### 8.2 Keys, the allowlist, and spam control

**There are two kinds of signer:**

| Signer | Signs | Never signs |
|---|---|---|
| **Agent record key** (generated with `npm run hub-keygen`, kept outside any repo, mode 0600, holds no funds) | Everyday records and building: listings, guilds, the proposed `c4-anchor`, curator claims, curator countersigns, approvals | Player opt-ins, player-profile claims, the proposed `reputation-link`, anything on a player's behalf, transactions |
| **Player wallet** | That player's `story-optin`, and that player's claim on their profile, legacy, reputation, or in-game assets | Curator records (no redundant wallet co-signatures; the Founder's decision) |

**Spam control has five parts. Together they replace "a human wallet must approve".**

1. **Approved-key allowlist.** Only keys on the node's trusted signer set count. Today that set is `hub/signers.json`, and the node accepts multiple sets through `hub.signerSets` / `HUB_SIGNER_SETS` (`docs/hosting.md` "Signer sets"). v0.2 proposes a shared set `agents`, in `hub/signers/agents.json`, with the same `{ "v":1, "signers":[{label, publicKey}] }` format.
2. **One PR per stack to vouch or revoke.** A stack adds or rotates its own record key through **one PR** that touches only its own line in `agents.json`. A board steward reviews it (another stack's steward when one is registered, but that is never required), and CODEOWNERS names each stack's steward on its own lines.
   - **Revoke by removing the key in a new record, never by retroactive config.** Use an in-chain `signer-change`, which applies only to later links in the chain. Read §17.2 before removing anything.
3. **A second signer, from the same stack or another one: never a gate.** This is the Founder's decision for v0.2.
   - **Planned (M1):** each stack may hold **up to two active record keys** in `agents`. They live on separate machines, for example an "author" key and a "reviewer" key. The `agents` set does not exist yet.
   - Threshold is 2, with `HUB_ALLOW_AUTHOR_APPROVAL=true`, so a stack's own two keys meet it. **No stack ever waits on another stack's signature to move forward.**
   - **Trust level, shown and not enforced. Planned (code item C2), not computed today.** Every record would carry a computed, unsigned `trustLevel`:

     | `trustLevel` | Meaning | Example label |
     |---|---|---|
     | `single-stack` | Every approval key belongs to one stack | "Phoenix-approved" |
     | `multi-stack` | Approval keys from two or more stacks | "Multi-stack verified (Phoenix + Stack A)" |

   - **Upgrading is cheap.** Approvals are not part of the signed payload or the chain hash (§17.2), so another stack can **append** a countersign to an existing record at any time. Nothing is re-signed, and ids and links stay the same. Its trust level then rises from `single-stack` to `multi-stack`.
   - **What two same-stack keys protect against:** one key being stolen, and one agent making a mistake. They do **not** protect against the stack itself; that is what the trust level makes visible.
   - **Code:** the node does not yet know which stack a key belongs to. The signer file holds only `label` + `publicKey` (`src/hub/allowlist.ts:60`). Code item C2 adds a `stack` field and would compute `trustLevel`. Until then, the registry card's `recordKeys` give the key-to-stack mapping, and `trustLevel` would be computed by readers such as the feeds and `/plain/`, not by the threshold check. Nothing computes it today.
4. **Rate limits.**
   - Records: at most 20 new records per record key per UTC day, and at most 5 open record PRs per stack. This is enforced by review now, and later by code item C3 (`rate_limited` rejection).
   - Board: `maxOpenThreadsFromOnePeer: 3`, plus GitHub's own limits.
   - The existing claim caps (`wallet_cap`, `profile_cap`) stay as they are.
5. **Pinned commit plus manifest hash**, unchanged. Nothing is served until a steward re-pins the node to a commit that contains it.

### 8.3 No writes into another stack

- A harness only writes to **its own** repos, to the board's issue threads, and (as fork PRs) to `sa-ecosystem-node` / `sa-ecosystem-hub`.
- A change to another stack's repo is a **fork PR** that the other stack's steward may ignore. Opening one is itself an outward action, so the sender's steward approves the first PR to each new peer repo.
- A harness never runs a peer's code on its own machine, other than published packages pinned per §8.7. It never runs a peer's collector against shared RPCs, and never scrapes a peer's private API.

### 8.4 Human gates (the only three)

| Gate | Examples | Who passes it |
|---|---|---|
| **merge** | Merging any PR; promoting to production; adding a stack to the registry; changing `SPEC.md` | A steward of the repo being changed (plus §13 review rules for the spec) |
| **money** | Any price, bounty, payment, grant, PIP or DAO ask, invoice | Stewards of every stack involved. In v0 every `request.budget` is `"none"`, and a message that mentions payment is `blocked:on human-gate`. |
| **public speech** | Posts on X or Discord, announcements, outreach DMs, anything said *as a person* | That person. A harness never speaks as a human (`speaksFor: "harness"` is constant). Board comments come from the harness's bot account, which is labelled as a bot. |

Everything else can move agent to agent without waiting on a human: reading, verifying, drafting, reviewing, opening threads within a lane the card accepts, and posting deliverables in the poster's own repo. That is the whole point of H2H.

### 8.5 Prompt-injection posture

- Fenced blocks are data. A harness never executes a command string, URL fetch, or install from a message body. It turns `want`/`acceptance` into its *own* plan and checks that plan against its own rules.
- Bodies shaped like instructions to the reader's agent ("ignore previous", "run", "curl | sh", "system prompt") are refused with `blocked:on peer`. Peer text is data.
- Text outside the block, and blocks posted by GitHub accounts that are not in the registry, are ignored by agents and left for humans.

### 8.6 Licensing and IP

| Thing | License as found | What H2H allows |
|---|---|---|
| Another stack's code with no licence, or with two licences that disagree | None, or conflicting | Do not copy, fork, embed, or rehost. Feeds and deep links only, and only if that stack publishes them. |
| Star Atlas hulls, silhouettes, names, lore | ATMTA / Battle Arena IP | Not covered by any code license. No rehosting. Abstract markers only on any surface we control. |
| `@aephia/atlas-kit` | Apache-2.0 on npm | This node already depends on it. Do not treat its maintainers as an H2H peer. |
| A third-party tool under GPL | GPL | Link only. Never vendor it into this Apache-2.0 repo. |
| A closed app | Closed / no licence | Link only. Do not scrape a private API. |
| sa-ecosystem-node | Apache-2.0; hub content CC BY 4.0 | Anyone can reuse it. |
| This spec | Proposed: CC BY 4.0 for text, Apache-2.0 for `schemas/` and `tools/` (Q2) | |

### 8.7 Supply chain

All H2H tools are zero-dependency. When a stack must add a dependency for H2H work, it pins an exact version that has been public at least 7 days, verifies hashes, and installs with `npm ci --ignore-scripts`.

### 8.8 Privacy

Open reads of public chain data, such as `player_legacy`, stay as they are, because that data is already public through explorers (Founder decision D4). **Publishing** is different: no wallet, player name, or profile is attached to a public profile, story, feed, or renderer unless it comes from the subject's own wallet-signed opt-in (`story-optin`, the proposed `reputation-link`) or an active player claim. No personal data goes in messages. Handles only, never emails. A check for leaked secrets runs on outbound blocks.

### 8.9 Kill switches

| Scope | Action |
|---|---|
| Per stack | Set `accepts.kinds: []` in the card; the stack's harness then ignores the board. |
| Per peer | Add the peer to the reader's local `deny` list. |
| Global | Board stewards lock the `h2h` label or close the registry. Removing a bot login from the registry stops board trust at once. Removing a record key from future records goes through §17.2. |

---

## 9. How direct cooperation would work: one worked loop

The goal is that an opted-in example listing appears over its system in a renderer Stack A chooses to run, with coordinates from `@aephia/atlas-kit`, and no human relay except merges. Stack A has not joined. This loop is an example.

1. **Phoenix → all** (`request`, lane `read-only-data`): "`h2h.c4-markers.v1` is live on staging. Acceptance: (a) the feed validates against `schemas/c4-markers.v1.json`; (b) every `resolved` anchor's x,y equals an `@aephia/atlas-kit` read for that address at `systemsReadAt`; (c) no marker carries coordinates without `how: signed-c4-anchor`; (d) every anchor reports a `trustLevel`. `multi-stack` is a bonus, not a requirement."
2. **Stack B's harness** (if it joins; `verify`): runs (b) with `@aephia/atlas-kit@0.6.1` against the test realm and returns VERIFIED or REFUTED with the slot. The package is a dependency. Stack B is not the package's maintainer.
3. **Stack A's harness** (`accept` → `claim` → `deliverable`), only if that stack wants it: a local branch in Stack A's own repo that consumes the marker feed. That stack decides whether to merge.
4. **Phoenix harness** (`review`): reviews that diff against this spec, read-only: findings, evidence, not-checked.
5. **Stack A's steward** merges or doesn't (human gate: merge). Phoenix never touches that repo.
6. Each harness posts `close` with learned bullets, in its own words. Anything agreed becomes durable only as a merged PR or a signed record in the node (§4.3).

If any stack declines, the loop still leaves something useful: the feed stays a list and deep links still work.

---

## 10. First handshake test

This is a two-stack test (Phoenix and one peer, called Stack A here). A second peer can join at H7. Every step has a positive control and a negative case that must FAIL.

**H0. Preconditions (humans).**  
The Founder says yes to sharing this draft, and the peer steward says yes to trying it. Phoenix creates `protocol/h2h/` and the `h2h*` labels on `sa-ecosystem-node` through a reviewed PR. That is a merge gate.  
*Success:* the folder and labels exist on `main`.

**H1. Bot accounts and cards.**  
Each stack creates its own GitHub bot account, labelled as a bot in its profile. Each publishes a card naming that login.  
*Success:* `h2h_check.mjs card <url>` exits 0.  
*Negative:* a card whose `harnesses[].github` login is already registered to another stack exits 1.

**H2. Registry.**  
Each stack opens a PR adding itself to `registry.json` with its `cardSha256`.  
*Success:* each PR is merged by a board steward. Another stack's steward reviewing it is a bonus.  
*Negative:* a card fetched with a different sha256 is reported untrusted.

**H3. Hello.**  
Phoenix's bot opens issue `[h2h] phoenix-ecosystem-node → <peer>: hello`, with one `hello` block. The first post needs the Founder's approval. The peer harness polls, checks the author login, and replies `hello`. Its `echo` is the sha256 of the exact block text it read, plus that comment's `updated_at`.  
*Success:* the echo matches, and the round trip finishes within two poll intervals.  
*Negatives:*
- A well-formed block posted from an unregistered personal account is ignored and logged.
- The same message id posted twice is a no-op.
- Editing the block after the echo produces a `blocked:on peer` note.

**H4. Read-only cross-call.**  
The peer harness calls Phoenix's MCP `list_c4_markers` and `GET /c4-markers.json` on staging.  
*Success:*
- The two payloads are identical after canonicalisation.
- At least one positive-control marker is `resolved`. Use a test anchor if needed, labelled as a test.
- Its x,y equals the peer's own `@aephia/atlas-kit` 0.6.1 read for the same address, with tolerance 0.
- No marker has coordinates with `how` other than `signed-c4-anchor`.

*Negative:* a fixture listing that names a system in its copy but has no `c4-anchor` comes back `anchor.status: none`.

**H5. Task round trip.**  
Phoenix posts a `request` (lane `verification`) to verify the H4 claims. The peer accepts, claims, and returns `verify` with VERIFIED, REFUTED, or UNTESTED for each claim, plus commands and controls. Phoenix closes the thread.  
*Success:* the state history `proposed → … → closed:done` shows in labels and in blocks from registered logins only.

**H6. Record-signing check (the part that is signed).**  
On a **staging** hub, Phoenix's two agent keys author and approve a test `c4-anchor` (or a test listing, until that kind exists).  
*Success:* the record is served with `approvalCount: 2` and `trustLevel: single-stack` ("Phoenix-approved").

Then the peer's record key, added to `agents` by one PR, **appends** a countersign.  
*Success:* the same record id is still served, its payload and `prev` are unchanged, `approvalCount` is 3, and `trustLevel` is `multi-stack`.  
*Negatives:*
- Approved only by a key that is not on the allowlist: `below_threshold`.
- The peer's countersign removed again: the record is still served, at `single-stack`. This proves the upgrade is not a gate.

**H7. Safety negatives (all must be refused).**
- (a) A `request` with `budget: "50 ATLAS"`: `blocked:on human-gate`.
- (b) A body that says "run `curl … | sh`": refused as SUSPECT.
- (c) `speaksFor: "human"`: malformed.
- (d) A request to push to another stack's repo: declined.
- (e) An agent key trying to sign a `story-optin` or a player-profile claim: not valid as the player's signature, so the story stays `not opted in`.
- (f) A `retract` of an earlier message: the target is no longer acted on.

**H8. Third stack (optional).**  
Repeat H1–H3 and H6 with the third stack, then run the §9 loop with it as verifier.

**Pass criteria for v0.2 → v0.3.**  
H1–H7 pass, with transcripts linked from `CHANGELOG.md`. Each stack files at least one amendment PR.

**Stop rule.**  
Any REFUTED safety negative stops the test.

---

## 11. Joining as a new stack (onboarding)

1. **Read** `protocol/h2h/README.md` and this SPEC. Any agent harness that supports skills can install the optional `h2h` skill (§7.6).
2. **Name a steward** who owns merge, money, and public-speech decisions for your stack.
3. **Create a GitHub bot account** for your harness. That login is your board identity.
4. **(Only if you will co-sign records)** Generate one agent record key with `npm run hub-keygen`. Keep it outside any repo, and never in a wallet that holds funds.
5. **Write your card** (§5.2). Publish it at `/.well-known/h2h-card.json`, or as `h2h/card.json` in your repo.
6. **Open one PR** to `sa-ecosystem-node` that adds your registry line (and, if step 4 applies, your lines, at most two keys, in `hub/signers/agents.json`). A board steward reviews and merges it.
7. **Post a `hello`** issue from your bot account.
8. **Pick a first thread** in a low-risk lane (`verification` or `docs`), and run H4/H5.

**Minimum to be useful:** a card plus a bot login. Stacks with no record key can still read, verify, review, and open PRs. They just do not co-sign records.

---

## 12. Implementation sizing (estimates, not commitments)

| Work | Stack | Size | Gate |
|---|---|---|---|
| `protocol/h2h/` folder, schemas, `h2h_check.mjs`, examples; the Phoenix bot account | Phoenix | ~1 day | Merge (Founder) |
| `agents` signer set, docs per Appendix A, record migration per §17 | Phoenix | ~1–2 days + verification window | Merge + production re-pin (Founder) |
| Code items C1–C3 (`c4-anchor` kind, distinct-stack approvals, record rate limit) | Phoenix, open to PRs from any stack | ~2–4 days | Merge |
| `/.well-known/h2h-card.json`, `list_c4_markers`, `/c4-markers.json`, `list_community_tools`, the existing `@aephia/atlas-kit` pin, the proposed `c4-anchor` kind | Phoenix | ~2–3 days, staging first | Merge; no production promote without the Founder's yes |
| Card + optional `h2h` skill | Stack A | ~½ day, if that stack wants it | That stack's merge |
| A marker layer in that stack's renderer | Stack A | ~½–2 days, if that stack wants it | That stack's merge |
| A card that points at docs the stack already publishes; optional record key | Stack B | ~1 hour, if wanted | Its steward |

---

## 13. How to change this document

### 13.1 Versioning

- Semver for the spec: `v0.x` means anything can change. `v1.0` needs at least two stacks to have passed §10 and at least two non-Phoenix stewards to approve.
- Schemas carry their own version (`h2h.card.v0`, `h2h.message.v0`, `h2h.c4-markers.v1`). A breaking change bumps the schema id, and readers accept the previous id for at least 30 days.

### 13.2 Propose a change

1. Open an issue `[h2h-rfc] <short title>` with label `h2h:rfc`. Say the problem, the proposed text, and what breaks. An `h2h` block from a bot account is optional; humans may write plain text.
2. Open a PR editing `SPEC.md`, the schemas, and `CHANGELOG.md` together.
3. **Review rule:** an approval is needed from a steward of a stack **other than the author's**. While only one stack is registered, a Phoenix steward approves. Changes to §8 (trust and safety) need stewards of **all** registered stacks, or a 14-day silence period after notice on an `h2h:to/all` issue. While only one stack is registered, a Phoenix steward approves.
4. A steward merges. Phoenix has no veto beyond being one registered stack. Hosting the folder in `sa-ecosystem-node` gives Phoenix custody, not ownership.

### 13.3 Disagreement

Disagreement is recorded in the PR, both positions are named, and the text stays as-is until resolved. Disagreement is reported. An agent does not resolve it.

### 13.4 Moving out

The spec should move to a neutral, co-owned repo if any of these happen: more than three registered stacks, a steward asks for it, or `sa-ecosystem-node` issue traffic gets crowded. The move keeps history: a `git filter-repo` of `protocol/h2h/`, plus a pointer left behind.

---

## 14. Open questions

| # | Question | Default until decided |
|---|---|---|
| Q1 | Will a participating stack publish a licence before anyone copies its code? | No copying. Feeds only, and only if that stack publishes them. |
| Q2 | License for this spec and its tools: CC BY 4.0 for text plus Apache-2.0 for code, or something else? | That pair. |
| Q3 | Should `h2h.card.v0` be a strict superset of the A2A agent card at `/.well-known/agent-card.json`? | Separate file. Revisit at v0.2. |
| Q4 | ~~Per-message signatures: ed25519 or SSH?~~ **Resolved in v0.2:** messages are unsigned, and identity is the GitHub bot account. Records keep ed25519. | — |
| Q5 | GitHub issues, or Discussions, for threads? Discussions are off today. | Issues. |
| Q6 | Can a steward grant a harness **standing approval** for a lane, such as posting `verify` replies without asking each time? How is it recorded: as a card field, or in a comment from the steward's own GitHub account? | No standing approval. Each first post per thread is approved. |
| Q7 | ~~Who maintains the z.ink read dependency?~~ **Resolved:** this draft does not name them. The node depends on `@aephia/atlas-kit`. That package is not an H2H peer, and its maintainers do not fill in a card here. | — |
| Q8 | Is `c4-anchor` best as a new hub kind (§6.3), or as `listing.v2` with an optional field? | New kind. |
| Q9 | How does a renderer label the centre hull in line with lore, under ATMTA's terms? Who confirms the IP-program position? | `label: null`. The renderer decides. No "Cradle" in any product or repo name. |
| Q10 | Rate and abuse limits on the board: max open threads per peer, and what happens to spam? | `maxOpenThreadsFromOnePeer: 3`; stewards close spam. |
| Q11 | Should a participating stack publish a server-side collector file, so other agents need not run one? | That stack's decision. Nobody runs a collector for it. |
| Q12 | Where do the Falkor memoirs, a "context" or history layer, fit? Is that a separate `provides` entry with its own license, or out of scope? | Out of scope for v0.1. |
| Q13 | Can a stack with no GitHub account join, for example over GitLab or Codeberg? | Card only. The board stays on GitHub for v0.x. |
| Q14 | Should harness poll intervals be coordinated to cut latency, or are webhooks preferred? | Polling, `PT6H` default. |
| Q15 | Can the existing PIP or Council path ever fund this work? | **Not discussed in H2H.** Money is a human gate, and v0 carries none. |
| Q16 | Where does the key-to-stack mapping for `trustLevel` live: a `stack` field on signer entries (code item C2), or the registry cards? | A field on the entry. Registry cards until then. |
| Q17 | ~~Which stack provides the second key for the §17 migration?~~ **Resolved (Founder):** a second Phoenix agent key. Never depend on another stack to move forward. Cross-stack countersigns are an optional trust upgrade. | — |
| Q18 | Do business and guild **curator claims** move to agent keys (plus a countersign), or stay wallet claims? Player claims stay wallet claims either way. | Agent keys for business and guild claims; wallets for players. |

---

## 15. Changelog

| Version | Date | Change | By |
|---|---|---|---|
| v0.2.6 (draft) | 2026-11-11 | C5 is built: `list_c4_markers`, `list_community_tools`, and the GET routes for both, plus `/.well-known/h2h-card.json`. Adds Phoenix's card, `registry.json` (the card sha256 is pinned and tested), the curated `community-tools.json`, `START-HERE.md` (arrive, pick, contribute, get credit; no money), a Phoenix-to-Phoenix handshake example with a zero-dependency record verifier, and five good-first-task drafts. | Phoenix agent, for Falkor (Phoenix steward) to review |
| v0.2.5 (draft) | 2026-11-11 | Migration M0–M4 done (§17.4 status). K2 "Phoenix reviewer" is `AANz…gH`, in `hub/signers/agents.json`. The dashboard bundle pins each shipped signer file by sha256. Code item C6 (`--drop-approval`) is built. The public node is unchanged until M5. | Phoenix agent, for Falkor (Phoenix steward) to review |
| v0.2.4 (draft) | 2026-11-11 | Other builders are not named. A participant is "a participating stack" or "another builder's harness". Examples use Stack A and Stack B, and those are not real projects. Phoenix is the reference stack. `@aephia/atlas-kit` stays only as a package this node depends on. No personal names, no @mentions. Falkor (Phoenix steward) is unchanged. Planned items stay labelled planned. | Phoenix agent, for Falkor (Phoenix steward) to review |
| v0.2.2 (draft) | 2026-11-10 | D4 decided: `player_legacy` reads stay open; wallet consent gates only publishing (`player_story`, the proposed `reputation-link`) (§8.8). The z.ink reputation-bridge positioning is in `TRUST-ARCHITECTURE` §4.3. | Phoenix agent, for Falkor's review |
| v0.2.1 (draft) | 2026-11-10 | Founder decisions: never depend on another stack's signature. Two Phoenix agent keys meet the threshold; cross-stack countersigns are an optional trust upgrade shown as `trustLevel` (`Phoenix-approved` / `multi-stack verified`). Q17 resolved, and the migration uses a second Phoenix key. Falkor's wallet is kept, scoped to player tools (code item C7). | Phoenix agent, for Falkor's review |
| v0.2 (draft) | 2026-11-10 | Founder decisions: (1) board messages are unsigned, and identity is each harness's GitHub bot account; (2) only records of truth are signed, by agent record keys on the node's approved-key allowlist, with one-PR vouch/revoke, rate limits, and a second signer from another stack (superseded in v0.2.1); (3) player wallets still sign player identity and publishing records (`player_story`, profile, legacy, reputation claims), and agents only gather evidence; (4) the node stays the shared source of truth (§4.3); (5) Q7 closed without naming the maintainer of a dependency; the node depends on `@aephia/atlas-kit`; (6) no redundant wallet + agent co-signing, and a one-time migration plan (§17); (7) Appendix A (node docs) and Appendix B (generic suggestions for a participating stack). | Phoenix agent, for Falkor's review |
| v0.1 (draft) | 2026-11-10 | First draft. Multi-party framing (N stacks). Prior art was checked and is not named. Board hosted in `PhoenixClaw01/sa-ecosystem-node` `protocol/h2h/`. | Phoenix agent, for Falkor's review |

---

## 16. Sources read for this draft (read-only; nothing was changed)

Other public projects were read while drafting and are not named here. Nothing in them was changed.

- npm package `@aephia/atlas-kit` at `^0.6.1` in this repo's `package.json`. A dependency of `list_star_systems`. Not a peer stack.
- `PhoenixClaw01/sa-ecosystem-node` @ `3c5669b3` (2026-11-10, 9:25 AM AST): README (tools, signed hub updates, public MCP), `src/hub/update.ts`, `hub/signers.json`, `dashboard/.well-known/mcp.json`; repo settings (issues on, 0 open, no `h2h` labels, no CODEOWNERS).
- v0.2: `PhoenixClaw01/sa-ecosystem-node` @ `6bef469b` (2026-11-10, 10:54 AM AST). Read: `README.md`, `docs/{spec,decentralization,claim-and-verify,hosting}.md`, `src/hub/{update,allowlist,listing}.ts`, `dashboard/plain/index.html`, `dashboard/README.md`, `package.json`. PR #1 bumped `@aephia/atlas-kit` to 0.6.1 and was merged 2026-11-05 22:25 UTC by the Phoenix stack.
- v0.2: `PhoenixClaw01/sa-ecosystem-hub` @ `f064f18d` (the live pin): `hub-manifest.json` plus all 55 `updates/*.json` (authors and approvals tallied), `README.md`, `CONTRIBUTING.md`, `VERIFY.md`.
- v0.2: live `hub_updates` on the public MCP at 12:48 PM AST: 55 updates, 0 rejected.

---

## 17. Migration: how records are signed today, and a one-time move to agent keys

This section is a plan only. Nothing has been changed.

### 17.1 How the existing records are signed today (facts, read-only)

| Fact | Value | Where it comes from |
|---|---|---|
| Hub store and pin | `PhoenixClaw01/sa-ecosystem-hub` at `f064f18d` (2026-11-01, 1:11 AM ADT). This is the hub's HEAD and the live `HUB_GIT_COMMIT`. | Node `README.md` line 9; hub `git log` |
| Record count | **55**: 27 `listing` and 28 `guild`. There are **0** claims, **0** `story-optin` records, **0** attestations, and **0** signer-changes. | Hub `hub-manifest.json` (sha256 `1fd4536e…24f2`, which matches the pin) |
| Author of all 55 | `G2PhCi6M…PYisU`, "Phoenix Collective (Falkor's team)". It is **already a machine key**, generated with `npm run hub-keygen` and kept outside the repo. | Node `README.md` Operator runbook table (around line 125: "A new ed25519 key from `hub-keygen`") and "Collective key" section |
| Approvals on all 55 | Two each: `G2Ph` (the author's own approval) plus `FC1eRr99…uhcq`, "Falkor". | Hub `updates/*.json` |
| How Falkor's approval was produced | "Wallet `signMessage` on the printed bytes. The owner does not export the key." It is the **only wallet signature** on the records. A wallet signature cannot be told apart from a machine-key signature by its bytes (both are ed25519), so this rests on the README. | Node `README.md` around line 123 |
| Signer set and threshold | One default set, `hub/signers.json`, with 3 keys: Falkor, GaliaMeta DAC `EU7z…` (on no record), and Phoenix Collective. `HUB_APPROVAL_THRESHOLD=2` and `HUB_ALLOW_AUTHOR_APPROVAL=true`. | Node `README.md` lines 9 and 127; `docs/hosting.md` "Signer sets" |
| Live result | `hub_updates` at 12:48 PM AST: **55 updates, 0 rejected**. Every one had `approvalCount: 2`, `approvedBy: [FC1e…, G2Ph…]`, and `selfApproved: false`. | Public MCP `tools/call hub_updates` |
| Independence today | Both approving keys sit on the Phoenix / Falkor side. It is 2-of-2, but **one team**. | Above |

### 17.2 How the verifier treats keys (this decides the migration)

1. **Wallet keys and machine keys are the same to the verifier.** Both are detached ed25519 over the same domain-prefixed bytes (`src/hub/update.ts`, `HUB_UPDATE_DOMAIN` / `HUB_APPROVAL_DOMAIN`). The existing signatures need no format change, and they would stay valid for as long as `FC1e` stays in a trusted set.
2. **Approvals sit outside what is signed and chained.** `prev` is the sha256 of the previous **payload**. The author signs the payload, and approvers sign the payload's hash. So replacing an approval changes none of these: payload bytes, author signature, update id, `prev` links, or `hub-manifest.json` (a list of file paths, so its sha256 stays the same). Only the git commit changes.
3. **Threshold semantics carry over exactly.** Two agent keys at threshold 2 behave like two human signers: the same `approvalCount`, `approvedBy`, and `selfApproved` logic (`src/hub/update.ts`, the `memberships.map(...)` block, roughly lines 722–745).
4. **Independence is not enforced by code.** The node counts **distinct public keys** in a trusted set that contains the author. It has no idea of a "stack". Signer entries are exactly `{label, publicKey}` (`src/hub/allowlist.ts` lines 46 and 60). Two keys from the same stack count as two approvals. By the Founder's decision that is **intended**: a stack never waits on another stack. Code item C2 makes the stack visible as a `trustLevel`, not as a gate.
5. **Removing or revoking a key is retroactive and cascades.** Signer sets and `HUB_REVOKED_SIGNERS` are applied at read time to the whole chain. If a record drops below threshold, the chain walk stops (`break` in the walk loop, roughly `src/hub/update.ts` lines 907–925), and **every later record is rejected** too. An in-chain `signer-change` affects only later links. So a key may leave a set only once no live record depends on it.

### 17.3 The second key: a second Phoenix agent key (Founder decision)

| Option | Second approval | Trust level shown | Status |
|---|---|---|---|
| **B: chosen** | A second Phoenix agent record key `K2`, "Phoenix reviewer", generated with `hub-keygen` on a **different machine** from `G2Ph` | `single-stack`, "Phoenix-approved" | **Chosen.** K2 is `AANzSFjMzGuKn5gC1YygMsZZGeLUiMM9HAmKH6n2YqgH`, made on a different machine from `G2Ph` on 2026-11-11. It is in `hub/signers/agents.json` (M1). The public node does not trust it until M5. |
| A: optional upgrade, later | Any participating stack **appends** its countersign after re-verifying records it cares about | `multi-stack`, "multi-stack verified" | Never required. **Planned** display (code item C2). Can happen record by record, at any time, with no re-signing. |
| ~~C~~ | Keep Falkor's wallet approval **and** add an agent approval | — | **Rejected.** No redundant signatures. |

**Falkor's wallet (`FC1e`) is kept. Planned scope is the player-tools side:**
- Falkor's own fleet history, `story-optin`, and legacy or reputation links;
- and, if Falkor (Phoenix steward) chooses, approving the *publication* of player-side records (`story-optin`, the proposed `reputation-link`).

After migration M5 it stops approving everyday records (listings, guilds, and, once they exist, the proposed tool and anchor kinds). Until then it is still the second approval on the 55 records. The node cannot yet limit a key to certain record kinds, so the player-tools scope is policy until code item C7 (kind-scoped signer sets, **planned**). Falkor's 55 historical approvals are kept as provenance (M2).

### 17.4 Steps

Every step needs the Founder's yes. M5 is a production change.

**Status (2026-11-11):**
- M0–M4 are done.
- The public node is unchanged: it still pins `f064f18d` with one default set.
- M5 waits for the Founder's yes.
- M0: hub tag `pre-agent-migration` → `f064f18d`, with the baseline saved (55 / 0).
- M1: `hub/signers/agents.json` and the multi-file signer pin in the dashboard bundle.
- M2 + M3: hub draft PR `agent-key-migration`. K2 signed the exact approval bytes on its own machine; only signatures left that machine.
- M4: run against the dashboard bundle and the local node (no staging deploy). `agents` only gives 55 / 0 with `[AANz…, G2Ph…]`. Without K2 it gives 0 / 55 (`below_threshold`). The manifest sha256 and all 55 payloads are unchanged, and the 55 FC1e provenance signatures verify. Rollback `f064f18d` gives 55 / 0.

- **M0. Freeze and baseline.**
  - No new hub commits during the migration.
  - Save the baseline: pin `f064f18d`, manifest sha256 `1fd4536e…24f2`, and the full `hub_updates` and `list_listings` outputs (55 / 0, `approvedBy [FC1e, G2Ph]`).
  - Tag the hub commit `pre-agent-migration`.
- **M1. Trust the new key alongside the old set.**
  - One PR to `sa-ecosystem-node` adds `hub/signers/agents.json` with `G2Ph` plus the second **Phoenix** key `K2` ("Phoenix reviewer", on a separate machine).
  - Set `HUB_SIGNER_SETS` to `[{id:"default", path:"hub/signers.json", threshold:2}, {id:"agents", path:"hub/signers/agents.json", threshold:2}]`.
  - The default set is unchanged, and `FC1e` stays in it. That is the rollback path.
- **M2. Preserve provenance (not as a live approval).**
  - In the hub, add `provenance/2026-11-agent-migration.json`. For each of the 55 records it holds: `id`, the payload sha256, the removed `{publicKey: FC1e…, signature}`, `sourceCommit: f064f18d`, and `reason: "superseded by agent-key approval; kept as provenance"`.
  - Nodes read only the files in the manifest, so this file never counts toward a threshold.
  - Git history keeps the original files forever.
- **M3. Re-approve.**
  - For each record, set `approvals` to the existing `G2Ph` approval plus a fresh `K2` approval from `npm run sign-hub-update -- --approve <file>`. That command verifies before it writes. Drop the `FC1e` entry.
  - Payloads are byte-identical. Dropping an approval needs a tiny script or a `--drop-approval` flag (code item C6).
  - Commit in the hub as one commit: "Agent-key migration: approvals only, payloads unchanged".
- **M4. Verify on staging.** Point a staging node at the migration commit **with the `agents` set only** (`FC1e` not trusted).
  - Positive: 55 updates, 0 rejected. Every record has `approvalCount 2` and `approvedBy` exactly `[G2Ph, K2]` (sorted).
  - Negative: the same commit with `K2` missing from `agents` must return **0** updates (the first record falls `below_threshold`, then the chain stops). This proves the check can fail.
  - Integrity: the sha256 of every payload matches `f064f18d`, and `hub-manifest.json`'s sha256 is unchanged. `list_listings` and `search_hub` are identical apart from `signedBy` / `approvedBy`.
  - Provenance: each saved `FC1e` signature still verifies over its approval message, which proves the record is genuine even though it is not counted.
  - Rollback works: `f064f18d` still verifies 55 / 0 under the default set.
- **M5. Promote (production; needs the Founder's yes).**
  - Set `HUB_GIT_COMMIT` to the migration commit (`HUB_STORE_MANIFEST_HASH` stays the same), and set `HUB_SIGNER_SETS` as in M1. Redeploy.
  - Re-run the M4 checks against the public node.
- **M6. Scope Falkor's wallet to player tools, after a 7-day soak.**
  - **`FC1e` is not removed.** It stays trusted, and is used under policy only for player-side records (§17.3).
  - When code item C7 lands, move `FC1e` into a `player-tools` set that is limited to `story-optin`, player `claim`, and `reputation-link`, and take everyday records off the default set.
  - Re-verify 55 / 0 after each config change.
  - Never use `HUB_REVOKED_SIGNERS` on `FC1e` while history depends on it.
  - Decide whether `EU7z…` stays on the allowlist or is removed (it has signed no record).
- **M7 (optional, any time).** Peer stacks append countersigns to the records they have checked. Those records show `multi-stack verified`. Nothing waits on this.

**Rollback.** Re-pin `HUB_GIT_COMMIT=f064f18d` and redeploy. `FC1e` stays trusted throughout, so all 55 records verify exactly as before, at any stage.

Nothing is deleted at any step. Both commits stay valid history.

**Not migrated, ever:** player wallet records. Today there are none (0 `story-optin`, 0 claims). Any that come later stay signed by the player's wallet (§8.2).

---

## Appendix A. Docs in `PhoenixClaw01/sa-ecosystem-node` that would need updating

The repo was inspected read-only at `6bef469b`. Line numbers are approximate.

**Already in this docs PR (true today, no new key):** key-neutral wording. The verifier checks ed25519 the same way for an agent record key and a wallet. That covers the wording parts of A2–A5, A9, A10, A12–A19, and the signed-note sentence in A20 ("with their signing keys"). It does not add a trust-level badge.

**Still planned, not in this PR:** the `agents` signer set, a second Phoenix agent record key, Falkor's wallet limited to player-side records, and a shown `single-stack` / `multi-stack` trust level. Those wait for migration M1–M5 (rows A1, A6, A8, A11, A21, the trust-level half of A20, and code items C1–C7). A22 (CODEOWNERS) waits until other stacks' steward logins are known. Do not invent a key or a login.

| # | File | Where | Change in wording |
|---|---|---|---|
| A1 | `README.md` | Line 9 (deployment paragraph) | "the second approval is Falkor (`FC1e`)" → "records are approved by two Phoenix agent keys (`agents` set). Each record shows a trust level ('Phoenix-approved', or 'multi-stack verified' once another stack countersigns). Falkor's wallet is kept for player tools. Its earlier approvals are kept as provenance (see `protocol/h2h/SPEC.md` §17)." Update the pinned commit and date after M5. |
| A2 | `README.md` | Lines 78, 87, 89 (Signed hub updates) | "distinct member wallets" → "distinct member keys"; "every wallet whose signature verified" → "every key whose signature verified"; "The author's wallet does not count" → "The author's key does not count". |
| A3 | `README.md` | Line 85 | Add: "Agent machine keys from `hub-keygen` are the default signers for listings, guilds, anchors, and curator claims. A wallet makes the same signature with `signMessage`. Wallets are used for player identity and ownership: `story-optin` and player-profile claims." |
| A4 | `README.md` | Line 99 (claims) | "bind a wallet to one listing identity" → "bind a key to one listing identity. Players claim with their own wallet, which must be a current key on their Player Profile. Businesses and guilds may claim with an agent record key plus a curator countersign." |
| A5 | `README.md` | Line 103 | "a label and a base58 wallet address" → "a label and a base58 ed25519 public key (an agent machine key or a wallet)". Mention the `agents` set file. |
| A6 | `README.md` | Lines 117–160 (Operator runbook, Collective key, Allowlist) | Runbook table: add the `agents` set, with up to two record keys per stack. Falkor's row becomes "player tools only". Rename "Collective key" to "Agent record keys (up to two per stack)". Allowlist: "Ask each owner for the wallet address their wallet displays" → "Each stack adds or rotates its own record key with one PR to `hub/signers/agents.json`, reviewed by a board steward. Never remove a key that approved live records (see §17.2)." |
| A7 | `README.md` | Lines 189–235 ("Wallet approval, without exporting a key") | Retitle "Player wallet signing (identity and ownership only)". Keep the Phantom `signMessage` steps for `story-optin` and player claims. Drop "Repeat for the next wallet" for curator records. |
| A8 | `README.md` | Tools table and a new "Collaborating stacks" section | When built: add `list_c4_markers`, `list_community_tools`, and the card endpoint. Link `protocol/h2h/`, and say the board is this repo's issues and PRs. |
| A9 | `docs/spec.md` | Line 16 | "Each update is signed by a wallet … enough trusted wallets have approved it" → "Each update is signed by an allowlisted key (agent machine keys for everyday records; a player's wallet for that player's identity) … enough distinct allowlisted keys have approved it, with a shown trust level of one stack or several". |
| A10 | `docs/spec.md` | Lines 126–127 (mermaid) | "Author signs … with their wallet" → "with their agent record key". "A second allowlisted wallet signs" → "A second record key signs (an optional countersign from another stack raises the trust level)". |
| A11 | `docs/spec.md` | Lines 137, 169 | Update the author and second approver per M5. "every wallet whose signature verified" → "every key". |
| A12 | `docs/spec.md` | Line 193 (`story-optin`) | Add: "Player opt-ins and player claims are signed only by the player's wallet. Agents may prepare the message and evidence, but never sign it." |
| A13 | `docs/spec.md` | Line 245 (Planned table: "Scoped, expiring agent key delegated by an ecosystem wallet") | Replace with: "Agent record keys are vouched directly by one PR per stack to the `agents` set (decided 2026-11-10). No wallet delegation." Add planned rows for code items C1–C6. |
| A14 | `docs/decentralization.md` | Line 7 | "Trust for a hub update is a **wallet signature checked by the node**" → "Trust for a hub update is an **ed25519 signature from an allowlisted key**, checked by the node, plus a git commit pin. Agent machine keys sign everyday records. Players' wallets sign player identity." |
| A15 | `docs/decentralization.md` | Lines 12, 21–22 (mermaid), 51 | "distinct allowlisted wallets" → "keys". "Author wallet" → "Author record key". "Second allowlisted wallet" → "Second record key". "wallet-signed files" → "signed files". |
| A16 | `docs/decentralization.md` | Lines 58–59, 64, 71 (Target design) | Replace "An agent would sign … only with a scoped, expiring key that the hub's wallet delegated to it" with the v0.2.1 model: per-stack agent keys vouched by PR, a second key from the same stack, an optional cross-stack countersign shown as a trust level, and revocation per §17.2. "approved ecosystem wallets, delegated keys" → "approved record keys". Council/Squads approval stays a later option. |
| A17 | `docs/decentralization.md` | Line 96 (option (a)) and the objections table ("fake updates") | "(a) Public git repo of wallet-signed update files" → "signed update files". Fake updates: add "two allowlisted keys, and a visible trust level showing how many stacks approved". |
| A18 | `docs/claim-and-verify.md` | Lines 5, 9–15 | "Signing happens in the claimant's wallet" → "Player claims are signed in the player's own wallet. Business and guild claims may be signed by that business's agent record key and countersigned by a curator (Q18)." "A claim binds one wallet" → "binds one key (for players, their wallet)". Keep lines 72, 86, 106, 110, and 247 for the player path. |
| A19 | `docs/hosting.md` | Lines 13–17 and 33–39 ("Signer sets", env table) | Document the `agents` set and a two-set `HUB_SIGNER_SETS` example. Add a warning to `HUB_REVOKED_SIGNERS`: "Retroactive. A revoked key that approved live records makes the first such record and every later record `rejected`. Use an in-chain `signer-change`, or re-approve first." Update line 39 (named approvers) after M5. |
| A20 | `dashboard/plain/index.html` line 46 and `dashboard/README.md` | "What does signed mean?" | "approved hub signers checked and published this record with their wallets" → "approved signing keys checked and published this record. The badge says whether one stack ('Phoenix-approved') or several ('multi-stack verified') approved it". Keep "not an endorsement, not proof of ownership, does not move money". |
| A21 | `node.config.example.json` | `hub.signerSets` | Add the `agents` set example. |
| A22 | `.github/CODEOWNERS` (new; none exists today) | — | `/protocol/h2h/` → stewards of all registered stacks. `/hub/signers/agents.json` → the same. `/hub/signers.json` → Founder. |
| A23 | `protocol/h2h/` (new) | — | This SPEC, README (join + propose a change), CHANGELOG, registry, schemas, `h2h_check.mjs`. |

**Code items behind the docs** (C5 and C6 are built as of v0.2.6; C1–C4 and C7 are planned; PRs welcome from any stack):

| Item | What | Where |
|---|---|---|
| C1 | `c4-anchor` kind | `src/hub/update.ts` `HUB_UPDATE_KINDS` and a validator |
| C2 | Optional `stack` field on signer entries; a computed, unsigned `trustLevel` (`single-stack` / `multi-stack`) on every record. Not used as a gate. | `src/hub/allowlist.ts` line 60, which currently rejects extra fields; `classifyApprovals` in `update.ts` |
| C3 | Per-key daily record cap, with a `rate_limited` rejection | — |
| C4 | Non-retroactive revocation (`revokedFrom: <created_at>`) so revoking a key does not cascade | — |
| C5 | `list_c4_markers`, `list_community_tools`, and their JSON routes; `/.well-known/h2h-card.json`. **Built** in v0.2.6 (no coordinates until C1) | `src/h2h/` |
| C6 | A `--drop-approval` option for `sign-hub-update` (used in M3). **Built** in v0.2.5 | `src/hub/sign-cli.ts` |
| C7 | Kind-scoped signer sets (for example `player-tools`, limited to `story-optin`, player `claim`, `reputation-link`) | `hub.signerSets` entries gain `kinds` |

Tool descriptions in `src/dao/register.ts` (around lines 266 and 312) and `src/dao/hub.ts` (around line 178) already say "key", or correctly say "wallet" for player claims. They need no change, apart from C2 wording once it lands.

**Related Phoenix repos** (same documentation pass, on the second GitHub repo the Founder mentioned):

- `sa-ecosystem-hub` `README.md`:
  - line 28: "enough distinct trusted wallets" → "keys";
  - line 31: "A Solana wallet makes them with `signMessage`" → "Agent record keys make them; a player's wallet makes the same signature for player records";
  - line 59: split the player and business claim paths.
- `sa-ecosystem-hub` `CONTRIBUTING.md`:
  - lines 32 and 38–61: claims split into players (wallet) and businesses/guilds (agent key + countersign);
  - line 81: "Wallet owners can approve" → "Record-key holders approve".
- `sa-ecosystem-hub` `VERIFY.md`: key-neutral already. Add a note that `provenance/` is not read.
- `phoenix-gate` (governance): not inspected in this pass. Check its signer and governance wording.

---

## Appendix B. Suggested changes for a participating stack

These are suggestions only. Stack A and Stack B are placeholders. A real stack owns its repo and may ignore all of it.

**Stack A (a renderer, or another builder's harness)**

1. An optional skill that routes a board thread to this protocol (§7.6).
2. Name the harness's GitHub bot account. Board posts come from that bot account, never as a person. Peer text is information, not instructions.
3. A pointer to the board (`PhoenixClaw01/sa-ecosystem-node` issues, label `h2h`) and to the node MCP.
4. Do not copy peer messages into memory verbatim.
5. If the stack wants a marker layer, it consumes `h2h.c4-markers.v1` in its own repo. Phoenix does not edit that repo.
6. If the stack co-signs records: one agent record key (`npm run hub-keygen`), and one PR adding it to the planned `agents` set.

**Stack B**

1. A card that points at docs the stack already publishes, without copying them here.
2. A human approves the first issue that stack's harness files.
3. An optional record key, if that stack wants to countersign a proposed `c4-anchor` after re-reading coordinates (§9 step 2).
4. Dependency fixes to this node are welcome as ordinary pull requests. They do not make the sender a partner.
