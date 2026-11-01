/**
 * Private plain-language preview. Visitor text is assigned with textContent.
 * Links are emitted only for https URLs that pass allowedHttpsUrl.
 */

const DEFINITIONS = {
  signed: "A named person marked this as their own. The mark does not move money.",
  signer: "The person who published this.",
  hub: "The shared board these updates are published on.",
  profile: "A player's public page.",
  fleet: "The ships still listed on a player's public record.",
  faction: "The side a player joined: MUD, ONI, or Ustur.",
};

const STATUS_LABEL = {
  available: "Available",
  sold_out: "No longer available",
  inquire_only: "Ask the business",
  paused: "Paused",
};

const STREAM_LABEL = {
  referral: "Someone may receive a thank-you if you use their link.",
  hybrid: "Online and in person.",
  irl: "In person.",
  player: "Player.",
};

const CATEGORY_LABEL = {
  ip_and_business: "Business",
  creators: "Creators",
  developers_and_tools: "Tools",
  guilds_and_dacs: "Groups",
  events: "Events",
};

const PUBLIC_KIND = {
  announcement: true,
  "proposal-note": true,
  "payment-note": true,
  status: true,
  "signer-change": true,
  listing: true,
  guild: true,
  "story-optin": true,
};

/** Allowlisted hub kinds only. A claimant row must already be an active claim. */
export function isPublicUpdate(update) {
  if (!update || typeof update !== "object") return false;
  if (!PUBLIC_KIND[update.kind]) return false;
  if (update.signerAllowlist === "self" && update.claimed !== true) return false;
  return true;
}

const KIND_LABEL = {
  announcement: "Announcement",
  "proposal-note": "Note",
  "payment-note": "Note",
  status: "Status",
  "signer-change": "Who can publish",
  listing: "Listing",
  guild: "Group",
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const boundTerms = new WeakSet();
const DEFAULT_DISCLOSURE = "This page does not take payment. Offers link to each business's own page.";

function isBidiOrInvisible(code) {
  if (code === 0x61c || code === 0xfeff) return true;
  if (code >= 0x200b && code <= 0x200f) return true;
  if (code >= 0x202a && code <= 0x202e) return true;
  if (code >= 0x2066 && code <= 0x2069) return true;
  return false;
}

function hasHostileUrlChar(value) {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127 || isBidiOrInvisible(code)) return true;
  }
  return false;
}

export function neutralizeText(value) {
  if (typeof value !== "string") return "";
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13) {
      out += " ";
      continue;
    }
    if (code < 32 || code === 127 || isBidiOrInvisible(code)) continue;
    out += char;
  }
  const cleaned = out.replace(/ {2,}/g, " ").trim();
  return cleaned.length > 4000 ? cleaned.slice(0, 4000) : cleaned;
}

export function allowedHttpsUrl(value) {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > 2000) return null;
  if (value !== value.trim()) return null;
  if (!value.startsWith("https://")) return null;
  if (value.includes("\\") || hasHostileUrlChar(value)) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (!isPublicHost(parsed.hostname)) return null;
  if (parsed.href !== value && parsed.href !== `${value}/`) return null;
  return parsed.href;
}

export function offerFragment(listing) {
  const hash = listing && typeof listing.hash === "string" ? listing.hash : "";
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  return `#offer/${hash}`;
}

export function playerAddress(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) return null;
  return trimmed;
}

export function plainDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  return monthYear(`${value}T00:00:00.000Z`);
}

export function monthYear(iso) {
  if (typeof iso !== "string" || iso.length === 0) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const month = MONTHS[date.getUTCMonth()];
  if (!month) return "";
  return `${month} ${date.getUTCFullYear()}`;
}

export function parseRpcBody(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
  let last = null;
  for (const line of trimmed.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload && payload !== "[DONE]") last = payload;
  }
  if (!last) return null;
  return JSON.parse(last);
}

export function rpcResult(message) {
  if (!message || typeof message !== "object") return null;
  if (message.error) return null;
  const result = message.result;
  if (!result || typeof result !== "object") return null;
  if (result.isError === true) return null;
  return result;
}

export function callData(message) {
  const result = rpcResult(message);
  if (!result) return null;
  const structured = result.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) return structured;
  const parts = Array.isArray(result.content) ? result.content : [];
  for (const part of parts) {
    if (!part || part.type !== "text" || typeof part.text !== "string") continue;
    try {
      const parsed = JSON.parse(part.text);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      return { text: part.text };
    }
  }
  return null;
}

export function playerStoryArguments(tool, address) {
  if (!tool || typeof tool !== "object") return null;
  const schema = tool.inputSchema;
  const properties =
    schema && typeof schema === "object" && schema.properties && typeof schema.properties === "object"
      ? schema.properties
      : null;
  const required = schema && Array.isArray(schema.required) ? schema.required.filter((key) => typeof key === "string") : [];
  const preferred = ["address", "profileAddress", "playerAddress", "profile", "player"];
  const args = {};
  if (properties) {
    const key = preferred.find((name) => Object.prototype.hasOwnProperty.call(properties, name));
    if (!key) return null;
    args[key] = address;
  } else {
    args.address = address;
  }
  for (const key of required) {
    if (args[key] === undefined) return null;
  }
  return args;
}

export function storyParagraphs(data) {
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data.paragraphs)) {
    return data.paragraphs.map((item) => neutralizeText(item)).filter(Boolean);
  }
  if (Array.isArray(data.chapters)) {
    const lines = [];
    for (const chapter of data.chapters) {
      if (typeof chapter === "string") lines.push(neutralizeText(chapter));
      else if (chapter && typeof chapter === "object") {
        if (typeof chapter.title === "string") lines.push(neutralizeText(chapter.title));
        if (typeof chapter.text === "string") lines.push(neutralizeText(chapter.text));
        if (typeof chapter.body === "string") lines.push(neutralizeText(chapter.body));
      }
    }
    return lines.filter(Boolean);
  }
  for (const key of ["story", "text", "summary", "body"]) {
    if (typeof data[key] === "string" && neutralizeText(data[key])) return [neutralizeText(data[key])];
  }
  return [];
}

export function signedExplainer(listing) {
  const line = neutralizeText(listing && listing.signedMeaning);
  if (line) return line;
  return "Signed means this signer published the listing. It does not move money.";
}

export function playerLines(card) {
  if (!card || typeof card !== "object") return [];
  const profiles = Array.isArray(card.profiles) ? card.profiles : [];
  const fleets = Array.isArray(card.fleets) ? card.fleets : [];
  if (profiles.length === 0 && fleets.length === 0) {
    return [
      card.dataMode === "partial"
        ? "The public record could not be fully read. Try again later."
        : "No player profile was found for this address.",
    ];
  }
  const lines = [];
  for (const profile of profiles) {
    const name = neutralizeText(profile && profile.name) || "Unnamed player";
    lines.push(name);
    const faction = neutralizeText(profile && profile.faction);
    lines.push(faction && faction !== "Unaligned" ? `Faction: ${faction}` : "No faction listed.");
  }
  if (fleets.length === 0) lines.push("No fleet listed.");
  for (const fleet of fleets) {
    const name = neutralizeText(fleet && fleet.name) || "Unnamed fleet";
    lines.push(`Fleet: ${name}`);
  }
  const activity = card.activity;
  if (activity && typeof activity === "object") {
    const first = monthYear(activity.firstSeen);
    const last = monthYear(activity.lastSeen);
    if (first) lines.push(`First seen ${first}`);
    if (last) lines.push(`Last seen ${last}`);
  }
  return lines;
}

export async function loadBoard(rpc) {
  const listed = rpcResult(await rpc("tools/list", {}));
  const tools = listed && Array.isArray(listed.tools) ? listed.tools : [];
  const storyTool = tools.find((tool) => tool && tool.name === "player_story") ?? null;
  const [listingsMessage, updatesMessage] = await Promise.all([
    rpc("tools/call", { name: "list_listings", arguments: {} }),
    rpc("tools/call", { name: "hub_updates", arguments: {} }),
  ]);
  const listingsData = callData(listingsMessage);
  const updatesData = callData(updatesMessage);
  return {
    listings: listingsData && Array.isArray(listingsData.listings) ? listingsData.listings : [],
    listingsFailed: listingsData === null,
    updates: updatesData && Array.isArray(updatesData.updates) ? updatesData.updates : [],
    updatesFailed: updatesData === null,
    storyTool,
  };
}

export async function lookupPlayer(rpc, address, storyTool) {
  const legacy = callData(await rpc("tools/call", { name: "player_legacy", arguments: { address } }));
  if (!storyTool) return { legacy, story: { state: "absent" } };
  const args = playerStoryArguments(storyTool, address);
  if (!args) return { legacy, story: { state: "absent" } };
  try {
    const storyData = callData(await rpc("tools/call", { name: "player_story", arguments: args }));
    if (!storyData) return { legacy, story: { state: "error" } };
    const paragraphs = storyParagraphs(storyData);
    if (paragraphs.length === 0) return { legacy, story: { state: "empty" } };
    const title = typeof storyData.title === "string" ? neutralizeText(storyData.title) : "";
    return { legacy, story: { state: "ready", title, paragraphs } };
  } catch {
    return { legacy, story: { state: "error" } };
  }
}

export function renderListingCard(doc, listing) {
  const card = el(doc, "article", "card");
  appendLogo(doc, card, listing && listing.image, listing && listing.title);
  card.appendChild(el(doc, "h3", "card-title", displayText(listing && listing.title, "Untitled offer")));
  appendClaimed(doc, card, listing);
  const by = el(doc, "p", "byline");
  by.textContent = `Listed by ${signerName(listing)}`;
  card.appendChild(by);
  card.appendChild(explainer(doc, signedExplainer(listing)));
  appendDisclosure(doc, card, listing);
  const offer = displayText(listing && listing.offerText, "");
  if (offer) card.appendChild(el(doc, "p", "offer", offer));
  const status = STATUS_LABEL[listing && listing.status] || "";
  if (status) card.appendChild(el(doc, "p", "status", status));
  appendOfferLink(doc, card, listing);
  appendExternal(doc, card, listing && listing.url);
  return card;
}

export function renderListingDetail(doc, listing) {
  const card = el(doc, "article", "card detail-card");
  appendLogo(doc, card, listing && listing.image, listing && listing.title);
  appendClaimed(doc, card, listing);
  const by = el(doc, "p", "byline");
  by.textContent = `Listed by ${signerName(listing)}`;
  card.appendChild(by);
  card.appendChild(explainer(doc, signedExplainer(listing)));
  appendDisclosure(doc, card, listing);
  const offer = displayText(listing && listing.offerText, "");
  if (offer) card.appendChild(el(doc, "p", "offer", offer));
  const note = displayText(listing && listing.verifyLiveNote, "");
  if (note) card.appendChild(el(doc, "p", "note", note));
  const owner = displayText(listing && listing.owner, "");
  if (owner) card.appendChild(el(doc, "p", "meta", `From ${owner}`));
  const status = STATUS_LABEL[listing && listing.status] || "";
  if (status) card.appendChild(el(doc, "p", "status", status));
  const stream = STREAM_LABEL[listing && listing.stream] || "";
  if (stream) card.appendChild(el(doc, "p", "meta", stream));
  const category = CATEGORY_LABEL[listing && listing.category] || "";
  if (category) card.appendChild(el(doc, "p", "meta", category));
  const asOf = plainDate(listing && listing.asOf);
  if (asOf) card.appendChild(el(doc, "p", "meta", `Noted on ${asOf}`));
  const expires = plainDate(listing && listing.expiresAt);
  if (expires) card.appendChild(el(doc, "p", "meta", `Open through ${expires}`));
  if (listing && listing.expired === true) card.appendChild(el(doc, "p", "meta", "This offer is past its end date."));
  appendExternal(doc, card, listing && listing.url);
  return card;
}

export function renderHubUpdate(doc, update) {
  if (!isPublicUpdate(update)) return el(doc, "p", "empty", "");
  const card = el(doc, "article", "card");
  card.appendChild(el(doc, "h3", "card-title", KIND_LABEL[update && update.kind] || "Update"));
  appendClaimed(doc, card, update);
  const when = monthYear(update && update.created_at);
  if (when) card.appendChild(el(doc, "p", "meta", when));
  const body = displayText(update && update.body, "");
  if (body) card.appendChild(el(doc, "p", "update-body", body));
  if (update && update.kind === "guild") appendGuild(doc, card, update.guild);
  if (update && update.kind === "listing") appendOfferLink(doc, card, update);
  return card;
}

/** Only a hub file at the pinned commit. External https logos are not loaded. */
export function allowedImageUrl(value) {
  const href = allowedHttpsUrl(value);
  if (!href) return null;
  let parsed;
  try {
    parsed = new URL(href);
  } catch {
    return null;
  }
  if (parsed.hostname !== "raw.githubusercontent.com") return null;
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || !/^[0-9a-f]{40}$/.test(parts[2] || "")) return null;
  const file = parts.slice(3).join("/");
  if (file.includes("%") || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(file)) return null;
  if (file.split("/").some((segment) => segment === "." || segment === "..")) return null;
  if (file.toLowerCase().includes(".svg") || !/\.(png|jpe?g|webp)$/i.test(file)) return null;
  return href;
}

export function renderSearchResults(doc, data) {
  const host = el(doc, "div", "search-results");
  if (!data || data.pinned === false) {
    host.appendChild(el(doc, "p", "empty", "No shared board is pinned, so there is nothing to search."));
    return host;
  }
  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) {
    host.appendChild(el(doc, "p", "empty", "No matches."));
    return host;
  }
  for (const hit of results) host.appendChild(renderSearchHit(doc, hit));
  if (data.truncated === true) {
    host.appendChild(el(doc, "p", "quiet", "Some opted-in players were not checked."));
  }
  return host;
}

export function renderSearchHit(doc, hit) {
  const row = el(doc, "article", "card search-hit");
  const head = el(doc, "div", "search-head");
  appendLogo(doc, head, hit && hit.image, hit && hit.name);
  head.appendChild(el(doc, "h3", "card-title", displayText(hit && hit.name, "Untitled")));
  row.appendChild(head);
  appendClaimed(doc, row, hit);
  const description = displayText(hit && hit.description, "");
  if (description) row.appendChild(el(doc, "p", "offer", description));
  const kind = hit && hit.kind === "guild" ? "Group" : hit && hit.kind === "player" ? "Player" : hit && hit.kind === "listing" ? "Listing" : "";
  if (kind) row.appendChild(el(doc, "p", "meta", kind));
  appendSearchLink(doc, row, hit && hit.link);
  if (hit && hit.site && hit.site !== hit.link) appendExternal(doc, row, hit.site);
  appendDiscord(doc, row, hit && hit.discord);
  return row;
}

export function allowedDiscordInvite(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 80 || value !== value.trim()) return null;
  if (value.includes("\\") || value.includes("%") || value.includes("@") || value.includes("?")) return null;
  if (!value.startsWith("https://")) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.href !== value) return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.port) return null;
  const host = parsed.hostname.toLowerCase();
  const code = /^[A-Za-z0-9-]{2,32}$/;
  if (host === "discord.gg") {
    const part = parsed.pathname.slice(1);
    if (!code.test(part) || part.includes("/")) return null;
  } else if (host === "discord.com") {
    const match = /^\/invite\/([A-Za-z0-9-]{2,32})$/.exec(parsed.pathname);
    if (!match || !code.test(match[1])) return null;
  } else {
    return null;
  }
  return parsed.href;
}

export function renderPlayerResult(doc, result) {
  const wrap = el(doc, "div", "player-result");
  const legacy = result && result.legacy;
  if (!legacy) wrap.appendChild(el(doc, "p", "empty", "That player could not be loaded."));
  else {
    for (const line of playerLines(legacy)) appendPlayerLine(doc, wrap, line);
    appendLegacyNotes(doc, wrap, legacy);
  }
  const story = (result && result.story) || { state: "absent" };
  if (story.state === "ready") {
    wrap.appendChild(el(doc, "h3", "story-title", story.title || "Story"));
    for (const paragraph of story.paragraphs || []) wrap.appendChild(el(doc, "p", "story", paragraph));
  } else if (story.state === "absent") {
    wrap.appendChild(el(doc, "p", "quiet", "A longer story is not available yet."));
  } else {
    wrap.appendChild(el(doc, "p", "quiet", "No story is available for this player."));
  }
  return wrap;
}

export function renderPage(doc, state) {
  const listingsBody = doc.getElementById("listings-body");
  const updatesBody = doc.getElementById("updates-body");
  if (listingsBody) fillListings(doc, listingsBody, state);
  if (updatesBody) fillUpdates(doc, updatesBody, state);
  const board = doc.getElementById("board");
  const detail = doc.getElementById("detail");
  const detailBody = doc.getElementById("detail-body");
  const detailHeading = doc.getElementById("detail-heading");
  if (!board || !detail || !detailBody) return;
  const offerId = routeHash(state && state.hash);
  if (!offerId) {
    detail.hidden = true;
    board.hidden = false;
    if (detailHeading) detailHeading.textContent = "Offer";
    clear(detailBody);
    return;
  }
  board.hidden = true;
  detail.hidden = false;
  clear(detailBody);
  const listings = state && Array.isArray(state.listings) ? state.listings : [];
  const listing = listings.find((item) => item && item.hash === offerId);
  if (!listing) {
    if (detailHeading) detailHeading.textContent = "Offer";
    detailBody.appendChild(el(doc, "p", "empty", "That offer is not on the list."));
    return;
  }
  if (detailHeading) detailHeading.textContent = displayText(listing.title, "Offer");
  detailBody.appendChild(renderListingDetail(doc, listing));
}

export async function bindPage(doc, env = {}) {
  const view = env.view ?? doc.defaultView ?? globalThis;
  const fetchImpl = env.fetch ?? (typeof view.fetch === "function" ? view.fetch.bind(view) : globalThis.fetch);
  const location = env.location ?? view.location;
  let rpcSeq = 0;
  async function rpc(method, params, notification = false) {
    const payload = notification
      ? { jsonrpc: "2.0", method }
      : { jsonrpc: "2.0", id: ++rpcSeq, method, params: params ?? {} };
    const response = await fetchImpl(new URL("/api/mcp", location.origin).href, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    const text = await response.text();
    if (!response.ok) throw new Error("The read did not finish.");
    return parseRpcBody(text);
  }

  const state = {
    listings: [],
    listingsFailed: false,
    updates: [],
    updatesFailed: false,
    storyTool: null,
    hash: location.hash || "",
  };
  try {
    await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "plain-preview", version: "0" },
    });
    await rpc("notifications/initialized", undefined, true);
  } catch {
    // A stateless server still answers tools/call on its own request.
  }
  try {
    const board = await loadBoard(rpc);
    state.listings = board.listings;
    state.listingsFailed = board.listingsFailed;
    state.updates = board.updates;
    state.updatesFailed = board.updatesFailed;
    state.storyTool = board.storyTool;
  } catch {
    state.listingsFailed = true;
    state.updatesFailed = true;
  }
  renderPage(doc, state);
  bindStaticTerms(doc);
  if (typeof view.addEventListener === "function") {
    view.addEventListener("hashchange", () => {
      state.hash = location.hash || "";
      renderPage(doc, state);
    });
  }
  bindSearch(doc, rpc);
  const form = doc.getElementById("lookup");
  if (form && typeof form.addEventListener === "function") {
    let lookupSeq = 0;
    let lookupBusy = false;
    const submit = doc.getElementById("lookup-submit");
    form.addEventListener("submit", (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      if (lookupBusy) return;
      const input = doc.getElementById("player-address");
      const address = playerAddress(input ? input.value : "");
      const host = doc.getElementById("player-body");
      if (!host) return;
      clear(host);
      if (!address) {
        host.appendChild(el(doc, "p", "empty", "Enter the public address of a player profile."));
        return;
      }
      lookupBusy = true;
      setLookupBusy(submit, true);
      host.appendChild(el(doc, "p", "status", "Looking up that player…"));
      const seq = ++lookupSeq;
      lookupPlayer(rpc, address, state.storyTool)
        .then((result) => {
          if (seq !== lookupSeq) return;
          clear(host);
          host.appendChild(renderPlayerResult(doc, result));
        })
        .catch(() => {
          if (seq !== lookupSeq) return;
          clear(host);
          host.appendChild(el(doc, "p", "empty", "That player could not be loaded."));
        })
        .then(() => {
          if (seq !== lookupSeq) return;
          lookupBusy = false;
          setLookupBusy(submit, false);
        });
    });
  }
  return state;
}

function isPublicHost(hostname) {
  const host = hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host.includes(":")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  return labels.every((label) => label.length > 0 && label.length <= 63);
}

function displayText(value, fallback) {
  const text = neutralizeText(value);
  return text || fallback;
}

function signerName(listing) {
  return displayText(listing && listing.signerDisplayName, "an unnamed signer");
}

function routeHash(hash) {
  const match = /^#offer\/([0-9a-f]{64})$/.exec(typeof hash === "string" ? hash : "");
  return match ? match[1] : null;
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function explainer(doc, text) {
  const wrap = el(doc, "div", "explain");
  const button = el(doc, "button", "explain-toggle", "What does signed mean?");
  button.setAttribute("type", "button");
  button.setAttribute("aria-expanded", "false");
  const answer = el(doc, "p", "explain-answer", text);
  answer.hidden = true;
  button.addEventListener("click", () => {
    const open = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", open ? "false" : "true");
    answer.hidden = open;
  });
  wrap.appendChild(button);
  wrap.appendChild(answer);
  return wrap;
}

function appendDisclosure(doc, card, listing) {
  const disclosure = displayText(listing && listing.disclosure, DEFAULT_DISCLOSURE);
  card.appendChild(el(doc, "p", "disclosure", `Disclosure: ${disclosure}`));
}

function setLookupBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.setAttribute("aria-busy", busy ? "true" : "false");
}

function appendLegacyNotes(doc, parent, card) {
  const disclaimer = neutralizeText(card && card.disclaimer);
  if (disclaimer) parent.appendChild(el(doc, "p", "disclaimer", disclaimer));
  const details = el(doc, "details", "sources");
  details.appendChild(el(doc, "summary", "", "Sources"));
  const list = el(doc, "ul", "source-list");
  const sources = card && Array.isArray(card.sources) ? card.sources : [];
  let count = 0;
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const item = el(doc, "li", "source");
    const account = neutralizeText(source.account);
    if (account) item.appendChild(el(doc, "p", "source-account", account));
    const facts = Array.isArray(source.facts) ? source.facts : [];
    for (const fact of facts) {
      if (!fact || typeof fact !== "object") continue;
      const label = neutralizeText(fact.fact);
      const record = neutralizeText(fact.signature);
      const line = [label, record].filter(Boolean).join(" ");
      if (line) item.appendChild(el(doc, "p", "source-fact", line));
    }
    if (!item.firstChild) continue;
    list.appendChild(item);
    count += 1;
  }
  if (count === 0) list.appendChild(el(doc, "li", "", "No sources were listed."));
  details.appendChild(list);
  parent.appendChild(details);
}

function appendLogo(doc, parent, image, fallback) {
  const alt = neutralizeText(image && image.alt);
  const src = allowedImageUrl(image && image.src);
  if (src && alt) {
    const img = el(doc, "img", "logo");
    img.setAttribute("src", src);
    img.setAttribute("alt", alt);
    img.setAttribute("referrerpolicy", "no-referrer");
    img.setAttribute("loading", "lazy");
    img.setAttribute("width", "32");
    img.setAttribute("height", "32");
    parent.appendChild(img);
    return;
  }
  const initial = textInitial(alt || fallback);
  if (!initial) return;
  parent.appendChild(el(doc, "span", "logo-initial", initial));
}

function textInitial(value) {
  const text = neutralizeText(value);
  for (const char of text) {
    if (char.trim()) return char.toLocaleUpperCase();
  }
  return "";
}

function appendClaimed(doc, parent, record) {
  if (!record || record.claimed !== true) return;
  parent.appendChild(el(doc, "p", "badge", "claimed"));
}

function appendGuild(doc, card, guild) {
  if (!guild || typeof guild !== "object") return;
  appendLogo(doc, card, guild.image, guild.name);
  const name = displayText(guild.name, "");
  if (name) card.appendChild(el(doc, "p", "offer", name));
  const description = displayText(guild.description, "");
  if (description) card.appendChild(el(doc, "p", "note", description));
  const tags = Array.isArray(guild.tags) ? guild.tags.map((tag) => neutralizeText(tag)).filter(Boolean) : [];
  if (tags.length > 0) card.appendChild(el(doc, "p", "meta", tags.join(", ")));
  const links = Array.isArray(guild.links) ? guild.links : [];
  for (const link of links) appendExternal(doc, card, link);
  appendExternal(doc, card, guild.site);
  appendDiscord(doc, card, guild.discord);
}

function appendDiscord(doc, parent, value) {
  const href = allowedDiscordInvite(value);
  if (!href) return;
  const link = el(doc, "a", "external", linkLabel(href));
  link.setAttribute("href", href);
  link.setAttribute("rel", "noopener noreferrer");
  link.setAttribute("target", "_blank");
  parent.appendChild(link);
}

function appendSearchLink(doc, parent, value) {
  const player = /^#player\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(typeof value === "string" ? value : "");
  if (player) {
    const button = el(doc, "button", "search-player", "Show this player");
    button.setAttribute("type", "button");
    button.setAttribute("data-player", player[1]);
    button.addEventListener("click", () => {
      const input = doc.getElementById("player-address");
      const form = doc.getElementById("lookup");
      if (input) input.value = player[1];
      if (form && typeof form.dispatch === "function") form.dispatch("submit", { preventDefault() {} });
      else if (form && typeof form.requestSubmit === "function") form.requestSubmit();
    });
    parent.appendChild(button);
    return;
  }
  appendExternal(doc, parent, value);
}

function bindSearch(doc, rpc) {
  const form = doc.getElementById("search-form");
  if (!form || typeof form.addEventListener !== "function") return;
  let busy = false;
  const submit = doc.getElementById("search-submit");
  form.addEventListener("submit", (event) => {
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    if (busy) return;
    const input = doc.getElementById("search-query");
    const raw = input && typeof input.value === "string" ? input.value : "";
    const host = doc.getElementById("search-body");
    if (!host) return;
    clear(host);
    if (raw.length > 80) {
      host.appendChild(el(doc, "p", "empty", "Search text must be at most 80 characters."));
      return;
    }
    busy = true;
    setLookupBusy(submit, true);
    host.appendChild(el(doc, "p", "status", "Searching…"));
    rpc("tools/call", { name: "search_hub", arguments: { query: raw } })
      .then((message) => {
        clear(host);
        const data = callData(message);
        if (!data) {
          host.appendChild(el(doc, "p", "empty", "Search could not be loaded."));
          return;
        }
        host.appendChild(renderSearchResults(doc, data));
      })
      .catch(() => {
        clear(host);
        host.appendChild(el(doc, "p", "empty", "Search could not be loaded."));
      })
      .then(() => {
        busy = false;
        setLookupBusy(submit, false);
      });
  });
}

function appendOfferLink(doc, parent, listing) {
  const fragment = offerFragment(listing);
  if (!fragment) return;
  const link = el(doc, "a", "more", "Read this offer");
  link.setAttribute("href", fragment);
  parent.appendChild(link);
}

function appendExternal(doc, parent, value) {
  const href = allowedHttpsUrl(value);
  if (!href) return;
  const link = el(doc, "a", "external", linkLabel(href));
  link.setAttribute("href", href);
  link.setAttribute("rel", "noopener noreferrer");
  link.setAttribute("target", "_blank");
  parent.appendChild(link);
}

function linkLabel(href) {
  try {
    const host = new URL(href).hostname;
    return host ? `Open ${host}` : "Open their page";
  } catch {
    return "Open their page";
  }
}

function appendPlayerLine(doc, parent, line) {
  if (line.startsWith("Faction: ")) {
    const row = el(doc, "p", "player-line");
    appendGlossary(doc, row, "faction", "Faction");
    row.appendChild(doc.createTextNode(`: ${line.slice("Faction: ".length)}`));
    parent.appendChild(row);
    return;
  }
  if (line.startsWith("Fleet: ")) {
    const row = el(doc, "p", "player-line");
    appendGlossary(doc, row, "fleet", "Fleet");
    row.appendChild(doc.createTextNode(`: ${line.slice("Fleet: ".length)}`));
    parent.appendChild(row);
    return;
  }
  parent.appendChild(el(doc, "p", "player-line", line));
}

function appendGlossary(doc, parent, key, label) {
  const gloss = el(doc, "span", "gloss");
  const button = el(doc, "button", "term", label);
  button.setAttribute("type", "button");
  button.setAttribute("aria-expanded", "false");
  bindTerm(button);
  const tip = el(doc, "span", "tip", DEFINITIONS[key] || "");
  tip.setAttribute("role", "tooltip");
  gloss.appendChild(button);
  gloss.appendChild(tip);
  parent.appendChild(gloss);
}

function bindTerm(button) {
  if (boundTerms.has(button)) return;
  boundTerms.add(button);
  button.addEventListener("click", () => {
    const open = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", open ? "false" : "true");
  });
}

function bindStaticTerms(doc) {
  const body = doc.body || doc;
  walk(body, (node) => {
    if (node && typeof node.className === "string" && node.className.split(/\s+/).includes("term")) bindTerm(node);
  });
}

function walk(node, visit) {
  if (!node) return;
  visit(node);
  const kids = node.childNodes || [];
  for (const kid of kids) walk(kid, visit);
}

function fillListings(doc, host, state) {
  clear(host);
  if (state && state.listingsFailed) {
    host.appendChild(el(doc, "p", "empty", "Listings could not be loaded."));
    return;
  }
  const listings = state && Array.isArray(state.listings) ? state.listings : [];
  if (listings.length === 0) {
    host.appendChild(el(doc, "p", "empty", "No listings yet"));
    return;
  }
  for (const listing of listings) {
    if (!listing || typeof listing !== "object") continue;
    host.appendChild(renderListingCard(doc, listing));
  }
}

function fillUpdates(doc, host, state) {
  clear(host);
  if (state && state.updatesFailed) {
    host.appendChild(el(doc, "p", "empty", "Updates could not be loaded."));
    return;
  }
  const raw = state && Array.isArray(state.updates) ? state.updates : [];
  const updates = raw.filter((update) => isPublicUpdate(update));
  if (updates.length === 0) {
    host.appendChild(el(doc, "p", "empty", "No updates yet"));
    return;
  }
  for (const update of updates) host.appendChild(renderHubUpdate(doc, update));
}

if (globalThis.document && globalThis.document.getElementById("board")) {
  bindPage(globalThis.document);
}
