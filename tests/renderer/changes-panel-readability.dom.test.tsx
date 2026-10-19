import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ChangesPanel, type ChangesPanelProps } from "../../src/renderer/src/components/ChangesPanel";
import { diffViewModeStorageKey } from "../../src/renderer/src/hooks/useDiffViewMode";
import type { ChangedFile, DiffReviewState } from "../../src/shared/contracts";
import { diffLineText } from "../helpers/diff-line-text";

const path = "src/page.ts";
const file: ChangedFile = {
  path, status: "modified", insertions: 2, deletions: 1, untracked: false,
  staged: false, unstaged: true, indexStatus: ".", worktreeStatus: "M",
};
const patch = [
  `diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`,
  "@@ -1,3 +1,4 @@",
  " const page = 1;",
  '-const html = "<script>alert(1)</script>";',
  '+const html = "<script>alert(2)</script>";',
  " export { html };",
  "+const extra = page;",
  "",
].join("\n");
const scope = "project-1:chat-1";

let width = 1_000;
class TestResizeObserver implements ResizeObserver {
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

beforeEach(() => {
  width = 1_000;
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
    x: 0, y: 0, width, height: 600, top: 0, left: 0, right: width, bottom: 600, toJSON: () => ({}),
  }));
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function Panel(props: Partial<ChangesPanelProps> & { patchText?: string }): React.JSX.Element {
  const [reviewStates, setReviewStates] = useState<DiffReviewState[]>([]);
  const { patchText = patch, ...rest } = props;
  return (
    <ChangesPanel
      files={[file]}
      diff={{ patch: patchText, truncated: false, files: [file] }}
      selectedPath={path}
      summary={null}
      reviewStates={reviewStates}
      diffLayoutScope={scope}
      onSelectFile={vi.fn()}
      onAsk={vi.fn(async () => undefined)}
      onRequestRevision={vi.fn(async () => undefined)}
      onRevert={vi.fn(async () => undefined)}
      onSetReviewState={async (state) => {
        setReviewStates((current) => [...current.filter((item) => item.hunkId !== state.hunkId), {
          ...state, conversationId: "chat-1", stale: false, updatedAt: "2026-10-19T10:00:00.000Z",
        }]);
      }}
      onCreateNote={vi.fn(async () => undefined)}
      onUpdateNote={vi.fn(async () => undefined)}
      onDeleteNote={vi.fn(async () => undefined)}
      onAddTextToPrompt={vi.fn()}
      onAddToPrompt={vi.fn()}
      {...rest}
    />
  );
}

const diffRegion = () => screen.getByRole("region", { name: `Diff content for ${path}` });
const layoutGroup = () => screen.getByRole("group", { name: /^Diff layout/u });

it("highlights diff lines through escaped markup and marks intraline changes", async () => {
  const view = render(<Panel />);
  const added = await screen.findByText(diffLineText('const html = "<script>alert(2)</script>";'));
  expect(view.container.querySelector("script")).toBeNull();
  expect(added).toHaveClass("hljs");
  expect(added.querySelector(".hljs-keyword")).toHaveTextContent("const");
  expect(added.innerHTML).toContain("&lt;script&gt;");
  expect(within(added).getByText("2", { selector: "mark.diff-intraline" })).toBeInTheDocument();
  const removed = screen.getByText(diffLineText('const html = "<script>alert(1)</script>";'));
  expect(removed.querySelector("mark.diff-intraline")).toHaveTextContent("1");
  // An unpaired addition has no emphasis.
  expect(screen.getByText(diffLineText("const extra = page;")).querySelector("mark")).toBeNull();
});

it("renders plain text without highlighting for over-long lines", async () => {
  const long = `const big = "${"<b>".repeat(700)}";`;
  const view = render(<Panel patchText={patch.replace("+const extra = page;", `+${long}`)} />);
  const line = await screen.findByText(diffLineText(long));
  expect(line).not.toHaveClass("hljs");
  expect(view.container.querySelector("b")).toBeNull();
  expect(screen.getByText(diffLineText('const html = "<script>alert(2)</script>";'))).not.toHaveClass("hljs");
});

it("persists a keyboard-reachable Unified | Split toggle per chat", async () => {
  const user = userEvent.setup();
  const view = render(<Panel />);
  await screen.findByText(diffLineText("const extra = page;"));
  const unified = within(layoutGroup()).getByRole("button", { name: "Unified" });
  const split = within(layoutGroup()).getByRole("button", { name: "Split" });
  expect(unified).toHaveAttribute("aria-pressed", "true");
  expect(diffRegion()).not.toHaveClass("is-split");

  unified.focus();
  await user.tab();
  expect(split).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(split).toHaveAttribute("aria-pressed", "true");
  expect(diffRegion()).toHaveClass("is-split");
  expect(window.localStorage.getItem(diffViewModeStorageKey(scope))).toBe("split");
  expect(view.container.querySelectorAll(".diff-split-row")).toHaveLength(4);
  expect(view.container.querySelectorAll(".diff-split-placeholder")).toHaveLength(1);

  view.unmount();
  const restored = render(<Panel />);
  await screen.findAllByText(diffLineText("const extra = page;"));
  expect(diffRegion()).toHaveClass("is-split");
  restored.unmount();

  render(<Panel diffLayoutScope="project-1:chat-2" />);
  await screen.findByText(diffLineText("const extra = page;"));
  expect(diffRegion()).not.toHaveClass("is-split");
  await user.click(within(layoutGroup()).getByRole("button", { name: "Split" }));
  await user.click(within(layoutGroup()).getByRole("button", { name: "Unified" }));
  expect(window.localStorage.getItem(diffViewModeStorageKey("project-1:chat-2"))).toBeNull();
  expect(window.localStorage.getItem(diffViewModeStorageKey(scope))).toBe("split");
});

it("falls back to unified in narrow panels with the reason in the toggle label", async () => {
  width = 600;
  window.localStorage.setItem(diffViewModeStorageKey(scope), "split");
  render(<Panel />);
  await screen.findByText(diffLineText("const extra = page;"));
  expect(layoutGroup()).toHaveAccessibleName("Diff layout: split view needs a panel at least 720 pixels wide");
  expect(within(layoutGroup()).getByRole("button", { name: "Split" })).toBeDisabled();
  expect(within(layoutGroup()).getByRole("button", { name: "Unified" })).toHaveAttribute("aria-pressed", "true");
  expect(diffRegion()).not.toHaveClass("is-split");
  expect(window.localStorage.getItem(diffViewModeStorageKey(scope))).toBe("split");
});

it("keeps selection, the popover, review marks and hunk navigation working in split view", async () => {
  window.localStorage.setItem(diffViewModeStorageKey(scope), "split");
  const onAddToPrompt = vi.fn();
  const scrolled = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => undefined);
  const view = render(<Panel onAddToPrompt={onAddToPrompt} />);
  await screen.findByText(diffLineText("const extra = page;"));
  expect(diffRegion()).toHaveClass("is-split");

  const deletion = view.container.querySelector<HTMLButtonElement>('.diff-line.is-deletion[data-side="old"]')!;
  const addition = view.container.querySelector<HTMLButtonElement>('.diff-line.is-addition[data-side="new"]')!;
  fireEvent.click(deletion);
  fireEvent.keyDown(addition, { key: "Enter", shiftKey: true });
  expect(view.container.querySelectorAll(".diff-line.is-selected")).toHaveLength(2);
  const popovers = view.container.querySelectorAll(".diff-selection-popover");
  expect(popovers).toHaveLength(1);
  for (const action of ["Ask about", "Request revision", "Revert", "Note", "Add to prompt"]) {
    expect(within(popovers[0] as HTMLElement).getByRole("button", { name: action })).toBeInTheDocument();
  }
  fireEvent.click(within(popovers[0] as HTMLElement).getByRole("button", { name: "Add to prompt" }));
  expect(onAddToPrompt).toHaveBeenCalledTimes(1);
  expect(onAddToPrompt.mock.calls[0]![0].lineIds).toHaveLength(2);
  expect(onAddToPrompt.mock.calls[0]![0].reference).toContain("alert(2)");

  // A context row is a single control even though both columns show it.
  expect(screen.getAllByRole("button", { name: /const page = 1/u })).toHaveLength(1);
  expect(view.container.querySelectorAll('.diff-split-context .diff-split-half[data-side="new"][aria-hidden="true"]')).toHaveLength(2);

  fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
  await waitFor(() => expect(screen.getByText("1/1")).toBeInTheDocument());
  expect(diffRegion()).toHaveClass("is-split");

  fireEvent.keyDown(diffRegion(), { key: "n" });
  await waitFor(() => expect(scrolled).toHaveBeenCalled());
});

it("collapses the file list to a Files strip in split view and restores it in unified", async () => {
  const user = userEvent.setup();
  const readme: ChangedFile = { ...file, path: "README.md", insertions: 1, deletions: 1 };
  const twoFilePatch = [
    patch.trimEnd(),
    "diff --git a/README.md b/README.md", "--- a/README.md", "+++ b/README.md",
    "@@ -1 +1 @@", "-intro before", "+intro after", "",
  ].join("\n");
  function TwoFiles(): React.JSX.Element {
    const [selected, setSelected] = useState(path);
    return <Panel files={[file, readme]} patchText={twoFilePatch} selectedPath={selected} onSelectFile={setSelected} />;
  }
  render(<TwoFiles />);
  await screen.findByText(diffLineText("const extra = page;"));
  expect(screen.getByRole("navigation", { name: "Changed files" })).toBeInTheDocument();

  await user.click(within(layoutGroup()).getByRole("button", { name: "Split" }));
  expect(screen.queryByRole("navigation", { name: "Changed files" })).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "Changed file" })).not.toBeInTheDocument();
  const toggle = screen.getByRole("button", { name: "Files (2)" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(document.querySelector(".changes-split-files-current")).toHaveTextContent("page.tssrc");

  toggle.focus();
  await user.keyboard("{Enter}");
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  const list = screen.getByRole("navigation", { name: "Changed files" });
  expect(list.closest(".changes-split-files-overlay")).toHaveAttribute("id", toggle.getAttribute("aria-controls"));
  await user.tab();
  expect(list).toContainElement(document.activeElement as HTMLElement);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("navigation", { name: "Changed files" })).not.toBeInTheDocument();
  expect(toggle).toHaveFocus();

  await user.click(toggle);
  const readmeButton = within(screen.getByRole("navigation", { name: "Changed files" })).getByRole("button", { name: /README\.md/u });
  readmeButton.focus();
  await user.keyboard("{Enter}");
  await screen.findAllByText(diffLineText("intro after"));
  expect(screen.queryByRole("navigation", { name: "Changed files" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Files (2)" })).toHaveFocus();

  await user.click(within(layoutGroup()).getByRole("button", { name: "Unified" }));
  expect(screen.getByRole("navigation", { name: "Changed files" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Files (2)" })).not.toBeInTheDocument();
  expect(window.localStorage.length).toBe(0);
});

it("scrolls each split column sideways without wrapping", async () => {
  window.localStorage.setItem(diffViewModeStorageKey(scope), "split");
  const view = render(<Panel />);
  await screen.findByText(diffLineText("const extra = page;"));
  const old = screen.getByRole("group", { name: "Scroll original lines sideways" });
  const changed = screen.getByRole("group", { name: "Scroll changed lines sideways" });
  expect(old).toHaveAttribute("tabindex", "0");
  expect((old.firstElementChild as HTMLElement).style.width).toBe("calc(41ch + 14px)");
  expect((changed.firstElementChild as HTMLElement).style.width).toBe("calc(41ch + 14px)");
  old.scrollLeft = 30;
  fireEvent.scroll(old);
  const body = view.container.querySelector<HTMLElement>(".diff-split-body")!;
  expect(body.style.getPropertyValue("--diff-scroll-old")).toBe("30px");
  expect(body.style.getPropertyValue("--diff-scroll-new")).toBe("");
});
