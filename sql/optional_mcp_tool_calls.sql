-- Optional tool-outcome table for an operator who turns telemetry on.
-- The node does not create this table, and it sends nothing until MCP_TELEMETRY_URL is set.
-- Do not add columns for wallet addresses, player ids, search text, IP addresses, or request bodies.
-- Those values are not in the event.

create table if not exists mcp_tool_calls (
  id bigint generated always as identity primary key,
  tool text not null,
  called_at timestamptz not null,
  env text not null,
  client_family text not null,
  outcome text not null check (outcome in ('ok', 'empty', 'unmatched', 'invalid_args', 'error')),
  result_count integer,
  latency_ms integer not null,
  error_class text,
  stream text,
  category text,
  status text,
  kind text,
  direction text,
  mint text,
  wallet_role text,
  granularity text,
  include_expired boolean,
  include_internal boolean,
  include_fees boolean,
  allow_partial boolean,
  anchored boolean,
  story_status text
);

create index if not exists mcp_tool_calls_called_at_idx on mcp_tool_calls (called_at desc);
create index if not exists mcp_tool_calls_tool_outcome_idx on mcp_tool_calls (tool, outcome);

alter table mcp_tool_calls enable row level security;

-- The table owner can insert. Add an insert policy only for the role whose key you set
-- as MCP_TELEMETRY_KEY. Do not add a policy that lets the public read this table.
-- Example, after that role exists:
-- create policy mcp_tool_calls_insert on mcp_tool_calls
--   for insert to mcp_telemetry with check (true);
