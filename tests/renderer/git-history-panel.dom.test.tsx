import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import GitHistoryPanel from "../../src/renderer/src/components/GitHistoryPanel";
import WorkspaceGitActionMenu from "../../src/renderer/src/components/WorkspaceGitActionMenu";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import type { GitStatusSnapshot, ServerEvent } from "../../src/shared/contracts";
import type { GitCommitDetail, GitLogCommit } from "../../src/shared/contracts/git-history";

const projectId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const authorityRef = "33333333-3333-4333-8333-333333333333";

function sha(index: number): string {
  return index.toString(16).padStart(40, "a");
}

function commit(index: number, merge = false): GitLogCommit {
  return {
    sha: sha(index),
    shortSha: sha(index).slice(0, 7),
    subject: `Commit number ${index}`,
    authorName: `Author ${index}`,
    authorDate: new Date(Date.now() - index * 3_600_000).toISOString(),
    parents: merge ? [sha(index + 1), sha(index + 2)] : [sha(index + 1)],
    isMerge: merge,
  };
}

function detail(value: GitLogCommit): GitCommitDetail {
  return {
    ...value,
    body: `Body for ${value.subject}`,
    bodyTruncated: false,
    files: [
      { path: "src/a.ts", previousPath: null, status: "modified", additions: 1, deletions: 1 },
      { path: "assets/logo.png", previousPath: null, status: "added", additions: null, deletions: null },
    ],
    filesTruncated: false,
    diff: [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-const value = 1; <script>",
      `+const value = ${value.subject.length};`,
      "",
    ].join("\n"),
    diffTruncated: false,
  };
}

function result(value: Extract<ServerEvent, { type: "request.result" }>["result"]): ServerEvent {
  return { type: "request.result", requestId: crypto.randomUUID(), result: value };
}

function runner() {
  const pages = [
    { commits: [commit(1, true), commit(2), commit(3)], nextCursor: "cursor-2" },
    { commits: [commit(4)], nextCursor: null },
  ];
  return vi.fn(async (_key: string, command: CommandWithoutId): Promise<ServerEvent> => {
    if (command.type === "git.log") {
      const page = command.payload.cursor === "cursor-2" ? pages[1]! : pages[0]!;
      return result({ kind: "git.log", page: { head: sha(1), path: null, ...page } });
    }
    if (command.type === "git.commit.show") {
      const found = [...pages[0]!.commits, ...pages[1]!.commits].find(({ sha: value }) => value === command.payload.sha)!;
      return result({ kind: "git.commit.show", commit: detail(found) });
    }
    throw new Error(`Unexpected ${command.type}`);
  });
}

describe("GitHistoryPanel", () => {
  it("lists commits, shows the selected commit's files and diff, and loads more", async () => {
    const run = runner();
    render(<GitHistoryPanel
      open
      projectId={projectId}
      conversationId={conversationId}
      repositoryPath="."
      authorityRef={authorityRef}
      branch="main"
      run={run}
      onClose={vi.fn()}
    />);
    const dialog = await screen.findByRole("dialog", { name: "History" });
    expect(within(dialog).getByText("Read-only commits on main.")).toBeInTheDocument();
    const list = await within(dialog).findByRole("listbox", { name: "Commits" });
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(within(options[0]!).getByLabelText("Merge commit")).toBeInTheDocument();
    expect(within(options[1]!).getByText("Author 2")).toBeInTheDocument();
    expect(within(options[1]!).getByText(sha(2).slice(0, 7))).toBeInTheDocument();
    expect(run).toHaveBeenCalledWith("git.log", {
      type: "git.log",
      payload: { projectId, conversationId, repositoryPath: ".", authorityRef },
    });

    expect(await within(dialog).findByRole("heading", { name: "Commit number 1" })).toBeInTheDocument();
    expect(within(dialog).getByText("Merge · compared with first parent")).toBeInTheDocument();
    expect(within(dialog).getByRole("region", { name: "Diff for src/a.ts" })).toHaveTextContent("const value = 1; <script>");
    expect(dialog.querySelector("script")).toBeNull();
    // Shared Changes-panel highlighting: verified highlight.js markup only.
    const diffRegion = within(dialog).getByRole("region", { name: "Diff for src/a.ts" });
    expect(diffRegion.querySelector(".diff-line-content.hljs .hljs-keyword")).toHaveTextContent("const");
    fireEvent.click(within(dialog).getByRole("button", { name: /assets\/logo\.png/u }));
    expect(within(dialog).getByText(/No text diff is shown for assets\/logo\.png/u)).toBeInTheDocument();

    fireEvent.click(options[2]!);
    expect(await within(dialog).findByRole("heading", { name: "Commit number 3" })).toBeInTheDocument();
    expect(run).toHaveBeenCalledWith("git.commit.show", {
      type: "git.commit.show",
      payload: { projectId, conversationId, repositoryPath: ".", authorityRef, sha: sha(3) },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(4));
    expect(run).toHaveBeenCalledWith("git.log", {
      type: "git.log",
      payload: { projectId, conversationId, repositoryPath: ".", authorityRef, cursor: "cursor-2" },
    });
    expect(within(dialog).queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(within(dialog).getByText(/4 commits loaded · end of history/u)).toBeInTheDocument();
  });

  it("moves the selection with the keyboard and closes on Escape", async () => {
    const onClose = vi.fn();
    render(<GitHistoryPanel open projectId={projectId} run={runner()} onClose={onClose} />);
    const dialog = await screen.findByRole("dialog", { name: "History" });
    const list = await within(dialog).findByRole("listbox", { name: "Commits" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Close history" })).toHaveFocus());
    const first = within(list).getAllByRole("option")[0]!;
    expect(first).toHaveAttribute("tabindex", "0");
    first.focus();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    const second = within(list).getAllByRole("option")[1]!;
    await waitFor(() => expect(second).toHaveFocus());
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(first).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(list, { key: "End" });
    await waitFor(() => expect(within(list).getAllByRole("option")[2]).toHaveFocus());
    fireEvent.keyDown(list, { key: "Home" });
    await waitFor(() => expect(first).toHaveFocus());
    expect(await within(dialog).findByRole("heading", { name: "Commit number 1" })).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the list, selection and focus when a status refresh issues a new authority ref", async () => {
    const run = runner();
    const props = {
      open: true,
      projectId,
      conversationId,
      repositoryPath: "packages/nested",
      branch: "main",
      run,
      onClose: vi.fn(),
    };
    const { rerender } = render(<GitHistoryPanel {...props} authorityRef={authorityRef} />);
    const dialog = await screen.findByRole("dialog", { name: "History" });
    const list = await within(dialog).findByRole("listbox", { name: "Commits" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Close history" })).toHaveFocus());
    within(list).getAllByRole("option")[0]!.focus();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    const second = within(list).getAllByRole("option")[1]!;
    await waitFor(() => expect(second).toHaveFocus());
    expect(await within(dialog).findByRole("heading", { name: "Commit number 2" })).toBeInTheDocument();
    const callsBefore = run.mock.calls.length;

    const refreshed = "44444444-4444-4444-8444-444444444444";
    rerender(<GitHistoryPanel {...props} authorityRef={refreshed} />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(run.mock.calls.length).toBe(callsBefore);
    expect(within(list).getAllByRole("option")).toHaveLength(3);
    expect(within(list).getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    expect(within(list).getAllByRole("option")[1]).toHaveFocus();
    expect(within(dialog).getByRole("heading", { name: "Commit number 2" })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(4));
    expect(run).toHaveBeenLastCalledWith("git.log", {
      type: "git.log",
      payload: { projectId, conversationId, repositoryPath: "packages/nested", authorityRef: refreshed, cursor: "cursor-2" },
    });
    expect(within(list).getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
  });

  it("shows load failures as alerts and allows reloading", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("Unable to read the commit history."))
      .mockImplementation(runner());
    render(<GitHistoryPanel open projectId={projectId} run={run} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog", { name: "History" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Unable to read the commit history.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reload history" }));
    expect(await within(dialog).findByRole("listbox", { name: "Commits" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("Git menu history entry", () => {
  it("offers a read-only History… item even while Git is busy", () => {
    const onOpenHistory = vi.fn();
    const status = {
      isRepository: true,
      branch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [],
    } as unknown as GitStatusSnapshot;
    render(<WorkspaceGitActionMenu status={status} busy onAction={vi.fn()} onOpenHistory={onOpenHistory} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "History…" }));
    expect(onOpenHistory).toHaveBeenCalledOnce();
  });
});

describe("GitHistoryPanel diff fallback", () => {
  it("renders very large file diffs as plain text like the Changes panel", async () => {
    const value = commit(9);
    const lines = Array.from({ length: 4_001 }, (_, index) => `+const line${index} = ${index};`);
    const large: GitCommitDetail = {
      ...detail(value),
      files: [{ path: "src/big.ts", previousPath: null, status: "added", additions: 4_001, deletions: 0 }],
      diff: ["diff --git a/src/big.ts b/src/big.ts", "new file mode 100644", "--- /dev/null", "+++ b/src/big.ts", `@@ -0,0 +1,4001 @@`, ...lines, ""].join("\n"),
    };
    const run = vi.fn(async (_key: string, command: CommandWithoutId): Promise<ServerEvent> => command.type === "git.log"
      ? result({ kind: "git.log", page: { head: value.sha, path: null, commits: [value], nextCursor: null } })
      : result({ kind: "git.commit.show", commit: large }));
    render(<GitHistoryPanel open projectId={projectId} run={run} onClose={vi.fn()} />);
    const region = await screen.findByRole("region", { name: "Diff for src/big.ts" });
    expect(region.querySelectorAll(".diff-line")).toHaveLength(4_001);
    expect(region.querySelector(".hljs")).toBeNull();
    expect(region.querySelector(".diff-line-content")).toHaveTextContent("const line0 = 0;");
  });
  it("shows SHA-256 commits and the runtime's explanation when an id is ambiguous", async () => {
    const long = (index: number) => index.toString(16).padStart(64, "b");
    const commits: GitLogCommit[] = [1, 2].map((index) => ({
      ...commit(index),
      sha: long(index),
      shortSha: long(index).slice(0, 12),
      parents: [long(index + 1)],
    }));
    const run = vi.fn(async (_key: string, command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type === "git.log") {
        return result({ kind: "git.log", page: { head: long(1), path: null, commits, nextCursor: null } });
      }
      if (command.type === "git.commit.show" && command.payload.sha === long(1)) {
        return result({ kind: "git.commit.show", commit: detail(commits[0]!) });
      }
      throw new Error("That short commit identifier matches more than one commit. Use the full identifier.");
    });
    render(<GitHistoryPanel open projectId={projectId} conversationId={conversationId} repositoryPath="."
      authorityRef={authorityRef} branch="main" run={run} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog", { name: "History" });
    const list = await within(dialog).findByRole("listbox", { name: "Commits" });
    const options = within(list).getAllByRole("option");
    expect(options[0]).toHaveAttribute("data-sha", long(1));
    expect(within(options[0]!).getByText(long(1).slice(0, 12))).toBeInTheDocument();
    expect(await within(dialog).findByRole("heading", { name: "Commit number 1" })).toBeInTheDocument();
    expect(within(dialog).getByTitle(long(1))).toBeInTheDocument();

    fireEvent.click(options[1]!);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("That short commit identifier matches more than one commit. Use the full identifier.");
    expect(run).toHaveBeenCalledWith("git.commit.show", expect.objectContaining({
      payload: expect.objectContaining({ sha: long(2) }),
    }));
  });
});
