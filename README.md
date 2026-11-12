# sa-ecosystem-node

A read-only ecosystem node inspired by Star Atlas. It is an MCP server anyone can run. It serves public game reads, a profile key audit, a labelled fixture overview, and read-only DAO treasury, proposal, revenue, and Ecosystem Fund tools.

This is not an ATMTA product, and the product name is not Star Atlas. It holds no funds, no game keys, and no Council keys. The server does not sign, and it does not write to any chain.

**Status:** public v1.0.0. Game reads use the z.ink test realm. Treasury, proposals, and player records use public mainnet data. Licensed under [Apache-2.0](LICENSE) ([NOTICE](NOTICE)). Hub listings, guild records, descriptions, and lore are CC BY 4.0, as the hub repository states. Each project keeps the rights to its own name and logo.

The public node is [https://sa-ecosystem-node-dashboard.vercel.app](https://sa-ecosystem-node-dashboard.vercel.app) (Vercel project `sa-ecosystem-node-dashboard`, separate from the DAO Council preview). `/` on that site is the DAO dashboard front page. It links the live MCP Playground (`/playground/`) and the listings page (`/plain/`). The public hub is [sa-ecosystem-hub](https://github.com/PhoenixClaw01/sa-ecosystem-hub). Governance notes are in [phoenix-gate](https://github.com/PhoenixClaw01/phoenix-gate).

This deployment uses threshold 2 with `HUB_ALLOW_AUTHOR_APPROVAL=true`. Today a record needs 2 distinct allowlisted keys; the author's own approval counts. The author is Phoenix Collective and the second approval is Falkor (`FC1e`). `HUB_GIT_REPO`, `HUB_GIT_COMMIT`, and `HUB_STORE_MANIFEST_HASH` are set. On 1 November 2026 the pinned commit was `f064f18db1da60c4f3e562d4064c8f344042e97e`.

- [Spec v1.0.0](docs/spec.md)
- [Hosting](docs/hosting.md)
- [Decentralization](docs/decentralization.md) (what is live, then the later design)
- [Claim and verify](docs/claim-and-verify.md)
- [Contributing](CONTRIBUTING.md) (5-minute quickstart, for people and agent harnesses)
- [Protocol drafts](protocol/) (H2H harness-to-harness board and trust architecture, open v0.x drafts anyone can amend)

## Quickstart

```bash
npm install && npm start
```

That compiles the server and starts a local Streamable HTTP node at [http://127.0.0.1:8787/mcp](http://127.0.0.1:8787/mcp). `GET /` returns a short read-only status document. No API key and no wallet are required.

The process is native ESM (`node dist/http.js`). The `@aephia/atlas-kit` package is ESM-only, and from 0.6.1 its exports map also carries a `default` condition, so a CommonJS caller on a Node.js release with require(esm) enabled by default (22.12 and newer, or 20.19 and newer) can `require()` it as well; an older runtime must `import` it.

Stdio, for a local MCP client that spawns the process:

```bash
npm run start:stdio
```

Public RPC URLs have safe defaults (`https://testnet-rpc.z.ink` for game data). Copy `node.config.example.json` to `node.config.json` to configure every run mode from one file. Environment variables override that file. Copy `.env.example` to `.env` only if you want those overrides. Do not put private keys in the file or the environment. `node.config.json` is gitignored.

## Tools

| Tool | What it does |
|---|---|
| `list_star_systems` | Star systems on the z.ink test realm via [`@aephia/atlas-kit`](https://www.npmjs.com/package/@aephia/atlas-kit) (`zink-ptr`) |
| `get_fleet` | One fleet by address, or the fleets owned by a profile |
| `profile_key_audit` | Keys on a profile: scope, expiry, decoded permissions, heuristic risk flags |
| `player_legacy` | Public mainnet record for a wallet or a player profile: profiles, creation date, faction enlistment, SAGE fleets still on the accounts, signature bands, and first and last activity. The read runs on the server |
| `player_story` | Opt-in plain-language story built from that public record. The wallet signs a fixed sentence, published as a `story-optin` hub update. Without a valid unrevoked opt-in the tool returns `not opted in` and does not tell the story. Each claim cites a chain source. The story text has no prices and no call to action |
| `dao_overview` | Treasury balances, a short proposal list, and data-health checks. A failed section is an error, not a fixture |
| `treasury_balances` | Live SOL, ATLAS, and USDC for the two wallets, plus a Squads v3 decode of the two published multisigs |
| `pip_tracker` | Payments and milestones from the public Council Tracker sheet |
| `galaxy_overview` | Star systems, starbases, and an activity summary from the z.ink read |
| `list_categories` | The v0 category ids. Approved members stay unknown |
| `hub_updates` | Signed updates from a public git repo pinned to a commit. The manifest hash is checked first. An allowlisted update needs enough distinct allowlisted approvals. Claim records and attestation records are left out. A listing or guild update signed by a claimant is included only when that claim is active. It does not change the signer set. An empty allowlist still rejects curator updates |
| `list_listings` | Signed business listings from that same pinned store. Filter by stream, category, or status. Expired listings stay hidden unless `includeExpired` is set, and those rows are marked expired. Each row names the signer and includes a plain `signedMeaning` line. An optional `image` is a public png, jpeg, or webp logo covered by the signature. The node does not take payment and does not upload images |
| `search_hub` | One text query over signed listings and guild listings (names, descriptions, tags) and the display name of a player who opted in. Players who did not opt in are left out. Nothing is uploaded |
| `list_c4_markers` | H2H feed `h2h.c4-markers.v1`: one marker per current signed listing and guild listing. Every marker is in orbit with no coordinates until a signed `c4-anchor` kind exists. Also `GET /c4-markers.json` |
| `list_community_tools` | H2H feed `h2h.community-tools.v1`: the curated list in `protocol/h2h/community-tools.json`. Add a tool with one PR. Also `GET /community-tools.json` |
| `claim_status` | Claim state for one listing identity, or for every claim in the pinned hub. Players need a matching player-profile key. Guilds and businesses need a curator countersign. X and Discord stay self-attested unless a trusted verifier attestation is current |
| `data_health` | Freshness and the last error for the cache, galaxy, the Council sheet, and a Solana balance read |
| `list_proposals` | Live GET of `https://galaxy.staratlas.com/proposals` |
| `get_proposal_votes` | Live GET of `/proposals/votes/{id}.json`. No ranked-choice winner is invented |
| `dao_revenue` | Live GET of `/dao/treasury`, grouped by source and mint |
| `dao_treasury_flows` | Monthly inflows and outflows from the local treasury cache |
| `dao_payments` | Payment ledger from that same cache |
| `treasury_history` | Balance over time from that same cache |
| `ecofund_limit` | PIP-23 Ecosystem Fund refill, 5% limit, and next-quarter figure |

`submit_hub_update` is a type only. It is not an MCP tool. `hub_updates` verifies detached ed25519 signatures and does not sign. On-chain approval anchors are not implemented.

`player_legacy` reads public mainnet accounts for one address and returns them. It does not write a story. Repeat lookups for the same address stay in memory for about a minute. A thin record stays a short sentence.

`player_story` reads that same card only after a valid opt-in. The player signs `I allow sa-ecosystem-node to tell my public Star Atlas story. Wallet: <address>. Date: <YYYY-MM-DD>. Hub: <id>. Links: yes.` or `I allow sa-ecosystem-node to tell my public Star Atlas story. Wallet: <address>. Date: <YYYY-MM-DD>. Hub: <id>. Links: no.` `<id>` is the normalized `HUB_GIT_REPO` URL, such as `https://github.com/owner/repo`: lowercase, https only, no userinfo, query, or fragment, no trailing slash, and no trailing `.git`. It is not the manifest file name. The same manifest name on two repositories is two hubs. A signature that names a different repository does not verify on this node. If `HUB_GIT_REPO` is unset or not a valid https URL, the tool returns `not available` and does not tell a story. `Links` is part of that sentence, so the publisher cannot choose it. An allowlisted hub signer publishes the signature as a `story-optin` update. A revoke sentence is `I revoke sa-ecosystem-node from telling my public Star Atlas story. Wallet: <address>. Date: <YYYY-MM-DD>. Hub: <id>.` An allow counts only when its signed date is strictly after the latest signed revoke date. The same calendar day goes to the revoke. Publishing an older allow after a newer revoke does not restore the story. The same player signature bytes seen again are a no-op, including a replay of an old allow after a revoke. A date after the current UTC date stays in the chain and does not count until that UTC date. The latest-dated allow wins when more than one allow is still in force. Hub signer, threshold, revocation, and manifest-pin checks are the same as every other kind. There is no opt-in database. Without a valid unrevoked opt-in the tool returns `not opted in` and one line on how to opt in. It does not return the legacy card in story form. Sentences are fixed templates plus counts and dates. Names from the chain are not copied in. Each claim cites a transaction signature or account from the card's `sources`. The story text leaves addresses and explorer links out. Those stay in `sources`. `Links: yes` adds explorer links in a separate `links` field. A relevant listing is returned in `listings`, not inside the story. One request reads the pinned store once. That checkout is cached for up to a minute, at most 8 pins, keyed by the commit, the manifest hash, and the manifest path. A thin record stays a short card. Stories stay in memory for up to 10 minutes, and that cache holds at most 32.

## Collaborating stacks (H2H)

Other builders' stacks and their agent harnesses can work with this node over git. The board is this repo's issues and PRs, labelled `h2h`. Start at [protocol/h2h/START-HERE.md](protocol/h2h/START-HERE.md). Phoenix's capability card is at `/.well-known/h2h-card.json`. The read-only feeds are `list_c4_markers` / `GET /c4-markers.json` and `list_community_tools` / `GET /community-tools.json`. No money moves through H2H.

## Signed hub updates

Schema `sa-ecosystem-node.hub-update.v1`. A document is `{ "payload", "signature", "approvals" }`. The payload fields are `v` (1), `id`, `created_at` (UTC with milliseconds), `author` (base58 Solana address), `kind` (`announcement`, `proposal-note`, `payment-note`, `status`, `signer-change`, `listing`, `guild`, `story-optin`, `claim`, `attestation`, or `reputation-link`), `body`, `refs` (`pip` and `txs`), and `prev`. A `signer-change` also has `change` (`op` of `add` or `remove`, `publicKey`, and `set`). A `listing` also has `listing`. A `guild` also has `guild`. A `story-optin` also has `storyOptIn`. A `reputation-link` also has `reputationLink`. `prev` is null on the first update. After that it is the sha256 hex of the previous payload's canonical JSON. `approvals` is a list of `{ "publicKey", "signature" }`.

Canonical JSON sorts keys and has no whitespace. The author signs the UTF-8 bytes of `sa-ecosystem-node:hub-update:v1\n` plus that canonical JSON. Each approver signs the UTF-8 bytes of `sa-ecosystem-node:hub-approval:v1\n` plus the sha256 hex of the same canonical JSON. Signatures are detached ed25519, stored as base58.

The server returns an update only when all of these hold:

- the author signature matches, and the author is on a signer set this node trusts
- at least that set's threshold of distinct member keys signed the approval message (default 1). A repeated key counts once. The author signature is not an approval
- the update links the single hash chain

At threshold 1 the author's own approval counts. A verified update has `selfApproved: true` when that author key is the only approver. That is allowed on the testnet dry run. `npm run hub-add-update` prints a warning in that case. At threshold 2 or higher the author's approval does not count toward the threshold unless `HUB_ALLOW_AUTHOR_APPROVAL` (or `hub.allowAuthorApproval`) is true. The default is false. A signer-change still never counts the author.

`HUB_REVOKED_SIGNERS` (or `hub.revokedSigners`) is a local list of signer public keys. It takes effect when the process loads config, without a new hub commit. The key can remain in `hub/signers.json`. An approval from a revoked key does not count. An update whose only valid approvals are from revoked keys is rejected as `revoked_signer`, which is distinct from `unknown_signer`. One non-revoked approval still is not enough when the threshold is 2. Revoking a whole signer group is not implemented.

An approval is a detached ed25519 signature over the approval message above. That is the same byte string a Solana wallet signs with `signMessage` (Phantom signs a `Uint8Array` and returns a 64-byte ed25519 signature). It is not a transaction, and it moves no funds. The node checks the signature against the public key on the allowlist. To the node, a wallet signature and an agent machine key signature (a key from `npm run hub-keygen`) are the same thing: detached ed25519 over the same bytes. The planned policy is agent keys for everyday records (listings, guilds, tools, anchors) and a player's own wallet for that player's identity and publishing (`story-optin`, `reputation-link`, player claims). `reputation-link` is built as a kind. Limiting a signer set to those kinds is still planned. See [protocol/TRUST-ARCHITECTURE.md](protocol/TRUST-ARCHITECTURE.md).

Each returned update includes `signedBy` and `approvedBy`. `signedBy` lists the author and every key whose signature verified, including an author who did not count as an approver. `approvedBy` lists only the keys whose approvals counted toward the threshold. At threshold 2 or higher the author's own approval is left out of `approvedBy` unless the node is configured to count it. A signer-change never counts the author.

A `signer-change` adds or removes one public key in the named set. It takes effect for later links in the chain only when the current members of that set approve it. The author's key does not count toward that threshold. The node ignores a set id it was not configured to trust. A change is rejected when the author adds their own key, when the key is already in the set or is already absent, or when a removal would leave fewer signers than the threshold.

A `listing` is a signed business listing. It uses the same author, threshold, revocation, and manifest-pin checks as the other kinds. The `listing` object fields are `stream` (`referral`, `hybrid`, `irl`, or `player`), `category` (one `list_categories` id), `title` (up to 160 characters), `owner` (a display name, up to 120 characters), `url` (the business's own `https` page or checkout, in canonical form, with a dotted public hostname; this node never handles money), optional `offerText`, optional `verifyLiveNote`, `status` (`available`, `sold_out`, `inquire_only`, `paused`, or `withdrawn`), `disclosure` (required when `stream` is `referral`; the longer text fields are up to 500 characters), `asOf` and `expiresAt` (`YYYY-MM-DD`, and `expiresAt` falls on `asOf` or at most 90 days later), optional `ownershipProof` (`method` of `wallet_signed`, `site_code`, or `signer_review`, plus `evidenceRef`), and optional `image`. Unknown fields are rejected. `body` stays the short plain note on the hub update. `list_listings` returns the listing fields, not that note. `image` is `{ url, alt, link? }`. `alt` is required when `image` is present (at most 140 characters). `url` is `https` and the path must end in `.png`, `.jpg`, `.jpeg`, or `.webp`, or it is a hub-relative path with that extension, such as `images/logo.png`. `data:`, `javascript:`, `http:`, and SVG are refused. `link` is an optional `https` page. The image object is inside the signed canonical payload. `list_listings` sets `image.src` only for a hub-relative logo, resolved to `https://raw.githubusercontent.com/<owner>/<repo>/<pinned commit>/<path>`. An external https logo does not get `src`. `src` is derived at read time and is not part of the signature. This node does not upload images and does not proxy them. Curators should commit logo files into the hub repository. The plain page loads only a hub-relative path, resolved to `raw.githubusercontent.com` at the pinned 40-character commit. Content-Security-Policy `img-src` is `'self' https://raw.githubusercontent.com`, and each loaded logo uses `referrerpolicy="no-referrer"`. An external https logo stays in the signed payload and in MCP output, and the page shows a text initial instead of requesting it. `status` `withdrawn` is a takedown. Optional `listingId` is the stable identity. Without it, the identity is stream, category, and the normalized title and owner. `list_listings`, `search_hub`, and the story context keep only the newest hub-chain update for that identity, and a newest `withdrawn` drops it until a later update publishes it again. Chain order follows `prev`, not `created_at`. The signed update stays on the hub. Any allowlisted signer who meets the threshold can replace or withdraw any listing or guild by identity. The displayed signer becomes whoever published the latest update. Set `listingId` on every new listing. A withdraw must repeat the same identity form: the same `listingId`, or, when `listingId` was never set, the same stream, category, and normalized title and owner. A guild withdraw must repeat the same normalized name. `hub-add-update` warns, and still writes, when a withdraw matches no current listing or guild, and when a listing omits `listingId`. `http:`, `data:`, and `blob:` stay blocked.

A `guild` listing is a separate hub update kind, because listings do not have a type enum of ecosystem, business, and hybrid. Those remain streams and categories on kind `listing`. The `guild` object fields are `name` (at most 80 characters), `description` (the short description, at most 280 characters), `links` (up to 8 `https` URLs), optional `tags` (1 to 8 short labels), optional `image` (the same object as on a listing), optional `site` (one `https` page), and optional `discord`. `discord` is only `https://discord.gg/<code>` or `https://discord.com/invite/<code>`, at most 80 characters. Any other host, a query, or a hash is rejected. The plain page shows `site` and `discord` as links with `rel="noopener noreferrer"`. Unknown fields are rejected. A member list, a wallet field, or a price in the name, description, tags, image alt, or body is rejected. An allowlisted curator signs it with the same threshold, revocation, and manifest-pin checks as the other kinds. Curators publish public links and logos only. `search_hub` shows the newest guild update for each name. There is no guild-claim signer, so a curator and any other signer follow that same latest-wins rule. `withdrawn: true` removes that name from search. A guild that is not withdrawn needs at least one of `site` or `links`. A `withdrawn: true` record may omit both. Search starts at most 6 player-name reads, caches a miss for about a minute, and does not queue the whole opt-in list on the legacy gate. A wallet-shaped token in a URL is rejected. A price word in a URL is not. Player name reads for search run in parallel under the existing legacy concurrency gate, wait about 5 seconds, and return what finished. `truncated` is true when an opted-in player was not checked. Names are cached and the next search rotates to wallets that were not read, so the same first few are not the only ones ever checked. Display names have control and bidi characters removed.

`search_hub` takes one `query` of at most 80 characters. It matches listing titles, owners, categories, streams, offer text, and the listing note, plus guild names, descriptions, and tags, plus the display name of a player with a current unrevoked story opt-in. A revoked or missing opt-in is not searched and is not returned. At most 6 opted-in names are read per query (`SEARCH_NAME_BATCH` in `src/hub/search.ts`), through the same public profile read as `player_legacy`. The query is not an address. When the hub pin is unset, the tool returns no rows and says the pin is not set.

A `story-optin` records one player's permission to tell a public story. It uses the same author, threshold, revocation, and manifest-pin checks as the other kinds. The `storyOptIn` fields are `action` (`allow` or `revoke`), `wallet` (the player's base58 address), `date` (`YYYY-MM-DD`), and `signature` (the player's detached ed25519 signature, base58). Unknown fields are rejected. The signature must match the wallet over one fixed sentence for this hub. Allow: `I allow sa-ecosystem-node to tell my public Star Atlas story. Wallet: <address>. Date: <YYYY-MM-DD>. Hub: <id>. Links: yes.` or `I allow sa-ecosystem-node to tell my public Star Atlas story. Wallet: <address>. Date: <YYYY-MM-DD>. Hub: <id>. Links: no.` Revoke: `I revoke sa-ecosystem-node from telling my public Star Atlas story. Wallet: <address>. Date: <YYYY-MM-DD>. Hub: <id>.` `<id>` is the normalized `HUB_GIT_REPO` URL, such as `https://github.com/owner/repo`. It is not the manifest file name. The hub id and the links choice are not fields the hub author sets. Each `story-optin` from `hub_updates` has `consent` of `valid` or `inert`. `valid` means the player signature matches this hub. It does not mean that sentence is the current opt-in. A signature for another repository, a bad player signature, or a pin that is not a valid https repository URL is `inert` and does not grant consent. The update stays in the chain, so later listings and signer updates are kept. A date after the current UTC date stays in the chain and does not count until that date. An allow whose date is on or before the latest revoke date does not restore consent. When more than one allow is in force, the latest signed date wins. `npm run hub-add-update -- --kind story-optin --story-optin <json> --hub-repo <url>` embeds that signature and checks it against that repository URL before it writes. When `--hub-repo` is omitted, the command uses the store's git origin URL. The node does not keep a second copy of the opt-in.

A `reputation-link` records one player's choice to show a wallet next to one public profile. It uses the same author, threshold, revocation, and manifest-pin checks as the other kinds. The `reputationLink` fields are `action` (`link` or `unlink`), `wallet` (the player's base58 address), `profile` (a public profile name or a profile address), `date` (`YYYY-MM-DD`), and `signature` (the player's detached ed25519 signature, base58). Unknown fields are rejected. The scope is not a field. The signature must match the wallet over one fixed sentence for this hub. Link: `I link wallet <address> to public profile <profile> on hub <id>. Scope: legacy. Date: <YYYY-MM-DD>.` `Scope` is `legacy`, `fleets`, `guild`, or `story`. `legacy` is the smallest, and a link does not grant any other scope. Unlink: `I unlink wallet <address> from public profile <profile> on hub <id>. Date: <YYYY-MM-DD>.` `<id>` is the normalized `HUB_GIT_REPO` URL, such as `https://github.com/owner/repo`. It is not the manifest file name. Each `reputation-link` from `hub_updates` has `consent` of `valid` or `inert`, and `linkShown`. `valid` means the player signature matches this hub. `linkShown` is true only when that scope is still on display. An unlink hides every scope for that wallet and profile from that date on, including a link dated the same day. The update stays in the chain. One counting link per wallet per UTC day. A second link that day does not add a scope. A date after the current UTC date does not count until that date. A signature for another repository is `inert`. `npm run hub-add-update -- --kind reputation-link --reputation-link <json> --hub-repo <url>` checks the player signature before it writes. This kind does not change which signer set the node trusts. The steps are in [docs/reputation-link.md](docs/reputation-link.md).

Claims and verifier attestations are a separate path. A player, guild, or business can bind one public key (for a player, their own wallet) to one listing identity and then maintain that identity without being added to `hub/signers.json`. `/plain/claim/` collects that player's signature and does not publish it. Discord identify stays on the operator machine. The human steps, the record formats, and the optional Discord verifier are in [docs/claim-and-verify.md](docs/claim-and-verify.md).

`list_listings` can filter by `stream`, `category`, and `status`. A listing whose `expiresAt` is before the current UTC date is left out unless the caller passes `includeExpired`. Those rows have `expired` set to true. A listing is still shown on its expiry date. Each row includes `signerDisplayName`, the author's label from the trusted signer file, and `signedMeaning`. The line is `Signed by <display name>. This signature means that signer published this listing. It does not move money, and this node never handles payment.` When the author key has no label, the line says `an allowlisted wallet`. `signedBy` and `approvedBy` are the same lists `hub_updates` returns.

An empty allowlist rejects every curator update. A self-signed claim or attestation can still sit in the chain. It does not add a signer. Each `hub/signers.json` entry is a label and a base58 ed25519 public key (an agent machine key or a wallet). `hub.signerSets` in `node.config.json` (or `HUB_SIGNER_SETS`) lists the sets this node trusts. `HUB_SIGNERS_PATH` is the single default set when that list is omitted. A signer who is not on a trusted set is left out. There is no "unknown" result.

The store is a separate public git repository. It holds signed update files and a manifest, and it holds no signing keys. Set all three of these, or set none:

- `HUB_GIT_REPO`: an `https://` URL of any public git host, with no username, password, query, or hash. An absolute local path is accepted for testing
- `HUB_GIT_COMMIT`: the full 40-character commit
- `HUB_STORE_MANIFEST_HASH`: the sha256 hex of the manifest file's bytes

Content integrity comes from the commit pin plus signatures. The manifest hash covers the file list.

A host with the `git` binary checks out that commit. A host without it, including the Vercel function, downloads a public `github.com` repository at that same commit over HTTPS. The archive root and the archive comment must both be that commit. Another git host still needs `git`. The URL still cannot contain a username, password, query, or hash.

`HUB_STORE_MANIFEST` is the path inside that commit. Unset, the node reads `hub-manifest.json`. `npm run hub-store-init` writes that file. When `hub-manifest.json` is missing and `HUB_STORE_MANIFEST` is unset, the node reads `manifest.json`. The manifest is `{ "v": 1, "updates": ["updates/one.json"] }`. The server checks out that commit and refuses the whole read if `HEAD` is not `HUB_GIT_COMMIT` or the sha256 of the manifest file it read is not `HUB_STORE_MANIFEST_HASH`. A file that is present with the wrong hash is refused, and the other filename is not tried. Setting `HUB_STORE_MANIFEST` selects that path and does not try the other name. `node.config.example.json` sets `storeManifest` to `hub-manifest.json`, which is that same selection. Remove the field to allow the `manifest.json` fallback. It does not fall back to an unpinned URL or a loose folder.

## Operator runbook

This repository does not contain signing secrets. `hub/signers.json` ships with three public keys. The public deployment uses threshold 2 with `HUB_ALLOW_AUTHOR_APPROVAL=true`. Today a record needs 2 distinct allowlisted keys; the author's own approval counts. That pair is Phoenix Collective, plus Falkor (`FC1e`). The example config stays at threshold 1 for a local dry run. A fourth slot may be added later.

| Label | Public key | Who signs | How the approval is produced |
|---|---|---|---|
| Falkor | `FC1eRr99GGJZuc4KZeUivBpbSMGvjcBB839KaEfAuhcq` | Falkor wallet owner | Wallet `signMessage` on the printed bytes. The owner does not export the key |
| GaliaMeta DAC | `EU7zwmY8QP7B9FFUUyMu1eTNkrwuj27NQkgEmNMWreq1` | GaliaMeta DAC wallet owner | Same `signMessage` flow |
| Phoenix Collective (Falkor's team) | `G2PhCi6MApcuC6f5o2CDQBWDnJt9hRcozHuuN55PYisU` | Collective author | A new ed25519 key from `hub-keygen`, kept outside this repository |

The public deployment is threshold `2` with `HUB_ALLOW_AUTHOR_APPROVAL=true`. Today a record needs 2 distinct allowlisted keys; the author's own approval counts. The author is Phoenix Collective (`G2PhCi6MApcuC6f5o2CDQBWDnJt9hRcozHuuN55PYisU`) and Falkor (`FC1eRr99GGJZuc4KZeUivBpbSMGvjcBB839KaEfAuhcq`) adds the second. GaliaMeta DAC stays on the allowlist and is not required for that pair. The same wallet twice counts once. Without `HUB_ALLOW_AUTHOR_APPROVAL`, the author's approval would not count at threshold 2, and that is not this deployment. The example config stays at threshold 1 for a local dry run: one distinct allowlisted approval is enough, including the author's own approval, and that result is `selfApproved: true` when no other key approved. Publish a store commit whose updates already have the Collective signature and Falkor's approval before raising a local node to threshold 2, then pin that commit.

The public node sets `HUB_GIT_REPO` to `https://github.com/PhoenixClaw01/sa-ecosystem-hub`, `HUB_APPROVAL_THRESHOLD` to `2`, and `HUB_ALLOW_AUTHOR_APPROVAL` to `true`. On 1 November 2026 `HUB_GIT_COMMIT` was `f064f18db1da60c4f3e562d4064c8f344042e97e`, and `HUB_STORE_MANIFEST_HASH` was the sha256 of `hub-manifest.json` at that commit: `1fd4536e3a5b4176beebc04c16c53834092f519d98c0e30172862a2f24ae24f2`. Leave the three pin variables unset on a local process that should not serve the hub. Do not add a submit tool.

### Collective key

The agent generates one fresh key. It is not a copy of a wallet key.

```bash
mkdir -p "$HOME/.config/sa-ecosystem-node"
npm run hub-keygen -- --label "Phoenix Collective" --out "$HOME/.config/sa-ecosystem-node/phoenix-collective.keypair.json"
```

The command refuses a path inside this repository and sets the file mode to `0600`. Stdout is the public key, then one JSON object for the `signers` array. The secret is not printed. `*.keypair.json` is gitignored, and the file still stays outside this repository and outside the public store.

### Allowlist

Ask each owner for the wallet address their wallet displays. The shipped file is the live allowlist. Live approvals are by Falkor and Phoenix Collective. GaliaMeta DAC is on the same list. A fourth slot may be added later.

```json
{
  "v": 1,
  "signers": [
    { "label": "Falkor", "publicKey": "FC1eRr99GGJZuc4KZeUivBpbSMGvjcBB839KaEfAuhcq" },
    { "label": "GaliaMeta DAC", "publicKey": "EU7zwmY8QP7B9FFUUyMu1eTNkrwuj27NQkgEmNMWreq1" },
    { "label": "Phoenix Collective (Falkor's team)", "publicKey": "G2PhCi6MApcuC6f5o2CDQBWDnJt9hRcozHuuN55PYisU" }
  ]
}
```

### Public store

Use any free public git host. The store is public and contains no secrets.

```bash
npm run hub-store-init -- --dir "$HOME/src/sa-hub-store"
cd "$HOME/src/sa-hub-store"
git init -b main
git add README.md hub-manifest.json updates
git commit -m "Empty hub update store"
```

Create the public remote and push. After each publish, pin the new commit:

```bash
git rev-parse HEAD
sha256sum hub-manifest.json
```

`sha256sum` prints the manifest hash. On macOS, `shasum -a 256 hub-manifest.json` prints the same hash. Set `HUB_GIT_REPO` to the `https://` remote, or to an absolute local path when you are testing, `HUB_GIT_COMMIT` to the 40-character id, and `HUB_STORE_MANIFEST_HASH` to the 64-character hash. Leave `HUB_STORE_MANIFEST` unset for `hub-manifest.json`. Set it to `manifest.json` only for a store that still uses that name and also contains `hub-manifest.json`. Content integrity comes from the commit pin plus signatures. The manifest hash covers the file list.

### Author an update

The agent writes the payload with `author` set to the Collective public key, then signs it with the Collective key file:

```bash
npm run sign-hub-update -- \
  --keypair "$HOME/.config/sa-ecosystem-node/phoenix-collective.keypair.json" \
  --payload ./update.json \
  --out ./update.signed.json
```

### Wallet approval, without exporting a key

Falkor and GaliaMeta DAC each do this. The Collective agent can do it from the key file instead, shown at the end of this section.

Print the exact bytes:

```bash
npm run sign-hub-update -- --print-approval ./update.signed.json
```

Stdout is two lines:

```text
hex:<hex of the approval message>
utf8:"sa-ecosystem-node:hub-approval:v1\n<64 hex characters>"
```

The `utf8` line is a JSON string. The message the wallet signs is that string decoded, including the newline. The `hex` line is those same bytes. Sign the hex bytes so the newline cannot be dropped.

Phantom, on a page where the wallet is connected, signs that `Uint8Array`. The second argument `"utf8"` tells Phantom to display the text. This call is `signMessage`. It is not `signTransaction`, and it does not send a transfer.

```javascript
const hex = "<paste the hex line, without the hex: prefix>";
const message = Uint8Array.from(hex.match(/../g), (pair) => Number.parseInt(pair, 16));
const provider = window.phantom.solana;
const signed = await provider.signMessage(message, "utf8");
const signatureHex = [...signed.signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const publicKey = signed.publicKey.toString();
```

The owner sends `publicKey` and `signatureHex` back to the person assembling the file. The owner does not send a seed, a secret key, or a key file. Any other Solana wallet that can sign those same bytes off-chain produces the same proof: detached ed25519 over that UTF-8 message. Phantom documents verification with `tweetnacl`'s `nacl.sign.detached.verify` on `TextEncoder` bytes of the message.

Attach the signature. Hex, base58, and base64 of the 64-byte signature are accepted. The file stores base58. The command checks the signature before it writes, and it never reads a secret.

```bash
npm run sign-hub-update -- \
  --approve ./update.signed.json \
  --public-key "<wallet address>" \
  --signature "<signature hex>" \
  --out ./update.falkor.json
```

Repeat for the next wallet, using the file that already has the first approval as `--approve`. The public deployment sets `HUB_APPROVAL_THRESHOLD=2` and `HUB_ALLOW_AUTHOR_APPROVAL=true`: the Collective author signs, and Falkor (`FC1e`) approves. Those two approvals meet the threshold. Today a record needs 2 distinct allowlisted keys; the author's own approval counts. GaliaMeta DAC can still approve, and is not required for that pair. A local dry run at threshold 1 still accepts one wallet.

The Collective agent can approve with its key file. That signature is over the same bytes:

```bash
npm run sign-hub-update -- \
  --keypair "$HOME/.config/sa-ecosystem-node/phoenix-collective.keypair.json" \
  --approve ./update.falkor.json \
  --out ./update.approved.json
```

Copy `update.approved.json` into the store as `updates/<id>.json`, or let the helper commit it. Do not copy a key file into the store.

```bash
npm run hub-add-update -- \
  --store "$HOME/src/sa-hub-store" \
  --payload ./update.approved.json \
  --dry-run
```

`--dry-run` prints the path, the payload sha256, and the manifest hash. It does not write and it does not commit. Drop `--dry-run` to write `updates/<id>.json`, update the store manifest (`hub-manifest.json`, or `manifest.json` when that is the only manifest in the store), and commit in the store repository. The store needs `user.name` and `user.email`. Stdout is JSON with `commit` and `manifestHash` for the pin. Push that commit yourself, then set `HUB_GIT_COMMIT` and `HUB_STORE_MANIFEST_HASH` from those two fields.

`--keypair` is optional. On a file that already has an author signature, it adds one detached approval. On an unsigned payload it signs as the author, and `--approve` also attaches that key's approval. The key file must hold no funds. The secret is not printed. If that key is the only approver, stderr warns that the update is self-approved.

Flags can build the payload instead of a file: `--id`, `--kind`, `--body`, `--author`, `--prev`, `--created-at`, `--pip`, and repeated `--tx`. `--kind listing` also needs `--listing` set to the listing JSON object, which may include `image`. Set `listingId` on every new listing. `--kind guild` also needs `--guild` set to the guild JSON object. `--kind story-optin` also needs `--story-optin` set to the opt-in JSON object, including the player's signature, and `--hub-repo` set to the https repository URL. `--kind reputation-link` also needs `--reputation-link` set to the link JSON object, including the player's signature, and `--hub-repo` set to that same URL. `--prev` is the chain pointer, the sha256 of the previous payload. Omit it and the command uses the store tip.

Every new DAO tool returns `dataMode` (`live` or `cached`), `asOf`, and `sources`. Galaxy tools fetch on each call. Treasury tools only read `data/treasury-cache.json`. They do not refresh it and they do not write. A missing or unusable cache is an error, not an empty ledger.

## Treasury cache

Two wallets are scanned. Both are named on the public knowledge base and in the passed PIP-23 text, and they match the dashboards cited in the Oct 2026 gap review:

| Role | Address |
|---|---|
| DAO Treasury | `CuwnarNh7FEqZMmffFjRyWj54RecyS7zwFg1CxfzNudi` |
| Ecosystem Fund | `BxKehkp298nQunu8BWxh5U6VvfphFyjEB3t7USst7Uag` |

Sources: [knowledge base](https://star-atlas-dao.gitbook.io/knowledge-base/overview/treasury), [PIP-23](https://govern.staratlas.com/proposals/0ecf2928-15df-497e-8b67-d87eda030d5a). The retired pre-multisig address `DRGThVUMGEYcsoTERhmkFSa5q7HVjxBQdKwMNjyvehD1` is recorded in code and is not scanned.

The refresh is idempotent and resumable. It is the only writer of the cache. A scheduled run passes `--incremental`. It fetches signatures newer than each cached cursor, then continues the older walk from the oldest parsed signature while that walk is unfinished. Both walks stay inside the page cap, so one run stays short and the history completes over later runs. A run without that flag continues the older walk with no newer-signature pass:

```bash
npm run refresh-treasury
npm run refresh-treasury -- --max-atlas-pages=all
```

`--max-atlas-pages` defaults to 400 signature pages per run (`all` removes the cap). `--max-signature-pages` caps the wallet and token-account walks (1,000 signatures per page). `--cache=` overrides `TREASURY_CACHE_PATH`. `SOLANA_RPC_URL` defaults to `https://solana-rpc.publicnode.com`. If that host refuses the read, the client tries `SOLANA_RPC_FALLBACK_URLS` (default `https://api.mainnet-beta.solana.com`) and then the other public endpoint, with backoff. A run that stops early writes the cache with `completeness: "partial"` and a `partialReason`. The client sends only `getSignaturesForAddress`, `getTransaction`, `getTokenAccountsByOwner`, `getTokenAccountBalance`, `getBalance`, `getAccountInfo`, `getMultipleAccounts`, and `getProgramAccounts`. `getProgramAccounts` is sent only to `https://api.mainnet-beta.solana.com`, and only for the Player Profile, Profile Faction, and SAGE program ids, with a memcmp filter and a dataSlice. The public mainnet RPC refuses that call from a browser, so `player_legacy` runs on the server. Solana's HTTP API uses POST as the transport for those reads. The client refuses any other method.

The treasury ATLAS token account is too active for a full `getTransaction` history on a public RPC. The refresh parses the two wallet histories, the Ecosystem Fund ATLAS account, and the treasury USDC account in full. Treasury ATLAS inflows are the change in balance minus the parsed wallet movements, and only when a sample of the other ATLAS-account signatures did not decrease the balance. If that sample fails, or the scan does not cover the month, the inflow is omitted (or marked unknown with `allowPartial`). It is not reported as zero.

`npm run smoke-dao` is an optional live check of the galaxy JSON and the two wallet balances. It is not part of `npm test`.

## PIP-23 Ecosystem Fund formula

`ecofund_limit` follows the text of [PIP-23](https://govern.staratlas.com/proposals/0ecf2928-15df-497e-8b67-d87eda030d5a) (galaxy id `0ecf2928-15df-497e-8b67-d87eda030d5a`, status `Voting_Complete_Measure_Passes` when checked on 2026-10-24). PIP-23 says it replaces [PIP-4](https://star-atlas-dao.gitbook.io/knowledge-base/archive/foundational-pips/pip-4-star-atlas-ecosystem-fund) in its entirety, so the PIP-4 USDC formula is not applied.

`ecofund_limit` reflects each node's own treasury cache date, so two nodes can differ until both refresh.

- **5% per-PIP limit.** No Ecosystem Fund PIP exceeds 5% of the Ecosystem Fund ATLAS balance *after the last refill transaction*. The limit stays until the next refill. The worked example in PIP-23 is the 2025-07-03 refill: balance after `224,094,330` ATLAS, and 5% is `11,204,716.5` ATLAS.
- **ATLAS refill.** On or about 31 Mar, 20 Jun, 30 Sep, and 31 Dec (20 June is copied as written). If fund ATLAS is under 20% of (treasury ATLAS + fund ATLAS), send `R = (treasury − 4 × fund) / 5` so the fund is 20% of that total. If fund ATLAS is already at least 20%, send no ATLAS, and the next-quarter limit equals the current limit.
- **USDC refill.** If DAO Treasury USDC is more than 500,000, send 20% of the excess. Otherwise send no USDC. Fund USDC is not part of the test.
- **A refill on chain** is detected as an internal ATLAS transfer from the treasury wallet to the fund wallet. PIP-23 does not tag the transaction, so the detection is labelled. A Council override can sit beside the computed figure.

These inputs are unknown because the PIP text does not state them. The tool returns `unknown` rather than a guess:

- the USDC-to-ATLAS conversion rate and venue ("in a timely manner")
- rounding when `(treasury − 4 × fund)` is not divisible by 5 raw units
- the list of unpaid PIPs. Pass `unpaidPips` with a `sourceLabel` on each row. Omitting the field leaves the remainder unknown. An empty array means the caller says there are none
- a ranked-choice winner on a proposal whose `voteOptionsMaxChoices` is greater than 1

`councilOverride` is optional. It requires a `label` and either `perPipLimitAtlas` or `nextQuarterLimitAtlas`. `figureInForce` uses the labelled override for the per-PIP figure when one is supplied. The computed PIP-23 figure stays in the response.

## Hosting the MCP

Anyone can run this process. [docs/hosting.md](docs/hosting.md) is the full matrix: `node.config.json`, Docker Compose, stdio/`npx` for Claude Desktop and Cursor, the Node HTTP entry, the public Vercel project `sa-ecosystem-node-dashboard`, Railway, Fly, and Render. Cloudflare Workers is documented there as not feasible without a rewrite. The Vercel function can read a pinned `github.com` commit over HTTPS when `git` is absent, and it still reads the signer allowlist from disk. Workers do not run those Node filesystem calls.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/PhoenixClaw01/sa-ecosystem-node&root-directory=dashboard)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https://github.com/PhoenixClaw01/sa-ecosystem-node)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/PhoenixClaw01/sa-ecosystem-node)

A public Node process (`PUBLIC_NODE=1`) stays read-only. It refuses to start when `allowedHosts` is empty or `*` unless `ALLOW_ANY_HOST=1` is set. The Docker image, Compose file, Fly config, and Render config do not set that opt-in. Set `ALLOWED_HOSTS` to the hostname clients use, or startup exits. `POST /submit` and every other non-MCP path return 404. Each client key is limited by `rateLimitMax` / `rateLimitWindowMs`. The key is the socket address unless `TRUST_PROXY=1`, which the Vercel configs set. The limiter is in memory on each instance. Request bodies over `maxRequestBytes` (default 512 KiB) are refused with HTTP 413 before a tool runs. The MCP list is the 24 read-only tools. `submit_hub_update` is not one of them.

The MCP server is the product. The dashboard is a thin demo of the same balance reader: one `getMultipleAccounts` call, then the treasury cache if that read fails. `data_health` reports that wallet-balance check as `live` or `cached`.

`SOLANA_RPC_URL` defaults to `https://solana-rpc.publicnode.com`. `SOLANA_RPC_FALLBACK_URLS` defaults to `https://api.mainnet-beta.solana.com`. Both are public endpoints. No API key is required. Set either variable to point the open-source server at your own RPC.

- **Local.** `npm start` serves Streamable HTTP. `npm run start:stdio` speaks MCP on stdin. The cache file is `TREASURY_CACHE_PATH` (default `data/treasury-cache.json`).
- **Vercel, public node.** Project `sa-ecosystem-node-dashboard` is separate from the DAO Council preview. Root Directory is `dashboard` and the production branch is `main`. The function is the committed bundle `dashboard/api/mcp.js` (`npm run build:dashboard-mcp`). It inlines this repo's dependencies, so the deploy does not install the parent package and Vercel does not compile TypeScript for that route. The function is capped at 25 seconds. `dashboard/package.json` asks for Node.js 22. The `HUB_*` values are listed in [docs/hosting.md](docs/hosting.md).
- **Vercel, repo root.** `api/mcp.ts` re-exports the same handler. The root `vercel.json` rewrites `/mcp` to it. That file is not what the public node deploys.
- **Cloudflare or any other host.** The Solana client is fetch-only and sends the allow-listed read methods. Set `SOLANA_RPC_URL` to the RPC that host can reach. This repo does not ship a Workers entry.

Live balances still answer when the cache file is absent. History and payment tools fail closed without it. The server process does not refresh the cache. `npm run refresh-treasury` does, with read methods only. A scheduled refresh runs every 3 hours (`17 */3 * * *`), about 240 runs in a 30-day month: about 240 Actions minutes if each run bills one minute, or about 480 if install pushes a run into a second minute.

## Public MCP endpoint

The live read-only endpoint is [https://sa-ecosystem-node-dashboard.vercel.app/api/mcp](https://sa-ecosystem-node-dashboard.vercel.app/api/mcp). No API key. A short discovery file is at [https://sa-ecosystem-node-dashboard.vercel.app/.well-known/mcp.json](https://sa-ecosystem-node-dashboard.vercel.app/.well-known/mcp.json).

Cursor, in `~/.cursor/mcp.json` or the project `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "sa-ecosystem-node": {
      "url": "https://sa-ecosystem-node-dashboard.vercel.app/api/mcp"
    }
  }
}
```

Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sa-ecosystem-node": {
      "type": "http",
      "url": "https://sa-ecosystem-node-dashboard.vercel.app/api/mcp"
    }
  }
}
```

In Claude.ai, add a custom connector and paste that URL. Any other client that speaks Streamable HTTP can use the same URL.

Each request has a 20 second timeout, a 512 KiB request-body cap, and a 512 KiB response cap. A request over 524288 bytes is refused with HTTP 413 before a tool runs. A response over that size is replaced with the same status and is not truncated. The server allows 120 requests per minute per client key on each instance. On this Vercel project `TRUST_PROXY=1`, so the key is the first `X-Forwarded-For` hop. That limiter is in memory: it is not shared across Vercel instances, and it resets when an instance recycles. It is not a security boundary. Tool inputs are checked before a read runs. An upstream failure comes back as a short MCP error. The response does not include a stack trace.

`list_proposals` returns 20 proposals by default and at most 100. The page includes `nextCursor`. Pass that value back as `cursor` to read the next page.

The MCP Playground at `/playground/` calls this endpoint from the browser, on whatever origin serves it. `dashboard/data/mcp-recorded.json` is still generated for CI and is not served.

On the public Vercel project `sa-ecosystem-node-dashboard`, leave Root Directory as `dashboard` and the production branch as `main`. Leave the install command empty: the MCP route is already bundled, and a parent `npm ci` is not used. Confirm the Node.js version is 22.x. Set the `HUB_*` pins from [docs/hosting.md](docs/hosting.md). `SOLANA_RPC_URL` and `SOLANA_RPC_FALLBACK_URLS` are optional; unset, they stay on the public defaults. Do not add an API key. `dashboard/vercel.json` includes `data/treasury-cache.json`, `hub/signers.json`, and `hub/signers/agents.json` in the function. `ata.js` and `squads.js` are inlined in the bundle and listed in `dashboard/.vercelignore`, so the deploy does not ship them as separate files. `hub/signers.json` there is a byte-for-byte copy of the repository `hub/signers.json`, written by `npm run build:dashboard-mcp`. Do not edit the copy. The cache job commits `dashboard/data/treasury-cache.json`. A missing match does not fail the deploy. If that file is absent, `treasury_history` and `ecofund_limit` say the cache is not yet populated and include no figures. Payment and flow tools fail closed until the file is present. On 1 November 2026 `data_health` on the public node reported `treasury_cache` ok, and `treasury_history` returned cached series. `data_health` and `treasury_balances` can read live balances without that file. The bundle carries `ata.js` and `squads.js` inside it, so the function does not `require()` those scripts. When `git` is not on the function, a pinned `github.com` hub is read over HTTPS. Docker and the other container hosts still use `git`.

## Deploy

The files in `dashboard/` are what project `sa-ecosystem-node-dashboard` deploys. That project uses Root Directory `dashboard` and does not use the root `vercel.json`. See `dashboard/README.md`. `/` serves `dashboard/index.html`, the DAO dashboard front page. `home.js` calls same-origin `/mcp` for live revenue, treasury balances, and the Ecosystem Fund limit, and paints those figures. A failed read says "Data unavailable" and shows no figure.

`/` serves `dashboard/index.html`, the DAO dashboard front page. There is no redirect. The MCP server does not read `PUBLIC_HOME`, and `GET /` on the local Node process stays the status document. `PUBLIC_HOME` is no longer read by anything and can be removed from a project.

The in-memory rate limiter is a placeholder. It resets when the process restarts and is not shared across instances.

## Checks

```bash
npm run lint && npm run typecheck && npm test
```

GitHub Actions runs those three on push and pull request. Tests do not hit the network.
