import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import WorkspaceGitActionMenu from "../../src/renderer/src/components/WorkspaceGitActionMenu";
import type { GitStatusSnapshot } from "../../src/shared/contracts";

const status: GitStatusSnapshot = {
  isRepository: true,
  root: "/workspace/inertia",
  branch: "feature/header",
  upstream: "origin/feature/header",
  ahead: 1,
  behind: 0,
  hasRemote: true,
  pullRequest: { available: true, remoteName: "origin", forge: "github", unavailableReason: null },
  files: [],
  insertions: 0,
  deletions: 0,
};

describe("Git actions menu", () => {
  it("lists one-line actions with their details as descriptions and a plain branch summary", () => {
    render(<WorkspaceGitActionMenu status={status} busy={false} onAction={vi.fn()} onOpenBranches={vi.fn()} />);
    const menu = screen.getByRole("menu", { name: "Git actions" });
    expect(within(menu).getByText("Tracking origin/feature/header")).toBeInTheDocument();
    expect(within(menu).getByText("1 outgoing", { exact: true })).toBeInTheDocument();
    expect(menu.querySelector(".git-overview-counts, .git-menu-section-label")).toBeNull();
    for (const item of within(menu).getAllByRole("menuitem")) expect(item.querySelector("small")).toBeNull();
    const fetch = within(menu).getByRole("menuitem", { name: "Fetch" });
    expect(fetch).toHaveAccessibleDescription(/.+/u);
    expect(within(menu).getByRole("menuitem", { name: "Switch branch" })).toBeInTheDocument();
  });

  it("states outgoing and incoming counts once", () => {
    const { container } = render(<WorkspaceGitActionMenu status={{ ...status, ahead: 2, behind: 0 }} busy={false} onAction={vi.fn()} />);
    expect(screen.getByText("2 outgoing", { exact: true })).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/outgoing commit/u);
  });

  it("states a missing upstream once", () => {
    render(<WorkspaceGitActionMenu status={{ ...status, upstream: null }} busy={false} onAction={vi.fn()} />);
    expect(screen.getAllByText("No upstream")).toHaveLength(1);
  });
});
