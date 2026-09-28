import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";

import { ChangesPanel } from "../../src/renderer/src/components/ChangesPanel";
import type { ChangedFile, DiffReviewState } from "../../src/shared/contracts";

const file: ChangedFile = {
  path: "README.md",
  status: "modified",
  insertions: 2,
  deletions: 2,
  untracked: false,
  staged: false,
  unstaged: true,
  indexStatus: ".",
  worktreeStatus: "M",
};

const patch = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1 @@",
  "-first before",
  "+first after",
  "@@ -20 +20 @@",
  "-second before",
  "+second after",
  "",
].join("\n");

function ReviewedChanges(): React.JSX.Element {
  const [reviewStates, setReviewStates] = useState<DiffReviewState[]>([]);
  return (
    <ChangesPanel
      files={[file]}
      diff={{ patch, truncated: false, files: [file] }}
      selectedPath="README.md"
      summary={null}
      reviewStates={reviewStates}
      onSelectFile={vi.fn()}
      onAsk={vi.fn(async () => undefined)}
      onRequestRevision={vi.fn(async () => undefined)}
      onRevert={vi.fn(async () => undefined)}
      onSetReviewState={async (state) => {
        setReviewStates((current) => [...current, {
          ...state,
          conversationId: "conversation-review",
          stale: false,
          updatedAt: "2026-09-15T10:00:00.000Z",
        }]);
      }}
      onCreateNote={vi.fn(async () => undefined)}
      onUpdateNote={vi.fn(async () => undefined)}
      onDeleteNote={vi.fn(async () => undefined)}
      onAddTextToPrompt={vi.fn()}
      onAddToPrompt={vi.fn()}
    />
  );
}

it("filters hunks through counted review-state chips instead of a passive select", async () => {
  const view = render(<ReviewedChanges />);
  await screen.findByText("first after");
  const filter = screen.getByRole("group", { name: "Filter review state" });
  const chip = (name: string) => within(filter).getByRole("button", { name: new RegExp(`^${name} \\d+$`, "u") });
  const rows = () => [...view.container.querySelectorAll(".diff-filter-row")];

  expect(screen.queryByRole("combobox", { name: "Filter review state" })).not.toBeInTheDocument();
  expect(within(filter).getAllByRole("button").map((button) => button.textContent))
    .toEqual(["all2", "unreviewed2", "reviewed0"]);
  expect(chip("all")).toHaveAttribute("aria-pressed", "true");
  expect(rows()).toHaveLength(2);
  expect(rows().every((row) => !row.hasAttribute("inert"))).toBe(true);

  fireEvent.click(screen.getAllByRole("button", { name: "Mark reviewed" })[0]!);
  await waitFor(() => expect(within(filter).getAllByRole("button").map((button) => button.textContent))
    .toEqual(["all2", "unreviewed1", "reviewed1"]));

  fireEvent.click(chip("reviewed"));
  expect(chip("reviewed")).toHaveAttribute("aria-pressed", "true");
  expect(chip("all")).toHaveAttribute("aria-pressed", "false");
  expect(chip("unreviewed")).toHaveAttribute("aria-pressed", "false");
  expect(rows().map((row) => row.hasAttribute("inert"))).toEqual([false, true]);

  fireEvent.click(chip("unreviewed"));
  expect(chip("unreviewed")).toHaveAttribute("aria-pressed", "true");
  expect(rows().map((row) => row.hasAttribute("inert"))).toEqual([true, false]);

  fireEvent.click(chip("all"));
  expect(rows().map((row) => row.hasAttribute("inert"))).toEqual([false, false]);
});
