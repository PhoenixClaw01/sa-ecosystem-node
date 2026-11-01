/* Star Atlas DAO Dashboard preview config. Preview only. Static file, no secrets. */
window.SA_DASHBOARD_CONFIG = {
  /* Public Council sheet "Star Atlas DAO Council -- PIP Tracker & Grading Rubric".
     The page reads the CSV export of the Tracker tab (gid 0). */
  sheetUrl: "https://docs.google.com/spreadsheets/d/1QWkFjcLwhw4GHqk5Stz72H3WRwIb52f-UDnKne7hTtY/edit?usp=sharing",
  trackerTabName: "Tracker",
  trackerGid: 0,
  fixture: false,
  /* Same-origin copy of that public CSV, used only if the browser cannot load the export. Not sample data. */
  localCsvFallback: "tracker.csv",
  localCsvSavedOn: "2026-10-04",

  wallets: {
    treasury: "CuwnarNh7FEqZMmffFjRyWj54RecyS7zwFg1CxfzNudi",
    ecosystemFund: "BxKehkp298nQunu8BWxh5U6VvfphFyjEB3t7USst7Uag"
  },

  /* Multisigs that control the funds (Squads Protocol v3). Read-only: the page reads each multisig account
     and its latest transactions live, and checks that `vault` is the multisig's vault #vaultIndex.
     Member keys only; on-chain data does not say which Council member holds which key, so no names are attached.
     Fields: label, address (the multisig account), program, controls (key in `wallets`), vault, vaultIndex. */
  multisigs: [
    {
      label: "DAO Treasury multisig",
      address: "D2pEzvQE3Jo6k3H5Cv3uskaUjyQHoFu3hMzpDjHuQ8jj",
      program: "SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu",
      controls: "treasury",
      vault: "CuwnarNh7FEqZMmffFjRyWj54RecyS7zwFg1CxfzNudi",
      vaultIndex: 1
    },
    {
      label: "Ecosystem Fund multisig",
      address: "8Z8QrJEfiGTj9X4HejbsXyAMQToA7SPNE1scGXnC1Vcy",
      program: "SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu",
      controls: "ecosystemFund",
      vault: "BxKehkp298nQunu8BWxh5U6VvfphFyjEB3t7USst7Uag",
      vaultIndex: 1
    }
  ],
  /* How many of the latest multisig transactions to show per fund. */
  multisigRecentTransactions: 5,

  /* Marketplace fees (context only, not a balance-sheet wallet):
     feesQYAaH3wjGUUQYD959mmi5pY8HSz3F5C3SVc1fp3 */

  /* Ecosystem Fund limit. Typed in, not calculated on the page.
     currentLimitAtlas: the current 5% figure (13,992,734 ATLAS).
     nextQuarterLimitAtlas: Council input. No next-quarter formula is published, so leave null until the Council sets it. */
  currentLimitAtlas: 13992734,
  nextQuarterLimitAtlas: null,

  /* Same defaults as the MCP. publicnode answers cross-origin page reads. The official API is the fallback.
     Override rpcUrl to point this preview at another public RPC. */
  rpcUrl: "https://solana-rpc.publicnode.com",
  rpcFallbackUrls: ["https://api.mainnet-beta.solana.com"],
  /* Multisig panels only. balances.json is written by scripts/snapshot-balances.mjs (Node, public RPC, no key).
     Balance tiles do not read this file. They use the MCP balance reader and the treasury cache. */
  balancesSnapshotUrl: "balances.json",

  atlasMint: "ATLASXmbPQxBUYbxPsV97usA3fPQYEqzQBUHgiFCUsXx",
  usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",

  /* Community additions: placeholder cards for features requested by the community and Council.
     Add, remove, or edit entries here; the page draws one card per entry, no other change needed.
     Fields: title, description, status ("placeholder", "requested", "agreed"), source (where the number will come from, once agreed). */
  communityAdditions: [
    { title: "", description: "", status: "placeholder", source: "" },
    { title: "", description: "", status: "placeholder", source: "" },
    { title: "", description: "", status: "placeholder", source: "" }
  ],

  /* DAO Treasury History. Plain link only, opened in a new tab.
     The chart on this page is a separate read of the published treasury cache. */
  rydenGraphUrl: "https://ryden.systems/_vibes/dao_treasury_graph.html",

  /* Public galaxy JSON. The page sends GET only. */
  galaxyBaseUrl: "https://galaxy.staratlas.com",

  /* Same-origin treasury cache published by the refresh workflow. Not fetched from another host. */
  treasuryCacheUrl: "data/treasury-cache.json",

  /* Empty so Ask the MCP keeps showing the recorded sample.
     The live read-only endpoint is /api/mcp. */
  mcpEndpoint: "",
  mcpRecordedUrl: "data/mcp-recorded.json",

  /* Jupiter lite price API. Requested only when the USD box is checked. */
  jupiterPriceUrl: "https://lite-api.jup.ag/price/v3",
  /* Wrapped SOL mint, the id Jupiter uses for a SOL price. Native SOL is not a separate mint here. */
  solMint: "So11111111111111111111111111111111111111112"
};
