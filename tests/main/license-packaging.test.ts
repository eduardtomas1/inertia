import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("packaged license notices", () => {
  it("generates production notices before packaging and includes all required license resources", async () => {
    const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      build: { extraResources: Array<{ from: string; to: string }> };
    };

    expect(packageJson.scripts.prebuild).toContain("notices:generate");
    expect(packageJson.scripts["notices:generate"]).toBe(
      "node scripts/generate-third-party-notices.mjs",
    );
    expect(packageJson.build.extraResources).toEqual(expect.arrayContaining([
      {
        from: "resources/generated/THIRD_PARTY_NOTICES.txt",
        to: "THIRD_PARTY_NOTICES.txt",
      },
      { from: "LICENSE", to: "LICENSE.txt" },
      {
        from: "node_modules/electron/dist/LICENSE",
        to: "electron/LICENSE.txt",
      },
      {
        from: "node_modules/electron/dist/LICENSES.chromium.html",
        to: "electron/LICENSES.chromium.html",
      },
    ]));
  });
});
