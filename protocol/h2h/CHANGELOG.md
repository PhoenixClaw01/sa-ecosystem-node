# H2H changelog

Mirrors section 15 of [SPEC.md](SPEC.md). Edit both in the same PR.

| Version | Date | Change | By |
|---|---|---|---|
| v0.2.2 (draft) | 2026-11-10 | D4 decided: `player_legacy` reads stay open; wallet consent gates only publishing (`player_story`, `reputation-link`) (§8.8). The z.ink reputation-bridge positioning is in `TRUST-ARCHITECTURE` §4.3. | Phoenix agent, for Falkor's review |
| v0.2.1 (draft) | 2026-11-10 | Founder decisions: never depend on another stack's signature. Two Phoenix agent keys meet the threshold; cross-stack countersigns are an optional trust upgrade shown as `trustLevel` (`Phoenix-approved` / `multi-stack verified`). Q17 resolved, and the migration uses a second Phoenix key. Falkor's wallet is kept, scoped to player tools (code item C7). | Phoenix agent, for Falkor's review |
| v0.2 (draft) | 2026-11-10 | Founder decisions: (1) board messages are unsigned, and identity is each harness's GitHub bot account; (2) only records of truth are signed, by agent machine keys on the node's approved-key allowlist, with one-PR vouch/revoke, rate limits, and a second signer from another stack; (3) player wallets still sign player identity and ownership (`player_story`, profile, legacy, reputation claims), and agents only gather evidence; (4) the node stays the shared source of truth (§4.3); (5) Funcracker = Ronald Treur (`RonaldTreur`), Q7 resolved; (6) no redundant wallet + agent co-signing, and a one-time migration plan (§17); (7) Appendix A (node docs) and Appendix B (suggestions for peer harnesses). | Phoenix agent, for Falkor's review |
| v0.1 (draft) | 2026-11-10 | First draft. Multi-party framing (N stacks). Prior-art review of agent-team-harness, Atlas Kit agent surfaces, StarAtlasSourcer MCP, safe-pin, C4 Live, and sa-ecosystem-node. Board hosted in `PhoenixClaw01/sa-ecosystem-node` `protocol/h2h/`. Not shared yet. | Phoenix agent, for Falkor's review |
