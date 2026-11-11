# Run a node anywhere

One file configures every mode. Copy [`node.config.example.json`](../node.config.example.json) to `node.config.json`. The example has public defaults only. Do not commit `node.config.json`, and do not put private keys, API tokens, or wallet secrets in it.

Environment variables override the file. The names are listed in [`.env.example`](../.env.example). A value that is set in the environment wins.

The public node is the Vercel project `sa-ecosystem-node-dashboard`:

[https://sa-ecosystem-node-dashboard.vercel.app](https://sa-ecosystem-node-dashboard.vercel.app)

That project is separate from the DAO Council preview. Its MCP endpoint, home page, and environment are in the Vercel section below. The spec for what the node does is [spec.md](spec.md).

## Signer sets

`hub.signerSets` is the list of signer sets this node trusts. Each entry is an id, a path to a `{ "v": 1, "signers": [ { "label", "publicKey" } ] }` file, and a threshold. `hub/signers.json` ships with three public keys, and the example config uses threshold 1: Falkor (`FC1eRr99GGJZuc4KZeUivBpbSMGvjcBB839KaEfAuhcq`), GaliaMeta DAC (`EU7zwmY8QP7B9FFUUyMu1eTNkrwuj27NQkgEmNMWreq1`), and Phoenix Collective (Falkor's team) (`G2PhCi6MApcuC6f5o2CDQBWDnJt9hRcozHuuN55PYisU`). A fourth slot may be added later. Point a set at another file only on the machine that runs the node.

`hub/signers/agents.json` is a second signer file with two Phoenix agent record keys: Phoenix Collective (Falkor's team) (`G2PhCi6MApcuC6f5o2CDQBWDnJt9hRcozHuuN55PYisU`) and Phoenix reviewer (`AANzSFjMzGuKn5gC1YygMsZZGeLUiMM9HAmKH6n2YqgH`). The two keys were made on different machines, and neither holds funds. It is the `agents` set from the agent-key migration in [`protocol/h2h/SPEC.md`](../protocol/h2h/SPEC.md) section 17. **The public node does not use it yet.** It switches only at step M5, which needs the Founder's yes. To trust both files, set:

    HUB_SIGNER_SETS=[{"id":"default","path":"hub/signers.json","threshold":2},{"id":"agents","path":"hub/signers/agents.json","threshold":2}]

A relative `path` is looked up the same way as the default signer file: first under the working directory, then next to the code (for the dashboard bundle in `dashboard/api/`, that is `dashboard/hub/...`). On Vercel the working directory is not `dashboard/`, so this fallback is what finds the shipped copies. An absolute path is used as given. `npm run test:live-hub` checks both sets against the public hub from the repo root and from the temp directory.

A record counts when one set's keys meet that set's threshold. With both sets, the pre-migration commit and the migration commit both verify, so the default set stays the rollback path. The dashboard bundle ships a byte copy of each signer file under `dashboard/hub/` and pins every copy by sha256. Edit the file under `hub/`, then run `npm run build:dashboard-mcp`. A copy that does not match its pin is refused, and no updates are returned.

`npm run sign-hub-update -- --drop-approval <file> --public-key <address> [--out <file>]` removes one approval and leaves the payload, the author signature, and the other approvals as they are. Keep the removed signature as provenance outside the manifest first, as the migration does.

`hub.allowAuthorApproval` defaults to false in the example. Threshold 1 still lets the author be the only approver, and the verified update then has `selfApproved: true`. At threshold 2 or higher the author's approval does not count unless this flag is true. A signer-change never counts the author. `hub.revokedSigners` (or `HUB_REVOKED_SIGNERS`) is a local list of signer public keys. It takes effect when the process loads config. An update whose only valid approvals come from those keys is `revoked_signer`, even if the key is still in `hub/signers.json`. Revoking a whole signer group is not implemented. **Revocation is retroactive:** if a revoked key approved a record that still needs it to meet the threshold, that record and every later record in the chain are rejected. Re-approve those records with another key first, or use an in-chain `signer-change`. `npm run hub-add-update` writes one signed update into a local store repo. It does not change this file or the shipped signer list.

The public node sets the threshold and the author-approval flag. The values are in the table below.

## Environment variables

Names and meanings. The public values are the ones set on `sa-ecosystem-node-dashboard` or observed from that site on 1 November 2026. Do not put a secret in any of these.

| Name | Meaning | On the public node |
|---|---|---|
| `PUBLIC_HOME` | Read by `dashboard/middleware.js` only. The value `plain` answers `/` and `/index.html` with 302 to `/plain/`. Any other value, including unset, serves the file at that path. The MCP server does not read this variable. `GET /` on `npm start` stays the status document | `plain` |
| `HUB_GIT_REPO` | Public `https` git URL, no username, password, query, or hash. An absolute local path is accepted for a test on your own machine | `https://github.com/PhoenixClaw01/sa-ecosystem-hub` |
| `HUB_GIT_COMMIT` | Full 40-character lowercase hex commit. The node refuses the hub read if checkout is not this commit | `f064f18db1da60c4f3e562d4064c8f344042e97e` (the commit in live hub-relative logo URLs that day) |
| `HUB_STORE_MANIFEST` | Path of the manifest inside the commit. Unset reads `hub-manifest.json`, then `manifest.json` only if the first file is missing. Set, it selects that one path | Unset in the example. The public pin matches `hub-manifest.json` at the commit above |
| `HUB_STORE_MANIFEST_HASH` | sha256 hex of the manifest file bytes. A mismatch refuses the whole hub read | `1fd4536e3a5b4176beebc04c16c53834092f519d98c0e30172862a2f24ae24f2` (sha256 of `hub-manifest.json` at that commit). `list_listings` returned rows, which it does only when this pin matches the file the node opened |
| `HUB_APPROVAL_THRESHOLD` | How many distinct allowlisted approval signatures an update needs. Positive integer, at most 200. Default 1 | `2` |
| `HUB_ALLOW_AUTHOR_APPROVAL` | When `true`, the author's own approval counts at threshold 2 or higher. Default `false`. Threshold 1 counts the author either way. A signer-change never counts the author | `true` |
| `HUB_REVOKED_SIGNERS` | Comma-separated base58 addresses, or a JSON array. Applied when the process loads config | Not part of the published pin. Empty unless an operator sets it |
| `HUB_TRUSTED_VERIFIERS` | Verifier public keys. An attestation from one of these keys is `verified`. Any other attestation stays `self-attested, unverified`. Same list shape as `HUB_REVOKED_SIGNERS`. Empty by default | Empty unless an operator sets it. The public page does not print raw handles |
| `HUB_SIGNERS_PATH` | Single allowlist file when `HUB_SIGNER_SETS` is omitted | The function bundle includes `hub/signers.json`, a byte-for-byte copy of the repository file |
| `HUB_SIGNER_SETS` | JSON array of `{ "id", "path", "threshold" }`. Overrides the single path. The two-set value is in "Signer sets" above | Not set today, so the node uses one default set at the `HUB_APPROVAL_THRESHOLD` above. The two-set value is planned for step M5 |

Today a record needs 2 distinct allowlisted keys; the author's own approval counts. Phoenix Collective (`G2PhCi6MApcuC6f5o2CDQBWDnJt9hRcozHuuN55PYisU`) is the author key in `hub/signers.json`. Falkor (`FC1eRr99GGJZuc4KZeUivBpbSMGvjcBB839KaEfAuhcq`) supplies the second. GaliaMeta DAC stays on the allowlist and is not required for that pair.

`HUB_GIT_REPO`, `HUB_GIT_COMMIT`, and `HUB_STORE_MANIFEST_HASH` are set together on the public node. Leave all three unset on a local process and the hub tools return no rows. Do not add a submit tool.

These are not hub pins. They have the same meaning on every host:

| Name | Meaning |
|---|---|
| `ZINK_RPC_URL` | Game reads. Default `https://testnet-rpc.z.ink` |
| `SOLANA_RPC_URL` | Solana reads. Default `https://solana-rpc.publicnode.com` |
| `SOLANA_RPC_FALLBACK_URLS` | Tried, in order, when the primary URL refuses a read. Default `https://api.mainnet-beta.solana.com` |
| `GALAXY_BASE_URL` | Galaxy JSON origin. Default `https://galaxy.staratlas.com` |
| `TREASURY_CACHE_PATH` | Cache file the treasury history tools read. The server process does not refresh it |
| `HOST`, `PORT` | Local bind. Default `127.0.0.1:8787` |
| `PUBLIC_NODE` | `1` serves a hostname other than loopback and stays read-only |
| `ALLOWED_HOSTS` | Hostnames for that public process. Empty or `*` refuses to start unless `ALLOW_ANY_HOST=1` |
| `ALLOW_ANY_HOST` | Manual opt-in that starts with Host and Origin checks off, and prints a warning. Deploy templates leave it unset |
| `TRUST_PROXY` | When `1`, the rate-limit key is the first `X-Forwarded-For` hop. Off, the key is the socket address |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` | In-memory limit per instance. Defaults 120 requests and 60000 ms |
| `MAX_REQUEST_BYTES`, `MAX_RESPONSE_BYTES` | Default 524288 (512 KiB) each |
| `NODE_CONFIG` | Path of the config file. Default `node.config.json` |

`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and `DISCORD_REDIRECT_URI` belong to the optional operator command `npm run hub-attest`. The public server does not import that module (`src/hub/verifier/discord-oauth.ts`). Leave the secret off the public project. Do not commit it.

## Local HTTP

```bash
npm install
npm start
```

`npm start` builds and runs `node dist/http.js`. The default bind is `127.0.0.1:8787`. `GET /` is a read-only status document. MCP is `POST /mcp` and `GET /mcp`. There is no submit route.

## Claude Desktop and Cursor, no hosting

Build once, then point the client at the stdio process. `npx` runs the same process through the package bin:

```bash
npm install
npm run build
```

Cursor or Claude Desktop `mcpServers` entry, using the checkout path:

```json
{
  "mcpServers": {
    "sa-ecosystem-node": {
      "command": "npx",
      "args": ["--prefix", "/absolute/path/to/sa-ecosystem-node", "sa-ecosystem-node"]
    }
  }
}
```

The same process is `node dist/stdio.js` and `npm run start:stdio`. It speaks MCP on stdin and stdout. It does not open a port.

To use the public node instead of a local process, put the URL in the client. The README has the Cursor and Claude Desktop snippets for `https://sa-ecosystem-node-dashboard.vercel.app/api/mcp`.

## Docker, a home PC, or any server

```bash
docker compose up --build
```

The image listens on `0.0.0.0:8787` and sets `PUBLIC_NODE=1`. The published port is 8787. Mount your own config over `/app/node.config.json` when you want different public RPC URLs or signer-set files. The image does not contain a secret.

`PUBLIC_NODE=1` serves a hostname other than loopback. Set `ALLOWED_HOSTS` to those names: a LAN name, `your-app.fly.dev`, or the Render host. If `allowedHosts` is empty or `*`, the process exits on startup. `ALLOW_ANY_HOST=1` is a manual opt-in that starts anyway and leaves Host and Origin checks off. The process prints a warning in that case. The Docker image, Compose file, Fly config, and Render config leave that opt-in unset. An allowlist still wins: set `allowedHosts` and the checks turn on even if the opt-in is set.

The process is still read-only: unknown paths return 404, the body cap is `maxRequestBytes` (default 512 KiB), and each client gets `rateLimitMax` requests per window. The limiter is in memory on each instance. It is not shared across instances, and a restart clears it. Expired buckets are dropped as the map grows, and the map stops accepting new keys once it reaches its cap. The key is the socket address. `X-Forwarded-For` is used only when `TRUST_PROXY=1`. Set that only when a reverse proxy overwrites the header. Leave it off for a direct Docker publish, or every client is counted under the proxy address. Fly and Render append to `X-Forwarded-For`, so the left-most hop is spoofable and their configs leave `TRUST_PROXY` unset. The Vercel configs set `TRUST_PROXY=1` because Vercel overwrites the header.

## Vercel

The live public node is project `sa-ecosystem-node-dashboard`. It is separate from the DAO Council preview. Root Directory is `dashboard`. Production branch is `main`. The install command is empty. The function is the committed bundle `dashboard/api/mcp.js` (`npm run build:dashboard-mcp`). `dashboard/vercel.json` includes `hub/signers.json` with the function. That file is a byte-for-byte copy of the repository `hub/signers.json`. The build embeds that file's sha256 in the bundle. The function hashes the allowlist it loads and refuses a mismatch, which is the check that runs when only the bundled copy is on disk. `dashboard/vercel.json` and the root `vercel.json` set `TRUST_PROXY=1` because Vercel overwrites `X-Forwarded-For`. The rate limiter on that function is in memory on each instance. The function has no `git` binary. A pinned hub whose `HUB_GIT_REPO` is a public `github.com` URL is downloaded at `HUB_GIT_COMMIT` over HTTPS. Any other git host still needs `git`, which the Docker image has.

`PUBLIC_HOME=plain` on that project redirects `/` and `/index.html` to `/plain/` with status 302. `/plain/` is the indexable reading page. MCP is `https://sa-ecosystem-node-dashboard.vercel.app/api/mcp`. Discovery is `https://sa-ecosystem-node-dashboard.vercel.app/.well-known/mcp.json`. The function `maxDuration` is 25 seconds. Each MCP request stops at 20 seconds so the client gets a clean timeout. Node.js for the dashboard package is 22.

Someone else can deploy their own copy of that same dashboard project:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/PhoenixClaw01/sa-ecosystem-node&root-directory=dashboard)

A copy does not inherit the public project's environment. Set `PUBLIC_HOME` and the `HUB_*` variables yourself if you want the same home page and the same hub pin.

A repo-root Vercel project still uses `api/mcp.ts` and the root `vercel.json` rewrite of `/mcp`. That is not the live public node. The live project uses Root Directory `dashboard`.

## Railway, Fly, Render

These three run the same Docker image. No database, no volume, and no paid addon is declared.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https://github.com/PhoenixClaw01/sa-ecosystem-node)

```bash
fly launch --copy-config --no-deploy
fly deploy
```

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/PhoenixClaw01/sa-ecosystem-node)

`render.yaml` asks for Render's free instance. If that plan is not offered, run the Docker image on a computer you already have instead of picking a paid instance. `fly.toml` uses one shared-cpu 256 MB machine that stops when idle. `railway.toml` builds the Dockerfile and checks `GET /`.

Fly and Render leave `ALLOW_ANY_HOST` and `TRUST_PROXY` unset. Set `ALLOWED_HOSTS` to the public hostname (`your-app.fly.dev`, or the Render host) or the process exits on startup. On Fly, `fly secrets set ALLOWED_HOSTS=your-app.fly.dev`. On Render, set that variable to the service host. In Compose, set it on the service environment. Both platforms append to `X-Forwarded-For`, so the left-most hop can be spoofed. The rate-limit key stays the socket address. A future per-client key could use `Fly-Client-IP` or `CF-Connecting-IP` under its own flag. That flag is not implemented. Railway uses the image env, which also leaves the any-host opt-in unset and leaves `TRUST_PROXY` off until you set it.

Set `HUB_GIT_REPO`, `HUB_GIT_COMMIT`, and `HUB_STORE_MANIFEST_HASH` on that host when it should serve the hub. Set `HUB_APPROVAL_THRESHOLD` and `HUB_ALLOW_AUTHOR_APPROVAL` to match the signatures in the commit you pin.

## Cloudflare Workers

A Workers entry is not included. Docker checks out a pinned commit with the `git` binary. The Vercel function, which has no `git` binary, downloads a pinned public `github.com` commit over HTTPS and reads `hub/signers.json` from the function bundle. Both paths still read the signer file and the treasury cache with `node:fs`. The plain HTTP server uses `node:http`. Those calls do not run on Workers. Use Docker, the Node HTTP server, stdio, or the existing Vercel function instead.
