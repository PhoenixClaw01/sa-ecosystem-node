import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import {
  bindPage,
  buildArguments,
  callOutput,
  connectSnippets,
  DESCRIPTION_OVERRIDES,
  endpointFor,
  fieldsFor,
  groupDecimal,
  isRunnable,
  panelJson,
  presentTools,
  renderTreasury,
  summarize,
} from "../dashboard/playground/playground.js";
import {
  base58Decode,
  canonicalPayloadOf,
  flipOneByte,
  precheckProblem,
  verifyEd25519,
  verifyHubRecord,
} from "../dashboard/playground/verify.js";
import { base58Encode } from "../src/hub/base58.js";
import { verifyEd25519Detached } from "../src/hub/ed25519-verify.js";
import { canonicalHubPayload, hubUpdateHash, hubUpdateSigningMessage, type HubUpdatePayload } from "../src/hub/update.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAYGROUND = path.join(ROOT, "dashboard/playground");

function rawPublicKey(publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"]): Uint8Array {
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

function signedListing() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const author = base58Encode(rawPublicKey(publicKey));
  const payload: HubUpdatePayload = {
    v: 1,
    id: "listing-dock-bakery-2026-11",
    created_at: "2026-11-01T00:00:00.000Z",
    author,
    kind: "listing",
    body: "Listing: Dock Bakery.",
    refs: { pip: null, txs: [] },
    prev: null,
    listing: {
      stream: "irl",
      category: "ip_and_business",
      title: "Dock Bakery",
      owner: "Dock Bakery",
      url: "https://example.com/bakery",
      offerText: "Fresh loaves on weekday mornings.",
      status: "available",
      asOf: "2026-10-31",
      expiresAt: "2027-01-29",
      image: { url: "logos/bakery.png", alt: "Dock Bakery logo", link: "https://example.com/bakery" },
      listingId: "dock-bakery",
    },
  } as HubUpdatePayload;
  const signature = base58Encode(new Uint8Array(sign(null, Buffer.from(hubUpdateSigningMessage(payload)), privateKey)));
  // The shape hub_updates serves: payload fields plus derived fields the signature does not cover.
  const row = {
    ...payload,
    listing: { ...payload.listing, image: { ...payload.listing!.image, src: "https://raw.githubusercontent.com/x/y/z/logos/bakery.png" } },
    verified: true,
    hash: hubUpdateHash(payload),
    signature,
    signer: author,
    signerAllowlist: "allowed",
    approvalCount: 2,
    signedBy: [author],
    approvedBy: [author],
    selfApproved: false,
  };
  return { payload, row };
}

describe("playground signature check", () => {
  it("rebuilds the exact canonical payload the server signs", () => {
    const { payload, row } = signedListing();
    expect(canonicalPayloadOf(row)).toBe(canonicalHubPayload(payload));
  });

  it("passes a real record and fails the same record with one byte flipped", async () => {
    const { row } = signedListing();
    const good = await verifyHubRecord(row);
    expect(good.status).toBe("pass");
    const bad = await verifyHubRecord(row, { tamper: true });
    expect(bad.status).toBe("fail");
    expect(typeof bad.flipped).toBe("number");
  });

  it("does not claim pass or fail when the rebuilt bytes do not match the record hash", async () => {
    const { row } = signedListing();
    const edited = { ...row, body: "Listing: someone else." };
    const verdict = await verifyHubRecord(edited);
    expect(verdict.status).toBe("unchecked");
    const unknown = await verifyHubRecord({ ...row, kind: "claim" });
    expect(unknown.status).toBe("unchecked");
  });

  it("refuses small-order keys and R values the way the server does", async () => {
    const identity = new Uint8Array(32);
    identity[0] = 1;
    const zeroSignature = new Uint8Array(64);
    zeroSignature.set(identity, 0);
    const message = new TextEncoder().encode("anything");
    expect(verifyEd25519Detached(message, zeroSignature, identity)).toBe(false);
    expect(precheckProblem(identity, zeroSignature)).toMatch(/small-order/);
    expect((await verifyEd25519(message, zeroSignature, identity)).ok).toBe(false);
    const torsion = Uint8Array.from(Buffer.from("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85", "hex"));
    expect(precheckProblem(torsion, zeroSignature)).toMatch(/small-order/);
  });

  it("agrees with the server verifier on a valid, a non-canonical S, and a wrong-message case", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const key = rawPublicKey(publicKey);
    const message = new TextEncoder().encode("hello");
    const signature = new Uint8Array(sign(null, Buffer.from(message), privateKey));
    const highS = new Uint8Array(signature);
    highS.fill(0xff, 32);
    const other = new TextEncoder().encode("hellp");
    for (const [msg, sig] of [[message, signature], [message, highS], [other, signature]] as const) {
      expect((await verifyEd25519(msg, sig, key)).ok).toBe(verifyEd25519Detached(msg, sig, key));
    }
  });

  it("flips exactly one byte and decodes base58 like the server", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { bytes: out, index } = flipOneByte(bytes);
    expect([...out].filter((value, i) => value !== bytes[i])).toHaveLength(1);
    expect(index).toBe(2);
    const sample = base58Encode(new Uint8Array([0, 0, 5, 250, 7]));
    expect([...base58Decode(sample)]).toEqual([0, 0, 5, 250, 7]);
  });
});

describe("playground forms and summaries", () => {
  const schema = {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 500 },
      direction: { type: "string", enum: ["in", "out", "all"] },
      allowPartial: { type: "boolean" },
      unpaidPips: { type: "array", items: { type: "object" } },
      query: { type: "string", maxLength: 80 },
    },
    required: ["query"],
  };

  it("builds fields from an input schema", () => {
    const fields = fieldsFor(schema);
    expect(fields.map((field: { name: string; kind: string }) => `${field.name}:${field.kind}`)).toEqual([
      "limit:number",
      "direction:choice",
      "allowPartial:boolean",
      "unpaidPips:json",
      "query:text",
    ]);
  });

  it("leaves empty optional fields out and checks types", () => {
    const fields = fieldsFor(schema);
    expect(buildArguments(fields, { query: "dock" })).toEqual({ args: { query: "dock" } });
    expect(buildArguments(fields, { query: "dock", limit: "5", allowPartial: "false", direction: "out", unpaidPips: "[]" })).toEqual({
      args: { query: "dock", limit: 5, allowPartial: false, direction: "out", unpaidPips: [] },
    });
    expect(buildArguments(fields, {}).error).toMatch(/query is required/);
    expect(buildArguments(fields, { query: "x", limit: "1.5" }).error).toMatch(/whole number/);
    expect(buildArguments(fields, { query: "x", direction: "sideways" }).error).toMatch(/one of/);
    expect(buildArguments(fields, { query: "x", unpaidPips: "{}" }).error).toMatch(/JSON list/);
  });

  it("only runs tools the server marks read-only", () => {
    expect(isRunnable({ annotations: { readOnlyHint: true, destructiveHint: false } })).toBe(true);
    expect(isRunnable({ annotations: { readOnlyHint: false } })).toBe(false);
    expect(isRunnable({ annotations: { readOnlyHint: true, destructiveHint: true } })).toBe(false);
    expect(isRunnable({})).toBe(false);
  });

  it("groups digits without rounding them up", () => {
    expect(groupDecimal("829357368.45296781")).toBe("829,357,368.45…");
    expect(groupDecimal("0")).toBe("0");
    expect(groupDecimal("1234.5")).toBe("1,234.5");
    expect(groupDecimal("not a number")).toBeNull();
  });

  it("summarizes only what the reply says", () => {
    const lines = summarize("treasury_balances", {
      readOnly: true,
      dataMode: "live",
      asOf: "2026-11-12T00:00:00.000Z",
      wallets: [{ name: "DAO Treasury", sol: { amount: "1.5" }, tokens: [{ symbol: "USDC", amount: "10" }] }],
    });
    expect(lines.join(" ")).toContain("DAO Treasury holds 1.5 SOL, 10 USDC.");
    expect(lines.join(" ")).toContain("a live read");
    expect(summarize("x", new Error("boom"))[0]).toContain("boom");
    expect(callOutput({ error: { message: "nope" } })).toBeInstanceOf(Error);
    expect(callOutput({ result: { isError: true, content: [{ type: "text", text: "bad input" }] } }).message).toBe("bad input");
  });
});

function playgroundDoc(url = "https://preview.example/playground/") {
  const html = readFileSync(path.join(PLAYGROUND, "index.html"), "utf8").replace(/<script[\s\S]*?<\/script>/gi, "");
  const window = new Window({ url, settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true } });
  window.document.write(html);
  return { window, doc: window.document };
}

function sse(message: unknown): string {
  return `event: message\ndata: ${JSON.stringify(message)}\n\n`;
}

describe("playground page", () => {
  it("never shows a treasury number when the live calls fail", () => {
    const { doc } = playgroundDoc();
    const host = doc.getElementById("pg-treasury")!;
    renderTreasury(doc, host, new Error("HTTP 503 from /mcp"), new Error("HTTP 503 from /mcp"));
    expect(host.textContent).toBe("Data unavailable");
    expect(host.querySelectorAll(".kpi")).toHaveLength(0);
  });

  it("shows Data unavailable and no cached amount when the live balance read failed", () => {
    const { doc } = playgroundDoc();
    const host = doc.getElementById("pg-treasury")!;
    renderTreasury(
      doc,
      host,
      {
        dataMode: "cached",
        asOf: "2026-11-01T00:00:00.000Z",
        liveError: "HTTP 503 from the balance read",
        wallets: [{ name: "DAO Treasury", sol: { amount: "777001.5" }, tokens: [{ symbol: "ATLAS", amount: "777001" }, { symbol: "USDC", amount: "777001" }] }],
      },
      {
        dataMode: "cached",
        asOf: "2026-11-01T00:00:00.000Z",
        figureInForce: { perPipLimitAtlas: "10" },
        lastRefill: { amount: "5", time: "2026-07-08T21:29:16.000Z" },
        nextQuarter: { date: "2026-12-31", onOrAbout: true },
      },
    );
    expect(host.textContent).toBe("Data unavailable");
    expect(host.querySelectorAll(".kpi")).toHaveLength(0);
    expect(host.textContent).not.toContain("777001");
  });

  it("shows Data unavailable and no amount when the fund cache is not populated", () => {
    const { doc } = playgroundDoc();
    const host = doc.getElementById("pg-treasury")!;
    renderTreasury(
      doc,
      host,
      {
        dataMode: "live",
        asOf: "2026-11-12T00:00:00.000Z",
        liveError: null,
        wallets: [{ name: "DAO Treasury", sol: { amount: "1.5" }, tokens: [{ symbol: "ATLAS", amount: "424242" }, { symbol: "USDC", amount: "50" }] }],
      },
      { populated: false, dataMode: "cached", asOf: "2026-11-12T00:00:00.000Z", note: "The treasury cache is not yet populated. No figures were invented.", figureInForce: { perPipLimitAtlas: "999" } },
    );
    expect(host.textContent).toBe("Data unavailable");
    expect(host.textContent).not.toContain("424242");
    expect(host.textContent).not.toContain("999");
    expect(host.querySelectorAll(".kpi")).toHaveLength(0);
  });

  it("shows Data unavailable when any treasury figure is missing", () => {
    const { doc } = playgroundDoc();
    const host = doc.getElementById("pg-treasury")!;
    renderTreasury(
      doc,
      host,
      {
        dataMode: "live",
        liveError: null,
        wallets: [{ name: "DAO Treasury", sol: { amount: "1.5" }, tokens: [{ symbol: "ATLAS", amount: "100" }] }],
      },
      {
        figureInForce: { perPipLimitAtlas: "10" },
        lastRefill: { amount: "5", time: "2026-07-08T00:00:00.000Z" },
        nextQuarter: { date: "2026-12-31" },
      },
    );
    expect(host.textContent).toBe("Data unavailable");
    expect(host.textContent).not.toContain("100");
    expect(host.querySelectorAll(".kpi")).toHaveLength(0);
  });

  it("binds to same-origin /mcp, lists tools, runs only read-only ones, and reports failed treasury reads", async () => {
    const { window, doc } = playgroundDoc();
    const calls: { url: string; body: { method: string; params?: { name?: string } } }[] = [];
    const tools = [
      { name: "treasury_balances", description: "Balances.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false } },
      { name: "ecofund_limit", description: "Limit.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false } },
      { name: "search_hub", description: "Search.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, annotations: { readOnlyHint: true } },
      { name: "write_thing", description: "Writes.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false } },
    ];
    const fakeFetch = async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      if (body.method === "initialize") return new Response(sse({ jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "sa-ecosystem-node", version: "1.0.0" } } }));
      if (body.method === "notifications/initialized") return new Response("", { status: 202 });
      if (body.method === "tools/list") return new Response(sse({ jsonrpc: "2.0", id: body.id, result: { tools } }));
      return new Response("upstream down", { status: 503 });
    };
    const result = await bindPage(doc, { fetch: fakeFetch, location: window.location, view: window });
    expect(calls.every((call) => call.url === "https://preview.example/mcp")).toBe(true);
    expect([...result.allowed].sort()).toEqual(["ecofund_limit", "search_hub", "treasury_balances"]);
    expect(doc.querySelectorAll(".pg-tool")).toHaveLength(3);
    expect(doc.querySelector('[data-tool="write_thing"]')).toBeNull();
    expect(doc.getElementById("pg-status")!.textContent).toContain("3 shown of 4 (1 hidden on this page), 3 marked read-only");
    const treasury = doc.getElementById("pg-treasury")!;
    expect(treasury.textContent).toBe("Data unavailable");
    expect(treasury.querySelectorAll(".kpi")).toHaveLength(0);
    expect(doc.getElementById("pg-connect-url")!.textContent).toBe("https://preview.example/mcp");
    expect(doc.getElementById("pg-connect-config")!.textContent).toContain('"url": "https://preview.example/mcp"');
    expect(calls.filter((call) => call.body.method === "tools/call").map((call) => call.body.params?.name).sort()).toEqual(["ecofund_limit", "treasury_balances"]);
  });

  it("derives every connect URL from the page origin", () => {
    const snippets = connectSnippets(new URL("https://node.example/playground/"));
    expect(snippets.url).toBe("https://node.example/mcp");
    expect(snippets.curl).toContain("https://node.example/mcp");
    expect(snippets.card).toBe("https://node.example/.well-known/h2h-card.json");
    expect(endpointFor(new URL("http://localhost:3000/x"))).toBe("http://localhost:3000/mcp");
  });

  it("lists the real bundle's tools, all marked read-only", async () => {
    const handler = (await import(pathToFileURL(path.join(ROOT, "dashboard/api/mcp.js")).href)).default;
    const response = await handler.fetch(
      new Request("https://preview.example/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );
    const text = await response.text();
    const line = text.split("\n").find((entry: string) => entry.startsWith("data:"));
    const listed = JSON.parse(line ? line.slice(5) : text);
    const tools = listed.result.tools as { name: string; inputSchema: unknown }[];
    expect(tools.length).toBeGreaterThanOrEqual(24);
    expect(tools.every((tool) => isRunnable(tool))).toBe(true);
    for (const tool of tools) expect(Array.isArray(fieldsFor(tool.inputSchema))).toBe(true);
  }, 60_000);

  it("disables the tamper checkbox while a verify is in flight and drops a result if it changed", async () => {
    const { window, doc } = playgroundDoc();
    const { row } = signedListing();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const subtle = {
      async digest(algorithm: string, data: Uint8Array) {
        await gate;
        return crypto.subtle.digest(algorithm, data);
      },
      importKey: crypto.subtle.importKey.bind(crypto.subtle),
      verify: crypto.subtle.verify.bind(crypto.subtle),
    };
    const tools = [
      { name: "hub_updates", description: "Records.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false } },
      { name: "treasury_balances", description: "Balances.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false } },
      { name: "ecofund_limit", description: "Limit.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false } },
    ];
    const fakeFetch = async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      if (body.method === "tools/list") return new Response(sse({ jsonrpc: "2.0", id: body.id, result: { tools } }));
      if (body.method === "tools/call" && body.params.name === "hub_updates") {
        return new Response(sse({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { updates: [row] }, content: [] } }));
      }
      return new Response("no", { status: 503 });
    };
    await bindPage(doc, { fetch: fakeFetch, location: window.location, view: window, subtle });
    const load = doc.getElementById("pg-records-load") as unknown as { disabled: boolean; click(): void };
    load.click();
    for (let i = 0; i < 50 && load.disabled; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const tamper = doc.getElementById("pg-tamper") as unknown as { checked: boolean; disabled: boolean };
    const verify = doc.getElementById("pg-verify") as unknown as { disabled: boolean; click(): void };
    expect(verify.disabled).toBe(false);
    tamper.checked = true;
    verify.click();
    expect(tamper.disabled).toBe(true);
    expect(verify.disabled).toBe(true);
    tamper.checked = false;
    release();
    for (let i = 0; i < 50 && (tamper.disabled || verify.disabled); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(tamper.disabled).toBe(false);
    expect(verify.disabled).toBe(false);
    expect(doc.getElementById("pg-verdict")!.textContent).toBe("");
  });
});

describe("playground hide list", () => {
  const WORDING = /\bPIPs?\b|PIP-\d|Council|\bvot(e|es|ing|ers?)\b|proposal/i;
  const HIDDEN_TOOLS = ["pip_tracker", "list_proposals", "get_proposal_votes"];
  const DISCLOSURE = "Inspired by Star Atlas. Unofficial community read. This node is not affiliated with ATMTA, holds no funds, and holds no game or Council keys.";
  /** Third-party guild free text. It stays verbatim and is the only wording this page may show. */
  const GUILD_FREE_TEXT = ["head of council", "The Pirate Council Rules", "Leaders: The Council"];
  const CENTRE_NOTE = "Lore reference only. Not a Council record. No one signs on the Council's behalf. Renderer decides the label.";

  function withoutGuildFreeText(text: string) {
    return GUILD_FREE_TEXT.reduce((rest, phrase) => rest.split(phrase).join(""), text);
  }

  function expectNoWording(doc: { body: { textContent: string | null; innerHTML: string } }) {
    const text = withoutGuildFreeText(String(doc.body.textContent));
    const html = withoutGuildFreeText(doc.body.innerHTML);
    expect(text.match(new RegExp(`.{0,60}(${WORDING.source}).{0,60}`, "i"))?.[0] ?? null).toBeNull();
    expect(html).not.toMatch(WORDING);
    expect(doc.body.innerHTML).not.toContain("Not a Council record");
  }

  function toolPayload(name: string) {
    if (name === "treasury_balances") {
      return {
        disclaimer: DISCLOSURE,
        readOnly: true,
        dataMode: "live",
        asOf: "2026-11-12T00:00:00.000Z",
        liveError: null,
        sources: [{ url: "https://example.invalid/a", note: "PIP-23 names the same two wallets." }],
        wallets: [{ name: "DAO Treasury", sol: { amount: "1.5" }, tokens: [{ symbol: "ATLAS", amount: "100" }, { symbol: "USDC", amount: "50" }] }],
      };
    }
    if (name === "ecofund_limit") {
      return {
        disclaimer: DISCLOSURE,
        readOnly: true,
        dataMode: "cached",
        asOf: "2026-11-12T00:00:00.000Z",
        figureInForce: { perPipLimitAtlas: "10", source: "pip23" },
        currentPerPipLimit: { amount: "10", rule: "5% of the balance (PIP-23 section c)." },
        lastRefill: { amount: "5", time: "2026-07-08T21:29:16.000Z", detection: "PIP-23 refill noted by the Council." },
        nextQuarter: { date: "2026-12-31", note: "PIP-23 quarter." },
        rule: { pip: "PIP-23", perPipLimit: "No Ecosystem Fund PIP shall exceed 5%." },
        councilOverride: { label: "Council" },
        remainingAfterUnpaidPips: { reason: "PIP-23 does not publish unpaid PIP amounts." },
      };
    }
    if (name === "dao_overview") {
      return {
        disclaimer: DISCLOSURE,
        readOnly: true,
        sections: [
          { name: "proposals", ok: true, data: { proposals: [{ title: "A proposal", voteData: { Yes: { count: "1" } } }] } },
          { name: "treasury_balances", ok: true },
        ],
      };
    }
    if (name === "data_health") {
      return {
        disclaimer: DISCLOSURE,
        readOnly: true,
        dataMode: "live",
        asOf: "2026-11-12T00:00:00.000Z",
        sources: [{ note: "Council sheet probe." }],
        checks: [
          { source: "council_sheet", ok: true, error: null },
          { source: "galaxy_proposals", ok: false, error: "Galaxy proposals failed." },
        ],
      };
    }
    if (name === "list_c4_markers") {
      return {
        disclaimer: DISCLOSURE,
        readOnly: true,
        generatedAt: "2026-11-12T00:00:00.000Z",
        centre: { kind: "centre", label: null, note: CENTRE_NOTE },
        note: "Markers are the current signed listings and guild listings. Every marker is placement orbit with anchor none.",
        markers: [{ id: "guild:guild-east-hall", kind: "guild", title: "The Pirate Council Rules", placement: "orbit", anchor: { status: "none", how: null } }],
      };
    }
    if (name === "hub_updates") {
      const { row } = signedListing();
      return {
        disclaimer: DISCLOSURE,
        readOnly: true,
        dataMode: "live",
        asOf: "2026-11-12T00:00:00.000Z",
        updates: [
          {
            kind: "guild",
            id: "guild-east-hall",
            body: "Leaders: The Council",
            guild: { name: "The Pirate Council Rules", description: "head of council", links: ["https://example.invalid/rules"] },
            refs: { pip: null, txs: [] },
          },
          { kind: "proposal-note", id: "note-1", body: "This proposal needs a vote.", refs: { pip: "PIP-9", txs: [] }, author: "x" },
          { ...row, refs: { ...row.refs, pip: "PIP-1" } },
        ],
      };
    }
    return { disclaimer: DISCLOSURE, readOnly: true, dataMode: "live", asOf: "2026-11-12T00:00:00.000Z" };
  }

  it("hides the three governance tools, counts honestly, and renders no such wording from the real tool list", async () => {
    const handler = (await import(pathToFileURL(path.join(ROOT, "dashboard/api/mcp.js")).href)).default;
    const { window, doc } = playgroundDoc();
    const names: string[] = [];
    const fakeFetch = async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      if (body.method === "tools/call") {
        names.push(body.params.name);
        const payload = toolPayload(body.params.name);
        return new Response(sse({ jsonrpc: "2.0", id: body.id, result: { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload) }] } }));
      }
      return handler.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: init.body }));
    };
    const result = await bindPage(doc, { fetch: fakeFetch, location: window.location, view: window });
    const total = result.tools.length;
    expect(total).toBeGreaterThanOrEqual(24);
    expect(result.shown).toHaveLength(total - HIDDEN_TOOLS.length);
    for (const name of HIDDEN_TOOLS) {
      expect(result.tools.some((tool: { name: string }) => tool.name === name), name).toBe(true);
      expect(doc.querySelector(`[data-tool="${name}"]`), name).toBeNull();
      expect(result.allowed.has(name), name).toBe(false);
    }
    expect(doc.querySelectorAll(".pg-tool")).toHaveLength(total - HIDDEN_TOOLS.length);
    expect(doc.getElementById("pg-status")!.textContent).toContain(`${total - HIDDEN_TOOLS.length} shown of ${total} (${HIDDEN_TOOLS.length} hidden on this page)`);
    expectNoWording(doc);
    (doc.getElementById("pg-records-load") as unknown as { click(): void }).click();
    for (let i = 0; i < 50 && doc.getElementById("pg-records-load")!.hasAttribute("disabled"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(doc.getElementById("pg-record-pick")!.textContent).toContain("listing-dock-bakery");
    expect(doc.getElementById("pg-record-pick")!.textContent).not.toContain("note-1");
    for (const phrase of GUILD_FREE_TEXT) expect(doc.body.textContent, phrase).toContain(phrase);
    expectNoWording(doc);
    for (const form of doc.querySelectorAll(".pg-tool form")) {
      for (const input of form.querySelectorAll("input, select, textarea")) {
        const named = input as unknown as { value: string; tagName: string; getAttribute(name: string): string | null };
        if (!named.getAttribute("name")) continue;
        if (named.tagName === "SELECT") {
          const option = [...input.querySelectorAll("option")].find((item) => item.getAttribute("value"));
          if (option) named.value = option.getAttribute("value") ?? "";
        } else if (named.tagName === "TEXTAREA") {
          named.value = (named.getAttribute("placeholder") ?? "").includes("{") ? "{}" : "[]";
        } else if (named.getAttribute("type") === "number") {
          named.value = "1";
        } else {
          named.value = "dockdockdockdockdockdockdockdock";
        }
      }
      const button = form.querySelector("button") as unknown as { disabled: boolean };
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      for (let i = 0; i < 50 && button.disabled; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      expectNoWording(doc);
    }
    for (const tool of result.shown as { name: string }[]) {
      if (!isRunnable(tool)) continue;
      expect(names, tool.name).toContain(tool.name);
    }
    expect(names.every((name) => !HIDDEN_TOOLS.includes(name))).toBe(true);
  }, 60_000);

  it("does not ship the governance words or a denylist that spells them", () => {
    const served = ["index.html", "playground.js", "verify.js", "boot.js"].map((name) => readFileSync(path.join(PLAYGROUND, name), "utf8")).join("\n");
    const css = [path.join(ROOT, "dashboard/styles.css"), path.join(ROOT, "dashboard/home.css"), path.join(PLAYGROUND, "playground.css")]
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(served).not.toMatch(WORDING);
    expect(css).not.toMatch(WORDING);
    for (const word of ["pip_tracker", "list_proposals", "get_proposal_votes", "councilOverride", "unpaidPips", "proposal-note"]) {
      expect(served).not.toContain(word);
    }
    const markers = toolPayload("list_c4_markers");
    const panel = JSON.stringify(panelJson("list_c4_markers", markers));
    const summary = summarize("list_c4_markers", markers).join(" ");
    expect(panel).not.toContain(CENTRE_NOTE);
    expect(panel).not.toContain("Not a Council record");
    expect(panel).toContain("The Pirate Council Rules");
    expect(summary).not.toMatch(WORDING);
    expect(withoutGuildFreeText(panel)).not.toMatch(WORDING);
  });

  it("keeps hidden tools and fields out of presentTools without touching the input", () => {
    const tools = [
      { name: "pip_tracker", description: "x" },
      { name: "ecofund_limit", description: "server text", inputSchema: { type: "object", properties: { asOf: { type: "string" }, unpaidPips: { type: "array" }, councilOverride: { type: "object" } }, required: ["unpaidPips"] } },
    ];
    const shown = presentTools(tools);
    expect(shown.map((tool: { name: string }) => tool.name)).toEqual(["ecofund_limit"]);
    expect(Object.keys(shown[0].inputSchema.properties)).toEqual(["asOf"]);
    expect(shown[0].inputSchema.required).toEqual([]);
    expect(shown[0].description).toBe(DESCRIPTION_OVERRIDES.ecofund_limit);
    expect(Object.keys(tools[1].inputSchema!.properties)).toHaveLength(3);
    for (const text of Object.values(DESCRIPTION_OVERRIDES)) expect(text).not.toMatch(WORDING);
    const hub = presentTools([{ name: "hub_updates", inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["listing", "proposal-note", "guild"] } } } }]);
    expect(hub[0].inputSchema.properties.kind.enum).toEqual(["listing", "guild"]);
  });
});

describe("playground files", () => {
  const files = ["index.html", "playground.js", "verify.js", "boot.js", "playground.css"].map((name) => [name, readFileSync(path.join(PLAYGROUND, name), "utf8")] as const);

  it("hardcodes no deployment host and writes no HTML from data", () => {
    for (const [name, text] of files) {
      expect(text, name).not.toMatch(/vercel\.app|https?:\/\/[a-z0-9-]+\.vercel/i);
      if (name.endsWith(".js")) expect(text, name).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    }
  });

  it("offers no write, claim, sign, or payment action", () => {
    const source = files.filter(([name]) => name.endsWith(".js")).map(([, text]) => text).join("\n");
    expect(source).not.toMatch(/signMessage|signTransaction|sendTransaction|privateKey|secretKey|"sign"\]/);
    expect(source).not.toMatch(/"(claim|attest|hub-claim|hub-attest)"/);
  });

  it("is linked from the dashboard nav and the plain page, and served with a strict CSP", () => {
    const dashboard = readFileSync(path.join(ROOT, "dashboard/index.html"), "utf8");
    const plain = readFileSync(path.join(ROOT, "dashboard/plain/index.html"), "utf8");
    const vercel = JSON.parse(readFileSync(path.join(ROOT, "dashboard/vercel.json"), "utf8"));
    expect(dashboard).toMatch(/<nav class="topbar"[\s\S]*href="\/playground\/"[\s\S]*<\/nav>/);
    expect(plain).toContain('href="/playground/"');
    const header = vercel.headers.find((entry: { source: string }) => entry.source === "/playground/(.*)");
    const csp = header.headers.find((entry: { key: string }) => entry.key === "Content-Security-Policy").value as string;
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(vercel.redirects).toContainEqual({ source: "/playground", destination: "/playground/", permanent: true });
  });
});

describe("front page portal", () => {
  const home = readFileSync(path.join(ROOT, "dashboard/index.html"), "utf8");
  const homeJs = readFileSync(path.join(ROOT, "dashboard/home.js"), "utf8");
  const playgroundHtml = readFileSync(path.join(PLAYGROUND, "index.html"), "utf8");

  function homeDoc() {
    const html = home.replace(/<script[\s\S]*?<\/script>/gi, "");
    const window = new Window({ url: "https://preview.example/", settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true } });
    window.document.write(html);
    return { window, doc: window.document };
  }

  it("links the featured tools and every node tool, with one module script and no inline code", async () => {
    for (const href of [
      "/playground/",
      "/playground/#records",
      "/plain/",
      "/playground/#tool-claim_status",
      "/playground/#tool-hub_updates",
      "/.well-known/h2h-card.json",
      "/playground/#connect",
      "https://ses.aephia.com/C4Live/",
      "https://github.com/Aephia/atlas-kit",
      "https://github.com/ttdonovan/sa-forge-signer",
      "https://ttdonovan.github.io/sa-forge-signer/",
      "https://ttdonovan.github.io/sa-forge-signer/llms.txt",
    ]) {
      expect(home).toContain(`href="${href}"`);
    }
    const { C4_CREATOR_URL } = await import("../dashboard/home.js");
    expect(home).toContain(`href="${C4_CREATOR_URL}"`);
    expect(home.match(/<script/g)).toHaveLength(1);
    expect(home).toContain('<script type="module" src="/home.js"></script>');
    expect(home).not.toMatch(/\son\w+=|\sstyle=|<iframe/);
    expect(home).toContain("Unofficial, self-hosted; review its");
    expect(home).not.toMatch(/audited|reviewed by us|we reviewed/i);
  });

  it("carries no governance, funding-request, or partnership copy", () => {
    for (const text of [home, playgroundHtml, homeJs]) {
      expect(text).not.toMatch(/\bPIPs?\b|PIP-\d|Council|\bvot(e|es|ing)\b|proposal|budget/i);
      expect(text).not.toMatch(/\bpartner|co-builder|in collaboration|endorsed by|\bofficial/i);
    }
  });

  it("keeps the featured heading in one constant", async () => {
    const { FEATURED_HEADING } = await import("../dashboard/home.js");
    expect(typeof FEATURED_HEADING).toBe("string");
    expect(home).toMatch(/<h2 id="featured-heading"><\/h2>/);
    expect(homeJs.split(JSON.stringify(FEATURED_HEADING)).length - 1).toBe(1);
  });

  it("adds decimal strings exactly and groups revenue by month, newest first", async () => {
    const { addDecimal, revenueMonths } = await import("../dashboard/home.js");
    expect(addDecimal("0.1", "0.2")).toBe("0.3");
    expect(addDecimal("733442.58604847", "167384.223915")).toBe("900826.80996347");
    expect(addDecimal("x", "1")).toBeNull();
    const { formatUsd } = await import("../dashboard/home.js");
    expect(formatUsd("4005.009")).toBe("$4,005.01");
    expect(formatUsd("0.004")).toBe("$0.00");
    expect(formatUsd("999.995")).toBe("$1,000.00");
    expect(formatUsd("nope")).toBe("—");
    const { names, rows } = revenueMonths({
      months: [
        { period: "2026-01-01", sources: [{ segmentation: "Game Activity", usdcValue: "10" }, { segmentation: "Marketplace Fees", usdcValue: "2.5" }] },
        { period: "2026-02-01", sources: [{ segmentation: "Game Activity", usdcValue: "1" }, { segmentation: "Game Activity", usdcValue: "1" }] },
      ],
    });
    expect(names).toEqual(["Game Activity", "Marketplace Fees"]);
    expect(rows.map((row: { period: string; total: string }) => `${row.period}=${row.total}`)).toEqual(["2026-02=2", "2026-01=12.5"]);
  });

  it("shows Data unavailable and no figure when every live read fails", async () => {
    const { bindHome, FEATURED_HEADING } = await import("../dashboard/home.js");
    const { window, doc } = homeDoc();
    const fakeFetch = async () => new Response("down", { status: 503 });
    await bindHome(doc, { fetch: fakeFetch, location: window.location, view: window });
    expect(doc.getElementById("featured-heading")!.textContent).toBe(FEATURED_HEADING);
    for (const id of ["revenue-host", "atlas-kit-live", "playground-live", "treasury-host"]) {
      expect(doc.getElementById(id)!.textContent, id).toBe("Data unavailable");
      expect(doc.getElementById(id)!.textContent, id).not.toMatch(/\$\d/);
    }
    expect(doc.querySelectorAll(".kpi")).toHaveLength(0);
  });

  it("renders live revenue rows and loads the 3D view only after a click", async () => {
    const { bindHome } = await import("../dashboard/home.js");
    const { window, doc } = homeDoc();
    const revenue = {
      dataMode: "live",
      asOf: "2026-11-12T00:00:00.000Z",
      bySource: [{ segmentation: "Marketplace Fees", mint: "USDC", amount: "1234.5", usdcValue: "1234.5", months: 3 }],
      months: [{ period: "2026-10-01", sources: [{ segmentation: "Marketplace Fees", mint: "USDC", amount: "100", usdcValue: "100" }] }],
    };
    const fakeFetch = async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      if (body.method === "tools/call" && body.params.name === "dao_revenue") {
        return new Response(sse({ jsonrpc: "2.0", id: body.id, result: { structuredContent: revenue, content: [] } }));
      }
      return new Response("down", { status: 503 });
    };
    await bindHome(doc, { fetch: fakeFetch, location: window.location, view: window });
    const host = doc.getElementById("revenue-host")!;
    expect(host.textContent).toContain("$1,234.50");
    expect(host.textContent).toContain("2026-10");
    expect(doc.querySelector("iframe")).toBeNull();
    (doc.getElementById("c4-load") as unknown as { click(): void }).click();
    const frame = doc.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("https://ses.aephia.com/C4Live/");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
  });

  it("renders Data unavailable for a month whose source rows have no usdcValue string", async () => {
    const { renderRevenue } = await import("../dashboard/home.js");
    const { doc } = homeDoc();
    const host = doc.getElementById("revenue-host")!;
    renderRevenue(doc, host, {
      dataMode: "live",
      asOf: "2026-11-12T00:00:00.000Z",
      bySource: [{ segmentation: "Marketplace Fees", mint: "USDC", amount: "3", usdcValue: "3", months: 1 }],
      months: [{ period: "2026-04-01", sources: [{ segmentation: "Marketplace Fees", mint: "USDC", amount: "3" }] }],
    });
    const table = host.querySelector("tbody")!;
    expect(table.textContent).toContain("Data unavailable");
    expect(table.textContent).not.toContain("$0.00");
    expect(table.textContent).not.toMatch(/\$\d/);
    expect(host.textContent).not.toContain("$0.00");
  });

  it("serves / under a strict policy that frames only the 3D view", () => {
    const vercel = JSON.parse(readFileSync(path.join(ROOT, "dashboard/vercel.json"), "utf8"));
    for (const source of ["/", "/index.html"]) {
      const rule = vercel.headers.find((entry: { source: string }) => entry.source === source);
      const csp = rule.headers.find((entry: { key: string }) => entry.key === "Content-Security-Policy").value as string;
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("frame-src https://ses.aephia.com");
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    }
  });

  it("keeps the earlier page's scripts out of the deploy but not the function's files", () => {
    const ignore = readFileSync(path.join(ROOT, "dashboard/.vercelignore"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    for (const name of ["app.js", "chain.js", "config.js", "dao.js", "tracker.csv", "balances.json", "ata.js", "squads.js"]) expect(ignore).toContain(name);
    const vercel = JSON.parse(readFileSync(path.join(ROOT, "dashboard/vercel.json"), "utf8"));
    const included = String(vercel.functions["api/mcp.js"].includeFiles).replace(/[{}]/g, "").split(",");
    expect(included).not.toContain("ata.js");
    expect(included).not.toContain("squads.js");
    for (const file of [...included, "api/mcp.js", "index.html", "home.js", "home.css", "styles.css", "playground", "plain", ".well-known"]) {
      expect(ignore.some((entry) => entry === file || file.startsWith(`${entry}/`)), file).toBe(false);
    }
  });

  it("opens a linked tool card from the URL hash", async () => {
    const { window, doc } = playgroundDoc("https://preview.example/playground/#tool-claim_status");
    const tools = [{ name: "claim_status", description: "Claims.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }];
    const fakeFetch = async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      if (body.method === "tools/list") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools } }));
      return new Response("no", { status: 503 });
    };
    await bindPage(doc, { fetch: fakeFetch, location: window.location, view: window });
    expect(doc.getElementById("tool-claim_status")!.hasAttribute("open")).toBe(true);
  });
});
