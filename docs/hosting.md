# Run a node anywhere

One file configures every mode. Copy [`node.config.example.json`](../node.config.example.json) to `node.config.json`. The example has public defaults only. Do not commit `node.config.json`, and do not put private keys, API tokens, or wallet secrets in it.

Environment variables override the file. The names are listed in [`.env.example`](../.env.example). A value that is set in the environment wins, so the existing Vercel project can keep using its dashboard settings and does not need the file.

`hub.signerSets` is the list of signer sets this node trusts. Each entry is an id, a path to a `{ "v": 1, "signers": [ { "label", "publicKey" } ] }` file, and a threshold. `hub/signers.json` ships with three testnet public keys, and the example config uses threshold 1: Falkor (`FC1eRr99GGJZuc4KZeUivBpbSMGvjcBB839KaEfAuhcq`), GaliaMeta DAC (`EU7zwmY8QP7B9FFUUyMu1eTNkrwuj27NQkgEmNMWreq1`), and Phoenix Collective (Falkor's team) (`G2PhCi6MApcuC6f5o2CDQBWDnJt9hRcozHuuN55PYisU`). A fourth slot may be added later. Point a set at another file only on the machine that runs the node.

The public deployment is threshold 2 with `hub.allowAuthorApproval` true, so the author's own approval counts as one of the two. The Collective author counts as one approval, and Falkor (`FC1e…`) supplies the second. GaliaMeta DAC stays on the allowlist and is not required for that pair. The example file stays at threshold 1 for a local dry run.

`hub.allowAuthorApproval` defaults to false in the example. Threshold 1 still lets the author be the only approver, and the verified update then has `selfApproved: true`. At threshold 2 or higher the author's approval does not count unless this flag is true. The public deployment sets the flag so the Collective author counts. `hub.revokedSigners` (or `HUB_REVOKED_SIGNERS`) is a local list of signer public keys. It takes effect when the process loads config. An update whose only valid approvals come from those keys is `revoked_signer`, even if the key is still in `hub/signers.json`. Revoking a whole signer group is not implemented. `npm run hub-add-update` writes one signed update into a local store repo. It does not change this file or the shipped signer list.

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

## Docker, a home PC, or any server

```bash
docker compose up --build
```

The image listens on `0.0.0.0:8787` and sets `PUBLIC_NODE=1`. The published port is 8787. Mount your own config over `/app/node.config.json` when you want different public RPC URLs or signer-set files. The image does not contain a secret.

`PUBLIC_NODE=1` serves a hostname other than loopback. Set `ALLOWED_HOSTS` to those names: a LAN name, `your-app.fly.dev`, or the Render host. If `allowedHosts` is empty or `*`, the process exits on startup. `ALLOW_ANY_HOST=1` is a manual opt-in that starts anyway and leaves Host and Origin checks off. The process prints a warning in that case. The Docker image, Compose file, Fly config, and Render config leave that opt-in unset. An allowlist still wins: set `allowedHosts` and the checks turn on even if the opt-in is set.

The process is still read-only: unknown paths return 404, the body cap is `maxRequestBytes` (default 512 KiB), and each client gets `rateLimitMax` requests per window. The limiter is in memory on each instance. It is not shared across instances, and a restart clears it. Expired buckets are dropped as the map grows, and the map stops accepting new keys once it reaches its cap. The key is the socket address. `X-Forwarded-For` is used only when `TRUST_PROXY=1`. Set that only when a reverse proxy overwrites the header. Leave it off for a direct Docker publish, or every client is counted under the proxy address. Fly and Render append to `X-Forwarded-For`, so the left-most hop is spoofable and their configs leave `TRUST_PROXY` unset. The Vercel configs set `TRUST_PROXY=1` because Vercel overwrites the header.

## Vercel

The live Council preview stays the dashboard project. Root Directory remains `dashboard`. Production branch remains `main`. Install command remains empty. The function remains the committed bundle `dashboard/api/mcp.js`. This packaging does not change that deploy. `dashboard/vercel.json` includes `hub/signers.json` with the function. That file is a byte-for-byte copy of the repository `hub/signers.json`, written by `npm run build:dashboard-mcp`. The build also embeds that file's sha256 in the bundle. The function hashes the allowlist it loads and refuses a mismatch, which is the check that runs when only the bundled copy is on disk. `dashboard/vercel.json` and the root `vercel.json` set `TRUST_PROXY=1` because Vercel overwrites `X-Forwarded-For`. The rate limiter on that function is in memory on each instance. The function has no `git` binary. A pinned hub whose `HUB_GIT_REPO` is a public `github.com` URL is downloaded at `HUB_GIT_COMMIT` over HTTPS. Any other git host still needs `git`, which the Docker image has.

Someone else can deploy their own copy of that same dashboard project:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/PhoenixClaw01/sa-ecosystem-node&root-directory=dashboard)

A repo-root Vercel project still uses `api/mcp.ts` and the root `vercel.json` rewrite of `/mcp`. That is not the live dashboard project.

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

## Cloudflare Workers

A Workers entry is not included. Docker checks out a pinned commit with the `git` binary. The Vercel function, which has no `git` binary, downloads a pinned public `github.com` commit over HTTPS and reads `hub/signers.json` from the function bundle. Both paths still read the signer file and the treasury cache with `node:fs`. The plain HTTP server uses `node:http`. Those calls do not run on Workers. Use Docker, the Node HTTP server, stdio, or the existing Vercel function instead.
