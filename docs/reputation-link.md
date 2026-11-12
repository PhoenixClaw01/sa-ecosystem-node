# Reputation link

The hub kind `reputation-link` is built. Migration M6 is not. A `player-tools` signer set is still planned. This note does not change `HUB_SIGNER_SETS`, production, or aliases.

Only the player signs the sentence, with `signMessage`. That signature is not a transaction and it moves no funds. An agent may prepare the sentence. It must never sign it. No key belongs in `src/`.

An allowlisted hub signer publishes the signed object as a hub update, the same way as `story-optin`. Publishing still needs the hub threshold. The plain page does not render this kind.

## Sentences

`<id>` is the normalized `HUB_GIT_REPO` URL, such as `https://github.com/owner/repo`. It is not the manifest file name.

Link, one scope:

`I link wallet <address> to public profile <profile> on hub <id>. Scope: legacy. Date: <YYYY-MM-DD>.`

`Scope` is `legacy`, `fleets`, `guild`, or `story`. `legacy` is the smallest. A link does not grant any other scope. The scope is part of the sentence, so the publisher cannot widen it. It is not a field on the update.

Unlink:

`I unlink wallet <address> from public profile <profile> on hub <id>. Date: <YYYY-MM-DD>.`

An unlink hides every scope for that wallet and profile from that date on, including a link dated the same day. The records stay in git. `hub_updates` sets `linkShown` to false on a hidden link. A later link, dated after the unlink, can opt a scope back in.

`<profile>` is a public profile name (letters, digits, `.`, `_`, `-`) or a profile address. One counting link per wallet per UTC day. A second link that day stays in the chain and does not add a scope. A date after the current UTC date stays in the chain and does not count until that date. A signature for another repository is `inert`.

## Publish

```bash
npm run hub-add-update -- \
  --store "$HOME/src/sa-hub-store" \
  --id link-legacy \
  --kind reputation-link \
  --body "Link the profile." \
  --reputation-link '{"action":"link","wallet":"<address>","profile":"Pilot","date":"<YYYY-MM-DD>","signature":"<base58>"}' \
  --hub-repo https://github.com/owner/repo \
  --keypair "$HOME/.config/sa-ecosystem-node/author.keypair.json" \
  --approve
```

`--hub-repo` is the https repository URL. When it is omitted, the command uses the store's git origin. The player signature is checked before the file is written. The hub editor commits the file. This command does not submit to the public MCP.

## Still planned

M6 would limit a future `player-tools` set to `story-optin`, player `claim`, and `reputation-link`, and take everyday records off the player wallet. That switch is not this kind. It waits for kind-scoped signer sets and for Founder yes after the soak. Do not edit the live signer files to imitate it.
