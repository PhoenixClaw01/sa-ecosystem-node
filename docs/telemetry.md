# Tool telemetry

Tool-outcome telemetry is **off by default**. A checkout of this repository sends no telemetry request unless the operator sets `MCP_TELEMETRY_URL`. Leave that variable unset and the public MCP handler does not open a connection for telemetry.

This is for someone running their own node. The variables are read when the process builds the MCP handler. Change them and restart the process. Do not put a sink URL in `node.config.json`. The example config does not have one.

## What is recorded

One JSON object per `tools/call`:

| Field | Meaning |
|---|---|
| `tool` | A read-only tool name, or `unknown` when the name is not one of those tools |
| `called_at` | UTC timestamp |
| `env` | A short label: `MCP_TELEMETRY_ENV` when it is 1–24 characters of lowercase letters, digits, `_`, or `-`. Otherwise `production`, `preview`, or `development` from `VERCEL_ENV`, or `local` |
| `client_family` | `cursor`, `claude`, `vscode`, `chatgpt`, `browser`, `node`, or `unknown` |
| `outcome` | `ok`, `empty`, `unmatched`, `invalid_args`, or `error` |
| `result_count` | How many rows the result carried, or null |
| `latency_ms` | Handler time, capped |
| `error_class` | `invalid_args`, `timeout`, `unavailable`, `upstream`, `rate_limited`, `internal`, or null |

Safe enum fields are added only when the value is one of the tool's fixed choices: `stream`, `category`, `status`, `kind`, `direction`, `mint`, `wallet_role` (`dao_treasury` or `ecosystem_fund` only), `granularity`, `include_expired`, `include_internal`, `include_fees`, `allow_partial`, `anchored`, and `story_status` (`story`, `not_opted_in`, or `not_available`).

The event does **not** include wallet public keys, player ids, profile or fleet addresses, free-text search queries, claim identities, raw IP addresses, the raw User-Agent, request or response bodies, or the sink URL and key.

`empty` is a list that returned no rows. `unmatched` is a lookup that did not resolve: a fleet, a claim identity, a player story with no opt-in, or a player record with no profile, fleet, or activity. `invalid_args` is a rejected input. `error` is any other failure. A sink error is not one of these: the MCP response is unchanged.

## Operator environment

| Name | Meaning |
|---|---|
| `MCP_TELEMETRY_URL` | HTTPS URL that accepts `POST` of one JSON object. `http` is accepted only for `localhost` or `127.0.0.1`. Unset, empty, or invalid (including a URL with a username or password) keeps telemetry off |
| `MCP_TELEMETRY_KEY` | Optional bearer token, sent as `Authorization: Bearer …`. When the URL path contains `/rest/v1/`, the same value is also sent as `apikey` and the request sets `Prefer: return=minimal`. A key with a newline is ignored |
| `MCP_TELEMETRY_ENV` | Optional coarse label described above |
| `MCP_TELEMETRY_TIMEOUT_MS` | Optional. Default 1500. Values outside 100–3000 are clamped. The MCP response does not wait for the sink |

```bash
MCP_TELEMETRY_URL=https://telemetry.example/mcp-tool-calls
MCP_TELEMETRY_KEY=replace-with-your-key
MCP_TELEMETRY_ENV=production
```

A Supabase project you control can take the same POST at its REST table URL:

```bash
MCP_TELEMETRY_URL=https://<project-ref>.supabase.co/rest/v1/mcp_tool_calls
MCP_TELEMETRY_KEY=<your key>
```

`<project-ref>` and `<your key>` are yours. This repository does not contain a project ref or a key. The table is [`sql/optional_mcp_tool_calls.sql`](../sql/optional_mcp_tool_calls.sql). Row level security is enabled and no public read policy is included. Add an insert policy only for the role that owns the key.

The send is best-effort. A timeout, a refused connection, or a 4xx from the sink is discarded. The tool response is not delayed by the sink and does not change when the sink fails.
