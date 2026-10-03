import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("workspace scene lifecycle", () => {
  it("renders split panes before applying a primary-only detail boundary", async () => {
    const source = await readFile(
      new URL(
        "../../src/renderer/src/components/WorkspaceScene.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    const splitBoundary = source.indexOf(") : splitScene ? (");
    const primaryDetailBoundary = source.indexOf(") : detailState ? (");
    expect(splitBoundary).toBeGreaterThan(0);
    expect(primaryDetailBoundary).toBeGreaterThan(splitBoundary);
  });
});
