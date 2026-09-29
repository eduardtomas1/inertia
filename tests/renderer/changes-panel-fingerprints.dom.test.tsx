import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ChangedFile } from "../../src/shared/contracts";

const fingerprints = vi.hoisted(() => ({ hunk: 0, file: 0 }));

vi.mock("../../src/shared/diff-review", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/shared/diff-review")>();
  return {
    ...actual,
    diffHunkFingerprint: (...args: Parameters<typeof actual.diffHunkFingerprint>) => {
      fingerprints.hunk += 1;
      return actual.diffHunkFingerprint(...args);
    },
    diffFileFingerprint: (...args: Parameters<typeof actual.diffFileFingerprint>) => {
      fingerprints.file += 1;
      return actual.diffFileFingerprint(...args);
    },
  };
});

const { ChangesPanel } = await import("../../src/renderer/src/components/ChangesPanel");

const file: ChangedFile = {
  path: "src/app.ts",
  status: "modified",
  insertions: 6,
  deletions: 6,
  untracked: false,
  staged: false,
  unstaged: true,
  indexStatus: ".",
  worktreeStatus: "M",
};

function patchWithHunks(count: number): string {
  const hunks = Array.from({ length: count }, (_, index) => [
    `@@ -${index * 10 + 1} +${index * 10 + 1} @@`,
    `-before ${index}`,
    `+after ${index}`,
  ].join("\n"));
  return [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    ...hunks,
    "",
  ].join("\n");
}

describe("ChangesPanel review fingerprints", () => {
  it("hashes each parsed diff once instead of on every comment keystroke", () => {
    render(
      <ChangesPanel
        files={[file]}
        diff={{ patch: patchWithHunks(6), truncated: false, files: [file] }}
        selectedPath="src/app.ts"
        summary={null}
        reviewStates={[{
          repositoryPath: ".",
          conversationId: "11111111-1111-4111-8111-111111111111",
          scope: "hunk",
          path: "src/app.ts",
          hunkId: "unrelated",
          targetFingerprint: "b".repeat(64),
          reviewed: true,
          stale: false,
          updatedAt: "2026-09-27T12:00:00.000Z",
        }]}
        onSelectFile={vi.fn()}
        onAsk={vi.fn(async () => undefined)}
        onRequestRevision={vi.fn(async () => undefined)}
        onRevert={vi.fn(async () => undefined)}
        onSetReviewState={vi.fn(async () => undefined)}
        onCreateNote={vi.fn(async () => undefined)}
        onUpdateNote={vi.fn(async () => undefined)}
        onDeleteNote={vi.fn(async () => undefined)}
        onAddTextToPrompt={vi.fn()}
        onAddToPrompt={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "+ after 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask about" }));
    const textarea = screen.getByPlaceholderText("What would you like to know?");
    const before = { ...fingerprints };

    for (const value of ["W", "Wh", "Why", "Why?"]) {
      fireEvent.change(textarea, { target: { value } });
    }

    expect(textarea).toHaveValue("Why?");
    expect(fingerprints).toEqual(before);
    expect(screen.getByText("0/6")).toBeInTheDocument();
  });
});
