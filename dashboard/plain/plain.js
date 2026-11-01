/**
 * Private plain-language preview. Visitor text is assigned with textContent.
 * Links are emitted only for https URLs that pass allowedHttpsUrl.
 */

const DEFINITIONS = {
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
/** Shown once under Listings. Cards do not repeat it. */
export const PAGE_DISCLOSURE = "This page does not take payment. Offers link to each business's own page.";
/** Collapsed cards keep one short line and never cut a word in half. */
export const PREVIEW_LIMIT = 64;

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

/**
 * Shorten text on a word boundary. A limit that lands inside a word moves
 * back to the previous space. A first word longer than the limit is kept whole.
 * The ellipsis is omitted when the text already fits.
 */
export function truncateAtWord(value, limit = PREVIEW_LIMIT) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  const max = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : PREVIEW_LIMIT;
  if (!text || max <= 0) return "";
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const space = head.lastIndexOf(" ");
  if (space > 0) return `${head.slice(0, space).trimEnd()}…`;
  const next = text.indexOf(" ");
  if (next === -1) return text;
  return `${text.slice(0, next)}…`;
}

export function listingCategoryLabel(listing) {
  const raw = listing && typeof listing.category === "string" ? listing.category : "";
  if (!raw) return "";
  return CATEGORY_LABEL[raw] || neutralizeText(raw);
}

/** Tags on a guild update, or "Group" when a guild has none. */
export function guildTypeLabels(update) {
  const guild = update && update.guild && typeof update.guild === "object" ? update.guild : null;
  const tags = guild && Array.isArray(guild.tags) ? guild.tags.map((tag) => neutralizeText(tag)).filter(Boolean) : [];
  if (tags.length > 0) return tags;
  if ((update && update.kind === "guild") || guild) return ["Group"];
  return [];
}

export function searchKindLabel(hit) {
  if (!hit || typeof hit !== "object") return "";
  if (hit.kind === "guild") return "Group";
  if (hit.kind === "player") return "Player";
  if (hit.kind === "listing") return "Listing";
  return "";
}

/** Unique category labels from the records on the page, in A-Z order. */
export function categoryChoices(records, categoriesOf) {
  const seen = new Set();
  const choices = [];
  const list = Array.isArray(records) ? records : [];
  const read = typeof categoriesOf === "function" ? categoriesOf : () => [];
  for (const record of list) {
    const labels = read(record);
    const items = Array.isArray(labels) ? labels : [];
    for (const label of items) {
      if (typeof label !== "string") continue;
      const clean = label.trim();
      if (!clean) continue;
      const key = clean.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      choices.push(clean);
    }
  }
  choices.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return choices;
}

/**
 * Filter and sort a list without mutating it.
 * sort is "az", "newest", or "category".
 * filter "all" keeps every record. Any other filter keeps records whose
 * categoriesOf list includes that label.
 * Newest keeps the incoming order when no record has a date.
 */
export function applyView(records, options) {
  const list = Array.isArray(records) ? records.filter((item) => item && typeof item === "object") : [];
  const categoriesOf = options && typeof options.categoriesOf === "function" ? options.categoriesOf : () => [];
  const nameOf = options && typeof options.nameOf === "function" ? options.nameOf : () => "";
  const dateOf = options && typeof options.dateOf === "function" ? options.dateOf : () => "";
  const filter = options && options.filter ? options.filter : "all";
  const sort = options && options.sort ? options.sort : "az";
  const filtered =
    filter === "all"
      ? list.slice()
      : list.filter((item) => {
          const labels = categoriesOf(item);
          return Array.isArray(labels) && labels.includes(filter);
        });
  if (sort === "newest") {
    if (!filtered.some((item) => dateOf(item))) return filtered;
    return filtered.slice().sort((a, b) => compareNewest(dateOf(a), dateOf(b), nameOf(a), nameOf(b)));
  }
  if (sort === "category") {
    return filtered.slice().sort((a, b) => {
      const byCategory = firstLabel(categoriesOf(a)).localeCompare(firstLabel(categoriesOf(b)), undefined, { sensitivity: "base" });
      if (byCategory !== 0) return byCategory;
      return String(nameOf(a)).localeCompare(String(nameOf(b)), undefined, { sensitivity: "base" });
    });
  }
  return filtered.slice().sort((a, b) => String(nameOf(a)).localeCompare(String(nameOf(b)), undefined, { sensitivity: "base" }));
}

export function setCardsOpen(root, open) {
  if (!root) return;
  walk(root, (node) => {
    if (!node || node.tagName !== "DETAILS") return;
    if (!hasClass(node, "card-details")) return;
    if (open) node.setAttribute("open", "");
    else if (typeof node.removeAttribute === "function") node.removeAttribute("open");
  });
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

export function renderListingCard(doc, listing, options) {
  const title = displayText(listing && listing.title, "Untitled offer");
  const offer = displayText(listing && listing.offerText, "");
  const category = listingCategoryLabel(listing);
  const status = STATUS_LABEL[listing && listing.status] || "";
  const meta = [category, status].filter(Boolean).join(" · ");
  return renderSummaryCard(doc, {
    className: options && options.open ? "card detail-card" : "card",
    open: Boolean(options && options.open),
    title,
    owner: `Listed by ${signerName(listing)}`,
    meta,
    record: listing,
    signed: true,
    logo: { image: listing && listing.image, fallback: title },
    preview: offer ? truncateAtWord(offer, PREVIEW_LIMIT) : "",
    fill(more) {
      appendListingMore(doc, more, listing);
    },
  });
}

export function renderListingDetail(doc, listing) {
  return renderListingCard(doc, listing, { open: true });
}

export function renderHubUpdate(doc, update) {
  if (!isPublicUpdate(update)) return el(doc, "p", "empty", "");
  if (update && update.kind === "guild") return renderGuildCard(doc, update);
  const body = displayText(update && update.body, "");
  const when = monthYear(update && update.created_at);
  const title = KIND_LABEL[update && update.kind] || "Update";
  const preview = body ? truncateAtWord(body, PREVIEW_LIMIT) : "";
  return renderSummaryCard(doc, {
    title,
    meta: when,
    record: update,
    signed: true,
    preview,
    fill(more) {
      if (body && body !== preview) more.appendChild(el(doc, "p", "update-body", body));
      if (update && update.kind === "listing") appendOfferLink(doc, more, update);
    },
  });
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

export function renderSearchResults(doc, data, view) {
  const host = el(doc, "div", "search-results");
  fillSearchResults(doc, host, data, view);
  return host;
}

function fillSearchResults(doc, host, data, view) {
  if (!data || data.pinned === false) {
    clear(host);
    host.appendChild(el(doc, "p", "empty", "No shared board is pinned, so there is nothing to search."));
    return;
  }
  const results = Array.isArray(data.results) ? data.results.filter((hit) => hit && typeof hit === "object") : [];
  if (results.length === 0) {
    clear(host);
    host.appendChild(el(doc, "p", "empty", "No matches."));
    return;
  }
  const prefs = view && typeof view === "object" ? view : {};
  const filter = prefs.filter || "all";
  const sort = prefs.sort || "az";
  paintToolbarAndCards(doc, host, results, {
    filter,
    sort,
    categoriesOf: (hit) => {
      const label = searchKindLabel(hit);
      return label ? [label] : [];
    },
    nameOf: (hit) => displayText(hit.name, "Untitled"),
    dateOf: () => "",
    onFilter: (next) => {
      if (typeof prefs.onChange === "function") prefs.onChange({ filter: next, sort });
    },
    onSort: (next) => {
      if (typeof prefs.onChange === "function") prefs.onChange({ filter, sort: next });
    },
    render: (hit) => renderSearchHit(doc, hit),
  });
  if (data.truncated === true) {
    host.appendChild(el(doc, "p", "quiet", "Some opted-in players were not checked."));
  }
}

export function renderSearchHit(doc, hit) {
  const name = displayText(hit && hit.name, "Untitled");
  const description = displayText(hit && hit.description, "");
  const preview = description ? truncateAtWord(description, PREVIEW_LIMIT) : "";
  const kind = searchKindLabel(hit);
  return renderSummaryCard(doc, {
    className: "card search-hit",
    title: name,
    meta: kind,
    record: hit,
    signed: hit && (hit.kind === "listing" || hit.kind === "guild"),
    logo: { image: hit && hit.image, fallback: name },
    preview,
    fill(more) {
      if (description && description !== preview) more.appendChild(el(doc, "p", "offer", description));
      appendSearchLink(doc, more, hit && hit.link);
      if (hit && hit.site && hit.site !== hit.link) appendExternal(doc, more, hit.site);
      appendDiscord(doc, more, hit && hit.discord);
    },
  });
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
  const wrap = el(doc, "div", "player-result cards");
  const legacy = result && result.legacy;
  let more = null;
  if (!legacy) wrap.appendChild(el(doc, "p", "empty", "That player could not be loaded."));
  else {
    const card = renderPlayerCard(doc, legacy);
    wrap.appendChild(card);
    more = findByClass(card, "card-more");
  }
  const storyTarget = more || wrap;
  const story = (result && result.story) || { state: "absent" };
  if (story.state === "ready") {
    storyTarget.appendChild(el(doc, "h3", "story-title", story.title || "Story"));
    for (const paragraph of story.paragraphs || []) storyTarget.appendChild(el(doc, "p", "story", paragraph));
  } else if (story.state === "absent") {
    storyTarget.appendChild(el(doc, "p", "quiet", "A longer story is not available yet."));
  } else {
    storyTarget.appendChild(el(doc, "p", "quiet", "No story is available for this player."));
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
    listingFilter: "all",
    listingSort: "az",
    updateFilter: "all",
    updateSort: "az",
    guildFilter: "all",
    guildSort: "az",
    searchFilter: "all",
    searchSort: "az",
    searchData: null,
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
  bindSearch(doc, rpc, state);
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

function renderSummaryCard(doc, spec) {
  const card = el(doc, "article", spec.className || "card");
  const details = el(doc, "details", "card-details");
  if (spec.open) details.setAttribute("open", "");
  const summary = el(doc, "summary", "card-summary");
  const main = el(doc, "div", "summary-main");
  if (spec.logo) appendLogo(doc, main, spec.logo.image, spec.logo.fallback);
  const text = el(doc, "div", "summary-text");
  text.appendChild(el(doc, "h3", "card-title", spec.title));
  if (spec.owner) text.appendChild(el(doc, "p", "byline", spec.owner));
  if (spec.meta) text.appendChild(el(doc, "p", "meta", spec.meta));
  if (spec.record) appendClaimed(doc, text, spec.record);
  if (spec.signed) text.appendChild(el(doc, "p", "signed-badge", "Signed"));
  main.appendChild(text);
  summary.appendChild(main);
  if (spec.preview) summary.appendChild(el(doc, "p", "preview", spec.preview));
  details.appendChild(summary);
  const more = el(doc, "div", "card-more");
  if (typeof spec.fill === "function") spec.fill(more);
  if (more.childNodes && more.childNodes.length > 0) details.appendChild(more);
  else details.className = "card-details is-brief";
  card.appendChild(details);
  return card;
}

function appendListingMore(doc, more, listing) {
  const offer = displayText(listing && listing.offerText, "");
  const preview = offer ? truncateAtWord(offer, PREVIEW_LIMIT) : "";
  if (offer && offer !== preview) more.appendChild(el(doc, "p", "offer", offer));
  const note = displayText(listing && listing.verifyLiveNote, "");
  if (note) more.appendChild(el(doc, "p", "note", note));
  const owner = displayText(listing && listing.owner, "");
  if (owner) more.appendChild(el(doc, "p", "meta", `From ${owner}`));
  const stream = STREAM_LABEL[listing && listing.stream] || "";
  if (stream) more.appendChild(el(doc, "p", "meta", stream));
  const asOf = plainDate(listing && listing.asOf);
  if (asOf) more.appendChild(el(doc, "p", "meta", `Noted on ${asOf}`));
  const expires = plainDate(listing && listing.expiresAt);
  if (expires) more.appendChild(el(doc, "p", "meta", `Open through ${expires}`));
  if (listing && listing.expired === true) more.appendChild(el(doc, "p", "meta", "This offer is past its end date."));
  appendOfferLink(doc, more, listing);
  appendExternal(doc, more, listing && listing.url);
}

function renderGuildCard(doc, update) {
  const guild = update && update.guild && typeof update.guild === "object" ? update.guild : {};
  const name = displayText(guild.name, "Group");
  const description = displayText(guild.description, "");
  const body = displayText(update && update.body, "");
  const types = guildTypeLabels(update);
  const when = monthYear(update && update.created_at);
  const meta = [types.join(", "), when].filter(Boolean).join(" · ");
  const previewSource = description || body;
  const preview = previewSource ? truncateAtWord(previewSource, PREVIEW_LIMIT) : "";
  return renderSummaryCard(doc, {
    className: "card guild-card",
    title: name,
    meta,
    record: update,
    signed: true,
    logo: { image: guild.image, fallback: name },
    preview,
    fill(more) {
      if (description && description !== preview) more.appendChild(el(doc, "p", "offer", description));
      if (body && body !== description) more.appendChild(el(doc, "p", "update-body", body));
      const links = Array.isArray(guild.links) ? guild.links : [];
      for (const link of links) appendExternal(doc, more, link);
      appendExternal(doc, more, guild.site);
      appendDiscord(doc, more, guild.discord);
    },
  });
}

function renderPlayerCard(doc, legacy) {
  const profiles = Array.isArray(legacy.profiles) ? legacy.profiles : [];
  const lines = playerLines(legacy);
  const name = displayText(profiles[0] && profiles[0].name, lines[0] || "Player");
  const faction = displayText(profiles[0] && profiles[0].faction, "");
  const meta = faction && faction !== "Unaligned" ? `Faction: ${faction}` : "No faction listed.";
  const fleets = Array.isArray(legacy.fleets) ? legacy.fleets : [];
  const fleetName = fleets.length > 0 ? displayText(fleets[0] && fleets[0].name, "Unnamed fleet") : "";
  const preview = fleetName ? truncateAtWord(`Fleet: ${fleetName}`, PREVIEW_LIMIT) : "";
  return renderSummaryCard(doc, {
    className: "card player-card",
    title: name,
    meta,
    preview,
    fill(more) {
      for (const line of lines) appendPlayerLine(doc, more, line);
      appendLegacyNotes(doc, more, legacy);
    },
  });
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

function firstLabel(labels) {
  return Array.isArray(labels) && typeof labels[0] === "string" ? labels[0] : "";
}

function compareNewest(aDate, bDate, aName, bName) {
  const da = typeof aDate === "string" ? aDate : "";
  const db = typeof bDate === "string" ? bDate : "";
  if (da === db) return String(aName).localeCompare(String(bName), undefined, { sensitivity: "base" });
  if (!da) return 1;
  if (!db) return -1;
  return da < db ? 1 : -1;
}

function hasClass(node, name) {
  return typeof node.className === "string" && node.className.split(/\s+/).includes(name);
}

function findByClass(node, className) {
  let found = null;
  walk(node, (child) => {
    if (found || !child || typeof child.className !== "string") return;
    if (child.className.split(/\s+/).includes(className)) found = child;
  });
  return found;
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

function bindSearch(doc, rpc, state) {
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
      state.searchData = null;
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
          state.searchData = null;
          host.appendChild(el(doc, "p", "empty", "Search could not be loaded."));
          return;
        }
        state.searchFilter = "all";
        state.searchData = data;
        paintSearch(doc, state);
      })
      .catch(() => {
        clear(host);
        state.searchData = null;
        host.appendChild(el(doc, "p", "empty", "Search could not be loaded."));
      })
      .then(() => {
        busy = false;
        setLookupBusy(submit, false);
      });
  });
}

function paintSearch(doc, state) {
  const host = doc.getElementById("search-body");
  if (!host || !state.searchData) return;
  let results = directChild(host, "search-results");
  if (!results) {
    clear(host);
    results = el(doc, "div", "search-results");
    host.appendChild(results);
  }
  fillSearchResults(doc, results, state.searchData, {
    filter: state.searchFilter || "all",
    sort: state.searchSort || "az",
    onChange(next) {
      state.searchFilter = next.filter;
      state.searchSort = next.sort;
      paintSearch(doc, state);
    },
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
  if (state && state.listingsFailed) {
    clear(host);
    host.appendChild(el(doc, "p", "empty", "Listings could not be loaded."));
    return;
  }
  const listings = (state && Array.isArray(state.listings) ? state.listings : []).filter((item) => item && typeof item === "object");
  if (listings.length === 0) {
    clear(host);
    host.appendChild(el(doc, "p", "empty", "No listings yet"));
    return;
  }
  paintToolbarAndCards(doc, host, listings, {
    filter: state.listingFilter || "all",
    sort: state.listingSort || "az",
    categoriesOf: (item) => {
      const label = listingCategoryLabel(item);
      return label ? [label] : [];
    },
    nameOf: (item) => displayText(item.title, "Untitled offer"),
    dateOf: listingSortDate,
    onFilter: (next) => {
      state.listingFilter = next;
      renderPage(doc, state);
    },
    onSort: (next) => {
      state.listingSort = next;
      renderPage(doc, state);
    },
    render: (item) => renderListingCard(doc, item),
  });
}

function fillUpdates(doc, host, state) {
  const guildHost = doc.getElementById("guilds-body");
  if (state && state.updatesFailed) {
    clear(host);
    host.appendChild(el(doc, "p", "empty", "Updates could not be loaded."));
    if (guildHost) {
      clear(guildHost);
      guildHost.appendChild(el(doc, "p", "empty", "Groups could not be loaded."));
    }
    return;
  }
  const raw = state && Array.isArray(state.updates) ? state.updates : [];
  const updates = raw.filter((update) => isPublicUpdate(update));
  const guilds = guildHost ? updates.filter((update) => update.kind === "guild") : [];
  const rest = guildHost ? updates.filter((update) => update.kind !== "guild") : updates;
  paintPlainSection(doc, host, state, rest, {
    filterKey: "updateFilter",
    sortKey: "updateSort",
    emptyText: "No updates yet",
    categoriesOf: (update) => [KIND_LABEL[update.kind] || "Update"],
    nameOf: (update) => displayText(update.body, KIND_LABEL[update.kind] || "Update"),
    dateOf: (update) => (typeof update.created_at === "string" ? update.created_at : ""),
    render: (update) => renderHubUpdate(doc, update),
  });
  if (!guildHost) return;
  paintPlainSection(doc, guildHost, state, guilds, {
    filterKey: "guildFilter",
    sortKey: "guildSort",
    emptyText: "No groups yet",
    categoriesOf: (update) => guildTypeLabels(update),
    nameOf: (update) => displayText(update.guild && update.guild.name, "Group"),
    dateOf: (update) => (typeof update.created_at === "string" ? update.created_at : ""),
    render: (update) => renderHubUpdate(doc, update),
  });
}

function paintPlainSection(doc, host, state, records, config) {
  if (records.length === 0) {
    clear(host);
    host.appendChild(el(doc, "p", "empty", config.emptyText));
    return;
  }
  paintToolbarAndCards(doc, host, records, {
    filter: state[config.filterKey] || "all",
    sort: state[config.sortKey] || "az",
    categoriesOf: config.categoriesOf,
    nameOf: config.nameOf,
    dateOf: config.dateOf,
    onFilter: (next) => {
      state[config.filterKey] = next;
      renderPage(doc, state);
    },
    onSort: (next) => {
      state[config.sortKey] = next;
      renderPage(doc, state);
    },
    render: config.render,
  });
}

function paintToolbarAndCards(doc, host, records, config) {
  const choices = categoryChoices(records, config.categoriesOf);
  const filter = config.filter && config.filter !== "all" && choices.includes(config.filter) ? config.filter : "all";
  const sort = config.sort || "az";
  const shown = applyView(records, {
    filter,
    sort,
    categoriesOf: config.categoriesOf,
    nameOf: config.nameOf,
    dateOf: config.dateOf,
  });
  const choiceKey = JSON.stringify(choices);
  let bar = directChild(host, "toolbar");
  if (!bar || bar.getAttribute("data-choices") !== choiceKey) {
    if (bar) host.removeChild(bar);
    appendToolbar(doc, host, {
      choices,
      filter,
      sort,
      onFilter: config.onFilter,
      onSort: config.onSort,
      onExpand: () => setCardsOpen(host, true),
      onCollapse: () => setCardsOpen(host, false),
    });
    bar = directChild(host, "toolbar");
    if (bar) bar.setAttribute("data-choices", choiceKey);
  } else {
    syncToolbar(bar, filter, sort);
  }
  const stale = (host.childNodes || []).slice();
  for (const kid of stale) {
    if (kid !== bar) host.removeChild(kid);
  }
  if (shown.length === 0) {
    host.appendChild(el(doc, "p", "empty", "Nothing matches that filter."));
    return;
  }
  const grid = el(doc, "div", "cards");
  for (const record of shown) grid.appendChild(config.render(record));
  host.appendChild(grid);
}

function directChild(host, className) {
  for (const kid of host.childNodes || []) {
    if (hasClass(kid, className)) return kid;
  }
  return null;
}

function syncToolbar(bar, filter, sort) {
  walk(bar, (node) => {
    if (hasClass(node, "chip")) {
      const pressed = (filter === "all" && node.textContent === "All") || node.textContent === filter;
      node.setAttribute("aria-pressed", pressed ? "true" : "false");
    }
    if (node.tagName === "SELECT" && hasClass(node, "sort")) node.value = sort || "az";
  });
}

function appendToolbar(doc, host, config) {
  const bar = el(doc, "div", "toolbar");
  const choices = Array.isArray(config.choices) ? config.choices : [];
  if (choices.length > 0 && typeof config.onFilter === "function") {
    const group = el(doc, "div", "chips");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "Filter by category");
    group.appendChild(chipButton(doc, "All", config.filter === "all", () => config.onFilter("all")));
    for (const choice of choices) {
      group.appendChild(chipButton(doc, choice, config.filter === choice, () => config.onFilter(choice)));
    }
    bar.appendChild(group);
  }
  if (typeof config.onSort === "function") {
    const label = el(doc, "label", "sort-label");
    label.appendChild(doc.createTextNode("Sort"));
    const select = el(doc, "select", "sort");
    select.setAttribute("aria-label", "Sort");
    for (const [value, text] of [
      ["az", "A-Z"],
      ["newest", "Newest"],
      ["category", "Category"],
    ]) {
      const option = el(doc, "option", "", text);
      option.setAttribute("value", value);
      option.value = value;
      select.appendChild(option);
    }
    select.value = config.sort || "az";
    select.addEventListener("change", () => {
      const next = typeof select.value === "string" && select.value ? select.value : "az";
      config.onSort(next);
    });
    label.appendChild(select);
    bar.appendChild(label);
  }
  if (typeof config.onExpand === "function") bar.appendChild(toolButton(doc, "Expand all", config.onExpand));
  if (typeof config.onCollapse === "function") bar.appendChild(toolButton(doc, "Collapse all", config.onCollapse));
  if (bar.childNodes.length > 0) host.appendChild(bar);
}

function chipButton(doc, text, pressed, onClick) {
  const button = el(doc, "button", "chip", text);
  button.setAttribute("type", "button");
  button.setAttribute("aria-pressed", pressed ? "true" : "false");
  button.addEventListener("click", onClick);
  return button;
}

function toolButton(doc, text, onClick) {
  const button = el(doc, "button", "tool", text);
  button.setAttribute("type", "button");
  button.addEventListener("click", onClick);
  return button;
}

function listingSortDate(listing) {
  if (listing && typeof listing.created_at === "string" && listing.created_at) return listing.created_at;
  if (listing && typeof listing.asOf === "string" && listing.asOf) return listing.asOf;
  return "";
}

if (globalThis.document && globalThis.document.getElementById("board")) {
  bindPage(globalThis.document);
}
