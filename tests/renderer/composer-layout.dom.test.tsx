import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Composer } from "../../src/renderer/src/components/Composer";
import { CheckoutBranchControlProvider } from "../../src/renderer/src/components/CheckoutBranchControl";
import { composerCheckoutStrip } from "../../src/renderer/src/components/composer/ComposerToolbar";
import {
  COMPOSER_FOLD_ORDER,
  composerFoldOrder,
  nextComposerFoldCount,
} from "../../src/renderer/src/components/composer/useComposerChipFolding";
import type { GitStatusSnapshot, Project, ProviderInfo } from "../../src/shared/contracts";
import { MAX_CHAT_MESSAGE_CHARS } from "../../src/shared/diff-review";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { composerProps, conversation, routedProvider } from "./composer-fixtures";
import { simulateComposerLayout, type SimulatedComposerLayout } from "./composer-fold-layout";

const project: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Studio",
  path: "/work/studio",
  normalizedPath: "/work/studio",
  repositoryIdentity: "git:/work/studio/.git",
  repositoryRoot: "/work/studio",
  repositoryRelativePath: ".",
  groupingMode: null,
  gitRepositoryLimit: 16,
  color: "#5661d8",
  status: "ready",
  createdAt: "2026-07-29T08:00:00.000Z",
  updatedAt: "2026-07-29T08:00:00.000Z",
};

const settingsProvider: ProviderInfo = {
  ...routedProvider,
  models: [{
    id: "agent",
    label: "Routed Agent",
    description: "",
    isDefault: true,
    inputModalities: ["text"],
    reasoningOptions: [
      { value: "medium", label: "Medium", description: "Balanced" },
      { value: "high", label: "High", description: "Deeper" },
    ],
    defaultReasoningEffort: "medium",
    fastMode: { providerValue: "priority", label: "Fast", description: "Faster replies", isDefault: false },
  }],
};

function checkoutModel(branch: string | null) {
  return {
    project,
    conversation: null,
    gitStatus: { isRepository: true, root: "/work/studio", branch } as GitStatusSnapshot,
    branches: [],
    busy: false,
    onRefreshBranches: () => undefined,
    onSwitchBranch: () => undefined,
    onCreateBranch: () => undefined,
    onCreateConversationOnBranch: () => undefined,
    onCreateConversationInWorktree: () => undefined,
    onCreateConversationInIsolatedWorktree: () => undefined,
  };
}

function settingsConversation(id: string) {
  return {
    ...conversation(id),
    modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "agent", reasoningEffort: "high" }),
    reasoningEffort: "high",
  };
}

function renderWithBranch(id: string, branch = "main"): ReturnType<typeof render> {
  return render(
    <CheckoutBranchControlProvider value={checkoutModel(branch)}>
      <Composer {...composerProps(settingsConversation(id), { providers: [settingsProvider], promptPresetsEnabled: false, promptStashEnabled: false })} />
    </CheckoutBranchControlProvider>,
  );
}

const foldedChips = (): string[] => [...document.querySelectorAll<HTMLElement>('[data-folded="true"]')]
  .map((element) => element.dataset.composerFold ?? "");

let layout: SimulatedComposerLayout | null = null;

afterEach(() => {
  layout?.restore();
  layout = null;
  window.localStorage.clear();
});

describe("composer layout", () => {
  it("shows the checkout as the last chip of the left group, with everything the footer showed", async () => {
    const base = { showCheckoutContext: true, scratchWorkspace: false, newChatProjectPicker: false, worktreePath: null, repository: true };
    expect(composerCheckoutStrip(base)).toBe("branch");
    expect(composerCheckoutStrip({ ...base, repository: false })).toBe("hidden");
    expect(composerCheckoutStrip({ ...base, worktreePath: "/work/studio-worktree" })).toBe("context");
    expect(composerCheckoutStrip({ ...base, scratchWorkspace: true })).toBe("hidden");
    expect(composerCheckoutStrip({ ...base, scratchWorkspace: true, newChatProjectPicker: true })).toBe("context");
    expect(composerCheckoutStrip({ ...base, showCheckoutContext: false, worktreePath: "/work/x" })).toBe("hidden");

    const current = settingsConversation("checkout-chip");
    const props = composerProps(current, { providers: [settingsProvider] });
    const view = render(
      <CheckoutBranchControlProvider value={checkoutModel("main")}>
        <Composer {...props} />
      </CheckoutBranchControlProvider>,
    );
    const options = screen.getByRole("group", { name: "Model and run settings" });
    const checkout = within(options).getByRole("group", { name: "Chat checkout context" });
    expect(checkout).toHaveAttribute("data-checkout-context", "branch");
    expect(screen.queryByRole("group", { name: "Composer controls" })?.querySelectorAll(".composer-checkout-strip")).toHaveLength(0);
    const groups = [...options.children].filter((child) => child.matches('[role="group"]'));
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(["Composer settings", "Chat checkout context"]);
    const branch = await within(checkout).findByRole("button", { name: "Branch main" }, { timeout: 5_000 });
    expect(branch).toHaveTextContent(/^main$/u);
    expect(branch).toHaveAttribute("title", "main");
    expect(branch).toHaveClass("composer-chip");
    expect(branch.querySelector(".composer-setting-icon")).toHaveAttribute("width", "16");
    expect(branch.querySelector(".composer-setting-icon")).toHaveClass("lucide-git-branch");
    expect(branch.querySelector(".composer-setting-chevron")).toHaveAttribute("width", "12");
    fireEvent.click(branch);
    expect(branch).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("menu", { name: "Branches" }, { timeout: 5_000 })).toBeInTheDocument();
    fireEvent.click(branch);

    const longName = "feature/composer-two-row-layout";
    view.rerender(
      <CheckoutBranchControlProvider value={checkoutModel(longName)}>
        <Composer {...composerProps({ ...current, branch: longName }, { providers: [settingsProvider] })} />
      </CheckoutBranchControlProvider>,
    );
    const long = await screen.findByRole("button", { name: `Branch ${longName}` });
    expect(long.textContent).toHaveLength(16);
    expect(long).toHaveTextContent(/^feature…w-layout$/u);
    expect(long).toHaveAttribute("title", longName);

    view.rerender(
      <CheckoutBranchControlProvider value={{ ...checkoutModel("feature/other"), conversation: current }}>
        <Composer {...props} />
      </CheckoutBranchControlProvider>,
    );
    expect(await screen.findByRole("button", { name: "Checkout context differs, current branch main" }))
      .toHaveTextContent("Current checkout · main");

    view.rerender(
      <CheckoutBranchControlProvider value={checkoutModel("main")}>
        <Composer {...composerProps({ ...current, worktreePath: "/work/studio-worktree" }, { providers: [settingsProvider] })} />
      </CheckoutBranchControlProvider>,
    );
    const isolated = await screen.findByRole("button", { name: "Branch main" }, { timeout: 5_000 });
    expect(screen.getByRole("group", { name: "Chat checkout context" })).toHaveAttribute("data-checkout-context", "context");
    expect(isolated).toHaveAttribute("aria-description", "Isolated worktree");
    expect(isolated).toHaveAttribute("title", "Isolated worktree · main");
    expect(isolated.querySelector(".composer-setting-icon")).toHaveClass("lucide-folder-git-2");

    view.rerender(
      <CheckoutBranchControlProvider value={checkoutModel(null)}>
        <Composer {...props} />
      </CheckoutBranchControlProvider>,
    );
    const detached = await screen.findByRole("button", { name: "Detached HEAD, create or check out a branch" });
    expect(detached).toHaveTextContent("Detached HEAD · Create branch");
    expect(detached).toHaveClass("is-detached");
    expect(detached.querySelector(".composer-setting-icon")).toHaveClass("lucide-triangle-alert");

    view.rerender(
      <CheckoutBranchControlProvider value={{ ...checkoutModel("main"), gitStatus: { isRepository: false } as GitStatusSnapshot }}>
        <Composer {...props} />
      </CheckoutBranchControlProvider>,
    );
    expect(screen.queryByRole("group", { name: "Chat checkout context" })).toBeNull();
  });

  it("keeps the new chat project picker beside the branch chip", async () => {
    const current = settingsConversation("new-chat-picker");
    render(
      <CheckoutBranchControlProvider value={checkoutModel("main")}>
        <Composer {...composerProps(current, {
          providers: [settingsProvider],
          newChatProjectPicker: { projects: [project], selectedProject: project, disabled: false, onChange: () => undefined },
        })} />
      </CheckoutBranchControlProvider>,
    );
    const checkout = screen.getByRole("group", { name: "Chat checkout context" });
    const picker = within(checkout).getByRole("button", { name: "Project" });
    expect(picker).toHaveClass("composer-chip");
    expect(picker).toHaveTextContent("Studio");
    expect(picker.querySelector(".composer-setting-chevron")).toHaveAttribute("width", "12");
    const branch = await within(checkout).findByRole("button", { name: "Branch main" }, { timeout: 5_000 });
    expect(picker.compareDocumentPosition(branch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("puts the ring, More tools, Attach and Send on the right, in that order, after every chip", () => {
    render(<Composer {...composerProps(settingsConversation("right-cluster"), { providers: [settingsProvider] })} />);
    const toolbar = screen.getByRole("group", { name: "Composer controls" });
    const options = within(toolbar).getByRole("group", { name: "Model and run settings" });
    const attach = within(toolbar).getByRole("button", { name: "Attach images, documents, or spreadsheets" });
    expect(options.contains(attach)).toBe(false);
    expect(attach.closest('[role="group"]')).toHaveAttribute("aria-label", "Attach");
    const sequence = [
      within(toolbar).getByRole("button", { name: /^Choose model/u }),
      within(toolbar).getByRole("button", { name: /^Choose project access/u }),
      within(toolbar).getByRole("button", { name: /^Choose work mode/u }),
      within(toolbar).getByRole("group", { name: "Usage" }),
      within(toolbar).getByRole("button", { name: "More tools" }),
      attach,
      within(toolbar).getByRole("button", { name: "Send message" }),
    ];
    for (let index = 1; index < sequence.length; index += 1) {
      expect(sequence[index - 1]!.compareDocumentPosition(sequence[index]!) & Node.DOCUMENT_POSITION_FOLLOWING, String(index)).toBeTruthy();
    }
    expect(attach.querySelector("svg")).toHaveAttribute("width", "16");
    expect(toolbar.querySelectorAll(":scope > *")).toHaveLength(2);
  });

  it("keeps Send as an accent disc that focuses the message while the draft is empty, disables it while sending is blocked, and shows Stop while running", () => {
    const sent: string[] = [];
    const current = settingsConversation("send-at-rest");
    const view = render(<Composer {...composerProps(current, {
      providers: [settingsProvider],
      onSend: async (content) => { sent.push(content); },
    })} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toHaveAttribute("data-composer-action-state", "send-disabled");
    expect(send).toHaveAttribute("aria-disabled", "true");
    expect(send).not.toBeDisabled();
    expect(send).toHaveClass("send-button");
    expect(send).not.toHaveClass("stop-button");
    input.blur();
    expect(input).not.toHaveFocus();
    fireEvent.click(send);
    expect(input).toHaveFocus();
    expect(sent).toEqual([]);

    fireEvent.change(input, { target: { value: "Ship it" } });
    expect(screen.getByRole("button", { name: "Send message" })).not.toHaveAttribute("aria-disabled");
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Send message" })).toHaveAttribute("aria-disabled", "true");

    fireEvent.change(input, { target: { value: "x".repeat(MAX_CHAT_MESSAGE_CHARS + 1) } });
    const oversized = screen.getByRole("button", { name: "Send message" });
    expect(oversized).toBeDisabled();
    expect(oversized).not.toHaveAttribute("aria-disabled");
    fireEvent.change(input, { target: { value: "" } });

    view.rerender(<Composer {...composerProps(current, { providers: [settingsProvider], disabled: true })} />);
    const unavailable = screen.getByRole("button", { name: "Send message" });
    expect(unavailable).toBeDisabled();
    expect(unavailable).not.toHaveAttribute("aria-disabled");
    view.rerender(<Composer {...composerProps(current, { providers: [settingsProvider] })} />);
    expect(screen.getByRole("button", { name: "Send message" })).toHaveAttribute("aria-disabled", "true");

    view.rerender(<Composer {...composerProps({ ...current, status: "running" }, { providers: [settingsProvider], running: true })} />);
    const stop = screen.getByRole("button", { name: "Stop agent" });
    expect(stop).toHaveAttribute("data-composer-action-state", "stop-ready");
    expect(stop).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
  });

  it("folds the branch first, then mode, access, speed and reasoning into More as the composer narrows", async () => {
    layout = simulateComposerLayout(1_000);
    renderWithBranch("fold-order");
    await screen.findByRole("button", { name: "Branch main" }, { timeout: 5_000 });
    expect(foldedChips()).toEqual([]);
    expect(document.querySelector(".composer-more-control")).not.toHaveAttribute("data-overflow");

    const expectations: Array<[number, string[]]> = [
      [600, ["branch"]],
      [520, ["mode", "branch"]],
      [420, ["access", "mode", "branch"]],
      [300, ["speed", "access", "mode", "branch"]],
      [200, ["reasoning", "speed", "access", "mode", "branch"]],
    ];
    for (const [width, expected] of expectations) {
      layout.setAvailableWidth(width);
      expect(foldedChips().sort(), String(width)).toEqual([...expected].sort());
      expect(document.querySelector(".composer-more-control"), String(width)).toHaveAttribute("data-overflow", "true");
    }
    expect(document.querySelector(".composer-options")).toHaveAttribute("data-fold-exhausted", "true");

    fireEvent.click(screen.getByRole("button", { name: "More composer options" }));
    const more = screen.getByRole("menu", { name: "More composer options" });
    expect(within(more).getAllByRole("menuitem").map((row) => row.textContent)).toEqual([
      "ReasoningHigh",
      "Response speedStandard",
      "ModeBuild",
      "AccessSupervised",
      "Branchmain",
    ]);
    fireEvent.keyDown(more, { key: "Escape" });

    layout.setAvailableWidth(520);
    expect(foldedChips().sort()).toEqual(["branch", "mode"]);
    fireEvent.click(screen.getByRole("button", { name: "More composer options" }));
    expect(within(screen.getByRole("menu", { name: "More composer options" })).getAllByRole("menuitem").map((row) => row.textContent))
      .toEqual(["ModeBuild", "Branchmain"]);
    fireEvent.keyDown(screen.getByRole("menu", { name: "More composer options" }), { key: "Escape" });

    layout.setAvailableWidth(1_000);
    expect(foldedChips()).toEqual([]);
    expect(document.querySelector(".composer-more-control")).not.toHaveAttribute("data-overflow");
  });

  it("folds a branch that needs attention last and marks More when it folds anyway", async () => {
    expect(composerFoldOrder([])).toEqual(COMPOSER_FOLD_ORDER);
    expect(composerFoldOrder(["branch"])).toEqual(["mode", "access", "speed", "reasoning", "branch"]);

    layout = simulateComposerLayout(1_000);
    const current = settingsConversation("fold-attention");
    const props = composerProps(current, { providers: [settingsProvider], promptPresetsEnabled: false, promptStashEnabled: false });
    const view = render(
      <CheckoutBranchControlProvider value={{ ...checkoutModel("feature/other"), conversation: current }}>
        <Composer {...props} />
      </CheckoutBranchControlProvider>,
    );
    const chip = await screen.findByRole("button", { name: "Checkout context differs, current branch main" });
    expect(chip).toHaveAttribute("data-attention", "true");
    expect(foldedChips()).toEqual([]);

    const expectations: Array<[number, string[]]> = [
      [600, ["mode"]],
      [520, ["mode", "access"]],
      [420, ["mode", "access", "speed"]],
      [300, ["mode", "access", "speed", "reasoning"]],
    ];
    for (const [width, expected] of expectations) {
      layout.setAvailableWidth(width);
      expect(foldedChips().sort(), String(width)).toEqual([...expected].sort());
      const more = screen.getByRole("button", { name: "More composer options" });
      expect(more, String(width)).not.toHaveAttribute("data-attention");
    }

    layout.setAvailableWidth(200);
    expect(foldedChips().sort()).toEqual([...COMPOSER_FOLD_ORDER].sort());
    const marked = screen.getByRole("button", { name: "More composer options, Checkout context differs" });
    expect(marked).toHaveAttribute("data-attention", "true");
    fireEvent.click(marked);
    expect(within(screen.getByRole("menu", { name: "More composer options" })).getAllByRole("menuitem").map((row) => row.textContent))
      .toEqual(["ReasoningHigh", "Response speedStandard", "ModeBuild", "AccessSupervised", "BranchCurrent checkout · main"]);
    fireEvent.keyDown(screen.getByRole("menu", { name: "More composer options" }), { key: "Escape" });

    view.rerender(
      <CheckoutBranchControlProvider value={checkoutModel(null)}>
        <Composer {...props} />
      </CheckoutBranchControlProvider>,
    );
    expect(await screen.findByRole("button", { name: "Detached HEAD, create or check out a branch", hidden: true }))
      .toHaveAttribute("data-attention", "true");
    await waitFor(() => expect(screen.getByRole("button", { name: "More composer options, Detached HEAD" }))
      .toHaveAttribute("data-attention", "true"));

    view.rerender(
      <CheckoutBranchControlProvider value={checkoutModel("main")}>
        <Composer {...props} />
      </CheckoutBranchControlProvider>,
    );
    expect(await screen.findByRole("button", { name: "Branch main", hidden: true }, { timeout: 5_000 })).not.toHaveAttribute("data-attention");
    layout.setAvailableWidth(600);
    expect(foldedChips()).toEqual(["branch"]);
    expect(screen.getByRole("button", { name: "More composer options" })).not.toHaveAttribute("data-attention");
  });

  it("unfolds the chips once a status beside them gives its space back", async () => {
    layout = simulateComposerLayout(700);
    let finishChoosing: (() => void) | null = null;
    render(
      <CheckoutBranchControlProvider value={checkoutModel("main")}>
        <Composer {...composerProps(settingsConversation("status-space"), {
          providers: [settingsProvider],
          promptPresetsEnabled: false,
          promptStashEnabled: false,
          onChooseAttachments: () => new Promise((resolve) => { finishChoosing = () => resolve(null); }),
        })} />
      </CheckoutBranchControlProvider>,
    );
    await screen.findByRole("button", { name: "Branch main" }, { timeout: 5_000 });
    expect(foldedChips()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Attach images, documents, or spreadsheets" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Adding attachments…");
    layout.setAvailableWidth(700);
    expect(foldedChips().sort()).toEqual(["branch", "mode"]);

    finishChoosing!();
    await waitFor(() => expect(screen.queryByText("Adding attachments…")).toBeNull());
    await waitFor(() => expect(foldedChips()).toEqual([]));
  });

  it("keeps every chip in place while a setting menu that overflows the row is open", async () => {
    layout = simulateComposerLayout(700);
    renderWithBranch("open-menu-overflow");
    await screen.findByRole("button", { name: "Branch main" }, { timeout: 5_000 });
    expect(foldedChips()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /^Choose work mode/u }));
    const menu = screen.getByRole("menu", { name: "Work mode" });
    await waitFor(() => expect(document.querySelector(".composer-popover")).not.toBeNull());
    layout.setAvailableWidth(700);
    expect(foldedChips()).toEqual([]);
    expect(menu).toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "Work mode" })).toBe(menu);
  });

  it("opens the same branch menu from More once the branch chip has folded", async () => {
    layout = simulateComposerLayout(600);
    renderWithBranch("folded-branch");
    await screen.findByRole("button", { name: "Branch main" }, { timeout: 5_000 });
    await waitFor(() => expect(foldedChips()).toEqual(["branch"]));
    const more = screen.getByRole("button", { name: "More composer options" });
    fireEvent.click(more);
    fireEvent.click(within(screen.getByRole("menu", { name: "More composer options" })).getByRole("menuitem", { name: /^Branch/u }));
    expect(screen.queryByRole("menu", { name: "More composer options" })).toBeNull();
    const branches = await screen.findByRole("menu", { name: "Branches" }, { timeout: 5_000 });
    expect(screen.getByRole("button", { name: "Branch main", hidden: true })).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(branches.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Branches" })).toBeNull());
    await waitFor(() => expect(more).toHaveFocus());

    fireEvent.click(more);
    fireEvent.keyDown(within(screen.getByRole("menu", { name: "More composer options" })).getByRole("menuitem", { name: /^Branch/u }), { key: "ArrowRight" });
    expect(screen.queryByRole("menu", { name: "More composer options" })).toBeNull();
    expect(await screen.findByRole("menu", { name: "Branches" }, { timeout: 5_000 })).toBeInTheDocument();
  });

  it("closes Branches opened from More when More is pressed again, so only one menu is open", async () => {
    layout = simulateComposerLayout(600);
    renderWithBranch("borrowed-anchor");
    await screen.findByRole("button", { name: "Branch main" }, { timeout: 5_000 });
    await waitFor(() => expect(foldedChips()).toEqual(["branch"]));
    const more = screen.getByRole("button", { name: "More composer options" });
    fireEvent.click(more);
    fireEvent.click(within(screen.getByRole("menu", { name: "More composer options" })).getByRole("menuitem", { name: /^Branch/u }));
    await screen.findByRole("menu", { name: "Branches" }, { timeout: 5_000 });

    fireEvent.pointerDown(more);
    fireEvent.click(more);
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Branches" })).toBeNull());
    expect(screen.getByRole("menu", { name: "More composer options" })).toBeInTheDocument();
    expect(more).toHaveAttribute("aria-expanded", "true");
  });

  it("closes More once nothing is folded and moves focus off a chip that folds", async () => {
    layout = simulateComposerLayout(600);
    renderWithBranch("fold-focus");
    await screen.findByRole("button", { name: "Branch main" }, { timeout: 5_000 });
    await waitFor(() => expect(foldedChips()).toEqual(["branch"]));
    fireEvent.click(screen.getByRole("button", { name: "More composer options" }));
    within(screen.getByRole("menu", { name: "More composer options" })).getAllByRole("menuitem")[0]!.focus();

    layout.setAvailableWidth(1_000);
    expect(foldedChips()).toEqual([]);
    await waitFor(() => expect(screen.queryByRole("menu", { name: "More composer options" })).toBeNull());
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();

    const mode = screen.getByRole("button", { name: /^Choose work mode/u });
    mode.focus();
    layout.setAvailableWidth(520);
    expect(foldedChips().sort()).toEqual(["branch", "mode"]);
    await waitFor(() => expect(screen.getByRole("button", { name: "More composer options" })).toHaveFocus());
  });

  it("decides each fold from the spill, the free space and the remembered chip widths", () => {
    const widths = new Map([["branch", 90], ["mode", 80]] as const);
    const present = COMPOSER_FOLD_ORDER;
    expect(present).toEqual(["branch", "mode", "access", "speed", "reasoning"]);
    const measure = { present, widths, gap: 12, freedWhenUnfolded: 0 };
    expect(nextComposerFoldCount({ ...measure, folded: 0, spill: 0, slack: 0 })).toBe(0);
    expect(nextComposerFoldCount({ ...measure, folded: 0, spill: 4, slack: 0 })).toBe(1);
    expect(nextComposerFoldCount({ ...measure, folded: 5, spill: 4, slack: 0 })).toBe(5);
    expect(nextComposerFoldCount({ ...measure, folded: 2, spill: 0, slack: 93 })).toBe(1);
    expect(nextComposerFoldCount({ ...measure, folded: 2, spill: 0, slack: 92.5 })).toBe(2);
    expect(nextComposerFoldCount({ ...measure, folded: 1, spill: 0, slack: 60 })).toBe(1);
    expect(nextComposerFoldCount({ ...measure, folded: 1, spill: 0, slack: 60, freedWhenUnfolded: 40 })).toBe(1);
    expect(nextComposerFoldCount({ ...measure, folded: 1, spill: 0, slack: 60, freedWhenUnfolded: 43 })).toBe(0);
    expect(nextComposerFoldCount({ ...measure, folded: 3, spill: 0, slack: 500 })).toBe(3);
  });
});
