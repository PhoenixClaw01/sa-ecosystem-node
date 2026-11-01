const THIRTY_DAYS_SECONDS = 30n * 24n * 60n * 60n;

const MEMBERSHIP_PERMISSIONS = new Set([
  "addMember",
  "removeMember",
  "createRole",
  "removeRole",
  "setAuthorizer",
  "toggleAcceptingNewMembers",
]);

export interface ProfileKeyInput {
  address: string;
  scope: string;
  expiresAt?: bigint;
  expiresAtRaw: bigint;
  permissionsRaw: bigint;
  permissions: readonly string[];
}

export interface AuditedKey {
  address: string;
  scope: string;
  /** ISO-8601, or null when the key has no expiry. */
  expiresAt: string | null;
  permissions: string[];
  permissionsRaw: string;
  active: boolean;
  risk: "high" | "medium" | "low";
  flags: string[];
}

export interface ProfileKeyAudit {
  profileAddress: string;
  keyThreshold: number;
  authKeyCount: number;
  keyCount: number;
  riskyKeyCount: number;
  keys: AuditedKey[];
}

function unixSecondsToIso(seconds: bigint): string {
  if (seconds > BigInt(Number.MAX_SAFE_INTEGER)) return seconds.toString();
  return new Date(Number(seconds) * 1000).toISOString();
}

function hasNoExpiry(key: ProfileKeyInput): boolean {
  return key.expiresAt === undefined || key.expiresAtRaw < 0n;
}

/** Heuristic flags for one profile key. These are not chain policy. */
export function assessProfileKey(key: ProfileKeyInput, nowMs: number): AuditedKey {
  const flags: string[] = [];
  const nowSeconds = BigInt(Math.floor(nowMs / 1000));
  const noExpiry = hasNoExpiry(key);
  let active = true;

  if (noExpiry) {
    flags.push("no_expiry");
  } else if (key.expiresAt !== undefined && key.expiresAt <= nowSeconds) {
    flags.push("expired");
    active = false;
  } else if (key.expiresAt !== undefined && key.expiresAt - nowSeconds > THIRTY_DAYS_SECONDS) {
    flags.push("expiry_beyond_30_days");
  }

  if (key.permissions.some((permission) => permission === "addKeys" || permission === "removeKeys")) {
    flags.push("manages_keys");
  }
  if (key.permissions.includes("drainSolVault")) flags.push("can_drain_sol_vault");
  if (key.permissions.some((permission) => MEMBERSHIP_PERMISSIONS.has(permission))) {
    flags.push("manages_members");
  }
  if (key.permissions.includes("changeName")) flags.push("can_change_name");

  const beyondAuthenticate = key.permissions.some((permission) => permission !== "authenticate");
  let risk: AuditedKey["risk"];
  if (
    flags.includes("manages_keys") ||
    flags.includes("can_drain_sol_vault") ||
    (flags.includes("no_expiry") && beyondAuthenticate)
  ) {
    risk = "high";
  } else if (
    flags.includes("manages_members") ||
    flags.includes("no_expiry") ||
    flags.includes("expiry_beyond_30_days") ||
    key.permissions.length >= 4
  ) {
    risk = "medium";
  } else {
    risk = "low";
  }

  return {
    address: key.address,
    scope: key.scope,
    expiresAt: noExpiry || key.expiresAt === undefined ? null : unixSecondsToIso(key.expiresAt),
    permissions: [...key.permissions],
    permissionsRaw: key.permissionsRaw.toString(),
    active,
    risk,
    flags,
  };
}

export function auditProfileKeys(
  input: {
    profileAddress: string;
    keyThreshold: number;
    authKeyCount: number;
    keys: readonly ProfileKeyInput[];
  },
  nowMs = Date.now(),
): ProfileKeyAudit {
  const keys = input.keys.map((key) => assessProfileKey(key, nowMs));
  return {
    profileAddress: input.profileAddress,
    keyThreshold: input.keyThreshold,
    authKeyCount: input.authKeyCount,
    keyCount: keys.length,
    riskyKeyCount: keys.filter((key) => key.risk === "high").length,
    keys,
  };
}
