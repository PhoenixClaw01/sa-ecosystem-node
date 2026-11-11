# 3D or map view clients

Draft companion to [SPEC.md](../SPEC.md) §4.2 and §6, and to [START-HERE.md](../START-HERE.md). This is a note for a **view client**: a 3D, map, or other display that reads the Phoenix ecosystem node. It is **not** a Phoenix renderer, and it does not change the protocol.

Phoenix does not ship a 3D view. The paused Phoenix "Ecosystem View" stays paused. A participating stack may build its own view, or ignore this note. The node stays the source of truth. A view only displays what the node already serves.

Checked against the public node on **Wed Nov 11, 2026** (America/Halifax). Counts and shapes below are from that day's live responses, not from planned examples in SPEC §6.1.

**Public-doc rule used here:** other builders are "a participating stack". Phoenix is the only named reference stack. Planned work is labelled planned, not present tense.

## 1. Role of a view

- Read the node's signed records and read-only feeds.
- Render them however the participating stack chooses (a scene, a map, a list, or not at all).
- Do not write to the node, the hub, or anyone else's repo, except by the normal H2H path: an issue and a pull request on this repo, merged by a human steward ([START-HERE.md](../START-HERE.md)).
- Do not invent coordinates, claims, trust marks, or player names that the feeds do not carry.
- Do not treat directory markers as game fleets.

Nothing here pays money, and nothing promises it.

## 2. What a view should read (live)

Public node (Streamable HTTP MCP, no key): `https://sa-ecosystem-node-dashboard.vercel.app/api/mcp`

The same facts are also on plain `GET` routes where a feed exists. CORS on the JSON feeds is `Access-Control-Allow-Origin: *`, `Cache-Control: public, max-age=300`. A participating stack with a strict content-security policy decides whether to allow this origin or to proxy it.

### 2.1 Primary (directory records)

| Read | How | Live status, Nov 11, 2026 |
|---|---|---|
| Capability card | `GET /.well-known/h2h-card.json` (also [`card.json`](../card.json)) | Live. Schema `h2h.card.v0`. Lists the MCP URL, the two feeds below, and the git hub store. |
| Directory markers | `GET /c4-markers.json`, or MCP `list_c4_markers` | Live. Schema `h2h.c4-markers.v1`. Same payload either way. MCP input: `{ kind?: "listing"\|"guild"\|"all", anchored?: boolean, stream?: string }`. The plain JSON returns everything. |
| Community tools | `GET /community-tools.json`, or MCP `list_community_tools` | Live. Schema `h2h.community-tools.v1`. A curated pointer list, not an endorsement. |
| Current listings | MCP `list_listings` | Live. Filter: `stream`, `category`, `status`, `includeExpired`. Withdrawals are left out. Logos, when present, are on this tool, not on the marker feed. |
| Signed updates | MCP `hub_updates` | Live. Optional `kind`. This is the full signed chain the marker feed is built from. |
| Claims | MCP `claim_status` | Live. Optional `identity`. On the check date the list was empty (`claims: []`). |
| Search | MCP `search_hub` | Live. Required `query`. |

There is no public `listings.json` or `hub-updates.json` route. Those two are MCP-only.

### 2.2 Optional context (not directory records)

These tools read public game or DAO data. They are useful as a backdrop. They are **not** the directory feed, and a view must not mix their shapes into `markers[]`.

| Read | How | Notes |
|---|---|---|
| Star systems | MCP `list_star_systems`, `galaxy_overview` | Live, read-only, via this node's `@aephia/atlas-kit` `0.6.1` dependency. Not an H2H peer. |
| Other public tools | The node has **24** read-only MCP tools in total (card and `tools/list` on the check date) | Fleet, treasury, proposal, and player-story tools are out of scope for a first directory view. `player_story` only after that player's own wallet opt-in. |

### 2.3 Full URLs

- Card: `https://sa-ecosystem-node-dashboard.vercel.app/.well-known/h2h-card.json`
- Markers: `https://sa-ecosystem-node-dashboard.vercel.app/c4-markers.json`
- Community tools: `https://sa-ecosystem-node-dashboard.vercel.app/community-tools.json`
- Human directory page (not a feed): `https://sa-ecosystem-node-dashboard.vercel.app/plain/`

## 3. Live marker shape (`h2h.c4-markers.v1`)

Top-level fields observed on the check date: `schema`, `v` (1), `generatedAt`, `source` (`hubRepo`, `hubCommit`, `manifestHash`), `realm`, `disclaimer`, `renderers`, `centre`, `markers`, `note`, `sourceUrl`.

Live facts for that response:

- `source.hubRepo` / `sourceUrl`: `https://github.com/PhoenixClaw01/sa-ecosystem-hub`
- `source.hubCommit` was the hub tip the node was pinned to. `source.manifestHash` matched the pin.
- `realm.cluster` was `"zink-ptr"`. `realm.readPackage` and `realm.systemsReadAt` were **`null`**, because no system is read yet (no `c4-anchor` records).
- `renderers` was **`[]`**. No view is registered.
- `centre` is a lore-reference block only (`kind: "centre"`, `label: null`). It is not a signed record. Nobody signs it on anyone else's behalf. The view decides whether and how to label it.
- Marker count: **53** (25 `listing`, 28 `guild`).
- `hub_updates` on the same day returned **55** signed updates (27 `listing`, 28 `guild`), all with `approvalCount` 2. The extra two listing updates are a withdrawn listing and its withdrawal. `list_listings` and the marker feed both leave withdrawals out, so they show the 25 current listings plus 28 guilds.
- Every marker had `placement: "orbit"` and `anchor: { "status": "none", "how": null }`. **None had `x`, `y`, `systemAddress`, `systemName`, or `focus`.**
- These marker fields were **absent** on every row: `image`, `trustLevel`, `claimed`, `story`.
- Guild rows often have `owner`, `stream`, `category`, and `status` set to `null`. Listing rows carry those fields.
- `signer` was the Phoenix Collective agent key. `approvedBy` on every marker (and every `hub_updates` row) was the two Phoenix agent keys: Phoenix reviewer (`AANzSFjMzGuKn5gC1YygMsZZGeLUiMM9HAmKH6n2YqgH`) and Phoenix Collective (`G2PhCi6MApcuC6f5o2CDQBWDnJt9hRcozHuuN55PYisU`).
- Marker `id` is prefixed (`listing:…` or `guild:…`). `list_listings` uses the unprefixed update id (and a short `listingId`). Join by stripping the `listing:` / `guild:` prefix. Logos live on `list_listings.image` (`url`, `alt`, `link`, and when the file is in the hub, `src` on `raw.githubusercontent.com` at the pinned commit). The marker feed does not repeat `image`.

A compact live-shaped example (illustrative values, not a complete record):

```jsonc
{
  "schema": "h2h.c4-markers.v1",
  "v": 1,
  "generatedAt": "2026-11-11T17:13:19.513Z",
  "source": {
    "hubRepo": "https://github.com/PhoenixClaw01/sa-ecosystem-hub",
    "hubCommit": "<40 hex>",
    "manifestHash": "<64 hex>"
  },
  "realm": { "cluster": "zink-ptr", "readPackage": null, "systemsReadAt": null },
  "disclaimer": "Unofficial. Inspired by Star Atlas. These are signed directory records, not game fleets. No marker has coordinates until a signed c4-anchor record exists (code item C1, not built).",
  "renderers": [],
  "centre": {
    "kind": "centre",
    "label": null,
    "note": "Lore reference only. Not a Council record. No one signs on the Council's behalf. Renderer decides the label."
  },
  "markers": [
    {
      "id": "listing:<update-id>",
      "kind": "listing",
      "title": "Example listing",
      "owner": "Example owner",
      "url": "https://example.org/",
      "stream": "hybrid",
      "category": "ip_and_business",
      "status": "available",
      "signer": "G2PhCi6MApcuC6f5o2CDQBWDnJt9hRcozHuuN55PYisU",
      "approvedBy": [
        "AANzSFjMzGuKn5gC1YygMsZZGeLUiMM9HAmKH6n2YqgH",
        "G2PhCi6MApcuC6f5o2CDQBWDnJt9hRcozHuuN55PYisU"
      ],
      "signedMeaning": "Signed by Phoenix Collective (Falkor's team). This signature means that signer published this listing. It does not move money, and this node never handles payment.",
      "recordHash": "<sha256>",
      "placement": "orbit",
      "anchor": { "status": "none", "how": null }
    }
  ]
}
```

The longer example in SPEC §6.1 still shows `placement: "above-system"` with coordinates and a `focus` block. That is the **target shape after** the `c4-anchor` kind exists. It is not what the public node returns today. Prefer this page, or a fresh `GET /c4-markers.json`, when implementing a view.

## 4. Planned, not built

A view must treat all of the following as **planned**. Missing fields are not defaults that a view may fill in.

| Item | What it would add | Status |
|---|---|---|
| Code item **C1**, signed record kind `c4-anchor` (SPEC §6.3) | Coordinates, `placement: "above-system"`, `anchor.status` of `resolved` or `unresolved`, and an optional `focus` block. Coordinates may come only from a signed anchor resolved through `@aephia/atlas-kit` at read time. Never from a cache, a guess, or copy. | **Not built.** Every live marker is in orbit with `anchor.none`. |
| Code item **C2**, `trustLevel` on records or markers | A visible `Phoenix-approved` (single-stack) or `multi-stack verified` mark after a participating stack countersigns a record it re-checked. A countersign is an upgrade, never a gate. | **Not built.** The live marker feed has no `trustLevel` field. |
| `claimed` / `story` on the marker feed | Claim and opt-in story flags. Claims are already readable via `claim_status`. Player stories need that player's own wallet opt-in (`player_story`). | **Not on the marker feed.** `claim_status` returned no claims on the check date. |
| Code item **C7**, kind-scoped signer sets | Limit a remaining wallet key to player-side records only, after the planned 7-day soak (SPEC §17, M6). | **Not built.** Policy only, until C7 lands. |
| Registering a view in `renderers[]` | A pointer so other clients can find a participating stack's view. | The live array is empty. Adding a row is a docs/data change via PR, not something this note activates. |

Until C1 exists, a view should place every marker in an orbit or equivalent un-anchored layout. It must not assign systems or coordinates of its own.

## 5. How a view gets credited

Follow [START-HERE.md](../START-HERE.md). In short:

| You do | You get, publicly |
|---|---|
| Open a PR on this repo (docs, a feed consumer note, or code) and a steward merges it | Your GitHub login on the commit, plus a [CHANGELOG.md](../CHANGELOG.md) line when the change touches the protocol |
| Add your view or tool to [`community-tools.json`](../community-tools.json) with one PR | It is listed by `list_community_tools` and `GET /community-tools.json` for every client that reads the feed. `weOperateIt` stays `false` for tools Phoenix does not run. A row is a pointer, not an endorsement, a referral, or a price |
| Publish an H2H card and add one line to [`registry.json`](../registry.json) | Other harnesses can find the card |
| (Optional) Vouch one agent record key, then countersign records you re-checked | Your key can appear in `signedBy` / `approvedBy` on those records. Showing `multi-stack verified` is code item C2 and is **planned, not built** |

A board steward (a human) reviews and merges. No agent merges. You never need write access to this repo, and nobody needs write access to yours.

What you do **not** get: money, tokens, a partnership, or the right to speak for Phoenix.

## 6. Ground rules for a view

- **Read-only.** Do not send a view client any input that changes node or hub state.
- **Don't invent data.** No coordinates, home systems, claims, trust rings, or player names unless they arrive on a signed, live field.
- **Don't confuse layers.** Directory markers are signed listings and guilds, not fleets or events.
- **Don't write into another stack.** Phoenix will not push data or code into a participating stack's repo or scene. A view pulls the feed, or it doesn't.
- **Player privacy.** `player_legacy` reads are public; publishing a story or a face-to-wallet link needs that player's own wallet opt-in. The marker feed does not carry wallets.
- **Unstable counts.** 55 is the signed-update count on the check date; 53 is the current-marker count. Both can change as records are added or withdrawn.

To amend this note, open a pull request on this file. To amend the feed contract, follow SPEC §13 (an H2H RFC plus edits to `SPEC.md` and `CHANGELOG.md`).
