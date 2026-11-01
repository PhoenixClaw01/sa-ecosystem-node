import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const hostTemplates = ["Dockerfile", "docker-compose.yml", "fly.toml", "render.yaml"] as const;

describe("public deploy templates", () => {
  it("leaves ALLOW_ANY_HOST unset so startup stays fail-closed", () => {
    for (const file of hostTemplates) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toContain("ALLOW_ANY_HOST");
      expect(text, file).toMatch(/# ALLOWED_HOSTS=\S+/);
    }
  });

  it("does not trust X-Forwarded-For on Fly or Render", () => {
    for (const file of ["fly.toml", "render.yaml"]) {
      expect(readFileSync(file, "utf8"), file).not.toContain("TRUST_PROXY");
    }
  });

  it("keeps TRUST_PROXY where the proxy overwrites X-Forwarded-For", () => {
    for (const file of ["vercel.json", "dashboard/vercel.json"]) {
      expect(readFileSync(file, "utf8"), file).toContain('"TRUST_PROXY": "1"');
    }
  });
});
