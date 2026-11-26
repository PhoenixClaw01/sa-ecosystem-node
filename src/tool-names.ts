/**
 * Tools registered by `createNodeServer`. `submit_hub_update` is not one of them.
 * `src/server.ts` re-exports this list.
 */
export const READ_ONLY_TOOLS = [
  "list_star_systems",
  "get_fleet",
  "profile_key_audit",
  "player_legacy",
  "player_story",
  "dao_overview",
  "treasury_balances",
  "pip_tracker",
  "galaxy_overview",
  "list_categories",
  "hub_updates",
  "list_listings",
  "search_hub",
  "claim_status",
  "list_c4_markers",
  "list_community_tools",
  "data_health",
  "list_proposals",
  "get_proposal_votes",
  "dao_revenue",
  "dao_treasury_flows",
  "dao_payments",
  "treasury_history",
  "ecofund_limit",
] as const;
