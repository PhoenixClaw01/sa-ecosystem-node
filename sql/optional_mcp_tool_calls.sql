-- Optional tool-outcome table for an operator who turns telemetry on.
-- The node does not create this table, and it sends nothing until MCP_TELEMETRY_URL is set.
-- Do not add columns for wallet addresses, player ids, search text, IP addresses, or request bodies.
-- Those values are not in the event. The checks match the sealed event enums.

create table if not exists mcp_tool_calls (
  id bigint generated always as identity primary key,
  tool text not null check (tool in (
    'unknown',
    'list_star_systems',
    'get_fleet',
    'profile_key_audit',
    'player_legacy',
    'player_story',
    'dao_overview',
    'treasury_balances',
    'pip_tracker',
    'galaxy_overview',
    'list_categories',
    'hub_updates',
    'list_listings',
    'search_hub',
    'claim_status',
    'list_c4_markers',
    'list_community_tools',
    'data_health',
    'list_proposals',
    'get_proposal_votes',
    'dao_revenue',
    'dao_treasury_flows',
    'dao_payments',
    'treasury_history',
    'ecofund_limit'
  )),
  called_at timestamptz not null,
  env text not null check (env ~ '^[a-z0-9_-]{1,24}$'),
  client_family text not null check (client_family in ('cursor', 'claude', 'vscode', 'chatgpt', 'browser', 'node', 'unknown')),
  outcome text not null check (outcome in ('ok', 'empty', 'unmatched', 'invalid_args', 'error')),
  result_count integer check (result_count is null or result_count >= 0),
  latency_ms integer not null check (latency_ms >= 0),
  error_class text check (error_class is null or error_class in ('invalid_args', 'timeout', 'unavailable', 'upstream', 'rate_limited', 'internal')),
  stream text check (stream is null or stream in ('referral', 'hybrid', 'irl', 'player')),
  category text check (category is null or category in ('ip_and_business', 'creators', 'developers_and_tools', 'guilds_and_dacs', 'events')),
  status text check (status is null or status in ('available', 'sold_out', 'inquire_only', 'paused', 'withdrawn')),
  kind text check (kind is null or kind in (
    'announcement',
    'proposal-note',
    'payment-note',
    'status',
    'signer-change',
    'listing',
    'guild',
    'story-optin',
    'claim',
    'attestation',
    'reputation-link',
    'all'
  )),
  direction text check (direction is null or direction in ('in', 'out', 'all')),
  mint text check (mint is null or mint in ('ATLAS', 'USDC', 'SOL')),
  wallet_role text check (wallet_role is null or wallet_role in ('dao_treasury', 'ecosystem_fund')),
  granularity text check (granularity is null or granularity in ('day', 'month')),
  include_expired boolean,
  include_internal boolean,
  include_fees boolean,
  allow_partial boolean,
  anchored boolean,
  story_status text check (story_status is null or story_status in ('story', 'not_opted_in', 'not_available'))
);

create index if not exists mcp_tool_calls_called_at_idx on mcp_tool_calls (called_at desc);
create index if not exists mcp_tool_calls_tool_outcome_idx on mcp_tool_calls (tool, outcome);

alter table mcp_tool_calls enable row level security;

-- The table owner can insert. Add an insert policy only for the role whose key you set
-- as MCP_TELEMETRY_KEY. Do not add a policy that lets the public read this table.
-- Example, after that role exists:
-- create policy mcp_tool_calls_insert on mcp_tool_calls
--   for insert to mcp_telemetry with check (true);
