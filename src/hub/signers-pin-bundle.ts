import { SafeClientError } from "../errors.js";

/**
 * Replaced by esbuild `define` in `npm run build:dashboard-mcp`.
 * A bundle that includes this module without that define throws on load of signers.
 */
declare const __SA_SIGNERS_SHA256_DEFINE__: string;

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
