import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  HEADER_ACTIONS_COLLAPSE_WIDTH,
  headerActionsCollapsed,
  WorkspaceHeader,
} from "../../src/renderer/src/components/WorkspaceHeader";
import type { GitStatusSnapshot, Project } from "../../src/shared/contracts";

const project: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Inertia",
  path: "/workspace/inertia",
  normalizedPath: "/workspace/inertia",
  repositoryIdentity: null,
  repositoryRoot: null,
  repositoryRelativePath: "",
  groupingMode: null,
  gitRepositoryLimit: 64,
  color: "#6366f1",
  status: "ready",
  createdAt: "2026-07-29T10:00:00.000Z",
  updatedAt: "2026-07-29T10:00:00.000Z",
};

const gitStatus: GitStatusSnapshot = {
  isRepository: true,
  root: "/workspace/inertia",
  branch: "feature/header",
  upstream: "origin/feature/header",
  ahead: 0,
  behind: 0,
  hasRemote: true,
  files: [{
    path: "src/app.ts",
    status: "modified",
    insertions: 2,
    deletions: 1,
    untracked: false,
    staged: false,
    unstaged: true,
    indexStatus: ".",
    worktreeStatus: "M",
  }],
  insertions: 2,
  deletions: 1,
};

type HeaderProps = ComponentProps<typeof WorkspaceHeader>;

function headerProps(overrides: Partial<HeaderProps> = {}): HeaderProps {
  return {
    project,
    conversation: null,
    view: "workspace",
    sidebarCollapsed: false,
    gitStatus,
    branches: [],
    actions: [
      { id: "dev", label: "Dev server", command: "npm run dev", preview: true },
      { id: "test", label: "Tests", command: "npm test", preview: false },
    ],
    busy: false,
    onOpenSidebar: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenConnectionsSettings: vi.fn(),
    onOpenFolder: vi.fn(),
    onRevealFolder: vi.fn(),
    onOpenFiles: vi.fn(),
    onAddAction: vi.fn(),
    onRefreshBranches: vi.fn(),
    onSwitchBranch: vi.fn(),
    onCreateBranch: vi.fn(),
    onCreateConversationOnBranch: vi.fn(),
    onCreateConversationInWorktree: vi.fn(),
    onCreateConversationInIsolatedWorktree: vi.fn(),
    onCommit: vi.fn(),
    onOpenPullRequest: vi.fn(),
    onPull: vi.fn(),
    onPush: vi.fn(),
    onRunAction: vi.fn(),
    ...overrides,
  };
}

describe("workspace header overflow", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  it("folds the three groups below 520px and on compact navigation", () => {
    expect(HEADER_ACTIONS_COLLAPSE_WIDTH).toBe(520);
    expect(headerActionsCollapsed({ containerWidth: 519, compact: false })).toBe(true);
    expect(headerActionsCollapsed({ containerWidth: 520, compact: false })).toBe(false);
    expect(headerActionsCollapsed({ containerWidth: 1200, compact: true })).toBe(true);
  });

  it("keeps Run, Open and Git in the same order inside the overflow menu", async () => {
    const props = headerProps({ compact: true });
    render(<WorkspaceHeader {...props} />);
    expect(screen.queryByRole("group", { name: "Project actions" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "More header actions" }));
    const menu = await screen.findByRole("menu", { name: "Header actions" });
    await within(menu).findByRole("menuitem", { name: "Commit" });
    const labels = within(menu).getAllByRole("menuitem").map((item) => item.textContent);
    expect(labels).toEqual([
      "Run Dev server",
      "Project actions",
      "Open in Folder",
      "Open in…",
      "Commit",
      "Git actions",
    ]);
    expect(within(menu).getAllByRole("separator")).toHaveLength(2);

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Commit" }));
    expect(props.onCommit).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "More header actions" }))
        .toHaveAttribute("aria-expanded", "false"));
    expect(menu).not.toBeVisible();
  });

  it("keeps the preferred project action when the header folds and unfolds", async () => {
    const props = headerProps();
    const view = render(<WorkspaceHeader {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Project action options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Tests/u }));
    expect(props.onRunAction).toHaveBeenLastCalledWith(props.actions[1]);
    expect(screen.getByRole("button", { name: "Run Tests" })).toBeVisible();

    view.rerender(<WorkspaceHeader {...props} compact />);
    fireEvent.click(screen.getByRole("button", { name: "More header actions" }));
    const menu = await screen.findByRole("menu", { name: "Header actions" });
    fireEvent.click(await within(menu).findByRole("menuitem", { name: "Run Tests" }));
    expect(props.onRunAction).toHaveBeenLastCalledWith(props.actions[1]);

    view.rerender(<WorkspaceHeader {...props} />);
    expect(await screen.findByRole("button", { name: "Run Tests" })).toBeVisible();
  });
});
