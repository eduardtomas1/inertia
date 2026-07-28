import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandPalette } from "../../src/renderer/src/components/CommandPalette";
import { useGlobalShortcuts } from "../../src/renderer/src/hooks/useGlobalShortcuts";

afterEach(() => {
  vi.restoreAllMocks();
});

function ShortcutHarness({ onTerminalKeyUp }: {
  onTerminalKeyUp: () => void;
}): React.JSX.Element {
  const [paletteOpen, setPaletteOpen] = useState(false);
  useGlobalShortcuts({
    createConversation: vi.fn(),
    mobileNavigation: false,
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
    createConversation: vi.fn(),
    mobileNavigation: false,
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

describe("global shortcut DOM integration", () => {
  it("does not re-bind global listeners after an unrelated render", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const view = render(<StableListenerHarness />);
    const shortcutAdds = (): number => add.mock.calls.filter(
      ([name]) => name === "keydown" || name === "keyup",
    ).length;

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

  it("keeps palette input through the complete chord released from a terminal widget", () => {
    const terminalKeyUp = vi.fn();
    render(<ShortcutHarness onTerminalKeyUp={terminalKeyUp} />);
    const terminal = screen.getByRole("textbox", { name: "Terminal input" });
    terminal.focus();

    fireEvent.keyDown(terminal, { key: "k", ctrlKey: true });
    const search = screen.getByRole("combobox", {
      name: "Search commands, projects, and threads",
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
});
