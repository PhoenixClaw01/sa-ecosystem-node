/**
 * Types for a future wallet-signed hub update.
 * Not implemented. v0 does not queue, store, or publish updates.
 * Full development waits for the Founder's go.
 *
 * A later write may add text, links, and images only. It must not move funds,
 * touch game keys, or cast votes.
 */

export const HUB_UPDATE_IMPLEMENTATION = "not_implemented" as const;

export const ECOSYSTEM_CATEGORIES = [
  "ip_and_business",
  "creators",
  "developers_and_tools",
  "guilds_and_dacs",
  "events",
] as const;

export type EcosystemCategory = (typeof ECOSYSTEM_CATEGORIES)[number];

/** Scoped, expiring agent key delegated by an ecosystem wallet. */
export interface DelegatedAgentKeyRef {
  publicKey: string;
  scope: readonly string[];
  /** ISO-8601. Delegated keys must expire. */
  expiresAt: string;
}

/**
 * The bytes a signer would cover. Key order is fixed.
 * The signature itself stays outside this object.
 */
export interface HubUpdateBody {
  v: 0;
  ecosystemWallet: string;
  category: EcosystemCategory;
  title: string;
  body: string;
  links: readonly string[];
  imageUrls: readonly string[];
}

export interface HubUpdateSubmission {
  update: HubUpdateBody;
  /** Public key of the ecosystem wallet or its delegated agent key. */
  signerPublicKey: string;
  /** Detached ed25519 signature over {@link canonicalHubUpdateBytes}, hex. */
  signatureHex: string;
  delegatedKey?: DelegatedAgentKeyRef;
}

export function canonicalHubUpdateBytes(update: HubUpdateBody): Uint8Array {
  const canonical = {
    body: update.body,
    category: update.category,
    ecosystemWallet: update.ecosystemWallet,
    imageUrls: [...update.imageUrls],
    links: [...update.links],
    title: update.title,
    v: 0 as const,
  };
  return new TextEncoder().encode(JSON.stringify(canonical));
}

/**
 * Future queue entry point. There is no implementation: calling the type's
 * shape is a type error unless a caller supplies their own function, and v0
 * does not register an MCP tool for it.
 */
export type SubmitHubUpdate = (input: HubUpdateSubmission) => Promise<never>;
