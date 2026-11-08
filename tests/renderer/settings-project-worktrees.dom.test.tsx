import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProjectSettings } from "../../src/renderer/src/components/ProjectSettings";
import type { IssueReportSettingsProps } from "../../src/renderer/src/components/IssueReportSettings";
import type { Project, ServerEvent } from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts";
import { defaultProjectPreferences } from "../../src/shared/project-preferences";
import type { WorktreeEntry, WorktreeList } from "../../src/shared/worktrees";
import { provider } from "./composer-fixtures";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const CHAT = "22222222-2222-4222-8222-222222222222";
const project: Project = { id: PROJECT, name: "Studio", path: "/workspace/studio", normalizedPath: "/workspace/studio",
  repositoryIdentity: "git:/workspace/studio/.git", repositoryRoot: "/workspace/studio", repositoryRelativePath: "",
  groupingMode: null, gitRepositoryLimit: 128, color: "#5661d8", status: "ready", createdAt: "2026-09-09T08:00:00.000Z",
  updatedAt: "2026-09-09T08:00:00.000Z", preferences: defaultProjectPreferences() };

function entry(overrides: Partial<WorktreeEntry>): WorktreeEntry {
  return {
    path: "/data/worktrees/chat", location: "inertia", branch: "inertia/22222222", head: "a".repeat(40),
    isMain: false, owned: true, conversationId: CHAT, title: "Fix login", chatStatus: "completed",
    sharedChatCount: 0, dirty: false, changeCount: 0, changeCountTruncated: false, ignoredFiles: false,
    locked: false, prunable: false, removal: { allowed: true }, ...overrides,
  };
}

const listed: WorktreeList = {
  projectId: PROJECT,
  truncated: false,
  worktrees: [
    entry({ path: ".", location: "repository", branch: "main", isMain: true, owned: false, conversationId: null, title: null,
      chatStatus: null, removal: { allowed: false, reason: "This is the project's main checkout, which is never removed here." } }),
    entry({}),
    entry({ path: "/data/worktrees/dirty", branch: "inertia/33333333", conversationId: "33333333-3333-4333-8333-333333333333",
      title: "Draft", dirty: true, changeCount: 3, removal: { allowed: false, reason: "This worktree has 3 uncommitted changes. Commit, stash or discard them first." } }),
    entry({ path: "…/feature", location: "external", branch: "feature", owned: false, conversationId: null, title: null, chatStatus: null,
      prunable: true, dirty: null, changeCount: null, removal: { allowed: false, reason: "Inertia did not create this worktree. Remove it with Git if you no longer need it." } }),
  ],
};

function setup(responses: Partial<Record<string, (command: Parameters<IssueReportSettingsProps["request"]>[0]) => ServerEvent | Promise<ServerEvent>>> = {}) {
  let list = listed;
  const request = vi.fn<IssueReportSettingsProps["request"]>(async (command) => {
    const custom = responses[command.type];
    if (custom) return await custom(command);
    if (command.type === "worktree.list") {
      return { type: "request.result", requestId: "r", result: { kind: "worktree.list", list } };
    }
    return { type: "request.ok", requestId: "r" };
  });
  const onOpenConversation = vi.fn(() => true);
  const view = render(<ProjectSettings projects={[project]} conversations={[]} providers={[provider]} backendDefaults={[]}
    backendProfiles={[]} settings={defaultSettings} disabled={false} request={request} onUpdateSettings={vi.fn()}
    initialProjectId={PROJECT} onOpenConversation={onOpenConversation} />);
  fireEvent.click(screen.getByRole("button", { name: "Show worktrees" }));
  return { ...view, request, onOpenConversation, setList: (next: WorktreeList) => { list = next; } };
}

describe("Settings → Projects → Worktrees", () => {
  it("lists paths, branches, chat links, clean/dirty badges and refusal reasons", async () => {
    const { request, onOpenConversation } = setup();
    const worktreeList = await screen.findByRole("list", { name: "Worktrees" });
    expect(request).toHaveBeenCalledWith({ type: "worktree.list", payload: { projectId: PROJECT } });
    const items = within(worktreeList).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent("main");
    const mainTitle = within(items[0]!).getByText("Main checkout");
    expect(mainTitle.tagName).toBe("STRONG");
    expect(within(items[0]!).getByText("studio")).toHaveClass("worktree-list-folder");
    expect(within(items[0]!).queryByText(".")).not.toBeInTheDocument();
    expect(items[0]!.innerHTML).not.toContain("/workspace/studio");
    expect(within(items[0]!).queryByRole("button", { name: /Remove/u })).not.toBeInTheDocument();

    expect(items[1]).toHaveTextContent("/data/worktrees/chat");
    expect(items[1]).toHaveTextContent("inertia/22222222");
    expect(items[1]).toHaveTextContent("Clean");
    const remove = within(items[1]!).getByRole("button", { name: "Remove worktree /data/worktrees/chat" });
    expect(remove).not.toHaveAttribute("aria-disabled");
    fireEvent.click(within(items[1]!).getByRole("button", { name: "Open chat “Fix login”" }));
    expect(onOpenConversation).toHaveBeenCalledWith(CHAT);

    expect(items[2]).toHaveTextContent("3 changes");
    const refused = within(items[2]!).getByRole("button", { name: "Remove worktree /data/worktrees/dirty" });
    expect(refused).toHaveAttribute("aria-disabled", "true");
    expect(refused).toHaveAccessibleDescription("This worktree has 3 uncommitted changes. Commit, stash or discard them first.");
    fireEvent.click(refused);
    expect(screen.queryByRole("group", { name: "Confirm removing the worktree" })).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ type: "worktree.remove" }));

    expect(items[3]).toHaveTextContent("…/feature");
    expect(items[3]).toHaveTextContent("Folder missing");
    expect(items[3]).toHaveTextContent("Not created by Inertia");
    expect(within(items[3]!).getByRole("button", { name: /Remove worktree/u }))
      .toHaveAccessibleDescription(/did not create this worktree/u);
    expect(screen.getByRole("button", { name: /Prune stale entries \(1\)/u })).toBeInTheDocument();
  });

  it("confirms with the path and branch, keeps keyboard focus, and sends the removal", async () => {
    const { request, setList } = setup({
      "worktree.remove": () => ({ type: "request.result", requestId: "r", result: { kind: "worktree.action",
        outcome: { action: "remove", branchDeleted: true, message: "Removed the worktree /data/worktrees/chat. Deleted branch inertia/22222222, which was merged into main." } } }),
    });
    const list = await screen.findByRole("list", { name: "Worktrees" });
    const remove = within(list).getByRole("button", { name: "Remove worktree /data/worktrees/chat" });
    remove.focus();
    fireEvent.click(remove);
    const confirm = screen.getByRole("group", { name: "Confirm removing the worktree" });
    expect(confirm).toHaveTextContent("Remove the worktree /data/worktrees/chat?");
    expect(confirm).toHaveTextContent("Branch inertia/22222222");
    const cancel = within(confirm).getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Confirm removing the worktree" })).not.toBeInTheDocument();
    expect(remove).toHaveFocus();

    fireEvent.click(remove);
    setList({ ...listed, worktrees: listed.worktrees.filter(({ path }) => path !== "/data/worktrees/chat") });
    await act(async () => {
      fireEvent.click(within(screen.getByRole("group", { name: "Confirm removing the worktree" })).getByRole("button", { name: "Remove worktree" }));
    });
    expect(request).toHaveBeenCalledWith({ type: "worktree.remove", payload: { projectId: PROJECT, path: "/data/worktrees/chat" } });
    expect(await screen.findByText(/Deleted branch inertia\/22222222/u, { selector: "[role=status]" })).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Worktrees" })).getAllByRole("listitem")).toHaveLength(3));
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveFocus();
  });

  it("shows a server refusal without changing the list and prunes on request", async () => {
    const { request } = setup({
      "worktree.remove": () => { throw new Error("Stop the chat “Fix login” before removing its worktree."); },
      "worktree.prune": () => ({ type: "request.result", requestId: "r", result: { kind: "worktree.action",
        outcome: { action: "prune", branchDeleted: false, message: "Cleared 1 stale worktree entry. No files were changed." } } }),
    });
    const list = await screen.findByRole("list", { name: "Worktrees" });
    fireEvent.click(within(list).getByRole("button", { name: "Remove worktree /data/worktrees/chat" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("group", { name: "Confirm removing the worktree" })).getByRole("button", { name: "Remove worktree" }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Stop the chat “Fix login” before removing its worktree.");
    expect(within(screen.getByRole("list", { name: "Worktrees" })).getAllByRole("listitem")).toHaveLength(4);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Prune stale entries/u })); });
    expect(request).toHaveBeenCalledWith({ type: "worktree.prune", payload: { projectId: PROJECT } });
    expect(await screen.findByText("Cleared 1 stale worktree entry. No files were changed.", { selector: "[role=status]" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a partial removal as a warning that names the leftover folder and refreshes the list", async () => {
    const message = "Git unregistered the worktree but could not delete all of its files, usually because a program still has one open. What is left is in /data/worktrees/chat; close that program and delete the folder by hand.";
    const { request, setList } = setup({
      "worktree.remove": () => ({ type: "request.result", requestId: "r", result: { kind: "worktree.action",
        outcome: { action: "remove", branchDeleted: false, partial: true, message } } }),
    });
    const list = await screen.findByRole("list", { name: "Worktrees" });
    fireEvent.click(within(list).getByRole("button", { name: "Remove worktree /data/worktrees/chat" }));
    setList({ ...listed, worktrees: listed.worktrees.filter(({ path }) => path !== "/data/worktrees/chat") });
    await act(async () => {
      fireEvent.click(within(screen.getByRole("group", { name: "Confirm removing the worktree" })).getByRole("button", { name: "Remove worktree" }));
    });
    expect(await screen.findByText(message, { selector: "[role=status]" })).toBeInTheDocument();
    const warning = screen.getByText(/What is left is in \/data\/worktrees\/chat/u, { selector: "p" });
    expect(warning).toHaveClass("project-worktrees-warning");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Worktrees" })).getAllByRole("listitem")).toHaveLength(3));
    expect(request.mock.calls.filter(([command]) => command.type === "worktree.list")).toHaveLength(2);
  });

  it("shows a complete removal as an ordinary notice", async () => {
    setup({
      "worktree.remove": () => ({ type: "request.result", requestId: "r", result: { kind: "worktree.action",
        outcome: { action: "remove", branchDeleted: false, message: "Removed the worktree /data/worktrees/chat." } } }),
    });
    const list = await screen.findByRole("list", { name: "Worktrees" });
    fireEvent.click(within(list).getByRole("button", { name: "Remove worktree /data/worktrees/chat" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("group", { name: "Confirm removing the worktree" })).getByRole("button", { name: "Remove worktree" }));
    });
    const notice = await screen.findByText("Removed the worktree /data/worktrees/chat.", { selector: "p" });
    expect(notice).toHaveClass("project-worktrees-notice");
  });

  it("does not show worktrees for a project without a repository", () => {
    const request = vi.fn<IssueReportSettingsProps["request"]>();
    render(<ProjectSettings projects={[{ ...project, repositoryRoot: null }]} conversations={[]} providers={[provider]} backendDefaults={[]}
      backendProfiles={[]} settings={defaultSettings} disabled={false} request={request} onUpdateSettings={vi.fn()} initialProjectId={PROJECT} />);
    expect(screen.queryByRole("heading", { name: "Worktrees" })).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });

  it("runs no Git inventory until the person opens the list", async () => {
    const request = vi.fn<IssueReportSettingsProps["request"]>(async () => ({
      type: "request.result", requestId: "r", result: { kind: "worktree.list", list: listed },
    }) as ServerEvent);
    render(<ProjectSettings projects={[project]} conversations={[]} providers={[provider]} backendDefaults={[]}
      backendProfiles={[]} settings={defaultSettings} disabled={false} request={request} onUpdateSettings={vi.fn()} initialProjectId={PROJECT} />);
    expect(screen.getByRole("heading", { name: "Worktrees" })).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
    const show = screen.getByRole("button", { name: "Show worktrees" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    show.focus();
    fireEvent.click(show);
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveFocus();
    expect(await screen.findByRole("list", { name: "Worktrees" })).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
