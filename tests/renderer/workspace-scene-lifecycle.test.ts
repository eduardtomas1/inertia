import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("workspace scene lifecycle", () => {
  it("keeps an activated terminal docked and alive while it is hidden", async () => {
    const source = await readFile(
      new URL(
        "../../src/renderer/src/components/WorkspaceScene.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).toContain("if (tools && open) activatedKeyRef.current = tools.terminalKey;");
    expect(source).toContain("hidden={!open}");
    expect(source).not.toContain('tools.activeTool === "terminal"');
  });

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

  it("normalizes split-owned busy actions before building each split pane scene", async () => {
    const source = await readFile(
      new URL(
        "../../src/renderer/src/hooks/useSplitWorkspaceScene.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).toContain("const busyPrefix = `split:${owner}:`;");
    expect(source).toContain("busyAction?.startsWith(busyPrefix)");
    expect(source).toContain("busyAction.slice(busyPrefix.length)");
  });
});
