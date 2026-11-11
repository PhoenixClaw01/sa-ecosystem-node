import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { renderPage } from "../dashboard/plain/plain.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HASH = "ab".repeat(32);

describe("plain page real DOM", () => {
  it("renders listings, groups, and updates from a served record without touching NodeList.slice", () => {
    const html = readFileSync(path.join(ROOT, "dashboard/plain/index.html"), "utf8").replace(/<script[\s\S]*?<\/script>/gi, "");
    const window = new Window({
      url: "https://preview.example/plain/",
      settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true },
    });
    window.document.write(html);
    const doc = window.document;
    expect(typeof (doc.body.childNodes as { slice?: unknown }).slice).toBe("undefined");

    renderPage(doc, {
      listings: [
        {
          title: "Dock Bakery",
          signerDisplayName: "Rowan Hale",
          owner: "Dock Bakery",
          category: "ip_and_business",
          status: "available",
          offerText: "Fresh loaves on weekday mornings before the dock bell.",
          url: "https://example.com/bakery",
          hash: HASH,
          created_at: "2026-08-02T00:00:00.000Z",
        },
      ],
      updates: [
        {
          kind: "announcement",
          created_at: "2026-10-28T15:00:00.000Z",
          body: "East hall is open this week.",
        },
        {
          kind: "guild",
          created_at: "2026-09-12T00:00:00.000Z",
          body: "Dawn watch is posted.",
          guild: {
            name: "Dawn Watch",
            description: "A morning group at the dock.",
            tags: ["Dawn"],
            site: "https://example.com/dawn",
            links: ["https://example.com/dawn"],
          },
        },
      ],
      hash: "",
    });

    const listings = doc.getElementById("listings-body")?.textContent ?? "";
    const groups = doc.getElementById("guilds-body")?.textContent ?? "";
    const updates = doc.getElementById("updates-body")?.textContent ?? "";
    expect(listings).toContain("Dock Bakery");
    expect(listings).not.toContain("Loading");
    expect(groups).toContain("Dawn Watch");
    expect(groups).not.toContain("Loading");
    expect(updates).toContain("East hall is open this week.");
    expect(updates).not.toContain("Loading");
    expect(doc.body.textContent).toContain(
      "Signed means approved hub signers checked and published this record with their signing keys.",
    );
    window.close();
  });
});
