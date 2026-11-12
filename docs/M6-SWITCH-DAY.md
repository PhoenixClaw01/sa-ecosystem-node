# M6 switch day

This file is the switch plan. It is not applied. The production node still trusts the unscoped `agents` set. Do not change `HUB_SIGNER_SETS` until the Founder says yes, after the 7-day soak (about 18 Nov 2026). Shipping this code does not scope any key. A set with no `kinds` still counts for every record kind.

`claim` in `kinds` counts only when the action is `claim` and the subject is `player`. Revoke and resolve are outside that scope. A wallet can still revoke its own claim.

## Exact value

Agents stays unscoped at threshold 2. Player-tools is threshold 1 and limited to `story-optin`, player `claim`, and `reputation-link`.

```json
[{"id":"agents","path":"hub/signers/agents.json","threshold":2},{"id":"player-tools","path":"hub/signers/player-tools.json","threshold":1,"kinds":["story-optin","claim","reputation-link"]}]
```

`hub/signers/player-tools.json` holds only the player wallet `FC1e…uhcq`. `hub/signers.json` stays the unscoped rollback file. Do not add that wallet to `HUB_REVOKED_SIGNERS`.

## Checks

Pin: `HUB_GIT_COMMIT=08d3fa1e0f5756843d47595c6000abcac5e94bf5`, manifest sha256 `1fd4536e3a5b4176beebc04c16c53834092f519d98c0e30172862a2f24ae24f2`.

Before the change, agents only:

```json
[{"id":"agents","path":"hub/signers/agents.json","threshold":2}]
```

`hub_updates`: 55 updates, 0 rejected, approved by `AANz…gH` and `G2Ph…`.

After the change, the same pin with the exact value above: 55 updates, 0 rejected, approved by `AANz…gH` and `G2Ph…`.

## EU7z on the allowlist

`EU7z…req1` is on `hub/signers.json` and has signed no record. Founder decision, left blank:

- Keep `EU7z…req1` on the allowlist:
- Remove `EU7z…req1` from the allowlist:

## Rollback

Restore the agents-only value: `HUB_SIGNER_SETS=[{"id":"agents","path":"hub/signers/agents.json","threshold":2}]`

Full rollback: `HUB_GIT_COMMIT=f064f18db1da60c4f3e562d4064c8f344042e97e`
