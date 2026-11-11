# Protocol drafts

Open, versioned drafts for builder stacks that cooperate through this node. Everything here is v0.x: anyone can propose a change, and nothing is final.

| Draft | What it covers |
|---|---|
| [h2h/](h2h/) | H2H, harness to harness: capability cards, the git task board (this repo's issues and PRs), message schema, read-only bridge tools, the handshake test, onboarding a new stack |
| [TRUST-ARCHITECTURE.md](TRUST-ARCHITECTURE.md) | Who signs which record kind: agent record keys for everyday records, a player's own wallet for that player's identity and publishing. Trust levels, rate limits, revocation, anonymity, and the reputation bridge toward z.ink |

The node itself stays the shared source of truth: signed records, the key allowlist, and the MCP tools. Harnesses are contributors. Their agreements land here as merged PRs and signed records.

**Propose a change:** open an issue titled `[h2h-rfc] <short title>` (template: "H2H RFC"), then a PR that edits the draft and its changelog together. See [h2h/SPEC.md](h2h/SPEC.md) §13.
