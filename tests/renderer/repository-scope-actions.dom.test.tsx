import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RepositoryScopeActions } from "../../src/renderer/src/components/RepositoryScopeActions";

const fitting = { rowClient: 520, rowScroll: 520, actionsClient: 300, actionsScroll: 300 };
const sizes = { ...fitting };
let resize: (() => void) | null = null;

beforeEach(() => {
  Object.assign(sizes, fitting);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("scope-row")) return sizes.rowClient;
    if (this.classList.contains("workspace-repository-scope-actions")) return sizes.actionsClient;
    return 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("scope-row")) return sizes.rowScroll;
    if (this.classList.contains("workspace-repository-scope-actions")) return sizes.actionsScroll;
    return 0;
  });
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) {
      resize = callback;
    }
    observe(): void {}
    disconnect(): void {}
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resize = null;
});

function actionsRow(onFetch = vi.fn(), onPush = vi.fn(), onMergeDialog = vi.fn()) {
  return (
    <div className="scope-row">
      <RepositoryScopeActions
        label="inertia"
        commit={<button type="button">Commit</button>}
        actions={[
          { id: "fetch", label: "Fetch", icon: null, disabled: false, onSelect: onFetch },
          { id: "pull", label: "Pull", icon: null, disabled: true, onSelect: vi.fn() },
          { id: "push", label: "Publish branch", icon: null, disabled: false, onSelect: onPush },
        ]}
        confidence={{ disabled: false, title: "Compare" }}
        pullRequest={{ disabled: true }}
        onRequestMergeDialog={onMergeDialog}
      >
        {(compact) => <span data-testid="launcher">{compact ? "dialogs only" : "buttons"}</span>}
      </RepositoryScopeActions>
    </div>
  );
}

describe("Changes repository actions", () => {
  it("shows every action inline while the row fits", () => {
    render(actionsRow());
    const group = screen.getByLabelText("Actions for inertia");
    for (const name of ["Commit", "Fetch", "Pull", "Publish branch"]) {
      expect(within(group).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "More Git actions" })).toBeNull();
    expect(screen.getByTestId("launcher")).toHaveTextContent("buttons");
  });

  it("keeps Commit and moves the rest behind More when the row would overflow, then expands again", () => {
    sizes.rowScroll = 760;
    const onFetch = vi.fn();
    const onMergeDialog = vi.fn();
    render(actionsRow(onFetch, vi.fn(), onMergeDialog));
    const group = screen.getByLabelText("Actions for inertia");
    expect(within(group).getByRole("button", { name: "Commit" })).toBeInTheDocument();
    expect(within(group).queryByRole("button", { name: "Fetch" })).toBeNull();
    expect(screen.getByTestId("launcher")).toHaveTextContent("dialogs only");

    fireEvent.click(screen.getByRole("button", { name: "More Git actions" }));
    const menu = screen.getByRole("menu", { name: "More Git actions" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent))
      .toEqual(["Fetch", "Pull", "Publish branch", "Confidence", "PR"]);
    expect(within(menu).getByRole("menuitem", { name: "Pull" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Pull" }));
    expect(screen.getByRole("menu", { name: "More Git actions" })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Fetch" }));
    expect(onFetch).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu", { name: "More Git actions" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More Git actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Confidence" }));
    expect(onMergeDialog).toHaveBeenCalledWith("confidence");

    sizes.rowClient = 700;
    act(() => resize?.());
    expect(screen.queryByRole("button", { name: "More Git actions" })).not.toBeNull();

    sizes.rowClient = 760;
    sizes.rowScroll = 760;
    act(() => resize?.());
    expect(within(group).getByRole("button", { name: "Fetch" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More Git actions" })).toBeNull();
    expect(screen.getByTestId("launcher")).toHaveTextContent("buttons");
  });

  it("collapses when the stacked action line itself would overflow", () => {
    sizes.rowClient = 300;
    sizes.rowScroll = 300;
    sizes.actionsClient = 280;
    sizes.actionsScroll = 420;
    render(actionsRow());
    expect(screen.getByRole("button", { name: "More Git actions" })).toBeInTheDocument();
  });
});
