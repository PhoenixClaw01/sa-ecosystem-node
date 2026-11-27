# Tool telemetry

A stock node writes **one JSON line to stdout** for each `tools/call`. That is the default sink. It works on Vercel function logs, Cloudflare, Fly, Docker, a local process, or any collector that reads stdout. There is no required database and no vendor lock-in.

Set `MCP_TELEMETRY_SINK=off` to write nothing. An HTTP POST or a custom in-process callback is optional and stays off until you configure it. A sink error, a timeout, or a throw while building an event never changes the MCP tool response.

These variables are read when the process builds the MCP handler. Change them and restart the process. Do not put a sink URL in `node.config.json`. The example config does not have one. The stdio process does not send telemetry.

## What is recorded

One JSON object per `tools/call`. The UTC time is `called_at` (the event timestamp; the name avoids a reserved SQL column).

| Field | Meaning |
|---|---|
| `tool` | A read-only tool name, or `unknown` when the name is not one of those tools |
| `called_at` | UTC timestamp |
| `env` | A short label: `MCP_TELEMETRY_ENV` when it is 1–24 characters of lowercase letters, digits, `_`, or `-`. Otherwise `production`, `preview`, or `development` from `VERCEL_ENV`, or `local` |
| `client_family` | `cursor`, `claude`, `vscode`, `chatgpt`, `browser`, `node`, or `unknown` |
| `self_traffic` | `true` when the request is marked as operator or smoke traffic (see below). Always a boolean. The header value is not stored |
| `outcome` | `ok`, `empty`, `unmatched`, `invalid_args`, or `error` |
| `result_count` | How many rows the result carried, or null |
| `latency_ms` | Handler time, capped |
| `error_class` | `invalid_args`, `timeout`, `unavailable`, `upstream`, `rate_limited`, `internal`, or null |

Safe enum fields are added only when the value is one of the tool's fixed choices: `stream`, `category`, `status`, `kind`, `direction`, `mint`, `wallet_role` (`dao_treasury` or `ecosystem_fund` only), `granularity`, `include_expired`, `include_internal`, `include_fees`, `allow_partial`, `anchored`, and `story_status` (`story`, `not_opted_in`, or `not_available`).

The event does **not** include wallet public keys, player ids, profile or fleet addresses, free-text search queries, claim identities, raw IP addresses, the raw User-Agent, a raw client name, request or response bodies, auth headers, or the sink URL and key.

`empty` is a list that returned no rows. `unmatched` is a lookup that did not resolve: a fleet, a claim identity, a player story with no opt-in, or a player record with no profile, fleet, or activity. `invalid_args` is a rejected input. `error` is any other failure. A sink error is not one of these: the MCP response is unchanged.

## Self-traffic

Operators and smoke checks should mark their own calls so forks can filter them out of "outside use" counts. `self_traffic` is `true` when:

- The request has a non-empty `x-phoenix-agent` header, or
- The request has a non-empty `x-phoenix-sweep` header, or
- The User-Agent contains `PhoenixCollectiveAgent` or `phoenix-mcp-smoke` (case-insensitive)

Only the boolean is stored. The header value and the raw User-Agent are not. A normal public caller sends neither header.

```bash
curl -sS https://sa-ecosystem-node-dashboard.vercel.app/api/mcp \
  -H 'content-type: application/json' \
  -H 'x-phoenix-agent: 1' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

`tools/list` does not emit a tool-call event. Use the same header on a `tools/call` when you want the event marked `self_traffic: true`.

## Operator environment

| Name | Meaning |
|---|---|
| `MCP_TELEMETRY_SINK` | Optional. `stdout` (JSON line to stdout), `off` (or `noop`) writes nothing, `http` posts only to `MCP_TELEMETRY_URL`, `both` writes stdout and HTTP. Unset means stdout, except that a valid `MCP_TELEMETRY_URL` alone keeps the previous HTTP-only behaviour. In unit tests the unset default is off so the suite stays quiet |
| `MCP_TELEMETRY_URL` | Optional HTTPS URL that accepts `POST` of one JSON object. `http` is accepted only for `localhost`, `127.0.0.1`, or `[::1]`. A runtime that reports the IPv6 loopback hostname as `::1` or `[::1]` is accepted. Unset, empty, or invalid (including a URL with a username or password) leaves the HTTP sink off. This variable is read by the HTTP server and the public MCP handler, not by the stdio process |
| `MCP_TELEMETRY_KEY` | Optional bearer token, sent as `Authorization: Bearer …`. When the URL path contains `/rest/v1/`, the same value is also sent as `apikey` and the request sets `Prefer: return=minimal`. A key with a newline is ignored |
| `MCP_TELEMETRY_ENV` | Optional coarse label described above |
| `MCP_TELEMETRY_TIMEOUT_MS` | Optional. Default 1500. Values outside 100–3000 are clamped. The MCP response does not wait for the sink |

A process that wants a custom callback can pass `sink` to `createToolTelemetry`. That hook receives the sealed event. It is off unless the operator wires it.

```bash
# Default: one JSON line on stdout (also the right setting on Vercel, Fly, or Docker)
# MCP_TELEMETRY_SINK is unset

# Silence telemetry
MCP_TELEMETRY_SINK=off

# Optional HTTP POST, for example to a collector you control
MCP_TELEMETRY_SINK=http
MCP_TELEMETRY_URL=https://telemetry.example/mcp-tool-calls
MCP_TELEMETRY_KEY=replace-with-your-key
MCP_TELEMETRY_ENV=production
```

A Supabase project you control can take the same POST at its REST table URL:

```bash
MCP_TELEMETRY_SINK=http
MCP_TELEMETRY_URL=https://<project-ref>.supabase.co/rest/v1/mcp_tool_calls
MCP_TELEMETRY_KEY=<your key>
```

`<project-ref>` and `<your key>` are yours. This repository does not contain a project ref or a key. The table is [`sql/optional_mcp_tool_calls.sql`](../sql/optional_mcp_tool_calls.sql). Row level security is enabled and no public read policy is included. Add an insert policy only for the role that owns the key.

An HTTP send is best-effort. A timeout, a refused connection, or a 4xx from the sink is discarded. The tool response is not delayed by the sink and does not change when the sink fails.
