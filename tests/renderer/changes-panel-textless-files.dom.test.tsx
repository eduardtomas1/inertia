import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { ChangesPanel } from "../../src/renderer/src/components/ChangesPanel";
import type { ChangedFile } from "../../src/shared/contracts";

const file: ChangedFile = {
  path: "README.md", status: "modified", insertions: 0, deletions: 0, untracked: false,
  staged: false, unstaged: true, indexStatus: ".", worktreeStatus: "M",
};

it.each([
  ["my img.bin", "diff --git a/my img.bin b/my img.bin\nindex 20b5be9..88f3700 100644\nBinary files a/my img.bin and b/my img.bin differ\n", "Binary file. No text diff to show."],
  ["new name.txt", "diff --git a/old name.txt b/new name.txt\nsimilarity index 100%\nrename from old name.txt\nrename to new name.txt\n", "Renamed from old name.txt. No text changes."],
  ["mode file.sh", "diff --git a/mode file.sh b/mode file.sh\nold mode 100644\nnew mode 100755\n", "No text changes to show."],
])("explains a change to %s that has no text lines instead of calling its diff unavailable", async (path, textless, message) => {
  const changed: ChangedFile = { ...file, path };
  render(<ChangesPanel files={[changed]} diff={{ patch: textless, truncated: false, files: [changed] }} selectedPath={path} summary={null}
    reviewStates={[]} onSelectFile={vi.fn()} onAsk={vi.fn(async () => undefined)} onRequestRevision={vi.fn(async () => undefined)}
    onRevert={vi.fn(async () => undefined)} onSetReviewState={vi.fn(async () => undefined)} onCreateNote={vi.fn(async () => undefined)}
    onUpdateNote={vi.fn(async () => undefined)} onDeleteNote={vi.fn(async () => undefined)} onAddTextToPrompt={vi.fn()} onAddToPrompt={vi.fn()} />);
  expect(await screen.findByText(message)).toBeInTheDocument();
  expect(screen.getByRole("region", { name: `Diff content for ${path}` })).toBeInTheDocument();
  expect(screen.queryByText("Diff unavailable")).not.toBeInTheDocument();
});
