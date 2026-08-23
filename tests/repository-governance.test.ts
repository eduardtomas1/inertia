import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("repository governance", () => {
  it("assigns precise ownership to every security-critical audit boundary", async () => {
    const source = await readFile(resolve(root, ".github/CODEOWNERS"), "utf8");
    const rules = source
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    expect(rules).toEqual(expect.arrayContaining([
      "/src/server/persistence/ @eduardtomas1",
      "/src/main/credential-vault.ts @eduardtomas1",
      "/src/main/runtime-supervisor.ts @eduardtomas1",
      "/src/node/runtime-process-protocol.ts @eduardtomas1",
      "/src/main/private-connect/ @eduardtomas1",
      "/src/server/private-connect/ @eduardtomas1",
      "/src/shared/private-connect/ @eduardtomas1",
      "/src/main/preview-agent-*.ts @eduardtomas1",
      "/src/main/preview-broker.ts @eduardtomas1",
      "/src/server/runtime/agent-browser-*.ts @eduardtomas1",
      "/.github/workflows/release-platforms.yml @eduardtomas1",
      "/scripts/release-assets.mjs @eduardtomas1",
      "/scripts/release-signing-policy.cjs @eduardtomas1",
    ]));
    expect(rules).not.toContain("* @eduardtomas1");
    expect(rules).not.toContain("/src/ @eduardtomas1");
  });
});
