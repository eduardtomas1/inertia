import { describe, expect, it } from "vitest";

import { unreviewedCommitHunks } from "../../src/renderer/src/lib/commitReview";
import type { DiffReviewState } from "../../src/shared/contracts";
import {
  diffHunkFingerprint,
  parseUnifiedDiff,
} from "../../src/shared/diff-review";

describe("commit review warnings", () => {
  it("does not let an identical nested-repository review mark satisfy a root commit", () => {
    const diff = parseUnifiedDiff([
      "diff --git a/src/Main.ts b/src/Main.ts",
      "--- a/src/Main.ts",
      "+++ b/src/Main.ts",
      "@@ -1 +1 @@",
      "-export const enabled = false;",
      "+export const enabled = true;",
      "",
    ].join("\n"));
    const file = diff.files[0]!;
    const hunk = file.hunks[0]!;
    const nestedState: DiffReviewState = {
      conversationId: "conversation",
      repositoryPath: "modules/example",
      scope: "hunk",
      path: file.path,
      hunkId: hunk.id,
      targetFingerprint: diffHunkFingerprint(file, hunk),
      reviewed: true,
      stale: false,
      updatedAt: new Date(0).toISOString(),
    };

    expect(unreviewedCommitHunks(
      diff,
      [file.path],
      [nestedState],
      ".",
    )).toEqual([hunk]);
    expect(unreviewedCommitHunks(
      diff,
      [file.path],
      [{ ...nestedState, repositoryPath: "." }],
      ".",
    )).toEqual([]);
    expect(unreviewedCommitHunks(
      diff,
      [file.path],
      [nestedState],
      "modules/example",
    )).toEqual([]);
  });
});
