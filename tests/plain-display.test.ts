import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  allowedHttpsUrl,
  applyView,
  bindPage,
  categoryChoices,
  guildTypeLabels,
  listingCategoryLabel,
  loadBoard,
  lookupPlayer,
  neutralizeText,
  offerFragment,
  PAGE_DISCLOSURE,
  parseRpcBody,
  playerStoryArguments,
  PREVIEW_LIMIT,
  allowedDiscordInvite,
  allowedImageUrl,
  renderHubUpdate,
  renderListingCard,
  renderPage,
  renderPlayerResult,
  renderSearchHit,
  renderSearchResults,
  searchKindLabel,
  setCardsOpen,
  storyParagraphs,
  truncateAtWord,
} from "../dashboard/plain/plain.js";

const HASH = "ab".repeat(32);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface MiniList {
  readonly length: number;
  item(index: number): MiniNode | null;
  [index: number]: MiniNode | undefined;
  [Symbol.iterator](): Iterator<MiniNode>;
}

interface MiniNode {
  nodeType: number;
  tagName: string;
  className: string;
  id: string;
  hidden: boolean;
  disabled: boolean;
  value: string;
  childNodes: MiniList;
  parentNode: MiniNode | null;
  attrs: Record<string, string>;
  textContent: string;
  firstChild: MiniNode | null;
  appendChild(child: MiniNode): MiniNode;
  removeChild(child: MiniNode): MiniNode;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, fn: (event: { preventDefault?: () => void; target?: unknown }) => void): void;
  dispatch(type: string, event?: { preventDefault?: () => void; target?: unknown }): void;
}

/** Live list with indexed access and iteration, and none of the array copy methods. */
function nodeListView(nodes: MiniNode[]): MiniList {
  const view = {
    get length() {
      return nodes.length;
    },
    item(index: number) {
      return nodes[index] ?? null;
    },
    [Symbol.iterator]() {
      return nodes[Symbol.iterator]();
    },
  };
  return new Proxy(view, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^(?:0|[1-9]\d*)$/.test(prop)) {
        const index = Number(prop);
        return index < nodes.length ? nodes[index] : undefined;
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as MiniList;
}

class MiniEl implements MiniNode {
  nodeType = 1;
  tagName: string;
  className = "";
  id = "";
  hidden = false;
  disabled = false;
  value = "";
  private kids: MiniNode[] = [];
  parentNode: MiniNode | null = null;
  attrs: Record<string, string> = {};
  private listeners: Record<string, ((event: { preventDefault?: () => void; target?: unknown }) => void)[]> = {};

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get childNodes(): MiniList {
    return nodeListView(this.kids);
  }

  set childNodes(value: MiniList | readonly MiniNode[]) {
    const next: MiniNode[] = [];
    for (const node of value ?? []) next.push(node);
    this.kids.splice(0, this.kids.length, ...next);
  }

  get textContent(): string {
    return this.kids.map((node) => node.textContent).join("");
  }

  set textContent(value: string) {
    const text = new MiniEl("#text");
    text.nodeType = 3;
    text.childNodes = [];
    Object.defineProperty(text, "textContent", { value: value == null ? "" : String(value), writable: true });
    this.childNodes = [text];
  }

  set innerHTML(_value: string) {
    throw new Error("innerHTML");
  }

  get firstChild(): MiniNode | null {
    return this.kids[0] ?? null;
  }

  appendChild(child: MiniNode): MiniNode {
    child.parentNode = this;
    this.kids.push(child);
    return child;
  }

  removeAttribute(name: string): void {
    delete this.attrs[name];
  }

  removeChild(child: MiniNode): MiniNode {
    const index = this.kids.indexOf(child);
    if (index >= 0) this.kids.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = String(value);
  }

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  addEventListener(type: string, fn: (event: { preventDefault?: () => void }) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }

  dispatch(type: string, event: { preventDefault?: () => void; target?: unknown } = {}): void {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
}

function createDoc(): MiniEl & { body: MiniEl; getElementById(id: string): MiniEl | null; createElement(tag: string): MiniEl; createTextNode(text: string): MiniEl } {
  const doc = new MiniEl("#document") as MiniEl & {
    body: MiniEl;
    getElementById(id: string): MiniEl | null;
    createElement(tag: string): MiniEl;
    createTextNode(text: string): MiniEl;
  };
  doc.body = new MiniEl("body");
  doc.createElement = (tag: string) => new MiniEl(tag);
  doc.createTextNode = (text: string) => {
    const node = new MiniEl("#text");
    node.nodeType = 3;
    node.textContent = text;
    return node;
  };
  doc.getElementById = (id: string) => {
    let found: MiniEl | null = null;
    walk(doc.body, (node) => {
      if (!found && node.id === id) found = node;
    });
    return found;
  };
  return doc;
}

function walk(node: MiniNode, visit: (node: MiniEl) => void): void {
  if (node instanceof MiniEl && node.nodeType === 1) visit(node);
  for (const child of node.childNodes) walk(child, visit);
}

function byTag(node: MiniNode, tag: string): MiniEl[] {
  const found: MiniEl[] = [];
  walk(node, (child) => {
    if (child.tagName === tag.toUpperCase()) found.push(child);
  });
  return found;
}

function hasClass(node: { className?: string } | null, className: string): boolean {
  return Boolean(node && typeof node.className === "string" && node.className.split(/\s+/).includes(className));
}

function byClass(node: MiniNode, className: string): MiniEl[] {
  const found: MiniEl[] = [];
  walk(node, (child) => {
    if (child.className.split(/\s+/).includes(className)) found.push(child);
  });
  return found;
}

function pageDoc() {
  const doc = createDoc();
  const board = doc.createElement("div");
  board.id = "board";
  const listings = doc.createElement("div");
  listings.id = "listings-body";
  const updates = doc.createElement("div");
  updates.id = "updates-body";
  const form = doc.createElement("form");
  form.id = "lookup";
  const input = doc.createElement("input");
  input.id = "player-address";
  const submit = doc.createElement("button");
  submit.id = "lookup-submit";
  submit.setAttribute("type", "submit");
  const player = doc.createElement("div");
  player.id = "player-body";
  const detail = doc.createElement("section");
  detail.id = "detail";
  const heading = doc.createElement("h2");
  heading.id = "detail-heading";
  const detailBody = doc.createElement("div");
  detailBody.id = "detail-body";
  form.appendChild(input);
  form.appendChild(submit);
  board.appendChild(listings);
  board.appendChild(updates);
  board.appendChild(form);
  board.appendChild(player);
  doc.body.appendChild(board);
  detail.appendChild(heading);
  detail.appendChild(detailBody);
  doc.body.appendChild(detail);
  return { doc, form, input, submit };
}

function jsonResponse(body: unknown, status = 200, raw?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return raw !== undefined ? raw : JSON.stringify(body);
    },
  };
}

function htmlFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git" || name === "plain") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) htmlFiles(full, acc);
    else if (name.endsWith(".html")) acc.push(full);
  }
  return acc;
}

function filesNamed(dir: string, fileName: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) filesNamed(full, fileName, acc);
    else if (name === fileName) acc.push(full);
  }
  return acc;
}

describe("plain display escaping", () => {
  it("gives elements a live child list without array copy methods", () => {
    const doc = createDoc();
    const parent = doc.createElement("div");
    const child = doc.createElement("span");
    parent.appendChild(child);
    const list = parent.childNodes as MiniList & { slice?: unknown; map?: unknown; filter?: unknown };
    expect(list.length).toBe(1);
    expect(list.item(0)).toBe(child);
    expect(list[0]).toBe(child);
    expect(Array.from(list)).toEqual([child]);
    expect([...list]).toEqual([child]);
    expect(list.slice).toBeUndefined();
    expect(list.map).toBeUndefined();
    expect(list.filter).toBeUndefined();
  });

  it("renders hostile strings as inert text", () => {
    const doc = createDoc();
    const card = renderListingCard(doc, {
      title: "<script>alert(1)</script>",
      signerDisplayName: "\u202EAnn [click](https://evil.example)",
      disclosure: "Hello \u202Eworld",
      offerText: "See [docs](javascript:alert(1))",
      signedMeaning: "Signed by <script>alert(1)</script>. \u2066done",
      url: "javascript:alert(1)",
      hash: HASH,
      status: "available",
      image: { url: "data:image/svg+xml,<svg onload=alert(1)></svg>", alt: "<script>mark</script>", src: "javascript:alert(1)" },
    });
    expect(byTag(card, "script")).toEqual([]);
    expect(byTag(card, "img")).toEqual([]);
    expect(card.textContent).toContain("<script>alert(1)</script>");
    expect(card.textContent).toContain("Listed by Ann [click](https://evil.example)");
    expect(card.textContent).toContain("[docs](javascript:alert(1))");
    expect(card.textContent).not.toContain("claimed");
    expect(card.textContent).not.toContain(PAGE_DISCLOSURE);
    expect(card.textContent).not.toContain("What does signed mean?");
    expect(byClass(card, "explain-toggle")).toEqual([]);
    expect(byClass(card, "disclosure")).toEqual([]);
    expect(card.textContent).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
    const hrefs = byTag(card, "a").map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual([`#offer/${HASH}`]);
    expect(hrefs.join(" ")).not.toContain("javascript:");
    expect(hrefs.join(" ")).not.toContain("evil.example");
    expect(byTag(card, "details")).toHaveLength(1);
    expect(byTag(card, "summary")).toHaveLength(1);
    expect(byTag(card, "details")[0]?.getAttribute("open")).toBeNull();
    const link = byClass(card, "more")[0];
    expect(link?.parentNode && hasClass(link.parentNode, "card-summary")).toBe(false);
    expect(card.textContent).not.toContain("Signed by <script>alert(1)</script>");
  });

  it("shows a claimed badge as text and does not add a wallet address", () => {
    const doc = createDoc();
    const wallet = "CuwnarNh7FEqZMmffFjRyWj54RecyS7zwFg1CxfzNudi";
    const card = renderListingCard(doc, {
      title: "North booth",
      signer: wallet,
      signerDisplayName: "North Booth",
      claimed: true,
      hash: HASH,
    });
    expect(byClass(card, "badge")[0]?.textContent).toBe("claimed");
    expect(card.textContent).not.toContain(wallet);
    const hit = renderSearchHit(doc, { kind: "guild", name: "East Hall", link: "https://example.com/east", description: "A group.", claimed: true });
    expect(hit.textContent).toContain("claimed");
    expect(hit.textContent).not.toContain(wallet);
  });

  it("does not turn markdown or bidi in an update or a story into a link", () => {
    const doc = createDoc();
    const update = renderHubUpdate(doc, {
      kind: "announcement",
      created_at: "2026-10-28T15:00:00.000Z",
      body: "See [docs](https://evil.example) <script>alert(1)</script> \u202Ehidden",
    });
    expect(byTag(update, "script")).toEqual([]);
    expect(byTag(update, "a")).toEqual([]);
    expect(update.textContent).toContain("[docs](https://evil.example)");
    expect(update.textContent).toContain("<script>alert(1)</script>");
    expect(update.textContent).not.toContain("\u202E");

    const player = renderPlayerResult(doc, {
      legacy: {
        dataMode: "live",
        profiles: [{ name: "<script>alert(1)</script>", faction: "ONI\u202E" }],
        fleets: [{ name: "[ship](https://evil.example)" }],
      },
      story: {
        state: "ready",
        title: "<script>",
        paragraphs: storyParagraphs({
          paragraphs: ["<script>alert(1)</script>", "Read [this](https://evil.example)"],
        }),
      },
    });
    expect(byTag(player, "script")).toEqual([]);
    expect(byTag(player, "a")).toEqual([]);
    expect(player.textContent).toContain("<script>alert(1)</script>");
    expect(player.textContent).toContain("[this](https://evil.example)");
    expect(player.textContent).toContain("Faction");
    expect(player.textContent).toContain("ONI");
    expect(player.textContent).not.toContain("\u202E");
  });

  it("strips bidi controls and keeps angle brackets as text", () => {
    expect(neutralizeText("Hello \u202Eworld")).toBe("Hello world");
    expect(neutralizeText("<script>alert(1)</script>")).toBe("<script>alert(1)</script>");
    expect(neutralizeText(12)).toBe("");
  });
});

describe("plain display url allowlist", () => {
  it("allows only canonical https urls and sets rel on those links", () => {
    expect(allowedHttpsUrl("https://dock-bakery.example/morning")).toBe("https://dock-bakery.example/morning");
    expect(allowedHttpsUrl("https://dock-bakery.example/morning?ref=1")).toBe("https://dock-bakery.example/morning?ref=1");
    expect(allowedHttpsUrl("https://dock-bakery.example")).toBe("https://dock-bakery.example/");
    expect(allowedHttpsUrl("http://dock-bakery.example/morning")).toBeNull();
    expect(allowedHttpsUrl("javascript:alert(1)")).toBeNull();
    expect(allowedHttpsUrl("data:text/html,hi")).toBeNull();
    expect(allowedHttpsUrl("https://user:pass@dock-bakery.example/morning")).toBeNull();
    expect(allowedHttpsUrl("https://user@dock-bakery.example/morning")).toBeNull();
    expect(allowedHttpsUrl("//dock-bakery.example/morning")).toBeNull();
    expect(allowedHttpsUrl("[click](https://dock-bakery.example/morning)")).toBeNull();
    expect(allowedHttpsUrl("https://dock-bakery.example/\u202Eevil")).toBeNull();
    expect(allowedHttpsUrl("https://127.0.0.1/morning")).toBeNull();
    expect(allowedHttpsUrl("https://localhost/morning")).toBeNull();
    expect(allowedHttpsUrl('https://dock-bakery.example/a"onmouseover="alert(1)')).toBeNull();

    const doc = createDoc();
    const card = renderListingCard(doc, {
      title: "Morning bread",
      signerDisplayName: "Rowan Hale",
      disclosure: "This is a referral.",
      url: "https://dock-bakery.example/morning",
      hash: HASH,
      status: "available",
    });
    const external = byClass(card, "external")[0];
    expect(external?.getAttribute("href")).toBe("https://dock-bakery.example/morning");
    expect(external?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(external?.getAttribute("target")).toBe("_blank");
    expect(external?.textContent).toBe("Open dock-bakery.example");
    expect(card.textContent).toContain("Listed by Rowan Hale");
    expect(card.textContent).not.toContain("Disclosure:");
    expect(byClass(card, "signed-badge")[0]?.textContent).toBe("Signed");

    const blocked = renderListingCard(doc, {
      title: "Stall",
      signerDisplayName: "Imani Cole",
      url: "http://dock-bakery.example/morning",
      hash: HASH,
    });
    expect(byClass(blocked, "external")).toEqual([]);
  });
});

describe("plain display page", () => {
  it("uses an honest empty state and one offer page per hash", () => {
    const { doc } = pageDoc();
    renderPage(doc, { listings: [], updates: [], hash: "" });
    expect(doc.getElementById("listings-body")?.textContent).toBe("No listings yet");
    expect(doc.getElementById("updates-body")?.textContent).toBe("No updates yet");
    expect(doc.getElementById("board")?.hidden).toBe(false);
    expect(doc.getElementById("detail")?.hidden).toBe(true);

    renderPage(doc, {
      listings: [
        {
          title: "Morning bread at the dock",
          signerDisplayName: "Rowan Hale",
          disclosure: "This is a referral.",
          offerText: "Fresh loaves on weekday mornings.",
          url: "https://dock-bakery.example/morning",
          hash: HASH,
          status: "available",
          stream: "referral",
          category: "ip_and_business",
          owner: "Dock Bakery",
          asOf: "2026-10-01",
          expiresAt: "2026-12-01",
        },
      ],
      updates: [],
      hash: `#offer/${HASH}`,
    });
    expect(doc.getElementById("board")?.hidden).toBe(true);
    expect(doc.getElementById("detail")?.hidden).toBe(false);
    expect(doc.getElementById("detail-heading")?.textContent).toBe("Morning bread at the dock");
    const detail = doc.getElementById("detail-body");
    expect(detail?.textContent).toContain("Listed by Rowan Hale");
    expect(detail?.textContent).not.toContain(PAGE_DISCLOSURE);
    expect(detail?.textContent).toContain("Fresh loaves on weekday mornings.");
    expect(detail?.textContent).toContain("From Dock Bakery");
    expect(offerFragment({ hash: "<script>" })).toBeNull();
  });

  it("shows a player story when that tool exists and stays quiet when it does not", async () => {
    const address = "11111111111111111111111111111111";
    const legacy = {
      dataMode: "live",
      profiles: [{ name: "Avery Quinn", faction: "ONI" }],
      fleets: [{ name: "Dawn Courier" }],
      activity: { firstSeen: "2024-03-02T00:00:00.000Z", lastSeen: "2026-10-20T00:00:00.000Z" },
    };
    const calls: string[] = [];
    const rpc = async (method: string, params?: { name?: string; arguments?: Record<string, string> }) => {
      calls.push(`${method}:${params?.name ?? ""}`);
      if (method === "tools/call" && params?.name === "player_legacy") {
        return { result: { structuredContent: legacy } };
      }
      if (method === "tools/call" && params?.name === "player_story") {
        return {
          result: {
            structuredContent: { title: "A quiet start", paragraphs: ["Avery kept the morning watch."] },
          },
        };
      }
      return { error: { message: "missing" } };
    };
    const missing = await lookupPlayer(rpc, address, null);
    expect(missing.story.state).toBe("absent");
    expect(calls).not.toContain("tools/call:player_story");
    const doc = createDoc();
    expect(renderPlayerResult(doc, missing).textContent).toContain("A longer story is not available yet.");

    const storyTool = { name: "player_story", inputSchema: { type: "object", properties: { address: { type: "string" } }, required: ["address"] } };
    expect(playerStoryArguments(storyTool, address)).toEqual({ address });
    expect(playerStoryArguments({ name: "player_story", inputSchema: { properties: { tale: {} }, required: ["tale"] } }, address)).toBeNull();
    const found = await lookupPlayer(rpc, address, storyTool);
    expect(found.story).toMatchObject({ state: "ready", title: "A quiet start" });
    const view = renderPlayerResult(doc, found);
    expect(view.textContent).toContain("Avery Quinn");
    expect(view.textContent).toContain("Dawn Courier");
    expect(view.textContent).toContain("Avery kept the morning watch.");
    expect(view.textContent).not.toContain("A longer story is not available yet.");
  });

  it("reads list_listings and hub_updates and leaves a failed read honest", async () => {
    const rpc = async (method: string, params?: { name?: string }) => {
      if (method === "tools/list") return { result: { tools: [{ name: "list_listings" }, { name: "player_legacy" }] } };
      if (params?.name === "list_listings") return { result: { structuredContent: { listings: [] } } };
      if (params?.name === "hub_updates") return { result: { isError: true, content: [{ type: "text", text: "nope" }] } };
      return { error: { message: "missing" } };
    };
    const board = await loadBoard(rpc);
    expect(board.listings).toEqual([]);
    expect(board.listingsFailed).toBe(false);
    expect(board.updatesFailed).toBe(true);
    expect(board.storyTool).toBeNull();
    const { doc } = pageDoc();
    renderPage(doc, { ...board, hash: "" });
    expect(doc.getElementById("listings-body")?.textContent).toBe("No listings yet");
    expect(doc.getElementById("updates-body")?.textContent).toBe("Updates could not be loaded.");

    const sse = parseRpcBody('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n');
    expect(sse).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
  });

  it("loads the board from /api/mcp and does not call a missing story tool", async () => {
    const { doc, form, input } = pageDoc();
    const names: string[] = [];
    const fetchImpl = async (_url: string, init: { body: string }) => {
      const payload = JSON.parse(init.body) as { method: string; params?: { name?: string } };
      names.push(payload.params?.name ?? payload.method);
      if (payload.method === "notifications/initialized") return jsonResponse(null, 202, "");
      if (payload.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } });
      if (payload.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: 2,
          result: { tools: [{ name: "list_listings" }, { name: "hub_updates" }, { name: "player_legacy" }] },
        });
      }
      if (payload.params?.name === "list_listings") {
        return jsonResponse({ jsonrpc: "2.0", id: 3, result: { structuredContent: { listings: [] } } });
      }
      if (payload.params?.name === "hub_updates") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: 4,
          result: { structuredContent: { updates: [{ kind: "announcement", body: "East hall this week.", created_at: "2026-10-28T15:00:00.000Z" }] } },
        });
      }
      if (payload.params?.name === "player_legacy") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: 5,
          result: { structuredContent: { dataMode: "live", profiles: [{ name: "<script>", faction: "ONI" }], fleets: [] } },
        });
      }
      throw new Error(`unexpected ${payload.method}`);
    };
    await bindPage(doc, { fetch: fetchImpl, location: { origin: "https://preview.example", hash: "" }, view: { addEventListener() {} } });
    expect(doc.getElementById("listings-body")?.textContent).toBe("No listings yet");
    expect(doc.getElementById("updates-body")?.textContent).toContain("East hall this week.");
    input.value = "11111111111111111111111111111111";
    form.dispatch("submit", { preventDefault() {} });
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    const player = doc.getElementById("player-body");
    expect(player?.textContent).toContain("<script>");
    expect(player?.textContent).toContain("A longer story is not available yet.");
    expect(byTag(player ?? doc.body, "script")).toEqual([]);
    expect(names).not.toContain("player_story");
    expect(doc.getElementById("lookup-submit")?.disabled).toBe(false);
  });

  it("keeps signing and the disclosure on the page once, and text-only sources", () => {
    const doc = createDoc();
    const meaning = "Signed by Rowan Hale. This signature means that signer published this listing. It does not move money, and this node never handles payment.";
    const named = renderListingCard(doc, {
      title: "Morning bread",
      signerDisplayName: "Rowan Hale",
      signedMeaning: meaning,
      disclosure: "This is a referral.",
      hash: HASH,
    });
    const other = renderListingCard(doc, {
      title: "Stall",
      disclosure: "Hello world",
      signedMeaning: "",
      hash: HASH,
    });
    expect(named.textContent).not.toContain(meaning);
    expect(named.textContent).not.toContain("This is a referral.");
    expect(other.textContent).not.toContain("Hello world");
    expect(named.textContent + other.textContent).not.toContain(PAGE_DISCLOSURE);
    expect(byClass(named, "explain-toggle")).toEqual([]);
    expect(byClass(other, "disclosure")).toEqual([]);
    expect(byClass(named, "signed-badge")).toHaveLength(1);
    const page = readFileSync(path.join(ROOT, "dashboard/plain/index.html"), "utf8");
    const source = readFileSync(path.join(ROOT, "dashboard/plain/plain.js"), "utf8");
    const signedMeaning =
      "Signed means approved hub signers checked and published this record with their agent record keys. Those are signing keys kept by each team's agent, separate from any wallet that holds funds. A player's own claim is still signed in that player's wallet. It is not an endorsement, it is not proof of ownership, and it does not move money. The business is responsible for its own offer.";
    expect(page.split(signedMeaning).length - 1).toBe(1);
    expect(page).not.toContain("marked this as their own");
    expect(source).not.toContain("marked this as their own");
    expect(source).not.toContain("signedExplainer");
    expect(page.split(PAGE_DISCLOSURE).length - 1).toBe(1);
    expect(page.match(/id="signed-note"/g)).toHaveLength(1);
    expect(page.match(/id="page-disclosure"/g)).toHaveLength(1);
    expect(page).not.toContain("explain-toggle");

    const player = renderPlayerResult(doc, {
      legacy: {
        dataMode: "live",
        disclaimer: "Inspired by Star Atlas. Unofficial community read. <script>alert(1)</script>",
        profiles: [{ name: "Avery Quinn", faction: "ONI" }],
        fleets: [],
        sources: [
          {
            account: "https://evil.example/<script>",
            facts: [{ fact: "profile \u202E<script>alert(1)</script>", signature: "[rec](javascript:alert(1))" }],
          },
        ],
      },
      story: { state: "absent" },
    });
    expect(byTag(player, "script")).toEqual([]);
    expect(byTag(player, "a")).toEqual([]);
    expect(byTag(player, "summary").some((node) => node.textContent === "Sources")).toBe(true);
    expect(player.textContent).toContain("Inspired by Star Atlas. Unofficial community read. <script>alert(1)</script>");
    expect(player.textContent).toContain("https://evil.example/<script>");
    expect(player.textContent).toContain("profile <script>alert(1)</script>");
    expect(player.textContent).toContain("[rec](javascript:alert(1))");
    expect(player.textContent).not.toContain("\u202E");
  });

  it("disables the lookup button while a read is in flight", async () => {
    const { doc, form, input } = pageDoc();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let legacyCalls = 0;
    const fetchImpl = async (_url: string, init: { body: string }) => {
      const payload = JSON.parse(init.body) as { method: string; params?: { name?: string } };
      if (payload.method === "notifications/initialized") return jsonResponse(null, 202, "");
      if (payload.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: 1, result: {} });
      if (payload.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: 2,
          result: { tools: [{ name: "list_listings" }, { name: "hub_updates" }, { name: "player_legacy" }] },
        });
      }
      if (payload.params?.name === "list_listings") {
        return jsonResponse({ jsonrpc: "2.0", id: 3, result: { structuredContent: { listings: [] } } });
      }
      if (payload.params?.name === "hub_updates") {
        return jsonResponse({ jsonrpc: "2.0", id: 4, result: { structuredContent: { updates: [] } } });
      }
      if (payload.params?.name === "player_legacy") {
        legacyCalls += 1;
        await gate;
        return jsonResponse({
          jsonrpc: "2.0",
          id: 5,
          result: {
            structuredContent: {
              dataMode: "live",
              profiles: [{ name: "Avery Quinn", faction: "ONI" }],
              fleets: [],
              disclaimer: "Unofficial community read.",
              sources: [],
            },
          },
        });
      }
      throw new Error(`unexpected ${payload.method}`);
    };
    await bindPage(doc, { fetch: fetchImpl, location: { origin: "https://preview.example", hash: "" }, view: { addEventListener() {} } });
    const button = doc.getElementById("lookup-submit");
    expect(button?.disabled).toBe(false);
    input.value = "11111111111111111111111111111111";
    form.dispatch("submit", { preventDefault() {} });
    form.dispatch("submit", { preventDefault() {} });
    await Promise.resolve();
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-busy")).toBe("true");
    expect(legacyCalls).toBe(1);
    release();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(button?.disabled).toBe(false);
    expect(button?.getAttribute("aria-busy")).toBe("false");
    expect(doc.getElementById("player-body")?.textContent).toContain("Avery Quinn");
    expect(doc.getElementById("player-body")?.textContent).toContain("Unofficial community read.");
    expect(doc.getElementById("player-body")?.textContent).toContain("No sources were listed.");
  });
});

describe("plain display privacy", () => {
  it("keeps /plain indexable, under a strict content policy, and off other public pages", () => {
    const page = readFileSync(path.join(ROOT, "dashboard/plain/index.html"), "utf8");
    const source = readFileSync(path.join(ROOT, "dashboard/plain/plain.js"), "utf8");
    const style = readFileSync(path.join(ROOT, "dashboard/plain/plain.css"), "utf8");
    const config = JSON.parse(readFileSync(path.join(ROOT, "dashboard/vercel.json"), "utf8")) as {
      redirects?: { source: string; destination: string; permanent: boolean }[];
      headers: { source: string; headers: { key: string; value: string }[] }[];
    };
    expect(config.redirects).toContainEqual({ source: "/plain", destination: "/plain/", permanent: true });
    expect(page.toLowerCase()).not.toContain("noindex");
    expect(page).not.toMatch(/<meta\s+name=["']robots["']/i);
    expect(page).toContain('<link rel="icon" href="/plain/favicon.svg" type="image/svg+xml">');
    expect(page).toContain('<link rel="stylesheet" href="/plain/plain.css">');
    expect(page).toContain('<script type="module" src="/plain/plain.js"></script>');
    expect(page).not.toMatch(/(?:href|src)="plain\./);
    const favicon = readFileSync(path.join(ROOT, "dashboard/plain/favicon.svg"), "utf8");
    expect(favicon).toContain("<svg");
    expect(favicon.toLowerCase()).not.toMatch(/<script|javascript:|onload=/);
    expect(page).not.toMatch(/\son\w+=/);
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    for (const word of ["signed", "hub", "profile", "fleet", "faction"]) {
      expect(page).toContain(`>${word}<`);
    }
    const aside = page.replace(/<details class="signed-note"[\s\S]*?<\/details>/, "");
    expect(aside.toLowerCase()).not.toMatch(/yield|crypto|blockchain|wallet|nft|\bprice\b/);
    expect(page.toLowerCase()).not.toMatch(/yield|crypto|blockchain|nft|\bprice\b/);
    expect(style.toLowerCase()).not.toMatch(/yield|crypto|blockchain/);
    for (const token of ["--bg: #04070e", "--card: #0b1526", "--card-2: #0e1b30", "--line: rgba(77, 214, 255, 0.20)", "--ink: #d5deec", "--white: #f4f8ff", "--mute: #8d9bb3", "--cy: #4dd6ff", "--cy-deep: #1fa8d6", "--gold: #e7b24c", "--grn: #6fe3a5", "--red: #ff7a7a"]) {
      expect(style).toContain(token);
    }
    expect(style).toContain("border-radius: var(--radius)");
    expect(style).toContain("box-shadow: var(--shadow)");
    expect(style).not.toMatch(/@import|fonts\.google|fonts\.gstatic/);
    expect(page).not.toMatch(/\sstyle=/);
    expect(style).toMatch(/h1,\s*h2,\s*h3\s*\{[^}]*font-family:\s*"Orbitron",\s*sans-serif/s);
    expect(style).not.toContain("Exo 2");
    expect(style).toMatch(/font-weight:\s*400 900/);
    expect(style).toMatch(/format\("truetype"\)/);
    expect(style).toMatch(/background-color:\s*var\(--bg\)/);
    expect(style).toMatch(/background-repeat:\s*no-repeat/);
    expect(style).toMatch(/a:hover\s*\{\s*color:\s*var\(--cy-bright\)/);
    expect(style).toMatch(/--control:\s*rgba\(77,\s*214,\s*255,\s*0\.[5-9]/);
    expect(style).toMatch(/input\s*\{[^}]*border:\s*1px solid var\(--control\)/s);
    const families = [...style.matchAll(/@font-face\s*\{[^}]*font-family:\s*"([^"]+)"/gs)].map((match) => match[1]);
    expect(new Set(families)).toEqual(new Set(["Inter", "Space Grotesk", "Orbitron"]));
    for (const family of new Set(families)) {
      const licence = readFileSync(path.join(ROOT, "dashboard/plain/fonts", `OFL-${family.replace(/\s+/g, "")}.txt`), "utf8");
      expect(licence, family).toMatch(/^Copyright /);
      expect(licence).toContain("SIL Open Font License, Version 1.1");
      expect(licence).toContain("PREAMBLE");
      expect(licence).toContain("PERMISSION & CONDITIONS");
      expect(licence).toContain("TERMINATION");
      expect(licence).toContain("DISCLAIMER");
    }
    expect(readFileSync(path.join(ROOT, "dashboard/plain/fonts/OFL-Inter.txt"), "utf8")).toContain(
      "Copyright 2016 The Inter Project Authors",
    );
    expect(readFileSync(path.join(ROOT, "dashboard/plain/fonts/OFL-SpaceGrotesk.txt"), "utf8")).toContain(
      "Copyright 2020 The Space Grotesk Project Authors",
    );
    const orbitronLicence = readFileSync(path.join(ROOT, "dashboard/plain/fonts/OFL-Orbitron.txt"), "utf8");
    expect(orbitronLicence).toContain("Copyright 2018 The Orbitron Project Authors");
    const orbitronFont = readFileSync(path.join(ROOT, "dashboard/plain/fonts/Orbitron[wght].ttf"));
    expect(createHash("sha256").update(orbitronFont).digest("hex")).toBe(
      "f42db2dd16e642258e35782916eceb1dcdbea06fb958d77ad71dc5963587e8fd",
    );
    const fontUrls = [...style.matchAll(/url\("(\/plain\/fonts\/[^"]+)"\)/g)].map((match) => match[1]);
    expect(fontUrls.length).toBe(families.length);
    for (const url of fontUrls) {
      const bytes = readFileSync(path.join(ROOT, "dashboard", url.replace(/^\/plain\//, "plain/")));
      if (url.endsWith(".woff2")) expect(bytes.subarray(0, 4).toString("ascii"), url).toBe("wOF2");
      else expect([...bytes.subarray(0, 4)], url).toEqual([0, 1, 0, 0]);
    }

    const plainHeaders = config.headers.filter((rule) => rule.source === "/plain" || rule.source === "/plain/(.*)");
    expect(plainHeaders).toHaveLength(2);
    for (const rule of plainHeaders) {
      const robots = rule.headers.find((header) => header.key === "X-Robots-Tag");
      const csp = rule.headers.find((header) => header.key === "Content-Security-Policy");
      expect(robots).toBeUndefined();
      expect(csp?.value).toContain("default-src 'none'");
      expect(csp?.value).toContain("script-src 'self'");
      expect(csp?.value).toContain("connect-src 'self'");
      expect(csp?.value).toContain("font-src 'self'");
      expect(csp?.value).toContain("img-src 'self' https://raw.githubusercontent.com");
      expect(csp?.value).not.toMatch(/img-src[^;]*\bhttps:(?!\/\/raw\.githubusercontent\.com)/);
      expect(csp?.value).not.toMatch(/img-src[^;]*\bdata:/);
      expect(csp?.value).not.toMatch(/img-src[^;]*\bblob:/);
      expect(csp?.value).not.toMatch(/unsafe-inline|unsafe-eval/);
    }

    const publicHtml = htmlFiles(ROOT);
    expect(publicHtml.length).toBeGreaterThan(0);
    for (const file of publicHtml) {
      expect(readFileSync(file, "utf8"), file).not.toContain("plain/");
    }
    for (const file of filesNamed(ROOT, "robots.txt")) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/disallow:\s*\/plain\b/i);
    }
  });
});

describe("plain layout controls", () => {
  it("cuts a short line on a word boundary and never mid-word", () => {
    const sentence =
      "Wholly owned subsidiary of Neuro Block Game Assets (NBGA). Our primary in-game goal is to expand and participate in all aspects of the game except political. Especially the council.";
    const naive = sentence.slice(0, 160);
    expect(naive.endsWith("Es")).toBe(true);
    const safe = truncateAtWord(sentence, 160);
    expect(safe.endsWith("…")).toBe(true);
    expect(safe.endsWith("Es")).toBe(false);
    const stem = safe.slice(0, -1);
    expect(sentence.startsWith(stem)).toBe(true);
    expect(sentence.charAt(stem.length)).toBe(" ");
    expect(truncateAtWord("alpha bravo charlie", 10)).toBe("alpha…");
    expect(truncateAtWord("short line", 40)).toBe("short line");
    expect(truncateAtWord("Supercalifragilistic expialidocious", 8)).toBe("Supercalifragilistic…");
    expect(truncateAtWord("Supercalifragilistic", 8)).toBe("Supercalifragilistic");
    expect(truncateAtWord("  spaced   out  ", 40)).toBe("spaced out");

    const doc = createDoc();
    const hit = renderSearchHit(doc, {
      kind: "listing",
      name: "Empiria",
      description: naive,
      link: "https://example.com/empiria",
    });
    const preview = byClass(hit, "preview")[0]?.textContent ?? "";
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.endsWith("Es")).toBe(false);
    expect(preview.length).toBeLessThanOrEqual(PREVIEW_LIMIT + 1);
    expect(hit.textContent).toContain(naive);
    const full = byClass(hit, "offer")[0];
    expect(full?.parentNode && hasClass(full.parentNode, "card-summary")).toBe(false);
  });

  it("filters and sorts listings, guilds, and search hits as pure functions", () => {
    const listings = [
      { title: "Cress", category: "events", created_at: "2026-01-01T00:00:00.000Z" },
      { title: "Anchor", category: "creators", created_at: "2026-06-01T00:00:00.000Z" },
      { title: "Baker", category: "creators", created_at: "2026-03-01T00:00:00.000Z" },
    ];
    const categoriesOf = (row: { category?: string }) => {
      const label = listingCategoryLabel(row);
      return label ? [label] : [];
    };
    const nameOf = (row: { title: string }) => row.title;
    const dateOf = (row: { created_at: string }) => row.created_at;
    expect(categoryChoices(listings, categoriesOf)).toEqual(["Creators", "Events"]);
    expect(applyView(listings, { filter: "Creators", sort: "az", categoriesOf, nameOf, dateOf }).map((row: { title: string }) => row.title)).toEqual([
      "Anchor",
      "Baker",
    ]);
    expect(applyView(listings, { filter: "all", sort: "newest", categoriesOf, nameOf, dateOf }).map((row: { title: string }) => row.title)).toEqual([
      "Anchor",
      "Baker",
      "Cress",
    ]);
    expect(applyView(listings, { filter: "all", sort: "category", categoriesOf, nameOf, dateOf }).map((row: { title: string }) => row.title)).toEqual([
      "Anchor",
      "Baker",
      "Cress",
    ]);
    expect(applyView(listings, { filter: "Missing", sort: "az", categoriesOf, nameOf, dateOf })).toEqual([]);

    const guilds = [
      { kind: "guild", guild: { name: "Dawn", tags: ["Dock", "Dawn"] }, created_at: "2026-02-01T00:00:00.000Z" },
      { kind: "guild", guild: { name: "North" }, created_at: "2026-08-01T00:00:00.000Z" },
    ];
    expect(guildTypeLabels(guilds[0])).toEqual(["Dock", "Dawn"]);
    expect(guildTypeLabels(guilds[1])).toEqual(["Group"]);
    expect(categoryChoices(guilds, guildTypeLabels)).toEqual(["Dawn", "Dock", "Group"]);
    expect(
      applyView(guilds, {
        filter: "Dock",
        sort: "az",
        categoriesOf: guildTypeLabels,
        nameOf: (row: { guild: { name: string } }) => row.guild.name,
        dateOf: (row: { created_at: string }) => row.created_at,
      }).map((row: { guild: { name: string } }) => row.guild.name),
    ).toEqual(["Dawn"]);

    const hits = [
      { kind: "player", name: "Zed" },
      { kind: "guild", name: "Dawn" },
      { kind: "listing", name: "Anchor" },
    ];
    const hitCategories = (hit: { kind?: string }) => {
      const label = searchKindLabel(hit);
      return label ? [label] : [];
    };
    expect(categoryChoices(hits, hitCategories)).toEqual(["Group", "Listing", "Player"]);
    expect(applyView(hits, { filter: "Group", sort: "az", categoriesOf: hitCategories, nameOf: (hit: { name: string }) => hit.name, dateOf: () => "" }).map((hit: { name: string }) => hit.name)).toEqual([
      "Dawn",
    ]);
    expect(applyView(hits, { filter: "all", sort: "newest", categoriesOf: hitCategories, nameOf: (hit: { name: string }) => hit.name, dateOf: () => "" }).map((hit: { name: string }) => hit.name)).toEqual([
      "Zed",
      "Dawn",
      "Anchor",
    ]);
  });

  it("collapses cards by default and opens or closes every card together", () => {
    const { doc } = pageDoc();
    const state = {
      listings: [
        { title: "Cress stand", category: "events", offerText: "Late greens.", hash: HASH, status: "available", created_at: "2026-01-02T00:00:00.000Z" },
        {
          title: "Anchor booth",
          category: "creators",
          offerText: "Morning sketches.",
          hash: "cd".repeat(32),
          status: "paused",
          created_at: "2026-05-02T00:00:00.000Z",
          url: "https://anchor.example/booth",
        },
      ],
      updates: [],
      hash: "",
      listingFilter: "all",
      listingSort: "az",
    };
    renderPage(doc, state);
    const body = doc.getElementById("listings-body");
    expect(body?.textContent ?? "").not.toContain(PAGE_DISCLOSURE);
    const cards = byClass(body ?? doc.body, "card");
    expect(cards).toHaveLength(2);
    expect(byTag(body ?? doc.body, "details").every((node) => node.getAttribute("open") === null)).toBe(true);
    const expand = byTag(body ?? doc.body, "button").find((node) => node.textContent === "Expand all");
    const collapse = byTag(body ?? doc.body, "button").find((node) => node.textContent === "Collapse all");
    expect(expand?.textContent).toBe("Expand all");
    expand?.dispatch("click");
    expect(byTag(body ?? doc.body, "details").every((node) => node.getAttribute("open") === "")).toBe(true);
    collapse?.dispatch("click");
    expect(byTag(body ?? doc.body, "details").every((node) => node.getAttribute("open") === null)).toBe(true);
    setCardsOpen(body, true);
    expect(byTag(body ?? doc.body, "details")[0]?.getAttribute("open")).toBe("");

    const titles = () => byTag(body ?? doc.body, "h3").map((node) => node.textContent);
    expect(titles()).toEqual(["Anchor booth", "Cress stand"]);
    const events = byTag(body ?? doc.body, "button").find((node) => node.textContent === "Events");
    const sort = byTag(body ?? doc.body, "select")[0];
    events?.dispatch("click");
    const next = doc.getElementById("listings-body");
    expect(byTag(next ?? doc.body, "h3").map((node) => node.textContent)).toEqual(["Cress stand"]);
    expect(events?.getAttribute("aria-pressed")).toBe("true");
    expect(byTag(next ?? doc.body, "button").find((node) => node.textContent === "Events")).toBe(events);
    expect(byTag(next ?? doc.body, "select")[0]).toBe(sort);
    if (sort) sort.value = "newest";
    sort?.dispatch("change");
    expect(byTag(doc.getElementById("listings-body") ?? doc.body, "select")[0]).toBe(sort);
    expect(doc.getElementById("listings-body")?.textContent).toContain("Cress stand");
  });
});

describe("plain guides", () => {
  it("links the guides, the hub, and the source as static anchors under the intro", () => {
    const page = readFileSync(path.join(ROOT, "dashboard/plain/index.html"), "utf8");
    const source = readFileSync(path.join(ROOT, "dashboard/plain/plain.js"), "utf8");
    const intro = page.indexOf("everyday words.");
    const guides = page.indexOf('id="guides"');
    const board = page.indexOf('id="board"');
    expect(intro).toBeGreaterThan(-1);
    expect(guides).toBeGreaterThan(intro);
    expect(board).toBeGreaterThan(guides);
    expect(page).toContain(">Guides<");
    const links: [string, string][] = [
      ["https://phoenix-collective.app/star-atlas/HOW-IT-WORKS.pdf", "Plain-language guide (PDF)"],
      ["https://phoenix-collective.app/star-atlas/HOW-IT-WORKS.md", "How it works (tech spec)"],
      ["https://github.com/PhoenixClaw01/sa-ecosystem-hub", "Hub repository"],
      ["https://github.com/PhoenixClaw01/sa-ecosystem-node", "Source"],
    ];
    for (const [href, label] of links) {
      expect(page).toContain(`href="${href}"`);
      expect(page).toContain(`>${label}</a>`);
    }
    const section = page.slice(guides, board);
    expect(section).not.toMatch(/<script|\son\w+=/);
    expect(source).not.toContain("HOW-IT-WORKS");
    expect(source).not.toContain("sa-ecosystem-hub");
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });
});

describe("plain search and guild links", () => {
  it("renders site and discord as plain links and keeps a hostile query out of the page", () => {
    const doc = createDoc();
    const card = renderHubUpdate(doc, {
      kind: "guild",
      created_at: "2026-10-28T15:00:00.000Z",
      body: "Dawn watch.",
      guild: {
        name: "<script>alert(1)</script>",
        description: "A morning group.",
        links: ["javascript:alert(1)"],
        site: "https://example.com/dawn",
        discord: "https://discord.gg/dawn-watch",
      },
    });
    expect(byTag(card, "script")).toEqual([]);
    expect(card.textContent).toContain("<script>alert(1)</script>");
    const links = byTag(card, "a");
    const hrefs = links.map((link) => link.getAttribute("href"));
    expect(hrefs).toContain("https://example.com/dawn");
    expect(hrefs).toContain("https://discord.gg/dawn-watch");
    expect(hrefs.join(" ")).not.toContain("javascript:");
    for (const link of links) expect(link.getAttribute("rel")).toBe("noopener noreferrer");

    const hit = renderSearchHit(doc, {
      kind: "guild",
      name: "Dawn Watch",
      description: "A morning group.",
      link: "https://example.com/dawn",
      site: "https://example.com/dawn",
      discord: "https://discord.com/invite/dawn-watch?x=1",
    });
    const hitHrefs = byTag(hit, "a").map((link) => link.getAttribute("href"));
    expect(hitHrefs).toContain("https://example.com/dawn");
    expect(hitHrefs.join(" ")).not.toContain("discord.com");
    expect(allowedDiscordInvite("https://discord.com/invite/dawn-watch?x=1")).toBeNull();
    expect(allowedDiscordInvite("https://discord.com/invite/dawn-watch")).toBe("https://discord.com/invite/dawn-watch");

    const empty = renderSearchResults(doc, { pinned: false, results: [], query: "<script>alert(1)</script>" });
    expect(empty.textContent).toBe("No shared board is pinned, so there is nothing to search.");
    expect(empty.textContent).not.toContain("<script>");
    expect(byTag(empty, "script")).toEqual([]);
    const none = renderSearchResults(doc, { pinned: true, results: [], note: "<img src=x onerror=alert(1)>" });
    expect(none.textContent).toBe("No matches.");
    expect(none.textContent).not.toContain("onerror");

    const external = renderListingCard(doc, {
      title: "Dock Bakery",
      hash: HASH,
      status: "available",
      image: { url: "https://cdn.example.com/logo.png", alt: "Dock mark", src: "https://cdn.example.com/logo.png" },
    });
    expect(byTag(external, "img")).toEqual([]);
    expect(byClass(external, "logo-initial")[0]?.textContent).toBe("D");

    const commit = "a".repeat(40);
    const hubLogo = `https://raw.githubusercontent.com/owner/repo/${commit}/images/logo.png`;
    const local = renderListingCard(doc, {
      title: "Dock Bakery",
      hash: HASH,
      status: "available",
      image: { url: "images/logo.png", alt: "Dock mark", src: hubLogo },
    });
    const img = byTag(local, "img")[0];
    expect(img?.getAttribute("src")).toBe(hubLogo);
    expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(allowedImageUrl("https://cdn.example.com/logo.png")).toBeNull();
    expect(allowedImageUrl(hubLogo)).toBe(hubLogo);
  });
});
