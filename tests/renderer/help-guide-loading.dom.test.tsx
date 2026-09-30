import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppNavigationOverlays } from "../../src/renderer/src/components/AppNavigationOverlays";
import { HelpGuideHost } from "../../src/renderer/src/components/HelpGuideHost";
import { WelcomeGuideHost } from "../../src/renderer/src/components/WelcomeGuideHost";
import { closeHelpGuide, helpGuideIsOpen, openHelpGuide } from "../../src/renderer/src/utils/helpGuide";
import {
  NATIVE_PREVIEW_OVERLAY_CLOSED,
  nativePreviewSuspended,
} from "../../src/renderer/src/utils/nativePreviewOverlay";
import {
  closeWelcomeGuide,
  openWelcomeGuide,
  WELCOME_GUIDE_STORAGE_KEY,
} from "../../src/renderer/src/utils/welcomeGuide";
import type { AppSnapshot, ServerEvent } from "../../src/shared/contracts";

const chunk = vi.hoisted(() => ({
  loaded: null as unknown,
  pending: [] as Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }>,
}));

vi.mock("../../src/renderer/src/components/lazySurfaceLoaders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/src/components/lazySurfaceLoaders")>();
  const loadWelcomeGuide = Object.assign(
    () => chunk.loaded
      ? Promise.resolve(chunk.loaded)
      : new Promise((resolve, reject) => {
        chunk.pending.push({ resolve, reject });
      }),
    { peek: () => chunk.loaded },
  );
  return { ...actual, loadWelcomeGuide };
});

async function finishChunk(): Promise<void> {
  const module = await import("../../src/renderer/src/components/welcome-guide/WelcomeGuide");
  chunk.loaded = module;
  await act(async () => {
    for (const request of chunk.pending.splice(0)) request.resolve(module);
  });
}

async function failChunk(): Promise<void> {
  await act(async () => {
    for (const request of chunk.pending.splice(0)) request.reject(new Error("chunk unavailable"));
  });
}

function hostProps() {
  return {
    shortcutLabel: () => "⌘K",
    commands: {
      "add-project": vi.fn(),
      search: vi.fn(),
      usage: vi.fn(),
      "daily-work": vi.fn(),
      "welcome-guide": vi.fn(),
    },
    onOpenSettings: vi.fn(),
    onLeave: vi.fn(),
    onLoadError: vi.fn(),
  };
}

function PaletteAndHelp({ props }: { props: ReturnType<typeof hostProps> }): React.JSX.Element {
  const [paletteOpen, setPaletteOpen] = useState(true);
  return (
    <>
      <AppNavigationOverlays
        snapshot={{ projects: [], conversations: [] } as unknown as AppSnapshot}
        paletteOpen={paletteOpen}
        paletteView="search"
        currentProjectId={null}
        newThreadShortcut="⌘N"
        setPaletteOpen={setPaletteOpen}
        setWorkspaceView={vi.fn()}
        selectProject={vi.fn()}
        selectConversation={vi.fn()}
        selectMessage={async () => false}
        sendCommand={() => new Promise<ServerEvent>(() => undefined)}
        createConversation={vi.fn()}
        createConversationIn={vi.fn()}
        importProject={async () => undefined}
        openSettings={vi.fn()}
      />
      <HelpGuideHost {...props} />
    </>
  );
}

let released = 0;
const countRelease = (): void => {
  released += 1;
};

beforeEach(() => {
  chunk.loaded = null;
  chunk.pending.length = 0;
  released = 0;
  window.addEventListener(NATIVE_PREVIEW_OVERLAY_CLOSED, countRelease);
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
});

afterEach(async () => {
  act(() => {
    closeHelpGuide();
    closeWelcomeGuide();
  });
  await waitFor(() => expect(nativePreviewSuspended()).toBe(false));
  window.removeEventListener(NATIVE_PREVIEW_OVERLAY_CLOSED, countRelease);
  window.localStorage.removeItem(WELCOME_GUIDE_STORAGE_KEY);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Help native preview suspension", () => {
  it("holds the preview from the palette request through a slow chunk until Help has fully closed", async () => {
    render(<PaletteAndHelp props={hostProps()} />);
    await screen.findByRole("combobox", { name: "Search commands, projects, chats, and messages" });
    expect(nativePreviewSuspended()).toBe(true);

    fireEvent.click(screen.getByRole("option", { name: /Open help/u }));

    expect(screen.queryByRole("dialog", { name: "Search Inertia" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Help" })).toBeNull();
    expect(nativePreviewSuspended()).toBe(true);
    expect(released).toBe(0);

    await finishChunk();
    const help = await screen.findByRole("dialog", { name: "Help" });
    expect(nativePreviewSuspended()).toBe(true);

    fireEvent.keyDown(help, { key: "Escape" });
    expect(helpGuideIsOpen()).toBe(false);
    expect(document.querySelector(".dialog-presence.is-closing .help-guide")).not.toBeNull();
    expect(nativePreviewSuspended()).toBe(true);
    expect(released).toBe(0);

    await waitFor(() => expect(document.querySelector(".help-guide")).toBeNull());
    await waitFor(() => expect(nativePreviewSuspended()).toBe(false));
    expect(released).toBe(1);
  });

  it("releases the preview and reports the failure when the Help chunk cannot load, then retries", async () => {
    const props = hostProps();
    render(<HelpGuideHost {...props} />);

    act(() => openHelpGuide());
    expect(nativePreviewSuspended()).toBe(true);
    await failChunk();

    expect(helpGuideIsOpen()).toBe(false);
    expect(props.onLoadError).toHaveBeenCalledWith("Help could not be loaded. Try again.");
    await waitFor(() => expect(nativePreviewSuspended()).toBe(false));
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => openHelpGuide());
    expect(nativePreviewSuspended()).toBe(true);
    await finishChunk();
    expect(await screen.findByRole("dialog", { name: "Help" })).toBeVisible();
    expect(props.onLoadError).toHaveBeenCalledOnce();
  });

  it("keeps one continuous hold across a rapid open, close and reopen while loading", async () => {
    render(<HelpGuideHost {...hostProps()} />);

    act(() => openHelpGuide());
    act(() => closeHelpGuide());
    act(() => openHelpGuide());
    expect(nativePreviewSuspended()).toBe(true);
    expect(released).toBe(0);

    await finishChunk();
    const help = await screen.findByRole("dialog", { name: "Help" });
    expect(screen.getByRole("tab", { name: "Getting started" })).toHaveAttribute("aria-selected", "true");
    expect(nativePreviewSuspended()).toBe(true);
    expect(released).toBe(0);

    fireEvent.keyDown(help, { key: "Escape" });
    await waitFor(() => expect(nativePreviewSuspended()).toBe(false));
    expect(released).toBe(1);
  });

  it("holds the preview while a replayed welcome guide loads", async () => {
    window.localStorage.setItem(WELCOME_GUIDE_STORAGE_KEY, "seen");
    render(
      <WelcomeGuideHost
        snapshot={{ projects: [{ id: "project" }], providers: [] } as unknown as AppSnapshot}
        blocked={false}
        existingProfile={false}
        shortcuts={[]}
        onOpenProviderSetup={vi.fn()}
        onAddProject={vi.fn()}
      />,
    );

    act(() => openWelcomeGuide());
    expect(nativePreviewSuspended()).toBe(true);
    await finishChunk();
    const guide = await screen.findByRole("dialog", { name: "Welcome guide" });
    fireEvent.keyDown(guide, { key: "Escape" });
    await waitFor(() => expect(nativePreviewSuspended()).toBe(false));
    expect(released).toBe(1);
  });
});
