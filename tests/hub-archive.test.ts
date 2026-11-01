import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import { HUB_ARCHIVE_MAX_BYTES, HUB_ARCHIVE_MAX_FILES, HUB_ARCHIVE_MAX_HEADERS, HUB_ARCHIVE_UNCOMPRESSED_MAX_BYTES, HUB_FETCH_TIMEOUT_MS, parseGithubRepo } from "../src/hub/github-archive.js";
import { HUB_FETCH_FAILURE_TTL_MS, chooseHubTransport, loadPinnedHubStore, resetHubFetchCache } from "../src/hub/store.js";
import { loadConfig } from "../src/config.js";

const COMMIT = "a".repeat(40);
const OTHER = "b".repeat(40);
const REPO = "https://github.com/example/demo";

function checksum(header: Buffer): number {
  let sum = 0;
  for (let index = 0; index < 512; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
  }
  return sum;
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function tarHeader(name: string, size: number, type: string, linkname = ""): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(octal(0o644, 8), 100, 8, "utf8");
  header.write(octal(0, 8), 108, 8, "utf8");
  header.write(octal(0, 8), 116, 8, "utf8");
  header.write(octal(size, 12), 124, 12, "utf8");
  header.write(octal(0, 12), 136, 12, "utf8");
  header.write("        ", 148, 8, "utf8");
  header.write(type, 156, 1, "utf8");
  if (linkname) header.write(linkname, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "utf8");
  header.write("00", 263, 2, "utf8");
  header.write(`${checksum(header).toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
  return header;
}

function pad(size: number): Buffer {
  const extra = size % 512 === 0 ? 0 : 512 - (size % 512);
  return Buffer.alloc(extra);
}

function paxRecord(key: string, value: string): Buffer {
  const rest = ` ${key}=${value}\n`;
  let length = rest.length;
  for (;;) {
    const total = String(length).length + rest.length;
    if (total === length) return Buffer.from(`${length}${rest}`);
    length = total;
  }
}

function entry(name: string, type: string, body: Buffer = Buffer.alloc(0), linkname = ""): Buffer {
  return Buffer.concat([tarHeader(name, body.length, type, linkname), body, pad(body.length)]);
}

function archive(commit: string, files: { name: string; type?: string; body?: Buffer; linkname?: string }[]): Buffer {
  const parts = [entry("pax_global_header", "g", paxRecord("comment", commit)), entry(`demo-${commit}/`, "5")];
  for (const file of files) {
    parts.push(entry(file.name, file.type ?? "0", file.body ?? Buffer.alloc(0), file.linkname ?? ""));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function gzipArchive(commit: string, files: { name: string; type?: string; body?: Buffer; linkname?: string }[]): Buffer {
  return gzipSync(archive(commit, files));
}

interface Captured {
  urls: string[];
  inits: RequestInit[];
}

function fetchGzip(body: Buffer, redirect: "codeload" | "direct" | string = "codeload"): { fetch: typeof fetch; captured: Captured } {
  const captured: Captured = { urls: [], inits: [] };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    captured.urls.push(url);
    captured.inits.push(init ?? {});
    if (redirect === "direct") {
      return new Response(body, { status: 200, headers: { "content-disposition": `attachment; filename=demo-${COMMIT}.tar.gz` } });
    }
    if (typeof redirect === "string" && redirect !== "codeload") {
      return new Response(null, { status: 302, headers: { location: redirect } });
    }
    if (url.startsWith("https://github.com/")) {
      const location = url.replace("https://github.com/", "https://codeload.github.com/").replace(`/archive/${COMMIT}.tar.gz`, `/tar.gz/${COMMIT}`);
      return new Response(null, { status: 302, headers: { location } });
    }
    return new Response(body, {
      status: 200,
      headers: { "content-disposition": `attachment; filename=demo-${COMMIT}.tar.gz` },
    });
  };
  return { fetch: fetchImpl, captured };
}

function pin(commit = COMMIT, manifestHash = "c".repeat(64)) {
  return {
    repo: REPO,
    commit,
    manifestPath: "hub-manifest.json",
    manifestHash,
  };
}

afterEach(() => {
  resetHubFetchCache();
  vi.useRealTimers();
});

describe("hub transport", () => {
  it("uses git when the binary is present and HTTPS when it is not", () => {
    expect(HUB_FETCH_TIMEOUT_MS).toBe(20_000);
    expect(chooseHubTransport()).toBe("git");
    expect(chooseHubTransport({ gitAvailable: () => true })).toBe("git");
    expect(chooseHubTransport({ gitAvailable: () => false })).toBe("https");
    expect(chooseHubTransport({ transport: "https", gitAvailable: () => true })).toBe("https");
    expect(chooseHubTransport({ transport: "git", gitAvailable: () => false })).toBe("git");
  });
});

describe("pinned GitHub archive", () => {
  const manifest = JSON.stringify({ v: 1, updates: ["updates/one.json"] });
  const document = JSON.stringify({ id: "one", note: "from the archive" });
  const manifestHash = createHash("sha256").update(manifest).digest("hex");
  const files = [
    { name: `demo-${COMMIT}/hub-manifest.json`, body: Buffer.from(manifest) },
    { name: `demo-${COMMIT}/updates/one.json`, body: Buffer.from(document) },
  ];

  it("reads a commit-pinned archive without calling git", async () => {
    const { fetch: fetchImpl, captured } = fetchGzip(gzipArchive(COMMIT, files));
    const loaded = await loadPinnedHubStore(
      { ...pin(COMMIT, manifestHash), manifestFallback: true },
      { transport: "https", fetch: fetchImpl },
    );
    expect(loaded.documents).toEqual([JSON.parse(document)]);
    expect(loaded.sourceUrl).toBe(REPO);
    expect(loaded.manifestPath).toBe("hub-manifest.json");
    expect(captured.urls).toEqual([
      `https://github.com/example/demo/archive/${COMMIT}.tar.gz`,
      `https://codeload.github.com/example/demo/tar.gz/${COMMIT}`,
    ]);
    expect(captured.urls.some((url) => url.includes("@") || url.includes("?") || url.includes("#"))).toBe(false);
    for (const init of captured.inits) {
      expect(init.redirect).toBe("manual");
      expect(init.credentials).toBe("omit");
      const headers = init.headers as Record<string, string>;
      expect(headers.authorization).toBeUndefined();
      expect(JSON.stringify(headers).toLowerCase()).not.toContain("bearer");
    }
  });

  it("accepts a github.com response that is already the archive", async () => {
    const { fetch: fetchImpl, captured } = fetchGzip(gzipArchive(COMMIT, files), "direct");
    const loaded = await loadPinnedHubStore(pin(COMMIT, manifestHash), { transport: "https", fetch: fetchImpl });
    expect(loaded.documents).toEqual([JSON.parse(document)]);
    expect(captured.urls).toEqual([`https://github.com/example/demo/archive/${COMMIT}.tar.gz`]);
  });

  it("refuses a fetch error without echoing the failure", async () => {
    await expect(
      loadPinnedHubStore(pin(), {
        transport: "https",
        fetch: async () => {
          throw new Error("network down at https://user:secret@github.com/example/demo");
        },
      }),
    ).rejects.toThrow(/^The hub git store could not be read\. No updates were returned\.$/);
  });

  it("refuses an HTTP error and a redirect off the allowlist", async () => {
    await expect(
      loadPinnedHubStore(pin(), {
        transport: "https",
        fetch: async () => new Response("nope", { status: 500 }),
      }),
    ).rejects.toThrow(/could not be read/);

    const calls: string[] = [];
    await expect(
      loadPinnedHubStore(pin(), {
        transport: "https",
        fetch: async (input) => {
          calls.push(String(input));
          return new Response(null, { status: 302, headers: { location: "https://evil.example/archive.tar.gz" } });
        },
      }),
    ).rejects.toThrow(/could not be read/);
    expect(calls).toEqual([`https://github.com/example/demo/archive/${COMMIT}.tar.gz`]);
  });

  it("does not follow a codeload redirect that carries credentials or a query", async () => {
    const locations = [
      `https://user:secret@codeload.github.com/example/demo/tar.gz/${COMMIT}`,
      `https://codeload.github.com/example/demo/tar.gz/${COMMIT}?token=secret`,
      `https://codeload.github.com/other/demo/tar.gz/${COMMIT}`,
      `http://codeload.github.com/example/demo/tar.gz/${COMMIT}`,
    ];
    for (const location of locations) {
      const calls: string[] = [];
      await expect(
        loadPinnedHubStore(pin(), {
          transport: "https",
          fetch: async (input) => {
            calls.push(String(input));
            return new Response(null, { status: 302, headers: { location } });
          },
        }),
      ).rejects.toThrow(/could not be read/);
      expect(calls).toHaveLength(1);
      expect(calls[0]).not.toContain("secret");
    }
  });

  it("refuses an oversized archive and an archive that expands past the cap", async () => {
    const oversized = Buffer.alloc(HUB_ARCHIVE_MAX_BYTES + 1);
    await expect(
      loadPinnedHubStore(pin(), {
        transport: "https",
        fetch: async () => new Response(oversized, { status: 200 }),
      }),
    ).rejects.toThrow(/could not be read/);

    await expect(
      loadPinnedHubStore(pin(), {
        transport: "https",
        fetch: async () =>
          new Response(new Uint8Array(1), {
            status: 200,
            headers: { "content-length": String(HUB_ARCHIVE_MAX_BYTES + 1) },
          }),
      }),
    ).rejects.toThrow(/could not be read/);

    const bomb = gzipSync(Buffer.alloc(HUB_ARCHIVE_UNCOMPRESSED_MAX_BYTES + 1));
    expect(bomb.length).toBeLessThan(HUB_ARCHIVE_MAX_BYTES);
    const { fetch: fetchImpl } = fetchGzip(bomb, "direct");
    await expect(loadPinnedHubStore(pin(), { transport: "https", fetch: fetchImpl })).rejects.toThrow(/could not be read/);
  });

  it("refuses an archive whose commit comment or root directory is a different SHA", async () => {
    const wrongComment = gzipArchive(OTHER, [
      { name: `demo-${COMMIT}/hub-manifest.json`, body: Buffer.from(manifest) },
    ]);
    const { fetch: fetchComment } = fetchGzip(wrongComment, "direct");
    await expect(loadPinnedHubStore(pin(COMMIT, manifestHash), { transport: "https", fetch: fetchComment })).rejects.toThrow(
      /commit did not match/,
    );

    const wrongRoot = gzipSync(
      Buffer.concat([
        entry("pax_global_header", "g", paxRecord("comment", COMMIT)),
        entry(`demo-${OTHER}/hub-manifest.json`, "0", Buffer.from(manifest)),
        Buffer.alloc(1024),
      ]),
    );
    const { fetch: fetchRoot } = fetchGzip(wrongRoot, "direct");
    await expect(loadPinnedHubStore(pin(COMMIT, manifestHash), { transport: "https", fetch: fetchRoot })).rejects.toThrow(
      /commit did not match/,
    );
  });

  it("refuses path traversal in an archive entry or a pax path", async () => {
    const traversed = gzipArchive(COMMIT, [{ name: `demo-${COMMIT}/../../etc/passwd`, body: Buffer.from("nope") }]);
    const { fetch: fetchSlip } = fetchGzip(traversed, "direct");
    await expect(loadPinnedHubStore(pin(), { transport: "https", fetch: fetchSlip })).rejects.toThrow(/could not be read/);

    const absolute = gzipArchive(COMMIT, [{ name: "/etc/passwd", body: Buffer.from("nope") }]);
    const { fetch: fetchAbsolute } = fetchGzip(absolute, "direct");
    await expect(loadPinnedHubStore(pin(), { transport: "https", fetch: fetchAbsolute })).rejects.toThrow(/could not be read/);

    const pax = Buffer.from(paxRecord("path", "../outside.json"));
    const slipped = gzipSync(
      Buffer.concat([
        entry("pax_global_header", "g", paxRecord("comment", COMMIT)),
        entry(`demo-${COMMIT}/`, "5"),
        entry("long-name", "x", pax),
        entry("placeholder", "0", Buffer.from("nope")),
        Buffer.alloc(1024),
      ]),
    );
    const { fetch: fetchPax } = fetchGzip(slipped, "direct");
    await expect(loadPinnedHubStore(pin(), { transport: "https", fetch: fetchPax })).rejects.toThrow(/could not be read/);
  });

  it("refuses a symlink and a gitdir entry in the archive", async () => {
    const linked = gzipArchive(COMMIT, [
      { name: `demo-${COMMIT}/hub-manifest.json`, type: "2", linkname: "/tmp/outside.json" },
    ]);
    const { fetch: fetchLink } = fetchGzip(linked, "direct");
    await expect(loadPinnedHubStore(pin(), { transport: "https", fetch: fetchLink })).rejects.toThrow(/could not be read/);

    const gitdir = gzipArchive(COMMIT, [
      { name: `demo-${COMMIT}/.git`, body: Buffer.from("gitdir: /tmp/evil\n") },
    ]);
    const { fetch: fetchGitdir } = fetchGzip(gitdir, "direct");
    await expect(loadPinnedHubStore(pin(), { transport: "https", fetch: fetchGitdir })).rejects.toThrow(/could not be read/);

    const nested = gzipArchive(COMMIT, [
      { name: `demo-${COMMIT}/updates/.git`, body: Buffer.from("gitdir: /tmp/evil\n") },
    ]);
    const { fetch: fetchNested } = fetchGzip(nested, "direct");
    await expect(loadPinnedHubStore(pin(), { transport: "https", fetch: fetchNested })).rejects.toThrow(/could not be read/);
  });

  it("does not fetch when the pin has credentials, a query, or a host other than github.com", async () => {
    const cases = [
      "https://user:secret@github.com/example/demo",
      "https://github.com/example/demo?token=secret",
      "https://gitlab.com/example/demo",
      "https://github.com.evil.com/example/demo",
      "https://github.com./example/demo",
    ];
    for (const repo of cases) {
      let called = false;
      let message = "";
      try {
        await loadPinnedHubStore(
          { ...pin(), repo },
          {
            transport: "https",
            fetch: async () => {
              called = true;
              throw new Error("fetch should not run");
            },
          },
        );
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(called, repo).toBe(false);
      expect(message, repo).toMatch(/pin is not valid|could not be read/);
      expect(message, repo).not.toMatch(/secret/);
    }
  });

  it("still checks the manifest hash on the HTTPS path", async () => {
    const { fetch: fetchImpl } = fetchGzip(gzipArchive(COMMIT, files), "direct");
    await expect(
      loadPinnedHubStore(pin(COMMIT, "d".repeat(64)), { transport: "https", fetch: fetchImpl }),
    ).rejects.toThrow(/manifest hash did not match/);
  });
});

describe("HTTPS fetch dedupe", () => {
  it("shares one in-flight archive fetch and remembers a failure for a few seconds", async () => {
    expect(HUB_FETCH_FAILURE_TTL_MS).toBeGreaterThanOrEqual(5_000);
    expect(HUB_FETCH_FAILURE_TTL_MS).toBeLessThanOrEqual(10_000);
    const commit = "c".repeat(40);
    const manifest = JSON.stringify({ v: 1, updates: ["updates/one.json"] });
    const document = JSON.stringify({ id: "deduped" });
    const manifestHash = createHash("sha256").update(manifest).digest("hex");
    const body = gzipArchive(commit, [
      { name: `demo-${commit}/hub-manifest.json`, body: Buffer.from(manifest) },
      { name: `demo-${commit}/updates/one.json`, body: Buffer.from(document) },
    ]);
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      await gate;
      return new Response(body, {
        status: 200,
        headers: { "content-disposition": `attachment; filename=demo-${commit}.tar.gz` },
      });
    };
    const successPin = {
      repo: "https://github.com/example/dedupe",
      commit,
      manifestPath: "hub-manifest.json",
      manifestHash,
    };
    const first = loadPinnedHubStore(successPin, { transport: "https", fetch: fetchImpl });
    const second = loadPinnedHubStore(successPin, { transport: "https", fetch: fetchImpl });
    release();
    await expect(first).resolves.toMatchObject({ documents: [JSON.parse(document)] });
    await expect(second).resolves.toMatchObject({ documents: [JSON.parse(document)] });
    expect(calls).toBe(1);

    const failCommit = "d".repeat(40);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    let failures = 0;
    const failFetch: typeof fetch = async () => {
      failures += 1;
      throw new Error("down");
    };
    const failPin = {
      repo: "https://github.com/example/dedupe-fail",
      commit: failCommit,
      manifestPath: "hub-manifest.json",
      manifestHash: "e".repeat(64),
    };
    const failed = loadPinnedHubStore(failPin, { transport: "https", fetch: failFetch });
    const failedAgain = loadPinnedHubStore(failPin, { transport: "https", fetch: failFetch });
    await expect(failed).rejects.toThrow(/could not be read/);
    await expect(failedAgain).rejects.toThrow(/could not be read/);
    expect(failures).toBe(1);
    vi.setSystemTime(new Date(Date.now() + HUB_FETCH_FAILURE_TTL_MS - 1));
    await expect(loadPinnedHubStore(failPin, { transport: "https", fetch: failFetch })).rejects.toThrow(/could not be read/);
    expect(failures).toBe(1);
    vi.setSystemTime(new Date(Date.now() + 1));
    await expect(loadPinnedHubStore(failPin, { transport: "https", fetch: failFetch })).rejects.toThrow(/could not be read/);
    expect(failures).toBe(2);
  });
});

describe("archive limits and repo URL checks", () => {
  it("counts regular files toward a high cap and names that refusal", async () => {
    expect(HUB_ARCHIVE_MAX_FILES).toBe(4096);
    expect(HUB_ARCHIVE_MAX_HEADERS).toBe(8192);
    const commit = "e".repeat(40);
    const manifest = JSON.stringify({ v: 1, updates: [] });
    const manifestHash = createHash("sha256").update(manifest).digest("hex");
    const directories = Array.from({ length: 600 }, (_, index) => ({
      name: `demo-${commit}/dir-${index}/`,
      type: "5",
    }));
    const directoryArchive = gzipArchive(commit, [
      ...directories,
      { name: `demo-${commit}/hub-manifest.json`, body: Buffer.from(manifest) },
    ]);
    const loaded = await loadPinnedHubStore(
      {
        repo: "https://github.com/example/many-dirs",
        commit,
        manifestPath: "hub-manifest.json",
        manifestHash,
      },
      {
        transport: "https",
        fetch: async () =>
          new Response(directoryArchive, {
            status: 200,
            headers: { "content-disposition": `attachment; filename=demo-${commit}.tar.gz` },
          }),
      },
    );
    expect(loaded.documents).toEqual([]);

    const tooManyFiles = gzipSync(
      Buffer.concat([
        entry("pax_global_header", "g", paxRecord("comment", commit)),
        entry(`demo-${commit}/`, "5"),
        ...Array.from({ length: HUB_ARCHIVE_MAX_FILES + 1 }, (_, index) => entry(`demo-${commit}/f-${index}.json`, "0")),
        Buffer.alloc(1024),
      ]),
    );
    await expect(
      loadPinnedHubStore(
        {
          repo: "https://github.com/example/many-files",
          commit,
          manifestPath: "hub-manifest.json",
          manifestHash,
        },
        {
          transport: "https",
          fetch: async () =>
            new Response(tooManyFiles, {
              status: 200,
              headers: { "content-disposition": `attachment; filename=demo-${commit}.tar.gz` },
            }),
        },
      ),
    ).rejects.toThrow(/^The hub archive has too many entries\. No updates were returned\.$/);

    const tooManyHeaders = gzipSync(
      Buffer.concat([
        ...Array.from({ length: HUB_ARCHIVE_MAX_HEADERS + 1 }, (_, index) => entry(`dir-${index}/`, "5")),
        Buffer.alloc(1024),
      ]),
    );
    await expect(
      loadPinnedHubStore(
        {
          repo: "https://github.com/example/many-headers",
          commit,
          manifestPath: "hub-manifest.json",
          manifestHash,
        },
        {
          transport: "https",
          fetch: async () =>
            new Response(tooManyHeaders, {
              status: 200,
              headers: { "content-disposition": `attachment; filename=demo-${commit}.tar.gz` },
            }),
        },
      ),
    ).rejects.toThrow(/too many entries/);
  });

  it("strips a trailing .git and accepts a codeload redirect with different case", async () => {
    const parsed = parseGithubRepo("https://github.com/Example/Demo.git");
    expect(parsed).toEqual({ owner: "Example", name: "Demo" });
    const commit = COMMIT;
    const manifest = JSON.stringify({ v: 1, updates: ["updates/one.json"] });
    const document = JSON.stringify({ id: "cased" });
    const manifestHash = createHash("sha256").update(manifest).digest("hex");
    const body = gzipArchive(commit, [
      { name: `demo-${commit}/hub-manifest.json`, body: Buffer.from(manifest) },
      { name: `demo-${commit}/updates/one.json`, body: Buffer.from(document) },
    ]);
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith("https://github.com/")) {
        return new Response(null, {
          status: 302,
          headers: { location: `https://codeload.github.com/example/demo/tar.gz/${commit}` },
        });
      }
      return new Response(body, {
        status: 200,
        headers: { "content-disposition": `attachment; filename=Demo-${commit}.tar.gz` },
      });
    };
    const loaded = await loadPinnedHubStore(
      {
        repo: "https://github.com/Example/Demo.git",
        commit,
        manifestPath: "hub-manifest.json",
        manifestHash,
      },
      { transport: "https", fetch: fetchImpl },
    );
    expect(loaded.documents).toEqual([JSON.parse(document)]);
    expect(loaded.sourceUrl).toBe("https://github.com/Example/Demo.git");
    expect(urls).toEqual([
      `https://github.com/Example/Demo/archive/${commit}.tar.gz`,
      `https://codeload.github.com/Example/Demo/tar.gz/${commit}`,
    ]);
  });

  it("refuses a repository URL whose path has dot segments or does not match its normalised path", async () => {
    const bad = [
      "https://github.com/owner/../repo",
      "https://github.com/owner/./repo",
      "https://github.com/owner/%2e%2e/repo",
      "https://example.com/a/../b",
    ];
    for (const repo of bad) {
      expect(() => loadConfig({ HUB_GIT_REPO: repo }), repo).toThrow(/\. or \.\. path segments/);
      let called = false;
      await expect(
        loadPinnedHubStore(
          {
            repo,
            commit: "f".repeat(40),
            manifestPath: "hub-manifest.json",
            manifestHash: "1".repeat(64),
          },
          {
            transport: "https",
            fetch: async () => {
              called = true;
              throw new Error("fetch should not run");
            },
          },
        ),
      ).rejects.toThrow(/pin is not valid/);
      expect(called, repo).toBe(false);
    }
    expect(loadConfig({}).hubGitRepo).toBe("");
  });

  it("refuses a pax extended header that carries a size override", async () => {
    const manifest = JSON.stringify({ v: 1, updates: ["updates/one.json"] });
    const document = JSON.stringify({ id: "sized" });
    const manifestHash = createHash("sha256").update(manifest).digest("hex");
    const body = gzipSync(
      Buffer.concat([
        entry("pax_global_header", "g", paxRecord("comment", COMMIT)),
        entry(`demo-${COMMIT}/`, "5"),
        entry(
          "override",
          "x",
          Buffer.concat([paxRecord("path", `demo-${COMMIT}/hub-manifest.json`), paxRecord("size", "1")]),
        ),
        entry("placeholder", "0", Buffer.from(manifest)),
        entry(`demo-${COMMIT}/updates/one.json`, "0", Buffer.from(document)),
        Buffer.alloc(1024),
      ]),
    );
    const { fetch: fetchImpl } = fetchGzip(body, "direct");
    await expect(
      loadPinnedHubStore(pin(COMMIT, manifestHash), { transport: "https", fetch: fetchImpl }),
    ).rejects.toThrow(/could not be read/);
  });

  it("refuses a global pax header that carries size, path, or linkpath", async () => {
    const manifest = JSON.stringify({ v: 1, updates: ["updates/one.json"] });
    const manifestHash = createHash("sha256").update(manifest).digest("hex");
    for (const extra of [
      paxRecord("size", "1"),
      paxRecord("path", `demo-${COMMIT}/hub-manifest.json`),
      paxRecord("linkpath", "link"),
    ]) {
      const body = gzipSync(
        Buffer.concat([
          entry("pax_global_header", "g", Buffer.concat([paxRecord("comment", COMMIT), extra])),
          entry(`demo-${COMMIT}/`, "5"),
          entry(`demo-${COMMIT}/hub-manifest.json`, "0", Buffer.from(manifest)),
          entry(`demo-${COMMIT}/updates/one.json`, "0", Buffer.from("{}")),
          Buffer.alloc(1024),
        ]),
      );
      const { fetch: fetchImpl } = fetchGzip(body, "direct");
      await expect(
        loadPinnedHubStore(pin(COMMIT, manifestHash), { transport: "https", fetch: fetchImpl }),
      ).rejects.toThrow(/could not be read/);
    }
  });
});

describe("git checkout symlink walk", () => {
  it("refuses a directory symlink that points outside the checkout", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "hub-symlink-dir-"));
    const outside = path.join(scratch, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "one.json"), "{\"injected\":true}");
    const repo = path.join(scratch, "repo");
    mkdirSync(repo);
    const run = (args: string[]) => {
      const result = spawnSync(
        "git",
        ["-c", "user.email=hub-test@example.com", "-c", "user.name=hub-test", "-c", "commit.gpgsign=false", ...args],
        { cwd: repo, encoding: "utf8" },
      );
      if (result.status !== 0) throw new Error(result.stderr || result.stdout || "git failed");
      return (result.stdout ?? "").trim();
    };
    run(["init", "-b", "main"]);
    const manifest = `${JSON.stringify({ v: 1, updates: ["updates/one.json"] })}\n`;
    writeFileSync(path.join(repo, "hub-manifest.json"), manifest);
    symlinkSync(outside, path.join(repo, "updates"));
    run(["add", "hub-manifest.json", "updates"]);
    run(["commit", "-m", "link"]);
    const commit = run(["rev-parse", "HEAD"]);
    const manifestHash = createHash("sha256").update(manifest).digest("hex");
    await expect(
      loadPinnedHubStore({
        repo,
        commit,
        manifestPath: "hub-manifest.json",
        manifestHash,
      }),
    ).rejects.toThrow(/manifest is not valid/);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
  });
});
