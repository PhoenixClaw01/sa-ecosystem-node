import { describe, expect, it } from "vitest";

import { clientKeyFromNode, clientKeyFromRequest, createRateLimiter } from "../src/rate-limit.js";

function nodeRequest(forwarded: string | undefined, remote: string | undefined) {
  return {
    headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
    socket: { remoteAddress: remote },
  };
}

function fetchRequest(forwarded: string | undefined, remote?: string): Request {
  const headers = new Headers();
  if (forwarded !== undefined) headers.set("x-forwarded-for", forwarded);
  const request = new Request("http://127.0.0.1/mcp", { method: "POST", headers });
  if (remote !== undefined) Object.defineProperty(request, "socket", { value: { remoteAddress: remote } });
  return request;
}

describe("rate limit placeholder", () => {
  it("allows up to the limit inside one window and then blocks", () => {
    let time = 1_000;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1_000, now: () => time });
    expect(limiter.check("a")).toMatchObject({ allowed: true, remaining: 1, placeholder: true });
    expect(limiter.check("a")).toMatchObject({ allowed: true, remaining: 0, placeholder: true });
    expect(limiter.check("a")).toMatchObject({ allowed: false, remaining: 0, placeholder: true });
    expect(limiter.check("b").allowed).toBe(true);
    time += 1_000;
    expect(limiter.check("a").allowed).toBe(true);
  });

  it("keys on the socket address and trusts X-Forwarded-For only when asked", () => {
    expect(clientKeyFromNode(nodeRequest("203.0.113.5", "10.0.0.1"), false)).toBe("10.0.0.1");
    expect(clientKeyFromNode(nodeRequest("198.51.100.9, 10.1.1.1", "10.0.0.2"), false)).toBe("10.0.0.2");
    expect(clientKeyFromNode(nodeRequest("203.0.113.8, 10.1.1.1", "10.0.0.1"), true)).toBe("203.0.113.8");
    expect(clientKeyFromNode(nodeRequest(undefined, "10.0.0.9"), true)).toBe("10.0.0.9");
    expect(clientKeyFromNode(nodeRequest("   ", undefined), false)).toBe("local");
    expect(clientKeyFromNode(nodeRequest(undefined, undefined), true)).toBe("local");

    expect(clientKeyFromRequest(fetchRequest("203.0.113.5"), false)).toBe("local");
    expect(clientKeyFromRequest(fetchRequest("198.51.100.9"), false)).toBe("local");
    expect(clientKeyFromRequest(fetchRequest("203.0.113.5", "192.0.2.10"), false)).toBe("192.0.2.10");
    expect(clientKeyFromRequest(fetchRequest("203.0.113.5, 10.0.0.1", "192.0.2.10"), true)).toBe("203.0.113.5");
    expect(clientKeyFromRequest(fetchRequest(undefined, "192.0.2.11"), true)).toBe("192.0.2.11");

    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 5_000 });
    const left = clientKeyFromNode(nodeRequest("203.0.113.5", "10.0.0.1"), false);
    const right = clientKeyFromNode(nodeRequest("203.0.113.5", "10.0.0.2"), false);
    expect(limiter.check(left).allowed).toBe(true);
    expect(limiter.check(left).allowed).toBe(false);
    expect(limiter.check(right).allowed).toBe(true);
    expect(left).not.toBe("anonymous");
    expect(right).not.toBe("anonymous");
  });

  it("prunes expired buckets and refuses new keys when the map is full", () => {
    let time = 1_000;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1_000, maxBuckets: 2, now: () => time });
    expect(limiter.check("a")).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.check("b").allowed).toBe(true);
    expect(limiter.check("c")).toMatchObject({ allowed: false, remaining: 0 });
    expect(limiter.check("a")).toMatchObject({ allowed: true, remaining: 0 });
    time += 1_000;
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("c").allowed).toBe(true);
    expect(limiter.check("d").allowed).toBe(false);
  });
});
