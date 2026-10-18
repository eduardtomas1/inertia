import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ChangesPanel } from "../../src/renderer/src/components/ChangesPanel";
import type { ChangedFile } from "../../src/shared/contracts";

const file: ChangedFile = {
  path: "README.md", status: "modified", insertions: 2, deletions: 2, untracked: false,
  staged: false, unstaged: true, indexStatus: ".", worktreeStatus: "M",
};
const patch = [
  "diff --git a/README.md b/README.md", "--- a/README.md", "+++ b/README.md",
  "@@ -1 +1 @@", "-first before", "+first after",
  "@@ -20 +20 @@", "-second before", "+second after", "",
].join("\n");

function Panel(): React.JSX.Element {
  return <ChangesPanel files={[file]} diff={{ patch, truncated: false, files: [file] }} selectedPath="README.md" summary={null}
    reviewStates={[]} onSelectFile={vi.fn()} onAsk={vi.fn(async () => undefined)} onRequestRevision={vi.fn(async () => undefined)}
    onRevert={vi.fn(async () => undefined)} onSetReviewState={vi.fn(async () => undefined)} onCreateNote={vi.fn(async () => undefined)}
    onUpdateNote={vi.fn(async () => undefined)} onDeleteNote={vi.fn(async () => undefined)} onAddTextToPrompt={vi.fn()} onAddToPrompt={vi.fn()} />;
}

afterEach(() => vi.restoreAllMocks());

it("scrolls the hunk inside its own panel when split panes show the same diff", async () => {
  const scrolled: Element[] = [];
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) { scrolled.push(this); });
  render(<><Panel /><Panel /></>);
  await waitFor(() => expect(screen.getAllByText("second after")).toHaveLength(2));
  const [, secondPanel] = screen.getAllByRole("region", { name: "Workspace changes" });
  fireEvent.click(within(secondPanel!).getByRole("button", { name: "Next review hunk (N)" }));
  await waitFor(() => expect(scrolled).toHaveLength(1));
  expect(secondPanel).toContainElement(scrolled[0] as HTMLElement);
  expect(scrolled[0]).toHaveTextContent("second after");
});
