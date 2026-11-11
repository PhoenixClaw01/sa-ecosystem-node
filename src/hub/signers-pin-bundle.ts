import { SafeClientError } from "../errors.js";

/**
 * Replaced by esbuild `define` in `npm run build:dashboard-mcp`.
 * A bundle that includes this module without that define throws on load of signers.
 */
declare const __SA_SIGNERS_SHA256_DEFINE__: string;
/** A JSON array of sha256 hex strings, inlined as a string literal. */
declare const __SA_SIGNER_SET_SHA256S_DEFINE__: string;

export function embeddedSignersSha(): string {
  let value: unknown;
  try {
    value = __SA_SIGNERS_SHA256_DEFINE__;
  } catch {
    value = undefined;
  }
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new SafeClientError("The signer allowlist could not be read. No updates were returned.");
  }
  return value;
}

/** sha256 of every extra signer-set file the bundle ships. Each one is a byte copy of a repository file. */
export function embeddedSignerSetShas(): string[] {
  let value: unknown;
  try {
    value = JSON.parse(__SA_SIGNER_SET_SHA256S_DEFINE__) as unknown;
  } catch {
    value = undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !/^[0-9a-f]{64}$/.test(entry))) {
    throw new SafeClientError("The signer allowlist could not be read. No updates were returned.");
  }
  return [...value] as string[];
}
