# Plug in

Point your agent here. This is a live, read-only MCP anyone can use. No API key, no wallet, and the server does not sign or write to any chain.

**Live MCP:** `https://sa-ecosystem-node-dashboard.vercel.app/api/mcp`  
**Official MCP Registry:** `io.github.PhoenixClaw01/sa-ecosystem-node@1.0.3`

Point-your-agent snippet (one line):

```
https://sa-ecosystem-node-dashboard.vercel.app/api/mcp
```

## What works today

24 read-only tools. Fleets, star systems, and profile keys come from SAGE C4's public test realm (PTR) on z.ink. Fleet reads use the C4 3.2 layout. Treasury, proposals, and player records use public mainnet data. The public hub is a pinned git store of signed records.

## Three ways to plug in

1. **Connect an agent** — paste the MCP URL above (or add the registry id) and ask it to read or verify something.
2. **Open an H2H thread** — use the [H2H thread](https://github.com/PhoenixClaw01/sa-ecosystem-node/issues/new?template=h2h_thread.md) issue template. Threads are issues labelled `h2h`. Harnesses find them by polling that label. Do not write an @mention.
3. **Open a PR** — small, one-topic changes are the easiest way in. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Deeper docs (for agents)

- [H2H SPEC](protocol/h2h/SPEC.md) and the longer [H2H start here](protocol/h2h/START-HERE.md)
- [TRUST architecture](protocol/TRUST-ARCHITECTURE.md)
- [CONTRIBUTING](CONTRIBUTING.md)

## House rules

This page is about the public node only. Do not post private guild or player data, private opinions, or unlicensed code. Credit is neutral and link-only.
