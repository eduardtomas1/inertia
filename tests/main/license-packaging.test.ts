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

  it("includes the vendored thinking-orbs engine notice", async () => {
    const generator = await readFile(
      resolve(root, "scripts/generate-third-party-notices.mjs"),
      "utf8",
    );
    const notice = await readFile(
      resolve(root, "resources/thinking-orbs-notices.txt"),
      "utf8",
    );
    const vendoredLicense = await readFile(
      resolve(root, "src/renderer/src/vendor/thinking-orbs/LICENSE"),
      "utf8",
    );

    expect(generator).toContain('"thinking-orbs-notices.txt"');
    expect(notice).toContain("Copyright (c) 2026 Jakub Antalik");
    expect(notice).toContain("de85557ca220332586d070d8788c0e1d6e877a0d");
    expect(notice).toContain("Copyright (c) 2026 Haplo LLC");
    expect(notice).toContain("e2c07bbdec4db797fb302300ef0159b1806a909f");
    expect(notice).toContain("Permission is hereby granted, free of charge");
    expect(vendoredLicense).toContain("Copyright (c) 2026 Jakub Antalik");
  });
});
