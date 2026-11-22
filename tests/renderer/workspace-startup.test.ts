import { describe, expect, it } from "vitest";

import { forgetWorkspaceBoundLastTool } from "../../src/renderer/src/utils/workspaceStartup";

describe("workspace startup surface", () => {
  it("forgets a workspace-bound last surface so a materialized draft does not start it", () => {
    for (const [stored, kept] of [
      ["terminal", false],
      ["changes", false],
      ["files", false],
      ["preview", false],
      ["agents", true],
      ["usage", true],
    ] as const) {
      const values = new Map<string, string>([
        ["inertia:layout:last-workspace-tool:v2", stored],
      ]);
      forgetWorkspaceBoundLastTool({
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
      });
      expect(values.has("inertia:layout:last-workspace-tool:v2")).toBe(kept);
    }
  });
});
