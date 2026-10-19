import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Composer } from "../../src/renderer/src/components/Composer";
import { CheckoutBranchControlProvider } from "../../src/renderer/src/components/CheckoutBranchControl";
import { composerCheckoutStrip } from "../../src/renderer/src/components/composer/ComposerToolbar";
import type { GitStatusSnapshot, Project } from "../../src/shared/contracts";
import { readSourceText } from "../helpers/source-text";
import { composerProps, conversation } from "./composer-fixtures";

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

function gitStatus(branch: string | null): GitStatusSnapshot {
  return { isRepository: true, root: "/work/studio", branch } as GitStatusSnapshot;
}

function checkoutModel(branch: string | null) {
  return {
    project,
    conversation: null,
    gitStatus: gitStatus(branch),
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

afterEach(() => {
  window.localStorage.clear();
});

describe("composer shell", () => {
  it("says Message in a chat without messages and Follow up once it has history", () => {
    const current = conversation("placeholder-chat");
    const view = render(<Composer {...composerProps(current)} />);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute("placeholder", "Message");
    view.rerender(<Composer {...composerProps(current, { hasVisibleHistory: true })} />);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute("placeholder", "Follow up");
    view.rerender(<Composer {...composerProps(current, { hasVisibleHistory: true, running: true })} />);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute("placeholder", "Enter sends · Tab queues");
  });

  it("shows the branch as one quiet line and the checkout context only when it differs", async () => {
    const base = {
      showCheckoutContext: true,
      scratchWorkspace: false,
      newChatProjectPicker: false,
      worktreePath: null,
      repository: true,
    };
    expect(composerCheckoutStrip(base)).toBe("branch");
    expect(composerCheckoutStrip({ ...base, repository: false })).toBe("hidden");
    expect(composerCheckoutStrip({ ...base, worktreePath: "/work/studio-worktree" })).toBe("context");
    expect(composerCheckoutStrip({ ...base, scratchWorkspace: true })).toBe("hidden");
    expect(composerCheckoutStrip({ ...base, scratchWorkspace: true, newChatProjectPicker: true })).toBe("context");
    expect(composerCheckoutStrip({ ...base, showCheckoutContext: false, worktreePath: "/work/x" })).toBe("hidden");

    const current = conversation("checkout-chat");
    const view = render(
      <CheckoutBranchControlProvider value={checkoutModel("main")}>
        <Composer {...composerProps(current)} />
      </CheckoutBranchControlProvider>,
    );
    const quiet = screen.getByRole("group", { name: "Chat checkout context" });
    expect(quiet).toHaveClass("is-branch-only");
    expect(quiet).not.toHaveTextContent("Current checkout");
    fireEvent.click(await within(quiet).findByRole("button", { name: "Branch main" }));
    expect(within(quiet).getByRole("button", { name: "Branch main" })).toHaveAttribute("aria-expanded", "true");
    view.rerender(
      <CheckoutBranchControlProvider value={{ ...checkoutModel("feature/other"), conversation: current }}>
        <Composer {...composerProps(current)} />
      </CheckoutBranchControlProvider>,
    );
    const differing = screen.getByRole("group", { name: "Chat checkout context" });
    expect(differing).toHaveClass("is-branch-only");
    expect(await within(differing).findByRole("button", { name: "Checkout context differs, current branch main" }))
      .toHaveTextContent("Current checkout · main");
    expect(differing.textContent?.match(/Current checkout/gu)).toHaveLength(1);
    view.rerender(
      <CheckoutBranchControlProvider value={checkoutModel("main")}>
        <Composer {...composerProps({ ...current, worktreePath: "/work/studio-worktree" })} />
      </CheckoutBranchControlProvider>,
    );
    expect(screen.getByRole("group", { name: "Chat checkout context" })).toHaveTextContent(/^Isolated worktree/u);
    view.rerender(
      <CheckoutBranchControlProvider value={{ ...checkoutModel("main"), gitStatus: { isRepository: false } as GitStatusSnapshot }}>
        <Composer {...composerProps(current)} />
      </CheckoutBranchControlProvider>,
    );
    expect(screen.queryByRole("group", { name: "Chat checkout context" })).toBeNull();
  });

  it("keeps attach, model, mode, usage, and send in view and puts the rest behind More tools", async () => {
    const view = render(<Composer {...composerProps(conversation("tools-chat"))} />);
    const controls = screen.getByRole("group", { name: "Composer controls" });
    const toggle = within(controls).getByRole("button", { name: "More tools" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(controls).getByRole("button", { name: /^Attach/u })).toBeVisible();
    expect(within(controls).getByRole("button", { name: /^Choose model/u })).toBeVisible();
    expect(within(controls).getByRole("button", { name: "Send message" })).toBeVisible();
    const tray = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(tray).not.toBeVisible();
    expect(within(tray).getByRole("group", { name: "Add context", hidden: true })).toBeInTheDocument();
    expect(within(controls).getByRole("group", { name: "Usage" })).toBeVisible();
    expect(tray.contains(within(controls).getByRole("group", { name: "Usage" }))).toBe(false);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(tray).toBeVisible();
    expect(toggle.nextElementSibling).toBe(tray);
    await waitFor(() => expect(within(tray).getByRole("button", { name: /^Prompt presets/u })).toBeVisible());
    view.unmount();

    render(<Composer {...composerProps(conversation("tools-chat-again"))} />);
    expect(screen.getByRole("button", { name: "More tools" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "More tools" }));
    expect(window.localStorage.getItem("inertia:composer-tools:v1")).toBe("closed");
  });

  it("opens and closes More tools in every mounted composer and follows other windows", () => {
    window.localStorage.setItem("inertia:composer-tools:v1", "closed");
    render(
      <>
        <section aria-label="First pane"><Composer {...composerProps(conversation("tools-first-pane"))} /></section>
        <section aria-label="Second pane"><Composer {...composerProps(conversation("tools-second-pane"))} /></section>
      </>,
    );
    const toggle = (pane: string) => within(screen.getByRole("region", { name: pane })).getByRole("button", { name: "More tools" });
    expect(toggle("Second pane")).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle("First pane"));
    expect(toggle("First pane")).toHaveAttribute("aria-expanded", "true");
    expect(toggle("Second pane")).toHaveAttribute("aria-expanded", "true");

    act(() => {
      window.localStorage.setItem("inertia:composer-tools:v1", "closed");
      window.dispatchEvent(new StorageEvent("storage", { key: "inertia:composer-tools:v1", newValue: "closed" }));
    });
    expect(toggle("First pane")).toHaveAttribute("aria-expanded", "false");
    expect(toggle("Second pane")).toHaveAttribute("aria-expanded", "false");
  });

  it("still opens and closes More tools when the preference cannot be saved", () => {
    window.localStorage.setItem("inertia:composer-tools:v1", "closed");
    const write = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is read-only", "SecurityError");
    });
    render(<Composer {...composerProps(conversation("tools-unsaved"))} />);
    const toggle = screen.getByRole("button", { name: "More tools" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    write.mockRestore();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(window.localStorage.getItem("inertia:composer-tools:v1")).toBe("closed");
  });

  it("keeps the open tray at its full width and lets it take the options' place only when both cannot fit", () => {
    const css = readSourceText("src/renderer/src/components/composer/ComposerSurface.css");
    const tray = css.slice(css.indexOf(".composer-shell .composer-more-tools {"), css.indexOf("}", css.indexOf(".composer-shell .composer-more-tools {")));
    expect(tray).toContain("flex: 0 0 auto;");
    expect(tray).not.toContain("min-width: 0");
    expect(css).toContain("@container (max-width: 820px) {\n  .composer-shell .composer-options {\n    min-width: var(--composer-control-height);\n  }");
    expect(css).toContain('@container (max-width: 320px) {\n  .composer-shell .composer-primary-rail:has(> .composer-tools-toggle[aria-expanded="true"]) > .composer-options {\n    display: none;\n  }');
    expect(css).toContain(".composer-shell .composer-primary-rail:not(:has(.prompt-presets-control, .prompt-stash-control)) > :is(.composer-tools-toggle, .composer-more-tools) {\n    display: none;\n  }");
  });

  it("offers no More tools toggle when the composer has no extra tools", () => {
    render(<Composer {...composerProps(conversation("no-tools-chat"), { promptPresetsEnabled: false, promptStashEnabled: false })} />);
    expect(screen.queryByRole("button", { name: "More tools" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send message" })).toBeVisible();
  });

  it("keeps the usage ring at the right end of the rail with or without More tools", () => {
    const style = document.createElement("style");
    style.textContent = readSourceText("src/renderer/src/components/composer/ComposerSurface.css");
    document.head.append(style);
    const view = render(<Composer {...composerProps(conversation("ring-with-tools"))} />);
    const marginLeft = (name: string) => getComputedStyle(
      name === "Usage" ? screen.getByRole("group", { name }) : screen.getByRole("button", { name }),
    ).marginLeft;
    expect(marginLeft("More tools")).toBe("auto");
    expect(marginLeft("Usage")).not.toBe("auto");
    view.unmount();

    render(<Composer {...composerProps(conversation("ring-without-tools"), { promptPresetsEnabled: false, promptStashEnabled: false })} />);
    expect(screen.queryByRole("button", { name: "More tools" })).toBeNull();
    expect(marginLeft("Usage")).toBe("auto");
    style.remove();
  });

  it("attaches a queued message to the composer as its own row with a visible Send now action", async () => {
    const current = conversation("queued-chat");
    window.localStorage.setItem(
      `inertia:queued-prompts:v2:${current.id}`,
      JSON.stringify([{ id: "queued-1", content: "Run the release checks", createdAt: "2026-08-21T10:00:00.000Z", attachments: [] }]),
    );
    render(<Composer {...composerProps(current, { running: true })} />);
    const queue = await screen.findByRole("list", { name: "Queued messages" }, { timeout: 5_000 });
    const composer = screen.getByRole("region", { name: "Message composer" });
    expect(queue.parentElement).toBe(composer);
    expect(composer.querySelector(".composer-queue-slot")).toBeNull();
    const row = within(queue).getByRole("listitem");
    expect(row.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(row.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(row).toHaveTextContent(/^Run the release checksQueuedSend now$/u);
    expect(within(queue).getByRole("button", { name: "Send queued message now" })).toHaveTextContent("Send now");
    expect(within(queue).getByRole("button", { name: "Remove queued message" })).toHaveTextContent("");
  });

  it.each([
    ["codex-app-server", true],
    ["claude-agent-sdk", true],
    ["kimi-acp", false],
  ] as const)("offers Send now on a queued message during a %s turn with an empty composer: %s", async (harnessId, enabled) => {
    const current = conversation(`queued-${harnessId}`);
    window.localStorage.setItem(
      `inertia:queued-prompts:v2:${current.id}`,
      JSON.stringify([{ id: "queued-1", content: "Look at this too", createdAt: "2026-08-21T10:00:00.000Z", attachments: [] }]),
    );
    const latestTurn = {
      ...({} as NonNullable<React.ComponentProps<typeof Composer>["latestTurn"]>),
      id: "turn-running",
      status: "running" as const,
      harnessId,
    };
    render(<Composer {...composerProps(current, { running: true, latestTurn })} />);
    const queue = await screen.findByRole("list", { name: "Queued messages" }, { timeout: 5_000 });
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
    const sendNow = within(queue).getByRole("button", { name: "Send queued message now" });
    if (enabled) expect(sendNow).toBeEnabled();
    else expect(sendNow).toBeDisabled();
  });
});
