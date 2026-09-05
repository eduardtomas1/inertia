// @inertia-test-suite portable
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  discoverPortableTests,
  parsePortableMarkers,
} from "../../scripts/ci/portable-test-manifest.mjs";

describe("portable test manifest", () => {
  it("requires an exact first-line suite marker", () => {
    expect(parsePortableMarkers(
      "// @inertia-test-suite portable\n// @inertia-harness kimi-acp\n",
      "test.ts",
    )).toEqual({ harnessId: "kimi-acp" });
    expect(parsePortableMarkers(
      "// comment\n// @inertia-test-suite portable\n",
      "test.ts",
    )).toBeNull();
    expect(() => parsePortableMarkers(
      "// @inertia-test-suite portable\n// @inertia-harness ../unsafe\n",
      "test.ts",
    )).toThrow("invalid portable harness marker");
  });

  it("discovers a sorted manifest and harness ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-portable-manifest-"));
    await mkdir(join(root, "tests/server"), { recursive: true });
    await writeFile(
      join(root, "tests/server/z.test.ts"),
      "// @inertia-test-suite portable\n// @inertia-harness cursor-acp\n",
    );
    await writeFile(
      join(root, "tests/server/a.test.ts"),
      "// @inertia-test-suite portable\n",
    );
    await writeFile(join(root, "tests/server/ignored.test.ts"), "// ordinary\n");

    await expect(discoverPortableTests(root)).resolves.toEqual({
      files: ["tests/server/a.test.ts", "tests/server/z.test.ts"],
      harnessTests: { "cursor-acp": "tests/server/z.test.ts" },
    });
  });

  it("rejects duplicate harness registrations", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-portable-duplicate-"));
    await mkdir(join(root, "tests"), { recursive: true });
    const source = "// @inertia-test-suite portable\n// @inertia-harness opencode-sdk\n";
    await writeFile(join(root, "tests/a.test.ts"), source);
    await writeFile(join(root, "tests/b.test.ts"), source);
    await expect(discoverPortableTests(root)).rejects.toThrow("registered more than once");
  });
});
