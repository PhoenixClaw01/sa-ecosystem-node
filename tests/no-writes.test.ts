import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function typescriptFiles(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

const banned: RegExp[] = [
  /\bsecretKey\b/,
  /\bprivateKey\b/,
  /\bkeypair\b/i,
  /\bsendTransaction\b/,
  /\bsignTransaction\b/,
  /\bsignMessage\b/,
  /nacl\.sign\.keyPair/,
  /nacl\.sign\.detached(?!\.verify)\s*\(/,
  /nacl\.sign\s*\(/,
  /atlas-kit\/[^"'`]*actions/,
  /\bwriteRpc\b/,
];

function isLocalKeyTool(file: string): boolean {
  const name = file.split(path.sep).join("/");
  return (
    name === "src/hub/sign-cli.ts" ||
    name === "src/hub/keygen-cli.ts" ||
    name === "src/hub/add-update-cli.ts" ||
    name === "src/hub/claim-cli.ts" ||
    name === "src/hub/attest-cli.ts"
  );
}

describe("read-only source", () => {
  it("does not sign, hold keys, or call write APIs", () => {
    const files = [...typescriptFiles("src"), ...typescriptFiles("api"), ...typescriptFiles("dashboard/api")].filter(
      (file) => !isLocalKeyTool(file),
    );
    expect(files.length).toBeGreaterThan(0);
    const hits = files.flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return banned.filter((pattern) => pattern.test(text)).map((pattern) => `${file}: ${pattern}`);
    });
    expect(hits).toEqual([]);
  });

  it("keeps signing inside the local hub scripts", () => {
    const local = new Set([
      "src/hub/sign-cli.ts",
      "src/hub/keygen-cli.ts",
      "src/hub/add-update-cli.ts",
      "src/hub/claim-cli.ts",
      "src/hub/attest-cli.ts",
    ]);
    const files = typescriptFiles("src").filter((file) => !local.has(file.split(path.sep).join("/")));
    const importing = files.filter((file) => {
      const text = readFileSync(file, "utf8");
      return text.includes("sign-cli") || text.includes("keygen-cli");
    });
    expect(importing).toEqual([]);
    const cli = readFileSync("src/hub/sign-cli.ts", "utf8");
    expect(cli).toMatch(/nacl\.sign\.detached\(/);
    expect(cli).not.toMatch(/\bsignTransaction\b/);
    expect(cli).not.toMatch(/\bsendTransaction\b/);
    const keygen = readFileSync("src/hub/keygen-cli.ts", "utf8");
    expect(keygen).toMatch(/nacl\.sign\.keyPair\.fromSeed\(/);
    expect(keygen).not.toMatch(/nacl\.sign\.detached\(/);
    const addUpdate = readFileSync("src/hub/add-update-cli.ts", "utf8");
    expect(addUpdate).toMatch(/from "\.\/sign-cli\.js"/);
    expect(addUpdate).not.toMatch(/nacl\.sign\.detached\(/);
    expect(addUpdate).not.toMatch(/\bsignTransaction\b/);
    expect(addUpdate).not.toMatch(/\bsendTransaction\b/);
  });
});
