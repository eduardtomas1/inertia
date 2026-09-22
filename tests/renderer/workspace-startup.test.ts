import { describe, expect, it } from "vitest";

import {
  finishLegacyWorkspaceStartupMigration,
  forgetWorkspaceBoundLastTool,
  readLegacyWorkspaceStartup,
} from "../../src/renderer/src/utils/workspaceStartup";

describe("legacy workspace startup migration", () => {
  it("preserves an open tool once without keeping the obsolete visibility key", () => {
    const values = new Map<string, string>([
      ["inertia:layout:active-tool:v1", "files"],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };

    const preference = readLegacyWorkspaceStartup(storage);
    expect(preference).toEqual({ surface: "tools", tool: "files" });
    finishLegacyWorkspaceStartupMigration(storage, preference!);

    expect(readLegacyWorkspaceStartup(storage)).toBeNull();
    expect(values.get("inertia:layout:last-workspace-tool:v2")).toBe("files");
    expect(values.has("inertia:layout:active-tool:v1")).toBe(false);
  });

  it("preserves an explicitly collapsed layout as the summary preference", () => {
    const storage = {
      getItem: (key: string) =>
        key === "inertia:layout:active-tool:v1" ? "collapsed" : null,
    };
    expect(readLegacyWorkspaceStartup(storage)).toEqual({
      surface: "summary",
      tool: null,
    });
  });

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
