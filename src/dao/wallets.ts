/**
 * The two wallets the public DAO names as the current treasury accounts.
 * Checked against the knowledge-base page, the passed PIP-23 text, and the
 * dashboards cited in the Oct 2026 gap review. The retired pre-multisig
 * treasury is recorded so it is not scanned by accident.
 */

export const DAO_TREASURY_ADDRESS = "CuwnarNh7FEqZMmffFjRyWj54RecyS7zwFg1CxfzNudi";
export const ECOSYSTEM_FUND_ADDRESS = "BxKehkp298nQunu8BWxh5U6VvfphFyjEB3t7USst7Uag";

/** Knowledge base: "Old, no longer used, pre-Multi-sig used for the Treasury." Not scanned. */
export const RETIRED_TREASURY_ADDRESS = "DRGThVUMGEYcsoTERhmkFSa5q7HVjxBQdKwMNjyvehD1";

export const WALLET_SOURCE_URL = "https://star-atlas-dao.gitbook.io/knowledge-base/overview/treasury";

export const PIP23_URL = "https://govern.staratlas.com/proposals/0ecf2928-15df-497e-8b67-d87eda030d5a";
export const PIP23_ID = "0ecf2928-15df-497e-8b67-d87eda030d5a";
export const PIP4_URL =
  "https://star-atlas-dao.gitbook.io/knowledge-base/archive/foundational-pips/pip-4-star-atlas-ecosystem-fund";

/** Mint on the PIP-23 refill transactions' parsed ATLAS balances. */
export const ATLAS_MINT = "ATLASXmbPQxBUYbxPsV97usA3fPQYEqzQBUHgiFCUsXx";
export const ATLAS_DECIMALS = 8;

/**
 * Mint of the USDC token account held by the DAO Treasury, discovered with
 * getTokenAccountsByOwner. This is Circle's published Solana USDC mint.
 */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_SOURCE_URL = "https://developers.circle.com/stablecoins/usdc-contract-addresses";

export const GALAXY_PROPOSALS_PATH = "/proposals";
export const GALAXY_VOTES_PATH = "/proposals/votes";
export const GALAXY_TREASURY_PATH = "/dao/treasury";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export const NATIVE_MINT = "native";
export const SOL_DECIMALS = 9;

/** PIP-23 continuous-funding quarter dates, copied as written, including June 20. */
export const PIP23_QUARTER_DATES: readonly { month: number; day: number }[] = [
  { month: 3, day: 31 },
  { month: 6, day: 20 },
  { month: 9, day: 30 },
  { month: 12, day: 31 },
];

export const USDC_REFILL_THRESHOLD = "500000";

export type WalletRole = "dao_treasury" | "ecosystem_fund";

export interface TrackedWallet {
  role: WalletRole;
  address: string;
  name: string;
}

export const TRACKED_WALLETS: readonly TrackedWallet[] = [
  { role: "dao_treasury", address: DAO_TREASURY_ADDRESS, name: "DAO Treasury" },
  { role: "ecosystem_fund", address: ECOSYSTEM_FUND_ADDRESS, name: "Ecosystem Fund" },
];

export function roleOf(address: string): WalletRole | undefined {
  return TRACKED_WALLETS.find((wallet) => wallet.address === address)?.role;
}

export function walletByRole(role: WalletRole): TrackedWallet {
  const wallet = TRACKED_WALLETS.find((item) => item.role === role);
  if (!wallet) throw new Error(`Unknown wallet role ${role}.`);
  return wallet;
}

export function symbolForMint(mint: string): string | null {
  if (mint === ATLAS_MINT) return "ATLAS";
  if (mint === USDC_MINT) return "USDC";
  if (mint === NATIVE_MINT) return "SOL";
  return null;
}

export function solscanTx(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}
