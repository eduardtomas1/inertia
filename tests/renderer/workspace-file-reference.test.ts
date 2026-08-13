import { describe, expect, it } from "vitest";

import {
  parseWorkspaceFileReference,
  validatedWorkspaceSourceLocation,
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

  it("parses conventional line, column, and GitHub-style range references", () => {
    expect(parseWorkspaceFileReference("src/Main.java#L12-L15")).toEqual({
      path: "src/Main.java",
      location: { startLine: 12, endLine: 15 },
      suffix: "#L12-L15",
    });
    expect(parseWorkspaceFileReference("src/Main.java#L12C4-L12C9"))
      .toEqual({
        path: "src/Main.java",
        location: {
          startLine: 12,
          endLine: 12,
          startColumn: 4,
          endColumn: 9,
        },
        suffix: "#L12C4-L12C9",
      });
    expect(parseWorkspaceFileReference("src/Main.java:12:4")).toEqual({
      path: "src/Main.java",
      location: { startLine: 12, endLine: 12, startColumn: 4 },
      suffix: ":12:4",
    });
    expect(parseWorkspaceFileReference("src/Main.java#L15-L12")).toEqual({
      path: "src/Main.java#L15-L12",
      location: null,
      suffix: "",
    });
  });

  it("accepts only source locations present in the returned file", () => {
    const content = "one\ntwo\nthree";
    expect(validatedWorkspaceSourceLocation(
      { startLine: 2, endLine: 3, startColumn: 1 },
      content,
    )).toEqual({ startLine: 2, endLine: 3, startColumn: 1 });
    expect(validatedWorkspaceSourceLocation(
      { startLine: 4, endLine: 4 },
      content,
    )).toBeNull();
    expect(validatedWorkspaceSourceLocation(
      { startLine: 2, endLine: 2, startColumn: 5 },
      content,
    )).toBeNull();
  });
});
