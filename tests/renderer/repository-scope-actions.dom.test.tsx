import { readFileSync } from "node:fs";

import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PreMergeConfidenceLauncher } from "../../src/renderer/src/components/PreMergeConfidenceLauncher";
import { RepositoryScopeActions, type MergeDialogRequest } from "../../src/renderer/src/components/RepositoryScopeActions";

const fitting = { rowClient: 520, rowScroll: 520, compactScroll: 0, foldedScroll: 0, actionsClient: 300, actionsScroll: 300 };
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
    if (this.classList.contains("scope-row")) {
      if (!this.querySelector('[aria-haspopup="menu"]')) return sizes.rowScroll;
      return this.querySelector(".workspace-repository-scope-actions > button") ? sizes.compactScroll : sizes.foldedScroll;
    }
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

function actionsRow(onFetch = vi.fn(), onPush = vi.fn(), onMergeDialog = vi.fn(), onCommit = vi.fn()) {
  return (
    <div className="scope-row">
      <RepositoryScopeActions
        label="inertia"
        commit={{ id: "commit", label: "Commit", icon: null, disabled: false, onSelect: onCommit }}
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
    expect(screen.queryByRole("button", { name: "More actions for inertia" })).toBeNull();
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

    fireEvent.click(screen.getByRole("button", { name: "More actions for inertia" }));
    const menu = screen.getByRole("menu", { name: "More actions for inertia" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent))
      .toEqual(["Fetch", "Pull", "Publish branch", "Confidence", "PR"]);
    expect(within(menu).getByRole("menuitem", { name: "Pull" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Pull" }));
    expect(screen.getByRole("menu", { name: "More actions for inertia" })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Fetch" }));
    expect(onFetch).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu", { name: "More actions for inertia" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More actions for inertia" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Confidence" }));
    expect(onMergeDialog).toHaveBeenCalledWith("confidence");

    sizes.rowClient = 700;
    act(() => resize?.());
    expect(screen.queryByRole("button", { name: "More actions for inertia" })).not.toBeNull();

    sizes.rowClient = 760;
    sizes.rowScroll = 760;
    act(() => resize?.());
    expect(within(group).getByRole("button", { name: "Fetch" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More actions for inertia" })).toBeNull();
    expect(screen.getByTestId("launcher")).toHaveTextContent("buttons");
  });

  it("folds Commit into More while the compact row still overflows, then restores it as the row widens", () => {
    sizes.rowScroll = 760;
    sizes.compactScroll = 560;
    const onCommit = vi.fn();
    render(actionsRow(vi.fn(), vi.fn(), vi.fn(), onCommit));
    const group = screen.getByLabelText("Actions for inertia");
    expect(within(group).queryByRole("button", { name: "Commit" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More actions for inertia" }));
    const menu = screen.getByRole("menu", { name: "More actions for inertia" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent))
      .toEqual(["Commit", "Fetch", "Pull", "Publish branch", "Confidence", "PR"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Commit" }));
    expect(onCommit).toHaveBeenCalledOnce();

    sizes.rowClient = 560;
    act(() => resize?.());
    expect(within(group).getByRole("button", { name: "Commit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More actions for inertia" })).toBeInTheDocument();

    sizes.rowClient = 760;
    act(() => resize?.());
    expect(within(group).getByRole("button", { name: "Fetch" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More actions for inertia" })).toBeNull();
  });

  it("reaches an unavailable collapsed action by arrow keys", () => {
    sizes.rowScroll = 760;
    render(actionsRow());
    fireEvent.click(screen.getByRole("button", { name: "More actions for inertia" }));
    const menu = screen.getByRole("menu", { name: "More actions for inertia" });
    const fetch = within(menu).getByRole("menuitem", { name: "Fetch" });
    fetch.focus();
    fireEvent.keyDown(fetch, { key: "ArrowDown" });
    expect(within(menu).getByRole("menuitem", { name: "Pull" })).toHaveFocus();
  });

  it("closes the More menu with one Escape while an item's tooltip shows", async () => {
    sizes.rowScroll = 760;
    render(actionsRow());
    fireEvent.click(screen.getByRole("button", { name: "More actions for inertia" }));
    const menu = screen.getByRole("menu", { name: "More actions for inertia" });
    const confidence = within(menu).getByRole("menuitem", { name: "Confidence" });
    confidence.focus();
    fireEvent.pointerEnter(confidence, { pointerType: "mouse" });
    await waitFor(() => expect(document.querySelector('[role="tooltip"]')).not.toBeNull());
    fireEvent.keyDown(confidence, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "More actions for inertia" })).toBeNull());
  });

  it("returns focus to the More trigger after a collapsed action runs", async () => {
    sizes.rowScroll = 760;
    const onFetch = vi.fn();
    render(actionsRow(onFetch));
    const trigger = screen.getByRole("button", { name: "More actions for inertia" });
    trigger.focus();
    fireEvent.click(trigger);
    const fetch = within(screen.getByRole("menu", { name: "More actions for inertia" }))
      .getByRole("menuitem", { name: "Fetch" });
    fetch.focus();
    fireEvent.click(fetch);
    expect(onFetch).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu", { name: "More actions for inertia" })).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("returns focus to the More trigger when a dialog opened from the collapsed menu closes", async () => {
    sizes.rowScroll = 760;
    function DialogRow(): React.JSX.Element {
      const [request, setRequest] = useState<MergeDialogRequest | null>(null);
      return (
        <div className="scope-row">
          <RepositoryScopeActions
            label="inertia"
            commit={{ id: "commit", label: "Commit", icon: null, disabled: false, onSelect: () => undefined }}
            actions={[]}
            confidence={{ disabled: false, title: "Compare" }}
            pullRequest={{ disabled: false }}
            onRequestMergeDialog={(kind) => setRequest((current) => ({ kind, id: (current?.id ?? 0) + 1 }))}
          >
            {(compact) => (
              <PreMergeConfidenceLauncher
                projectId="project"
                conversationId="conversation"
                repositoryPath="/repository"
                authorityRef="ref"
                forge="github"
                initialTitle="main"
                pullRequestBusy={false}
                pullRequestDisabled={false}
                run={() => new Promise(() => undefined)}
                buttons={!compact}
                openRequest={request}
              />
            )}
          </RepositoryScopeActions>
        </div>
      );
    }
    render(<DialogRow />);
    const trigger = screen.getByRole("button", { name: "More actions for inertia" });
    trigger.focus();
    fireEvent.click(trigger);
    const pullRequest = within(screen.getByRole("menu")).getByRole("menuitem", { name: "PR" });
    pullRequest.focus();
    fireEvent.click(pullRequest);
    const close = await screen.findByRole("button", { name: "Close pull request dialog" });
    await waitFor(() => expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull());

    fireEvent.click(close);

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("collapses when lazily loaded actions arrive after the row was measured", async () => {
    render(actionsRow());
    expect(screen.queryByRole("button", { name: "More actions for inertia" })).toBeNull();
    sizes.rowScroll = 760;
    await act(async () => {
      screen.getByLabelText("Actions for inertia").append(document.createElement("span"));
    });
    expect(screen.getByRole("button", { name: "More actions for inertia" })).toBeInTheDocument();
  });

  it("collapses when the stacked action line itself would overflow", () => {
    sizes.rowClient = 300;
    sizes.rowScroll = 300;
    sizes.actionsClient = 280;
    sizes.actionsScroll = 420;
    render(actionsRow());
    expect(screen.getByRole("button", { name: "More actions for inertia" })).toBeInTheDocument();
  });

  it("keeps the counts in the row name while the open action covers them", () => {
    const css = readFileSync("src/renderer/src/styles.css", "utf8");
    const rule = /\.workspace-repository-files > li:is\(:hover, :focus-within\) \.workspace-repository-file-stats \{(?<body>[^}]*)\}/u.exec(css)?.groups?.body ?? "";
    expect(rule).toContain("opacity: 0");
    expect(rule).not.toContain("visibility");
  });
});
