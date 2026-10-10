import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceChangesPanel } from "../../src/renderer/src/components/WorkspaceChangesPanel";
import { SelectionReviewAnswerCard } from "../../src/renderer/src/components/SelectionReviewAnswerCard";
import type { ChangedFile, ServerEvent, WorkspaceGitSnapshot } from "../../src/shared/contracts";

function changedFile(path: string): ChangedFile {
  return {
    path,
    status: "modified",
    insertions: 2,
    deletions: 1,
    untracked: false,
    staged: false,
    unstaged: true,
    indexStatus: ".",
    worktreeStatus: "M",
  };
}

const patch = ["diff --git a/README.md b/README.md", "--- a/README.md", "+++ b/README.md", "@@ -1 +1 @@", "-before", "+after", ""].join("\n");

function repository(repositoryPath: string): WorkspaceGitSnapshot["repositories"][number] {
  return {
    repositoryPath,
    state: "ready",
    error: null,
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    hasRemote: true,
    authorityRef: "authority",
    files: [changedFile("README.md")],
    insertions: 2,
    deletions: 1,
    clean: false,
    truncated: false,
  } as WorkspaceGitSnapshot["repositories"][number];
}

function snapshotWith(...paths: string[]): WorkspaceGitSnapshot {
  return {
    repositories: paths.map(repository),
    files: paths.length,
    insertions: 2,
    deletions: 1,
    scannedDirectories: 1,
    skippedDirectories: 0,
    discoveredRepositories: paths.length,
    repositoryLimit: 64,
    partial: false,
    truncated: false,
    issues: [],
  };
}

async function renderPanel(snapshot: WorkspaceGitSnapshot): Promise<void> {
  await act(async () => {
    render(
      <WorkspaceChangesPanel
        projectName="Inertia"
        projectId="11111111-1111-4111-8111-111111111111"
        conversationId="22222222-2222-4222-8222-222222222222"
        snapshot={snapshot}
        summary={null}
        onRefresh={vi.fn()}
        run={vi.fn(async (): Promise<ServerEvent> => ({ type: "request.ok", requestId: "request" }) as ServerEvent)}
        onLoadRepositoryDiff={vi.fn(async (repositoryPath: string) => ({ repositoryPath, patch, truncated: false, files: [changedFile("README.md")] }))}
        onOpenWorkspaceFile={vi.fn()}
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
  });
}

describe("changes panel chrome", () => {
  it("states the file count once, without a repeated title, icon or progress bar", async () => {
    await renderPanel(snapshotWith("."));
    await screen.findByRole("button", { name: "+ after" });
    const toolbar = document.querySelector(".changes-panel > .panel-toolbar")!;
    expect(within(toolbar as HTMLElement).getByRole("heading", { name: "Changes" })).toHaveClass("visually-hidden");
    expect(toolbar.querySelector(".panel-heading > svg")).toBeNull();
    expect(document.querySelector(".diff-review-toolbar progress")).toBeNull();
    expect(document.querySelector(".diff-review-toolbar")).toHaveTextContent("0/1 hunks reviewed");
  });

  it("keeps hints in tooltips instead of native titles on the Git row and file rows", async () => {
    await renderPanel(snapshotWith("."));
    await screen.findByRole("button", { name: "+ after" });
    const actions = screen.getByLabelText("Actions for Inertia");
    for (const button of within(actions).getAllByRole("button")) expect(button).not.toHaveAttribute("title");
    expect(within(actions).getByRole("button", { name: "Fetch" })).toHaveAccessibleDescription("Refresh remote branches while preserving local changes");
    expect(document.querySelectorAll(".change-file-status[title]")).toHaveLength(0);
    expect(within(actions).getByRole("button", { name: "Confidence" }).querySelector(".lucide-shield-check")).not.toBeNull();
  });

  it("explains a nested repository through a described control and drops the kicker from the compact picker", async () => {
    await renderPanel(snapshotWith(".", "modules/alpha"));
    await screen.findByRole("button", { name: "+ after" });
    expect(document.querySelector(".changes-file-picker > span")).toBeNull();
    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "Repository scope" }), { target: { value: "modules/alpha" } });
    });
    const boundary = await screen.findByRole("button", { name: "Nested repo" });
    expect(boundary).not.toHaveAttribute("title");
    expect(boundary).toHaveAccessibleDescription(/Agent summaries and revisions remain available only for the project-root repository/u);
  });
});

describe("selection review answer", () => {
  it("labels the answer without an accent icon", () => {
    render(<SelectionReviewAnswerCard answer={{
      repositoryPath: ".",
      fingerprint: "f",
      filePath: "README.md",
      hunkId: "h",
      question: "Why?",
      answer: "Because.",
      selectedLineCount: 1,
      modelSelection: { backendProfileDisplayName: "Codex", modelId: "gpt", alias: null },
    } as unknown as Parameters<typeof SelectionReviewAnswerCard>[0]["answer"]} />);
    const card = screen.getByRole("complementary", { name: "Agent answer about selected lines" });
    expect(card.querySelector("header svg")).toBeNull();
  });
});
