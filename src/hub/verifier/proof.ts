/**
 * Proof file passed from discord-code or x-check into hub-attest build.
 * The state is an opaque session key. It does not carry the wallet, nonce, or salt.
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

const OPAQUE_STATE = /^[A-Za-z0-9_-]{43,128}$/;

/** Random session key for an OAuth state or a posted-code proof. Not a JSON payload. */
export function opaqueVerifierState(bytes: Uint8Array): string {
  if (bytes.length < 32 || bytes.length > 64) throw new Error("The Discord state value is not usable.");
  const state = Buffer.from(bytes).toString("base64url");
  if (!verifierStateIsOpaque(state)) throw new Error("The Discord state value is not usable.");
  return state;
}

/** True when the state is an opaque key and not a base64 JSON binding. */
export function verifierStateIsOpaque(state: string): boolean {
  if (!OPAQUE_STATE.test(state)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if ("wallet" in record || "nonce" in record || "salt" in record) return false;
    }
  } catch {
    // Not JSON. That is the expected shape.
  }
  return true;
}

export function parseVerifierProof(value: unknown): VerifierProof | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;
  if (record.method !== "discord" && record.method !== "x") return null;
  if (typeof record.account !== "string" || !record.account) return null;
  if (typeof record.salt !== "string" || record.salt.length < 8) return null;
  if (typeof record.wallet !== "string" || typeof record.nonce !== "string" || typeof record.state !== "string") return null;
  if (!verifierStateIsOpaque(record.state)) return null;
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
