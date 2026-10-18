import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/renderer/src/components/lazySurfaceLoaders", () => ({
  prefetchWorkspaceTool: () => undefined,
}));

import type { GitStatusSnapshot } from "@shared/contracts";
import { CommitDialog } from "../../src/renderer/src/components/CommitDialog";
import { WorkspacePanel } from "../../src/renderer/src/components/WorkspacePanel";

const status = {
  branch: "main",
  insertions: 4,
  deletions: 1,
  files: [
    { path: "src/app.ts", staged: false, unstaged: true, untracked: false, insertions: 4, deletions: 1 },
  ],
} as unknown as GitStatusSnapshot;

function renderDialog(onCommit = vi.fn(async () => undefined), onClose = vi.fn()) {
  render(<CommitDialog open repositoryPath="." status={status} diff={{ fingerprint: "empty", files: [] }}
    diffParsing={false} diffError={null} reviewStates={[]} busy={false} onClose={onClose} onCommit={onCommit} />);
  return { onCommit, onClose };
}

describe("commit dialog keyboard", () => {
  it("keeps the Enter that confirms an input method composition from committing", async () => {
    const { onCommit } = renderDialog();
    const message = screen.getByRole("textbox", { name: "Commit message" });
    fireEvent.change(message, { target: { value: "変更" } });

    fireEvent.keyDown(message, { key: "Enter", isComposing: true });
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.keyDown(message, { key: "Enter" });
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("変更", false, ["src/app.ts"]));
  });

  it("closes only the commit dialog when Escape is pressed inside the Changes sheet", () => {
    const onClose = vi.fn();
    const onClosePanel = vi.fn();
    render(
      <WorkspacePanel surfaces={["changes"]} activeSurface="changes" presentation="sheet" onClosePanel={onClosePanel}>
        <CommitDialog open repositoryPath="." status={status} diff={{ fingerprint: "empty", files: [] }}
          diffParsing={false} diffError={null} reviewStates={[]} busy={false} onClose={onClose} onCommit={vi.fn()} />
      </WorkspacePanel>,
    );

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Commit message" }), { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
    expect(onClosePanel).not.toHaveBeenCalled();
  });
});
