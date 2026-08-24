import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { Composer } from "../../src/renderer/src/components/Composer";

const workspaceSource = readFileSync(
  new URL("../../src/renderer/src/components/ChatWorkspace.tsx", import.meta.url),
  "utf8",
);

describe("Composer streaming boundary", () => {
  it("memoizes the composer without coupling it to transcript deltas", () => {
    expect(Composer).toHaveProperty("$$typeof", Symbol.for("react.memo"));

    const composerStart = workspaceSource.search(/<Composer\s/u);
    const composerEnd = workspaceSource.indexOf("/>", composerStart);
    const composerProps = workspaceSource.slice(composerStart, composerEnd);

    expect(composerStart).toBeGreaterThanOrEqual(0);
    expect(composerEnd).toBeGreaterThan(composerStart);
    expect(composerProps).not.toContain("streamingText");
    expect(composerProps).not.toContain("streamingReasoning");
  });
});
