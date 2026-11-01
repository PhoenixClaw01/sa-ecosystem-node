import { afterEach, describe, expect, it } from "vitest";

import middleware, { config, publicHomeMatcherHits } from "../dashboard/middleware.js";

const previous = process.env.PUBLIC_HOME;

afterEach(() => {
  if (previous === undefined) delete process.env.PUBLIC_HOME;
  else process.env.PUBLIC_HOME = previous;
});

describe("PUBLIC_HOME", () => {
  it("matches only / and /index.html", () => {
    expect(config.matcher).toEqual(["/", "/index.html"]);
    expect(publicHomeMatcherHits("/")).toBe(true);
    expect(publicHomeMatcherHits("/index.html")).toBe(true);
    expect(publicHomeMatcherHits("/api/mcp")).toBe(false);
    expect(publicHomeMatcherHits("/plain/")).toBe(false);
  });

  it("redirects / and /index.html to /plain/ when PUBLIC_HOME=plain", () => {
    process.env.PUBLIC_HOME = "plain";
    for (const path of ["/", "/index.html"]) {
      const response = middleware(new Request(`https://preview.example${path}`));
      expect(response.status, path).toBe(302);
      expect(response.headers.get("location"), path).toBe("/plain/");
    }
    const api = middleware(new Request("https://preview.example/api/mcp"));
    expect(api.status).not.toBe(302);
    expect(api.headers.get("location")).toBeNull();
    expect(api.headers.get("x-middleware-next")).toBe("1");
  });

  it("leaves / unchanged when PUBLIC_HOME is unset", () => {
    delete process.env.PUBLIC_HOME;
    const response = middleware(new Request("https://preview.example/"));
    expect(response.status).not.toBe(302);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    process.env.PUBLIC_HOME = "";
    const blank = middleware(new Request("https://preview.example/index.html?from=preview"));
    expect(blank.headers.get("location")).toBeNull();
    expect(blank.headers.get("x-middleware-next")).toBe("1");
  });

  it("falls through to next for hostile or odd PUBLIC_HOME values", () => {
    const values = ["PLAIN", " plain", "plain/", "//evil.com", "plain\r\n"];
    for (const value of values) {
      process.env.PUBLIC_HOME = value;
      for (const path of ["/", "/index.html"]) {
        const response = middleware(new Request(`https://preview.example${path}`));
        const label = `${JSON.stringify(value)} ${path}`;
        expect(response.status, label).not.toBe(302);
        expect(response.headers.get("location"), label).toBeNull();
        expect(response.headers.get("x-middleware-next"), label).toBe("1");
      }
    }
  });
});
