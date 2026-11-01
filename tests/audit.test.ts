import { describe, expect, it } from "vitest";

import { assessProfileKey, auditProfileKeys, type ProfileKeyInput } from "../src/profile/audit.js";

const NOW = Date.parse("2026-10-23T00:00:00.000Z");
const NOW_SECONDS = BigInt(Math.floor(NOW / 1000));

function key(overrides: Partial<ProfileKeyInput> = {}): ProfileKeyInput {
  return {
    address: "Key111",
    scope: "Scope111",
    expiresAt: NOW_SECONDS + 86_400n,
    expiresAtRaw: NOW_SECONDS + 86_400n,
    permissionsRaw: 1n,
    permissions: ["authenticate"],
    ...overrides,
  };
}

describe("profile key audit", () => {
  it("flags a short-lived authenticate key as low risk", () => {
    const audited = assessProfileKey(key(), NOW);
    expect(audited.risk).toBe("low");
    expect(audited.active).toBe(true);
    expect(audited.flags).toEqual([]);
    expect(audited.permissions).toEqual(["authenticate"]);
    expect(audited.expiresAt).toBe(new Date(Number(NOW_SECONDS + 86_400n) * 1000).toISOString());
  });

  it("treats a negative raw expiry as no expiry and raises risk when the key can do more than authenticate", () => {
    const audited = assessProfileKey(
      key({
        expiresAt: undefined,
        expiresAtRaw: -1n,
        permissions: ["authenticate", "changeName"],
        permissionsRaw: 9n,
      }),
      NOW,
    );
    expect(audited.expiresAt).toBeNull();
    expect(audited.flags).toContain("no_expiry");
    expect(audited.flags).toContain("can_change_name");
    expect(audited.risk).toBe("high");
  });

  it("flags key management and vault drain as high risk even with an expiry", () => {
    const audited = assessProfileKey(
      key({ permissions: ["addKeys", "drainSolVault"], permissionsRaw: 42n }),
      NOW,
    );
    expect(audited.flags).toEqual(expect.arrayContaining(["manages_keys", "can_drain_sol_vault"]));
    expect(audited.risk).toBe("high");
  });

  it("marks an expired key inactive and still lists its permissions", () => {
    const audited = assessProfileKey(
      key({ expiresAt: NOW_SECONDS - 10n, expiresAtRaw: NOW_SECONDS - 10n, permissions: ["removeMember"] }),
      NOW,
    );
    expect(audited.active).toBe(false);
    expect(audited.flags).toContain("expired");
    expect(audited.permissions).toEqual(["removeMember"]);
    expect(audited.risk).toBe("medium");
  });

  it("counts high-risk keys on a profile", () => {
    const audit = auditProfileKeys(
      {
        profileAddress: "Profile111",
        keyThreshold: 1,
        authKeyCount: 2,
        keys: [key(), key({ address: "Key222", permissions: ["removeKeys"] })],
      },
      NOW,
    );
    expect(audit.keyCount).toBe(2);
    expect(audit.riskyKeyCount).toBe(1);
    expect(audit.keys[1]?.scope).toBe("Scope111");
  });
});
