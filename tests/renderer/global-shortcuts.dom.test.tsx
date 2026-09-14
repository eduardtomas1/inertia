import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandPalette } from "../../src/renderer/src/components/CommandPalette";
import { useGlobalShortcuts } from "../../src/renderer/src/hooks/useGlobalShortcuts";
import { DEFAULT_APP_KEYBINDINGS } from "../../src/shared/keybindings";

afterEach(() => {
  vi.restoreAllMocks();
});

function ShortcutHarness({ onTerminalKeyUp }: {
  onTerminalKeyUp: () => void;
}): React.JSX.Element {
  const [paletteOpen, setPaletteOpen] = useState(false);
  useGlobalShortcuts({
    keybindings: DEFAULT_APP_KEYBINDINGS,
    createConversation: vi.fn(),
    mobileNavigation: false,
    suspended: false,
    setActiveTool: vi.fn(),
    setPaletteOpen,
    setSidebarCollapsed: vi.fn(),
    setSidebarOpen: vi.fn(),
  });
  return (
    <>
      <textarea
        aria-label="Terminal input"
        onKeyUp={(event) => {
          if (["Alt", "Control", "Meta", "Shift"].includes(event.key)) return;
          onTerminalKeyUp();
          event.currentTarget.focus();
        }}
      />
      <CommandPalette
        open={paletteOpen}
        projects={[]}
        conversations={[]}
        newThreadShortcut="Ctrl+N"
        onClose={() => setPaletteOpen(false)}
        onSelectProject={vi.fn()}
        onSelectConversation={vi.fn()}
        onNewThread={vi.fn()}
        onAddProject={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    </>
  );
}

function StableListenerHarness(): React.JSX.Element {
  const [count, setCount] = useState(0);
  useGlobalShortcuts({
    keybindings: DEFAULT_APP_KEYBINDINGS,
    createConversation: vi.fn(),
    mobileNavigation: false,
    suspended: false,
    setActiveTool: vi.fn(),
    setPaletteOpen: vi.fn(),
    setSidebarCollapsed: vi.fn(),
    setSidebarOpen: vi.fn(),
  });
  return (
    <button type="button" onClick={() => setCount((value) => value + 1)}>
      Unrelated update {count}
    </button>
  );
}

function ImmediateShortcutOwner({ createConversation }: {
  createConversation: () => void;
}): null {
  useGlobalShortcuts({
    keybindings: DEFAULT_APP_KEYBINDINGS,
    createConversation,
    mobileNavigation: false,
    suspended: false,
    setActiveTool: vi.fn(),
    setPaletteOpen: vi.fn(),
    setSidebarCollapsed: vi.fn(),
    setSidebarOpen: vi.fn(),
  });
  return null;
}

function ImmediateShortcutDispatch({ onDispatch }: {
  onDispatch: (owned: boolean) => void;
}): null {
  useLayoutEffect(() => {
    const event = new KeyboardEvent("keydown", {
      key: "n",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);
    onDispatch(event.defaultPrevented);
  }, [onDispatch]);
  return null;
}

function ImmediateNewChatHarness({
  createConversation,
  onDispatch,
}: {
  createConversation: () => void;
  onDispatch: (owned: boolean) => void;
}): React.JSX.Element {
  return (
    <>
      <ImmediateShortcutOwner createConversation={createConversation} />
      <ImmediateShortcutDispatch onDispatch={onDispatch} />
    </>
  );
}

function SuspendedShortcutHarness({
  createConversation,
  setActiveTool,
  setPaletteOpen,
  setSidebarCollapsed,
}: {
  createConversation: () => void;
  setActiveTool: () => void;
  setPaletteOpen: () => void;
  setSidebarCollapsed: () => void;
}): React.JSX.Element {
  useGlobalShortcuts({
    keybindings: DEFAULT_APP_KEYBINDINGS,
    createConversation,
    mobileNavigation: false,
    suspended: true,
    setActiveTool,
    setPaletteOpen,
    setSidebarCollapsed,
    setSidebarOpen: vi.fn(),
  });
  return <textarea aria-label="Duo prompt" />;
}

describe("global shortcut DOM integration", () => {
  it("owns new-chat events dispatched by a sibling layout effect on mount", () => {
    const createConversation = vi.fn();
    const onDispatch = vi.fn();

    render(
      <ImmediateNewChatHarness
        createConversation={createConversation}
        onDispatch={onDispatch}
      />,
    );

    expect(onDispatch).toHaveBeenCalledWith(true);
    expect(createConversation).toHaveBeenCalledTimes(1);
  });

  it("does not re-bind global listeners after an unrelated render", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const view = render(<StableListenerHarness />);
    const shortcutAdds = (): number => add.mock.calls.filter(
      ([name]) => name === "keydown" || name === "keyup",
    ).length;

    // The listener must exist in the mount commit. A deferred module load can
    // otherwise drop the first shortcut pressed immediately after a reload.
    expect(shortcutAdds()).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Unrelated update 0" }));
    expect(screen.getByRole("button", { name: "Unrelated update 1" }))
      .toBeInTheDocument();
    expect(shortcutAdds()).toBe(2);

    view.unmount();
    expect(remove.mock.calls.filter(
      ([name]) => name === "keydown" || name === "keyup",
    )).toHaveLength(2);
  });

  it("keeps palette input through the complete chord released from a terminal widget", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const terminalKeyUp = vi.fn();
    render(<ShortcutHarness onTerminalKeyUp={terminalKeyUp} />);
    await waitFor(() => expect(add.mock.calls.filter(
      ([name]) => name === "keydown" || name === "keyup",
    )).toHaveLength(2));
    const terminal = screen.getByRole("textbox", { name: "Terminal input" });
    terminal.focus();

    fireEvent.keyDown(terminal, { key: "k", ctrlKey: true });
    const search = screen.getByRole("combobox", {
      name: "Search commands, projects, chats, and messages",
    });
    expect(search).toHaveFocus();

    fireEvent.keyUp(terminal, { key: "Control" });
    fireEvent.keyUp(terminal, { key: "k" });

    expect(terminalKeyUp).not.toHaveBeenCalled();
    expect(search).toHaveFocus();

    fireEvent.change(search, { target: { value: "settings" } });
    expect(search).toHaveValue("settings");
    expect(screen.getByRole("option", { name: /Open settings/u }))
      .toHaveAttribute("aria-selected", "true");
  });

  it("consumes app shortcuts without acting while a modal owns focus", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const createConversation = vi.fn();
    const setActiveTool = vi.fn();
    const setPaletteOpen = vi.fn();
    const setSidebarCollapsed = vi.fn();
    render(
      <SuspendedShortcutHarness
        createConversation={createConversation}
        setActiveTool={setActiveTool}
        setPaletteOpen={setPaletteOpen}
        setSidebarCollapsed={setSidebarCollapsed}
      />,
    );
    await waitFor(() => expect(add.mock.calls.filter(
      ([name]) => name === "keydown" || name === "keyup",
    )).toHaveLength(2));
    const prompt = screen.getByRole("textbox", { name: "Duo prompt" });
    prompt.focus();

    for (const key of ["b", "j", "k", "n"]) {
      const event = new KeyboardEvent("keydown", {
        key,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      prompt.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      fireEvent.keyUp(prompt, { key, ctrlKey: true });
    }

    expect(createConversation).not.toHaveBeenCalled();
    expect(setActiveTool).not.toHaveBeenCalled();
    expect(setPaletteOpen).not.toHaveBeenCalled();
    expect(setSidebarCollapsed).not.toHaveBeenCalled();
  });

  it("does not run background shortcuts from inside the command palette", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const createConversation = vi.fn();
    const setActiveTool = vi.fn();
    const setPaletteOpen = vi.fn();
    const setSidebarCollapsed = vi.fn();

    function PaletteHarness(): React.JSX.Element {
      useGlobalShortcuts({
        keybindings: DEFAULT_APP_KEYBINDINGS,
        createConversation,
        mobileNavigation: false,
        suspended: false,
        setActiveTool,
        setPaletteOpen,
        setSidebarCollapsed,
        setSidebarOpen: vi.fn(),
      });
      return (
        <CommandPalette
          open
          projects={[]}
          conversations={[]}
          newThreadShortcut="Ctrl+N"
          onClose={vi.fn()}
          onSelectProject={vi.fn()}
          onSelectConversation={vi.fn()}
          onNewThread={vi.fn()}
          onAddProject={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      );
    }

    render(<PaletteHarness />);
    await waitFor(() => expect(add.mock.calls.filter(
      ([name]) => name === "keydown" || name === "keyup",
    )).toHaveLength(2));
    const search = screen.getByRole("combobox", {
      name: "Search commands, projects, chats, and messages",
    });
    for (const key of ["b", "j", "k", "n"]) {
      const event = new KeyboardEvent("keydown", {
        key,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      search.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    const escapedFocusEvent = new KeyboardEvent("keydown", {
      key: "n",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(escapedFocusEvent);
    expect(escapedFocusEvent.defaultPrevented).toBe(true);

    expect(createConversation).not.toHaveBeenCalled();
    expect(setActiveTool).not.toHaveBeenCalled();
    expect(setPaletteOpen).not.toHaveBeenCalled();
    expect(setSidebarCollapsed).not.toHaveBeenCalled();
  });
});

describe("terminal and platform shortcut ownership", () => {
  it.each(["k", "j", "b", "n"])("preserves terminal Control+%s", async (key) => {
    const { installGlobalShortcuts } = await import("../../src/renderer/src/utils/globalShortcuts");
    const invoke = vi.fn();
    const actions = { current: {
      keybindings: DEFAULT_APP_KEYBINDINGS, createConversation: invoke,
      mobileNavigation: false, suspended: false, setActiveTool: invoke,
      setPaletteOpen: invoke, setSidebarCollapsed: invoke, setSidebarOpen: invoke,
    } };
    render(<div className="xterm"><textarea aria-label="Shell input" /></div>);
    const dispose = installGlobalShortcuts(window, actions, "linux");
    try {
      const event = new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true });
      screen.getByRole("textbox", { name: "Shell input" }).dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(invoke).not.toHaveBeenCalled();
    } finally { dispose(); }
  });

  it("uses physical Command keys on macOS and preserves Cocoa Control chords", async () => {
    const { installGlobalShortcuts } = await import("../../src/renderer/src/utils/globalShortcuts");
    const invoke = vi.fn();
    const actions = { current: {
      keybindings: DEFAULT_APP_KEYBINDINGS, createConversation: invoke,
      mobileNavigation: false, suspended: false, setActiveTool: invoke,
      setPaletteOpen: invoke, setSidebarCollapsed: invoke, setSidebarOpen: invoke,
    } };
    const dispose = installGlobalShortcuts(window, actions, "darwin");
    try {
      const control = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true });
      window.dispatchEvent(control);
      expect(control.defaultPrevented).toBe(false);
      expect(invoke).not.toHaveBeenCalled();
      const command = new KeyboardEvent("keydown", { key: "л", code: "KeyK", metaKey: true, cancelable: true });
      window.dispatchEvent(command);
      expect(command.defaultPrevented).toBe(true);
      expect(invoke).toHaveBeenCalledOnce();
    } finally { dispose(); }
  });
});
