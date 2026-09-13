import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppNavigationOverlays } from "../../src/renderer/src/components/AppNavigationOverlays";
import { useConversationNavigation } from "../../src/renderer/src/hooks/useConversationNavigation";
import { useDiagnosticNavigation } from "../../src/renderer/src/hooks/useDiagnosticNavigation";
import { useProjectChatNavigation } from "../../src/renderer/src/hooks/useProjectChatNavigation";
import { navigateDiagnosticContext } from "../../src/renderer/src/utils/diagnosticNavigation";
import type { AppView } from "../../src/renderer/src/appView";
import type { AppSnapshot, ServerEvent } from "../../src/shared/contracts";
import { conversation, deferred } from "./composer-fixtures";

const primary = conversation("11111111-1111-4111-8111-111111111111");
const affected = { ...conversation("22222222-2222-4222-8222-222222222222"), title: "Affected thread" };
const ok: ServerEvent = { type: "request.ok", requestId: "navigation" };

function setup({ palette = false, detached = false, online = true, available = true } = {}) {
  const focused = deferred<boolean>();
  const focus = vi.fn(() => focused.promise);
  const select = vi.fn(async () => ok);
  const error = vi.fn();
  function Harness() {
    const [view, setView] = useState<AppView>("settings");
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [paletteOpen, setPaletteOpen] = useState(palette);
    const [section, setSection] = useState("diagnostics");
    const generation = useRef(0);
    const transitions = useRef(0);
    const projectNavigation = useProjectChatNavigation({
      project: null, projects: [], busyAction: null,
      draftConversation: {
        changeProject: vi.fn(), discard: vi.fn(), clear: vi.fn(), start: vi.fn(),
        importProject: async () => false, sendFromComposer: async () => null,
      },
      selectionCommandQueue: select, conversationSelectionGenerationRef: generation,
      startupSurface: "summary", showStartupSurface: vi.fn(), updateSplitConversationId: vi.fn(),
      setSidebarOpen, setView,
    });
    const snapshot = { projects: [], conversations: available ? [primary, affected] : [primary] } as unknown as AppSnapshot;
    const navigation = useConversationNavigation({
      snapshot, conversation: primary, splitConversation: null,
      detachedChats: { ready: true, windows: [], conversationIds: new Set(detached ? [affected.id] : []), atLimit: false, focus, open: vi.fn() },
      exitGlobalChat: projectNavigation.exitGlobalChat,
      conversationSelectionGenerationRef: generation, splitSelectionTransitionsRef: transitions,
      setSuppressedMainConversationIds: vi.fn(), setSecondaryPaneFirst: vi.fn(),
      selectConversationCommand: select, updateSplitConversationId: vi.fn(), request: select, setActionError: error,
    });
    useDiagnosticNavigation(
      snapshot.conversations, online, navigation.selectConversation,
      () => { setView("workspace"); setSidebarOpen(false); },
      (target) => { setSection(target.section); projectNavigation.navigateToView("settings"); },
      error,
    );
    return <>
      <output aria-label="Current view">{view}</output><output aria-label="Settings section">{section}</output>
      {sidebarOpen && <aside aria-label="Sidebar" />}
      <button onClick={() => projectNavigation.navigateToView("settings")}>Later settings navigation</button>
      <AppNavigationOverlays snapshot={snapshot} paletteOpen={paletteOpen} setPaletteOpen={setPaletteOpen}
        newThreadShortcut="⌘N" setWorkspaceView={() => projectNavigation.navigateToView("workspace")}
        selectConversation={navigation.selectConversation}
        selectMessage={(hit, signal) => navigation.selectMessage(hit, () => setView("workspace"), signal)}
        sendCommand={select} selectProject={vi.fn()} createConversation={vi.fn()}
        importProject={async () => undefined} openSettings={vi.fn()} />
    </>;
  }
  return { ...render(<Harness />), focused, focus, select, error };
}

describe("diagnostic and thread navigation", () => {
  it("reveals the affected conversation from Diagnostics and closes the sidebar", async () => {
    const h = setup();
    await act(async () => { navigateDiagnosticContext({ conversationId: affected.id }); });
    expect(screen.getByLabelText("Current view")).toHaveTextContent("workspace");
    expect(screen.queryByRole("complementary", { name: "Sidebar" })).toBeNull();
    expect(h.select).toHaveBeenCalledExactlyOnceWith("conversation.select", affected.id, undefined);
    expect(h.error).not.toHaveBeenCalled();
  });

  it.each([{ online: false }, { available: false }])("keeps unavailable diagnostic context readable (%j)", async (options) => {
    const h = setup(options);
    await act(async () => { navigateDiagnosticContext({ conversationId: affected.id }); });
    expect(screen.getByLabelText("Current view")).toHaveTextContent("settings");
    expect(h.select).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledWith(expect.stringContaining("diagnostic record is still readable"));
  });

  it("keeps settings links working and removes the navigation listener on unmount", async () => {
    const h = setup();
    await act(async () => { navigateDiagnosticContext({ section: "discord" }); });
    expect(screen.getByLabelText("Settings section")).toHaveTextContent("discord");
    expect(screen.getByLabelText("Current view")).toHaveTextContent("settings");
    h.unmount();
    await act(async () => { navigateDiagnosticContext({ conversationId: affected.id }); });
    expect(h.select).not.toHaveBeenCalled();
  });

  it.each(["closed", "focused", "superseded"])("preserves palette detached focus intent when the window is %s", async (outcome) => {
    const h = setup({ palette: true, detached: true });
    fireEvent.click(await screen.findByRole("option", { name: "Affected thread Thread" }));
    expect(h.focus).toHaveBeenCalledExactlyOnceWith(affected.id);
    expect(h.select).not.toHaveBeenCalled();
    if (outcome === "superseded") fireEvent.click(screen.getByRole("button", { name: "Later settings navigation" }));
    await act(async () => { h.focused.resolve(outcome === "focused"); });
    if (outcome === "closed") expect(h.select).toHaveBeenCalledExactlyOnceWith("conversation.select", affected.id, undefined);
    else expect(h.select).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Current view")).toHaveTextContent(outcome === "superseded" ? "settings" : "workspace");
  });
});
