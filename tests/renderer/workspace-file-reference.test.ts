import { describe, expect, it } from "vitest";

import {
  validatedWorkspaceFileLocation,
  workspaceFileLocationFromFragment,
  workspaceFileLocationLabel,
  workspaceFileReference,
  workspaceFileReferenceFallback,
} from "../../src/renderer/src/utils/workspaceFileReference";

describe("workspace file references", () => {
  it("recognizes bounded Codex line and column suffixes", () => {
    expect(workspaceFileReferenceFallback("src/app.ts:42"))
      .toBe("src/app.ts");
    expect(workspaceFileReferenceFallback("src/app.ts:42:7"))
      .toBe("src/app.ts");
    expect(workspaceFileReferenceFallback("src/app.ts:0")).toBeNull();
    expect(workspaceFileReferenceFallback("src/app.ts:42:0")).toBeNull();
  });

  it("does not confuse a Windows drive prefix with a source location", () => {
    expect(workspaceFileReferenceFallback("C:\\repo\\src\\app.ts"))
      .toBeNull();
    expect(workspaceFileReferenceFallback("C:\\repo\\src\\app.ts:42:7"))
      .toBe("C:\\repo\\src\\app.ts");
  });

  it("parses source ranges from Codex suffixes and Markdown fragments", () => {
    expect(workspaceFileReference("src/App.java:12:4-15:8")).toEqual({
      path: "src/App.java",
      location: {
        startLine: 12,
        startColumn: 4,
        endLine: 15,
        endColumn: 8,
      },
    });
    expect(workspaceFileLocationFromFragment("#L12-L15")).toEqual({
      startLine: 12,
      endLine: 15,
    });
    expect(workspaceFileLocationFromFragment("#L12C4-L15C8")).toEqual({
      startLine: 12,
      startColumn: 4,
      endLine: 15,
      endColumn: 8,
    });
    expect(workspaceFileLocationFromFragment("#L15-L12")).toBeNull();
    expect(workspaceFileLocationFromFragment("#L0")).toBeNull();
  });

  it("validates locations against the exact loaded content", () => {
    const valid = { startLine: 2, endLine: 3 };
    expect(validatedWorkspaceFileLocation(valid, "one\ntwo\nthree"))
      .toEqual(valid);
    expect(validatedWorkspaceFileLocation(
      { startLine: 3, endLine: 4 },
      "one\ntwo\nthree",
    )).toBeNull();
    expect(validatedWorkspaceFileLocation(
      { startLine: 2, startColumn: 4, endLine: 2 },
      "one\ntwo\nthree",
    )).toEqual({ startLine: 2, startColumn: 4, endLine: 2 });
    expect(validatedWorkspaceFileLocation(
      { startLine: 2, startColumn: 5, endLine: 2 },
      "one\ntwo\nthree",
    )).toBeNull();
    expect(workspaceFileLocationLabel({ startLine: 2, endLine: 3 }))
      .toBe("Lines 2–3");
  });
});
