/**
 * Proof file passed from discord-code or x-check into hub-attest build.
 * The state binds the OAuth or posted-code check to one wallet and nonce.
 */

export interface VerifierProof {
  v: 1;
  method: "discord" | "x";
  account: string;
  salt: string;
  wallet: string;
  nonce: string;
  state: string;
}

export function bindAttestationState(input: { wallet: string; nonce: string; salt: string }): string {
  return Buffer.from(
    JSON.stringify({ v: 1, wallet: input.wallet, nonce: input.nonce, salt: input.salt }),
    "utf8",
  ).toString("base64url");
}

export function readAttestationState(state: string): { wallet: string; nonce: string; salt: string } | null {
  if (!state || state.length > 500) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1) return null;
  if (typeof record.wallet !== "string" || typeof record.nonce !== "string" || typeof record.salt !== "string") return null;
  if (!record.wallet || !record.nonce || !record.salt) return null;
  return { wallet: record.wallet, nonce: record.nonce, salt: record.salt };
}

export function parseVerifierProof(value: unknown): VerifierProof | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;
  if (record.method !== "discord" && record.method !== "x") return null;
  if (typeof record.account !== "string" || !record.account) return null;
  if (typeof record.salt !== "string" || record.salt.length < 8) return null;
  if (typeof record.wallet !== "string" || typeof record.nonce !== "string" || typeof record.state !== "string") return null;
  const state = readAttestationState(record.state);
  if (!state || state.wallet !== record.wallet || state.nonce !== record.nonce || state.salt !== record.salt) return null;
  return {
    v: 1,
    method: record.method,
    account: record.account,
    salt: record.salt,
    wallet: record.wallet,
    nonce: record.nonce,
    state: record.state,
  };
}
