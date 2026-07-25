import { describe, expect, it } from "vitest";

import {
  buildComposerTurnRequest,
  turnRequestContextFromPromptContext,
} from "../../src/renderer/src/utils/requestContext";

const diffContext = [
  "Local review context.",
  "",
  "Target file: src/example.ts",
  "Target hunk: @@ -1 +1 @@",
  "Selected lines: 1",
  "```diff",
  "+const next = true;",
  "```",
].join("\n");

describe("composer structured request context", () => {
  it("sends only visible authored text while carrying selected diff content separately", () => {
    const request = buildComposerTurnRequest(
      "Why is this needed?",
      [],
      diffContext,
    );

    expect(request.visibleContent).toBe("Why is this needed?");
    expect(request.visibleContent).not.toContain("Target file:");
    expect(request.context?.diffSelections).toEqual([{
      path: "src/example.ts",
      hunkHeader: "@@ -1 +1 @@",
      content: diffContext,
      selectedLineCount: 1,
      truncated: false,
    }]);
  });

  it("models local review notes and selected file mentions as typed references", () => {
    expect(turnRequestContextFromPromptContext([
      "Local review note for src/example.ts (hunk-1) [stale target]:",
      "Preserve the fallback.",
    ].join("\n"))).toEqual({
      reviewNotes: [{
        path: "src/example.ts",
        hunkId: "hunk-1",
        body: "Preserve the fallback.",
        stale: true,
      }],
    });

    expect(buildComposerTurnRequest(
      "Check @src/example.ts before answering.",
      [],
      null,
      ["src/example.ts"],
    )).toEqual({
      visibleContent: "Check @src/example.ts before answering.",
      context: { fileReferences: [{ path: "src/example.ts" }] },
    });
  });
});
