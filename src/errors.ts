export class UserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserInputError";
  }
}

/** A failure that is safe to show to a caller as written. No secrets, no invented data. */
export class SafeClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeClientError";
  }
}

/** Strip RPC URLs and stack frames from upstream errors before they reach a client. */
export function publicErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Request failed";
  const redacted = raw
    .replace(/https?:\/\/\S+/g, "[rpc]")
    .split("\n")
    .filter((line) => !/^\s*at\s+/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const message = redacted || "Request failed";
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}
