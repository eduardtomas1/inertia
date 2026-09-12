import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import WorkspaceBranchList from "../../src/renderer/src/components/WorkspaceBranchList";

const branches = [
  { name: "main", current: true, remote: false, worktreePath: null },
  { name: "feature/local", current: false, remote: false, worktreePath: null },
  { name: "occupied", current: false, remote: false, worktreePath: null, checkedOut: true },
  { name: "origin/feature/remote", current: false, remote: true, worktreePath: null },
];

describe("branch picker", () => {
  it("focuses search, filters both groups and explicitly selects a remote tracking branch", () => {
    const onSwitch = vi.fn();
    render(<WorkspaceBranchList branches={branches} busy={false} onSwitch={onSwitch} onCreate={vi.fn()} />);
    const search = screen.getByRole("searchbox", { name: "Search branches" });
    expect(search).toHaveFocus();
    expect(screen.getByRole("menuitemradio", { name: /occupied/u })).toBeDisabled();
    fireEvent.change(search, { target: { value: "REMOTE" } });
    expect(screen.queryByRole("group", { name: "Local branches" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /origin\/feature\/remote/u }));
    expect(onSwitch).toHaveBeenCalledWith("origin/feature/remote", true);
  });

  it("keeps branch choices focusable during refresh and exposes retry after failure", () => {
    const onRefresh = vi.fn();
    const props = { branches, busy: false, onSwitch: vi.fn(), onCreate: vi.fn(), onRefresh };
    const { rerender } = render(<WorkspaceBranchList {...props} loading />);
    expect(screen.getByText("Refreshing branches…")).toBeInTheDocument();
    const choice = screen.getByRole("menuitemradio", { name: "feature/local" });
    expect(choice).toBeEnabled();
    fireEvent.click(choice);
    expect(props.onSwitch).not.toHaveBeenCalled();
    rerender(<WorkspaceBranchList {...props} error="Git is unavailable." />);
    expect(props.onSwitch).not.toHaveBeenCalled();
    expect(screen.getByRole("menuitemradio", { name: "feature/local" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh branches" }));
    expect(onRefresh).toHaveBeenCalledOnce();
    // The click event must not reach loadBranches as its `passive` flag.
    expect(onRefresh).toHaveBeenCalledWith();
  });

  it("explains empty search and submits branch creation only when idle", () => {
    const onCreate = vi.fn();
    const { rerender } = render(<WorkspaceBranchList branches={branches} busy={false} onSwitch={vi.fn()} onCreate={onCreate} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "missing" } });
    expect(screen.getByText("No matching branches.")).toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "New branch name" });
    fireEvent.change(input, { target: { value: "feature/new" } });
    fireEvent.submit(input.closest("form")!);
    expect(onCreate).toHaveBeenCalledWith("feature/new");
    rerender(<WorkspaceBranchList branches={branches} busy onSwitch={vi.fn()} onCreate={onCreate} />);
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });
});
