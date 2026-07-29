import { describe, expect, it } from "vitest";

import {
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
});
