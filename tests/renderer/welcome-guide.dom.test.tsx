import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WelcomeGuide } from "../../src/renderer/src/components/welcome-guide/WelcomeGuide";
import { WelcomeGuideHost } from "../../src/renderer/src/components/WelcomeGuideHost";
import {
  closeWelcomeGuide,
  openWelcomeGuide,
  WELCOME_GUIDE_STORAGE_KEY,
} from "../../src/renderer/src/utils/welcomeGuide";
import type { AppSnapshot, ProviderInfo } from "../../src/shared/contracts";

function provider(
  id: string,
  label: string,
  overrides: Partial<ProviderInfo> = {},
): ProviderInfo {
  return {
    id,
    label,
    command: id,
    available: true,
    version: "1.0.0",
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: null,
    models: [],
    rateLimits: [],
    ...overrides,
  } as unknown as ProviderInfo;
}

const providers = [
  provider("codex", "Codex"),
  provider("claude", "Claude", { canRun: false, authState: "unauthenticated" }),
  provider("gemini", "Gemini CLI", {
    canRun: false,
    installState: "not-installed",
    authState: "unknown",
  }),
];
const shortcuts = [
  { keys: "⌘K", label: "Search" },
  { keys: "⌘N", label: "New chat" },
];

function renderGuide() {
  const props = {
    providers,
    shortcuts,
    onClose: vi.fn(),
    onOpenProviderSetup: vi.fn(),
    onAddProject: vi.fn(),
  };
  return { ...props, ...render(<WelcomeGuide {...props} />) };
}

function snapshot(projectCount: number): AppSnapshot {
  return {
    projects: Array.from({ length: projectCount }, (_, index) => ({ id: `project-${index}` })),
    providers,
  } as unknown as AppSnapshot;
}

function hostProps(overrides: Partial<Parameters<typeof WelcomeGuideHost>[0]> = {}) {
  return {
    snapshot: snapshot(0),
    blocked: false,
    existingProfile: false,
    shortcuts,
    onOpenProviderSetup: vi.fn(),
    onAddProject: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.removeItem(WELCOME_GUIDE_STORAGE_KEY);
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
});

afterEach(() => {
  act(() => closeWelcomeGuide());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WelcomeGuide", () => {
  it("walks the four steps with labelled next actions and a progress readout", () => {
    const guide = renderGuide();
    const dialog = screen.getByRole("dialog", { name: "Welcome guide" });
    const progress = screen.getByRole("progressbar", { name: "Guide progress" });

    expect(within(dialog).getByRole("heading", { name: "Welcome to Inertia" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Take the tour" })).toHaveFocus();
    expect(progress).toHaveAttribute("aria-valuetext", "Step 1 of 4: Welcome");

    fireEvent.click(screen.getByRole("button", { name: "Take the tour" }));
    expect(screen.getByRole("heading", { name: "How it works" })).toBeVisible();
    expect(progress).toHaveAttribute("aria-valuenow", "2");
    expect(screen.getByRole("button", { name: "Connect an agent" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Welcome to Inertia" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Take the tour" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect an agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "You're ready to start" })).toBeVisible();
    expect(screen.getByText("1 agent is ready. Add a project to open your first chat.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Start using Inertia" }));
    expect(guide.onClose).toHaveBeenCalledOnce();
  });

  it("moves with the arrow keys, advances on Enter and closes on Escape", () => {
    const guide = renderGuide();
    fireEvent.keyDown(screen.getByRole("button", { name: "Take the tour" }), { key: "ArrowRight" });
    expect(screen.getByRole("heading", { name: "How it works" })).toBeVisible();

    fireEvent.keyDown(screen.getByRole("button", { name: "Connect an agent" }), { key: "ArrowLeft" });
    expect(screen.getByRole("heading", { name: "Welcome to Inertia" })).toBeVisible();

    const dialog = screen.getByRole("dialog", { name: "Welcome guide" });
    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(screen.getByRole("heading", { name: "How it works" })).toBeVisible();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(guide.onClose).toHaveBeenCalledOnce();
  });

  it("switches tour topics with up and down without leaving the step", () => {
    renderGuide();
    fireEvent.click(screen.getByRole("button", { name: "Take the tour" }));
    const first = screen.getByRole("tab", { name: "Chat with context" });
    expect(first).toHaveAttribute("aria-selected", "true");

    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const split = screen.getByRole("tab", { name: "Work side by side" });
    expect(split).toHaveAttribute("aria-selected", "true");
    expect(split).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Open two chats in split view");

    fireEvent.keyDown(split, { key: "ArrowRight" });
    expect(screen.getByRole("heading", { name: "How it works" })).toBeVisible();

    fireEvent.keyDown(split, { key: "ArrowUp" });
    fireEvent.keyDown(screen.getByRole("tab", { name: "Chat with context" }), { key: "ArrowUp" });
    expect(screen.getByRole("tab", { name: "Usage and limits" })).toHaveAttribute("aria-selected", "true");
    expect(within(screen.getByRole("list", { name: "Keyboard shortcuts" })).getByText("⌘K"))
      .toBeVisible();
  });

  it("shows each agent's readiness and routes setup to its provider", () => {
    const guide = renderGuide();
    fireEvent.click(screen.getByRole("button", { name: "Take the tour" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect an agent" }));

    const agents = within(screen.getByRole("list", { name: "Agents on this computer" }))
      .getAllByRole("listitem");
    expect(agents.map((agent) => agent.textContent)).toEqual([
      "CodexReady",
      "ClaudeSign in neededSet up",
      "Gemini CLINot installedSet up",
    ]);
    expect(screen.getByText(/1 of 3 ready/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Set up Claude" }));
    expect(guide.onOpenProviderSetup).toHaveBeenCalledWith("claude");
  });

  it("opens project import from the last step", () => {
    const guide = renderGuide();
    for (const name of ["Take the tour", "Connect an agent", "Continue"]) {
      fireEvent.click(screen.getByRole("button", { name }));
    }
    fireEvent.click(screen.getByRole("button", { name: /Add a project/ }));
    expect(guide.onAddProject).toHaveBeenCalledOnce();
  });

  it("traps focus inside the dialog and restores it when closed", () => {
    const outside = document.createElement("button");
    outside.textContent = "Before";
    document.body.append(outside);
    outside.focus();
    vi.spyOn(HTMLElement.prototype, "getClientRects")
      .mockReturnValue([{}] as unknown as DOMRectList);

    const guide = renderGuide();
    const primary = screen.getByRole("button", { name: "Take the tour" });
    expect(primary).toHaveFocus();
    fireEvent.keyDown(primary, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Skip" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("button", { name: "Skip" }), { key: "Tab", shiftKey: true });
    expect(primary).toHaveFocus();

    guide.unmount();
    expect(outside).toHaveFocus();
    outside.remove();
  });
});

describe("WelcomeGuideHost", () => {
  it("opens once on a fresh install and remembers Skip", async () => {
    const props = hostProps();
    const view = render(<WelcomeGuideHost {...props} />);
    const dialog = await screen.findByRole("dialog", { name: "Welcome guide" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Skip" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(window.localStorage.getItem(WELCOME_GUIDE_STORAGE_KEY)).not.toBeNull();
    view.rerender(<WelcomeGuideHost {...props} snapshot={snapshot(0)} blocked />);
    view.rerender(<WelcomeGuideHost {...props} snapshot={snapshot(0)} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays out of the way for existing and recovered profiles", async () => {
    const view = render(<WelcomeGuideHost {...hostProps({ snapshot: null })} />);
    expect(window.localStorage.getItem(WELCOME_GUIDE_STORAGE_KEY)).toBeNull();

    view.rerender(<WelcomeGuideHost {...hostProps({ snapshot: snapshot(2) })} />);
    expect(window.localStorage.getItem(WELCOME_GUIDE_STORAGE_KEY)).not.toBeNull();

    window.localStorage.removeItem(WELCOME_GUIDE_STORAGE_KEY);
    view.rerender(<WelcomeGuideHost {...hostProps({ existingProfile: true })} />);
    expect(window.localStorage.getItem(WELCOME_GUIDE_STORAGE_KEY)).not.toBeNull();
    await act(async () => undefined);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("waits for other startup dialogs before opening", async () => {
    const view = render(<WelcomeGuideHost {...hostProps({ blocked: true })} />);
    await act(async () => undefined);
    expect(screen.queryByRole("dialog")).toBeNull();

    view.rerender(<WelcomeGuideHost {...hostProps()} />);
    expect(await screen.findByRole("dialog", { name: "Welcome guide" })).toBeVisible();
  });

  it("replays from settings and closes into provider setup", async () => {
    window.localStorage.setItem(WELCOME_GUIDE_STORAGE_KEY, "seen");
    const props = hostProps({ snapshot: snapshot(1) });
    render(<WelcomeGuideHost {...props} />);
    await act(async () => undefined);
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => openWelcomeGuide());
    await screen.findByRole("dialog", { name: "Welcome guide" });
    fireEvent.click(screen.getByRole("button", { name: "Take the tour" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect an agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Set up Claude" }));

    expect(props.onOpenProviderSetup).toHaveBeenCalledWith("claude");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
