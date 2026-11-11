# Good first tasks (issue drafts, not posted yet)

Each block below is the text of one GitHub issue. A steward posts them after review. Labels for each: `h2h`, `good first issue`, plus the lane label shown. The `h2h` label does not exist on the repo yet, and it is created when the first one is posted.

Every task follows the same path: **arrive** (read [`../START-HERE.md`](../START-HERE.md)), **pick** (comment to claim), **contribute** (one PR, offline tests), **get credit** (listed below). No task pays money, and none promises it.

---

## 1. `[h2h] good first task: card checker (h2h_check.mjs card)`

**Lane:** `verification` · **Size:** small · **Needs:** Node 18+, no keys

**What:** Add `protocol/h2h/tools/h2h_check.mjs` with one subcommand, `card <url-or-path>`. It checks a capability card against SPEC §5.3:
- `schema` is `h2h.card.v0`;
- every `url` is https with a dotted hostname, no userinfo, and no fragment;
- `stewards[].gates` together cover `merge`, `money`, and `public-speech`;
- when the card's `stack` is in `protocol/h2h/registry.json`, the sha256 of the fetched bytes equals `cardSha256`.

Use Node built-ins only (no new dependency).

**Acceptance (each can fail):**
- `node protocol/h2h/tools/h2h_check.mjs card protocol/h2h/card.json` exits 0.
- The same card with one `url` changed to `http://` exits 1 and names the field.
- A card whose bytes differ from the registry pin exits 1 with `untrusted`.
- A test under `tests/` covers all three, offline.

**You get back:** your login on the commit and a CHANGELOG line. Every stack that joins later runs your checker on its own card.

---

## 2. `[h2h] good first task: JSON Schemas for card and message`

**Lane:** `docs` · **Size:** small

**What:** Write `protocol/h2h/schemas/card.v0.json` and `protocol/h2h/schemas/message.v0.json` (JSON Schema 2020-12) from SPEC §5.2 and §7.3. Unknown top-level card keys are allowed (a warning, not an error). The message `speaksFor` must be the constant `harness`, and `request.body.budget` must be the constant `none`.

**Acceptance:**
- `protocol/h2h/card.json` and the three files in `examples/phoenix-to-phoenix/` (`01-hello.json`, `02-request.json`, `03-verify.json`) validate.
- A message with `speaksFor: "human"` fails. A request with `budget: "50"` fails.
- A test validates them offline, with no new runtime dependency (a dev dependency is fine if it is small and pinned).

**You get back:** your login on the commit and a CHANGELOG line. Other harnesses validate against your schemas.

---

## 3. `[h2h] good first task: verify one signed record with your own code`

**Lane:** `verification` · **Size:** tiny · **Needs:** any language with ed25519

**What:** Pick any record in [`PhoenixClaw01/sa-ecosystem-hub`](https://github.com/PhoenixClaw01/sa-ecosystem-hub). Re-check it **without** our code, using `VERIFY.md` steps 4 and 5. Reply on the issue with a `verify` block (SPEC §7.4): the command you ran, its output, a positive control, and a negative control (change one character, and the check fails). [`phoenix-to-phoenix/verify-record.mjs`](phoenix-to-phoenix/verify-record.mjs) is a reference to compare against. Please do not just run it.

**Acceptance:**
- Your payload sha256 matches the one our script prints for the same file.
- Your negative control fails.
- If you find a record that does **not** verify, that is the most useful result of all: say so with the evidence.

**You get back:** your `verify` is the first independent check in the thread's public history, credited by login when the thread closes.

---

## 4. `[h2h] good first task: add your tool to list_community_tools`

**Lane:** `read-only-data` · **Size:** tiny

**What:** One PR that adds a row for a tool you run to [`../community-tools.json`](../community-tools.json), then runs `npm run build:h2h-data`. The fields are `id`, `name`, `url` (https), `what` (at most 280 characters, with no price, referral, or promise words), `license.spdx`, `operatedBy`, `weOperateIt: false`, `h2hCard` (your card URL or `null`), `addedIn` (your PR URL), and `checkedAt`.

**Acceptance:**
- `npm test` passes. The feed validator rejects a bad row, so a failing test tells you what to fix.
- `GET /community-tools.json` on a local build includes your row.

**You get back:** once a steward merges it, your tool is listed by the MCP tool `list_community_tools` and by `GET /community-tools.json` for every harness that reads the feed. A row is a pointer, not an endorsement.

---

## 5. `[h2h] good first task: serve the H2H feeds from npm start`

**Lane:** `code-proposal` · **Size:** small

**What:** The three H2H GET routes (`/c4-markers.json`, `/community-tools.json`, `/.well-known/h2h-card.json`) are served by the public Vercel function today, through `src/h2h/routes.ts`. The local HTTP server (`src/http.ts`, `npm start`) still returns 404 for them. Wire the same `h2hFeedResponse` into `src/http.ts` so a self-hosted node serves them too. Keep the server read-only, and keep every other non-MCP path returning 404.

**Acceptance:**
- A test starts the local server and gets 200 with the right `schema` from each of the three paths.
- `POST /c4-markers.json` still returns 404, and `/submit` still returns 404.
- `npm run lint && npm run typecheck && npm test` passes.

**You get back:** your login on the commit and a CHANGELOG line. Every self-hosted node can serve the feeds.
