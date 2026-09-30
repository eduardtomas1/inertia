import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChangesPanel, type ChangesPanelProps } from "../../src/renderer/src/components/ChangesPanel";
import type { ChangedFile } from "../../src/shared/contracts";
import { diffHunkFingerprint, parseUnifiedDiff } from "../../src/shared/diff-review";

function changedFile(path: string): ChangedFile {
  return {
    path,
    status: "modified",
    insertions: 1,
    deletions: 1,
    untracked: false,
    staged: false,
    unstaged: true,
    indexStatus: ".",
    worktreeStatus: "M",
  };
}

function patchFor(path: string, after = "after"): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    "-before",
    `+${after}`,
    "",
  ].join("\n");
}

function panelProps(patch: string, onCreateNote: ChangesPanelProps["onCreateNote"]): ChangesPanelProps {
  return {
    files: [changedFile("README.md")],
    diff: { patch, truncated: false, files: [changedFile("README.md")] },
    selectedPath: "README.md",
    summary: null,
    onSelectFile: vi.fn(),
    onAsk: vi.fn(async () => undefined),
    onRequestRevision: vi.fn(async () => undefined),
    onRevert: vi.fn(async () => undefined),
    onSetReviewState: vi.fn(async () => undefined),
    onCreateNote,
    onUpdateNote: vi.fn(async () => undefined),
    onDeleteNote: vi.fn(async () => undefined),
    onAddTextToPrompt: vi.fn(),
    onAddToPrompt: vi.fn(),
  };
}

async function openNote(index: number, name: string): Promise<HTMLElement> {
  fireEvent.click(screen.getAllByRole("button", { name: "Note" })[index]!);
  const dialog = await screen.findByRole("dialog", { name });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Review note" }), {
    target: { value: "Explain this change" },
  });
  return dialog;
}

describe("review notes opened before the diff changed", () => {
  it.each([
    ["file", 0, "Add note for README.md"],
    ["hunk", 1, "Add note for this hunk"],
  ] as const)("does not save a %s note against a target that changed while the dialog was open", async (_scope, index, name) => {
    const onCreateNote = vi.fn(async () => undefined);
    const view = render(<ChangesPanel {...panelProps(patchFor("README.md"), onCreateNote)} />);
    const dialog = await openNote(index, name);

    view.rerender(<ChangesPanel {...panelProps(patchFor("README.md", "after edited"), onCreateNote)} />);
    await screen.findByRole("button", { name: "+ after edited" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save note" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The note could not be saved.");
    expect(within(dialog).getByRole("textbox", { name: "Review note" })).toHaveValue("Explain this change");
    expect(onCreateNote).not.toHaveBeenCalled();
  });

  it("saves a hunk note whose target is unchanged when another file changed", async () => {
    const onCreateNote = vi.fn(async () => undefined);
    const view = render(<ChangesPanel {...panelProps(patchFor("README.md"), onCreateNote)} />);
    const dialog = await openNote(1, "Add note for this hunk");

    const withOther = `${patchFor("README.md")}${patchFor("docs/guide.md")}`;
    view.rerender(<ChangesPanel
      {...panelProps(withOther, onCreateNote)}
      files={[changedFile("README.md"), changedFile("docs/guide.md")]}
    />);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save note" }));

    const file = parseUnifiedDiff(patchFor("README.md")).files[0]!;
    await waitFor(() => expect(onCreateNote).toHaveBeenCalledWith({
      repositoryPath: ".",
      path: "README.md",
      hunkId: file.hunks[0]!.id,
      lineIds: [],
      targetFingerprint: diffHunkFingerprint(file, file.hunks[0]!),
      body: "Explain this change",
    }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
