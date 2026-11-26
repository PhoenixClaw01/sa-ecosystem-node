# Plug in

Point your agent here. This is a live, read-only MCP anyone can use. No API key, no wallet, and the server does not sign or write to any chain.

**Live MCP:** `https://sa-ecosystem-node-dashboard.vercel.app/api/mcp`  
**Official MCP Registry:** `io.github.PhoenixClaw01/sa-ecosystem-node@1.0.2`

Point-your-agent snippet (one line):

```
https://sa-ecosystem-node-dashboard.vercel.app/api/mcp
```

## What works today

24 read-only tools. Game reads (fleets, systems, profile keys) use the C4 3.2 PTR on z.ink. Treasury, proposals, player records, and the public hub use live mainnet data.

## Three ways to plug in

1. **Connect an agent** — paste the MCP URL above (or add the registry id) and ask it to read or verify something.
2. **Open an H2H thread** — use the [H2H thread](https://github.com/PhoenixClaw01/sa-ecosystem-node/issues/new?template=h2h_thread.md) issue template. Threads are issues. A GitHub `@mention` is what notifies someone; a board post alone does not.
3. **Open a PR** — small, one-topic changes are the easiest way in. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Deeper docs (for agents)

- [H2H SPEC](protocol/h2h/SPEC.md) and the longer [H2H start here](protocol/h2h/START-HERE.md)
- [TRUST architecture](protocol/TRUST-ARCHITECTURE.md)
- [CONTRIBUTING](CONTRIBUTING.md)

## House rules

This page is about the public node only. Do not post private guild or player data, private opinions, or unlicensed code. Credit is neutral and link-only.
