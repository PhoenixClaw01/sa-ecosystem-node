import { lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { LocalPathError, PATH_NOT_EMPTY, safeNewDirectory } from "./repo-path.js";
import { HUB_APPROVAL_DOMAIN, HUB_UPDATE_DOMAIN, HUB_UPDATE_SCHEMA } from "./update.js";

/**
 * Writes the public hub store skeleton: a README, hub-manifest.json, and updates/.
 * The directory is a separate git repository. It holds signed JSON only.
 * hub-manifest.json is the path a node reads when HUB_STORE_MANIFEST is unset.
 */

const USAGE = "Usage: npm run hub-store-init -- --dir <path>\n";

function fail(message: string): { code: number; stdout: string; stderr: string } {
  return { code: 1, stdout: "", stderr: `${message}\n` };
}

function domainLine(domain: string): string {
  return `${JSON.stringify(domain.slice(0, -1))} and a newline`;
}

export function formatHubStoreManifest(updates: readonly string[]): string {
  for (const update of updates) {
    if (update.length === 0 || update.length > 200 || update.startsWith("/") || update.includes("\\") || update.includes("\0")) {
      throw new Error("The manifest path is not valid.");
    }
    if (update.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error("The manifest path is not valid.");
    }
  }
  return `${JSON.stringify({ v: 1, updates: [...updates] }, null, 2)}\n`;
}

export function hubStoreReadme(): string {
  return `# Public hub update store

This directory is a public git repository of signed hub updates for schema ${HUB_UPDATE_SCHEMA}. It holds \`hub-manifest.json\` and the files that manifest lists. It does not hold signing keys, node source, or governance records.

## Layout

\`hub-manifest.json\` has this shape:

    {
      "v": 1,
      "updates": []
    }

Each path in \`updates\` is one JSON document with \`payload\`, \`signature\`, and \`approvals\`. \`updates/.gitkeep\` keeps the empty directory in git. Delete that marker after the first update file is added.

Do not put a symlink or a git submodule in this directory. A symlink can make a manifest path point outside the checkout. A submodule is another repository. \`npm run hub-store-init\` refuses a directory that already has either.

## How to verify

1. Check out the commit in \`HUB_GIT_COMMIT\`. \`git rev-parse HEAD\` must print that 40-character hex id.
2. Hash the manifest bytes. \`sha256sum hub-manifest.json\` must print the 64-character hex id in \`HUB_STORE_MANIFEST_HASH\`. The hash is of the file bytes. Reformatting the file changes the hash.
3. Leave \`HUB_STORE_MANIFEST\` unset. A node then reads \`hub-manifest.json\`. When that file is missing, the node reads \`manifest.json\`. The hash pin is checked against the file that was read. A file that is present with a different hash is refused, and the other filename is not tried. Setting \`HUB_STORE_MANIFEST\` selects that path and does not try the other name.
4. The author signature is detached ed25519 over the UTF-8 bytes of the author domain plus the payload's canonical JSON. Canonical JSON sorts keys and has no whitespace. The domain is ${domainLine(HUB_UPDATE_DOMAIN)}.
5. Each approval is detached ed25519 over the UTF-8 bytes of the approval domain plus the sha256 hex of that canonical JSON. The domain is ${domainLine(HUB_APPROVAL_DOMAIN)}. \`publicKey\` is the signer's base58 address. A Solana wallet signs these bytes off-chain. The bytes are not a transaction and they move no funds.
6. A node returns an update only when the author is on that node's allowlist and the number of distinct allowlisted approval signatures is at least \`HUB_APPROVAL_THRESHOLD\`. One signer counts once. At threshold 1 the author's own approval can be that signature. At threshold 2 or higher the author's approval counts only when the node is configured to allow it. A node can also ignore individual public keys on a local revoked list. Revoking a whole signer group is not part of this store.

A payload with kind \`listing\` also has a \`listing\` object. The fields are \`stream\` (\`referral\`, \`hybrid\`, \`irl\`, or \`player\`), \`category\`, \`title\`, \`owner\`, \`url\`, \`status\` (\`available\`, \`sold_out\`, \`inquire_only\`, \`paused\`, or \`withdrawn\`), \`asOf\`, \`expiresAt\`, and optionally \`offerText\`, \`verifyLiveNote\`, \`disclosure\`, \`ownershipProof\` (\`method\` of \`wallet_signed\`, \`site_code\`, or \`signer_review\`, plus \`evidenceRef\`), and \`image\`. \`disclosure\` is required when \`stream\` is \`referral\`. \`asOf\` and \`expiresAt\` are \`YYYY-MM-DD\` dates, and \`expiresAt\` is at most 90 days after \`asOf\`. A field outside that set is rejected. The \`url\` is the business's own page. A node does not take payment. The same signer, threshold, revocation, and manifest-pin checks apply.

\`image\`, when present, is \`{ "url", "alt", "link"? }\`. \`alt\` is required and is at most 140 characters. \`url\` is either an \`https\` URL whose path ends in \`.png\`, \`.jpg\`, \`.jpeg\`, or \`.webp\`, or a hub-relative path such as \`images/logo.png\` with the same extension. A hub-relative path matches \`^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$\`, rejects \`%\`, and rejects \`.\` or \`..\` segments. Commit the logo file into the hub repository. The plain page shows only that hub file, resolved to \`https://raw.githubusercontent.com/<owner>/<repo>/<commit>/<path>\` at the pinned 40-character commit. An external https logo stays valid in the signed payload and in MCP output, and the page does not load it. \`link\` is an optional \`https\` page. \`data:\`, \`javascript:\`, \`http:\`, and SVG are refused. The image is part of the signed payload. Nothing is uploaded through MCP. \`status\` \`withdrawn\` is a takedown. Optional \`listingId\` is the stable identity of an offer. Without it, the identity is \`stream\`, \`category\`, and the normalized title and owner. \`list_listings\`, \`search_hub\`, and the story context keep only the newest hub-chain update for that identity. A newest \`withdrawn\` drops it until a later update publishes it again. Chain order follows \`prev\`, not \`created_at\`. The signed update remains on the hub. Any allowlisted signer who meets the threshold can replace or withdraw any listing or guild by that identity. The displayed signer becomes whoever published the latest update. Set \`listingId\` on every new listing. A withdraw must repeat the same identity form: the same \`listingId\`, or, when \`listingId\` was never set, the same stream, category, and normalized title and owner. A guild withdraw must repeat the same normalized name.

A payload with kind \`guild\` also has a \`guild\` object. This is the guild listing. There is no separate type enum for ecosystem, business, and hybrid listings; those stay on kind \`listing\`. The fields are \`name\` (at most 80 characters), \`description\` (the short description, at most 280 characters), \`links\` (an array of up to 8 \`https\` URLs), and optionally \`tags\` (1 to 8 short labels), \`image\` (the same object as on a listing), \`site\` (one \`https\` page), \`discord\`, and \`withdrawn\` (\`true\` only). A guild that is not withdrawn needs at least one of \`site\` or \`links\`. A \`withdrawn: true\` record may omit both. \`discord\` is only \`https://discord.gg/<code>\` or \`https://discord.com/invite/<code>\`, at most 80 characters, with no other host, userinfo, query, or hash. Unknown fields are rejected, including a member list, a wallet, or a price. A wallet-shaped token in a URL is rejected. A price word in a URL is not. \`withdrawn: true\` is a takedown. Search shows the newest guild update for each name, and a withdrawn name is left out. There is no separate guild-claim signer, so a curator update and any other signer follow that same latest-wins rule. A wallet-shaped token or a price in the name, description, tags, links, image text, or the update body is rejected. An allowlisted curator signs it with the same threshold, revocation, and manifest-pin checks as every other kind. Curators publish public links and logos only. Search shows the newest guild update for each name, so a curator replaces a listing by publishing a newer one with the same name. This node does not keep a private takedown list.

A payload with kind \`story-optin\` also has a \`storyOptIn\` object. The fields are \`action\` (\`allow\` or \`revoke\`), \`wallet\` (the player's base58 address), \`date\` (\`YYYY-MM-DD\`), and \`signature\` (the player's detached ed25519 signature over a fixed sentence, base58). The allow sentence is \`I allow sa-ecosystem-node to tell my public Star Atlas story. Wallet: <address>. Date: <YYYY-MM-DD>. Hub: <id>. Links: yes.\` or the same sentence with \`Links: no.\` The revoke sentence is \`I revoke sa-ecosystem-node from telling my public Star Atlas story. Wallet: <address>. Date: <YYYY-MM-DD>. Hub: <id>.\` \`<id>\` is the hub repository URL after normalization, such as \`https://github.com/owner/repo\`. It is not the manifest file name. A signature for a different repository does not verify. A date after the current UTC date stays in the chain and does not count until that date. The same signer, threshold, revocation, and manifest-pin checks apply. A node does not store a separate opt-in database.

A payload with kind \`reputation-link\` also has a \`reputationLink\` object. The fields are \`action\` (\`link\` or \`unlink\`), \`wallet\` (the player's base58 address), \`profile\` (a public profile name or a profile address), \`date\` (\`YYYY-MM-DD\`), and \`signature\` (the player's detached ed25519 signature over a fixed sentence, base58). The link sentence is \`I link wallet <address> to public profile <profile> on hub <id>. Scope: legacy. Date: <YYYY-MM-DD>.\` The scope is one of \`legacy\`, \`fleets\`, \`guild\`, or \`story\`. \`legacy\` is the smallest, and a link does not grant any other scope. The unlink sentence is \`I unlink wallet <address> from public profile <profile> on hub <id>. Date: <YYYY-MM-DD>.\` \`<id>\` is the hub repository URL after normalization, such as \`https://github.com/owner/repo\`. It is not the manifest file name. The scope is part of the signed sentence and is not a field the publisher sets. A signature for a different repository does not verify. One counting link per wallet per UTC day. A second link that day stays in the chain and does not add a scope. An unlink hides every scope for that wallet and profile from that date on, including a link dated the same day. A date after the current UTC date stays in the chain and does not count until that date. The same signer, threshold, revocation, and manifest-pin checks apply. This kind does not change which signer set the node trusts.

A changed body, an unknown signer, a repeated update id, or a manifest hash that does not match the pin is not served.
`;
}

/**
 * Walk a hub tree without following links. A symlink, a `.gitmodules` file,
 * or a `.git` gitdir file is refused. The root `.git` directory is the store
 * itself and is not walked.
 */
export function hubTreeProblem(root: string): string | null {
  return walkHubTree(root, true);
}

function walkHubTree(dir: string, isRoot: boolean): string | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return "The hub could not be checked.";
  }
  for (const name of names) {
    const full = path.join(dir, name);
    let info;
    try {
      info = lstatSync(full);
    } catch {
      return "The hub could not be checked.";
    }
    if (info.isSymbolicLink()) return "The hub must not contain a symlink.";
    if (name === ".gitmodules" || (name === ".git" && info.isFile())) return "The hub must not contain a submodule.";
    if (info.isDirectory()) {
      if (name === ".git" && isRoot) continue;
      const nested = walkHubTree(full, false);
      if (nested) return nested;
    }
  }
  return null;
}

export function runStoreInitCli(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  let dir = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--dir" && next && !next.startsWith("--")) {
      dir = next;
      index += 1;
    } else {
      return fail(USAGE.trim());
    }
  }
  if (!dir) return fail(USAGE.trim());

  try {
    const target = safeNewDirectory(dir);
    if (target.exists) {
      const problem = hubTreeProblem(target.path);
      if (problem) return fail(problem);
      if (readdirSync(target.path).length > 0) return fail(PATH_NOT_EMPTY);
    }
    if (!target.exists) mkdirSync(target.path, { mode: 0o755 });
    writeFileSync(path.join(target.path, "README.md"), hubStoreReadme(), { encoding: "utf8", mode: 0o644 });
    writeFileSync(path.join(target.path, "hub-manifest.json"), formatHubStoreManifest([]), { encoding: "utf8", mode: 0o644 });
    const updates = path.join(target.path, "updates");
    mkdirSync(updates, { mode: 0o755 });
    writeFileSync(path.join(updates, ".gitkeep"), "", { encoding: "utf8", mode: 0o644 });
    const written = hubTreeProblem(target.path);
    if (written) return fail(written);
    return { code: 0, stdout: "Wrote README.md, hub-manifest.json, and updates/.\n", stderr: "" };
  } catch (error) {
    return fail(error instanceof LocalPathError ? error.message : "The public store skeleton could not be written.");
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectRun()) {
  const result = runStoreInitCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
