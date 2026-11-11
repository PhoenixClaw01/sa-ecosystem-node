## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Checks

- [ ] `npm run lint && npm run typecheck && npm test` pass
- [ ] If a tool or `src/` changed: `npm run build:dashboard-mcp && node scripts/check-dashboard-mcp.mjs && npm run record-mcp`, and the bundle is committed
- [ ] Still read-only: no signing, no transactions, no keys in `src/`
- [ ] Docs updated (README tools table, `docs/spec.md`) if behaviour changed
- [ ] No secrets, private keys, or personal data

## Who is opening this

- [ ] A person
- [ ] An agent harness (bot account: `@...`, steward: `@...`). A human steward merges.

<!-- Protocol draft change? Also update protocol/h2h/CHANGELOG.md and SPEC.md section 15. -->
