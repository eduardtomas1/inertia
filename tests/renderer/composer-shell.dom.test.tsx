import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Composer } from "../../src/renderer/src/components/Composer";
import { CheckoutBranchControlProvider } from "../../src/renderer/src/components/CheckoutBranchControl";
import { composerCheckoutStripVisible } from "../../src/renderer/src/components/composer/ComposerToolbar";
import type { GitStatusSnapshot, Project } from "../../src/shared/contracts";
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

  it("shows the checkout strip only when the checkout differs from the project's own", () => {
    const base = {
      showCheckoutContext: true,
      scratchWorkspace: false,
      newChatProjectPicker: false,
      worktreePath: null,
      checkoutDiffers: false,
    };
    expect(composerCheckoutStripVisible(base)).toBe(false);
    expect(composerCheckoutStripVisible({ ...base, worktreePath: "/work/studio-worktree" })).toBe(true);
    expect(composerCheckoutStripVisible({ ...base, checkoutDiffers: true })).toBe(true);
    expect(composerCheckoutStripVisible({ ...base, scratchWorkspace: true, checkoutDiffers: true })).toBe(false);
    expect(composerCheckoutStripVisible({ ...base, scratchWorkspace: true, newChatProjectPicker: true })).toBe(true);
    expect(composerCheckoutStripVisible({ ...base, showCheckoutContext: false, worktreePath: "/work/x" })).toBe(false);

    const current = conversation("checkout-chat");
    const view = render(
      <CheckoutBranchControlProvider value={checkoutModel("main")}>
        <Composer {...composerProps(current)} />
      </CheckoutBranchControlProvider>,
    );
    expect(screen.queryByRole("group", { name: "Chat checkout context" })).toBeNull();
    view.rerender(
      <CheckoutBranchControlProvider value={checkoutModel("feature/other")}>
        <Composer {...composerProps(current)} />
      </CheckoutBranchControlProvider>,
    );
    expect(screen.getByRole("group", { name: "Chat checkout context" })).toHaveTextContent(/^Current checkout/u);
    view.rerender(
      <CheckoutBranchControlProvider value={checkoutModel("main")}>
        <Composer {...composerProps({ ...current, worktreePath: "/work/studio-worktree" })} />
      </CheckoutBranchControlProvider>,
    );
    expect(screen.getByRole("group", { name: "Chat checkout context" })).toHaveTextContent(/^Isolated worktree/u);
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
    await waitFor(() => expect(within(tray).getByRole("button", { name: /^Prompt presets/u })).toBeVisible());
    view.unmount();

    render(<Composer {...composerProps(conversation("tools-chat-again"))} />);
    expect(screen.getByRole("button", { name: "More tools" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "More tools" }));
    expect(window.localStorage.getItem("inertia:composer-tools:v1")).toBe("closed");
  });

  it("renders queued messages as plain rows at the top of the composer", async () => {
    const current = conversation("queued-chat");
    window.localStorage.setItem(
      `inertia:queued-prompts:v2:${current.id}`,
      JSON.stringify([{ id: "queued-1", content: "Run the release checks", createdAt: "2026-08-21T10:00:00.000Z", attachments: [] }]),
    );
    render(<Composer {...composerProps(current, { running: true })} />);
    const queue = await screen.findByRole("list", { name: "Queued messages" }, { timeout: 5_000 });
    const composer = screen.getByRole("region", { name: "Message composer" });
    expect(queue.parentElement).toHaveClass("composer-queue-slot");
    expect(queue.parentElement?.parentElement).toBe(composer);
    expect(queue.compareDocumentPosition(screen.getByRole("textbox", { name: "Message" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(queue).getByRole("listitem")).toHaveTextContent(/^Run the release checksQueued$/u);
    expect(within(queue).getByRole("button", { name: "Send queued message now" })).toHaveTextContent("");
    expect(within(queue).getByRole("button", { name: "Remove queued message" })).toHaveTextContent("");
  });
});
