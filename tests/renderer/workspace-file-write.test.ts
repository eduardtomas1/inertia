import { describe, expect, it } from "vitest";

import {
  MAX_WORKSPACE_FILE_EDIT_BYTES,
} from "../../src/shared/contracts";
import {
  workspaceFileWriteFitsRuntimeFrame,
  type WorkspaceFileWriteIdentity,
} from "../../src/renderer/src/utils/workspaceFileWrite";

const identity: WorkspaceFileWriteIdentity = {
  projectId: "22222222-2222-4222-8222-222222222222",
  conversationId: "33333333-3333-4333-8333-333333333333",
  path: "src/example.ts",
  authorityRef: "44444444-4444-4444-8444-444444444444",
  expectedDigest: "a".repeat(64),
};

describe("workspace file write preflight", () => {
  it("keeps the ordinary full raw editing capacity available", () => {
    expect(workspaceFileWriteFitsRuntimeFrame(
      identity,
      "x".repeat(MAX_WORKSPACE_FILE_EDIT_BYTES),
    )).toBe(true);
  });

  it.each([
    ["newlines", "\n"],
    ["quotes", "\""],
  ])("rejects raw-bounded %s when JSON escaping exceeds the frame", (
    _label,
    character,
  ) => {
    expect(workspaceFileWriteFitsRuntimeFrame(
      identity,
      character.repeat(140_000),
    )).toBe(false);
  });
});
