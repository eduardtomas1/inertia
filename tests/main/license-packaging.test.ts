import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("packaged license notices", () => {
  it("generates production notices before packaging and includes all required license resources", async () => {
    const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      build: {
        extraResources: Array<{ from: string; to: string }>;
        mac: { extraResources: Array<{ from: string; to: string }> };
      };
    };

    expect(packageJson.scripts.prebuild).toContain("notices:generate");
    expect(packageJson.scripts["notices:generate"]).toBe(
      "node scripts/generate-third-party-notices.mjs",
    );
    const shared = [
      {
        from: "resources/generated/THIRD_PARTY_NOTICES.txt",
        to: "THIRD_PARTY_NOTICES.txt",
      },
      { from: "LICENSE", to: "LICENSE.txt" },
      {
        from: "node_modules/electron/dist/LICENSE",
        to: "electron/LICENSE.txt",
      },
    ];
    expect(packageJson.build.extraResources).toEqual(expect.arrayContaining(shared));
    // Electron ships its Chromium credits beside the executable on Windows and
    // Linux. Only the macOS bundle, which does not carry that file, packages a
    // copy, and macOS keeps every shared resource because a platform list
    // replaces the shared one.
    const chromiumCredits = {
      from: "node_modules/electron/dist/LICENSES.chromium.html",
      to: "electron/LICENSES.chromium.html",
    };
    expect(packageJson.build.extraResources).not.toContainEqual(chromiumCredits);
    expect(packageJson.build.mac.extraResources)
      .toEqual([...packageJson.build.extraResources, chromiumCredits]);
  });

  it("includes the statically linked musl runtime notice", async () => {
    const generator = await readFile(
      resolve(root, "scripts/generate-third-party-notices.mjs"),
      "utf8",
    );
    const notice = await readFile(
      resolve(root, "resources/runtime-process-guardian-notices.txt"),
      "utf8",
    );

    expect(generator).toContain('"runtime-process-guardian-notices.txt"');
    expect(generator).toContain("VENDORED COMPONENT LICENSE AND NOTICE TEXTS");
    expect(notice).toContain("musl libc");
    expect(notice).toContain("Copyright © 2005-2020 Rich Felker, et al.");
    expect(notice).toContain("Permission is hereby granted, free of charge");
  });
});
