/**
 * Node process and tests. The dashboard bundle replaces this module.
 * A missing pin here means the operator's signer file is the source of truth.
 */
export function embeddedSignersSha(): string | null {
  return null;
}

/** Extra signer-set files shipped in the dashboard bundle (for example hub/signers/agents.json). None in the node process. */
export function embeddedSignerSetShas(): string[] | null {
  return null;
}
