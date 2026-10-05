import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandPalette } from "../../src/renderer/src/components/CommandPalette";
import { HelpGuideHost } from "../../src/renderer/src/components/HelpGuideHost";
import { SidebarHelpButton } from "../../src/renderer/src/components/sidebar/SidebarHelpButton";
import { HELP_TOPICS } from "../../src/renderer/src/components/welcome-guide/helpTopics";
import { closeHelpGuide, helpGuideIsOpen } from "../../src/renderer/src/utils/helpGuide";
import {
  closeWelcomeGuide,
  WELCOME_GUIDE_STORAGE_KEY,
  welcomeGuideIsOpen,
} from "../../src/renderer/src/utils/welcomeGuide";

function hostProps() {
  return {
    shortcutLabel: vi.fn((action: string) => `Ctrl+${action.toUpperCase()}`),
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

function renderWithSidebarButton(props = hostProps()) {
  const view = render(
    <>
      <button type="button">Before</button>
      <SidebarHelpButton />
      <HelpGuideHost projects={[]} currentProjectId={null} {...props} />
    </>,
  );
  return { ...view, props, opener: screen.getByRole("button", { name: "Help" }) };
}

async function openFrom(opener: HTMLElement) {
  opener.focus();
  fireEvent.click(opener);
  return await screen.findByRole("dialog", { name: "Help" });
}

beforeEach(() => {
  window.localStorage.removeItem(WELCOME_GUIDE_STORAGE_KEY);
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
  vi.spyOn(HTMLElement.prototype, "getClientRects")
    .mockReturnValue([{}] as unknown as DOMRectList);
});

afterEach(() => {
  act(() => {
    closeHelpGuide();
    closeWelcomeGuide();
  });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Help", () => {
  it("opens from the sidebar as a labelled modal on the first topic with focus in search", async () => {
    const { opener } = renderWithSidebarButton();
    expect(opener).toHaveAttribute("aria-haspopup", "dialog");
    expect(opener).toHaveAttribute("aria-expanded", "false");

    const dialog = await openFrom(opener);

    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("heading", { level: 2, name: "Help" })).toBeVisible();
    expect(opener).toHaveAttribute("aria-expanded", "true");
    expect(within(dialog).getByRole("searchbox", { name: "Search help" })).toHaveFocus();
    const first = within(dialog).getByRole("tab", { name: "Getting started" });
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getAllByRole("tab").map((tab) => tab.textContent))
      .toEqual(HELP_TOPICS.map(({ title }) => title));
    expect(within(dialog).getByRole("tabpanel", { name: "Getting started" }))
      .toHaveTextContent("Open a local folder or clone a repository");
    expect(within(dialog).getByText("Topic 1 of 12")).toBeVisible();
  });

  it("opens from the command palette by search", async () => {
    const onClose = vi.fn();
    render(
      <>
        <CommandPalette
          open
          projects={[]}
          conversations={[]}
          newThreadShortcut="Ctrl+N"
          onClose={onClose}
          onSelectProject={vi.fn()}
          onSelectConversation={vi.fn()}
          onNewThread={vi.fn()}
          onNewThreadIn={vi.fn()}
          currentProjectId={null}
          onAddProject={vi.fn()}
          onOpenSettings={vi.fn()}
        />
        <HelpGuideHost projects={[]} currentProjectId={null} {...hostProps()} />
      </>,
    );
    const search = screen.getByRole("combobox", {
      name: "Search commands, projects, chats, and messages",
    });
    fireEvent.change(search, { target: { value: "help" } });
    expect(screen.getByRole("option", { name: /Open help/u })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(search, { key: "Enter" });

    expect(onClose).toHaveBeenCalledOnce();
    expect(helpGuideIsOpen()).toBe(true);
    expect(await screen.findByRole("dialog", { name: "Help" })).toBeVisible();
  });

  it("closes with Escape from any control and returns focus to the opener every time", async () => {
    const { opener } = renderWithSidebarButton();
    const controls: Array<(dialog: HTMLElement) => HTMLElement> = [
      (dialog) => within(dialog).getByRole("searchbox", { name: "Search help" }),
      (dialog) => within(dialog).getByRole("tab", { name: "Getting started" }),
      (dialog) => within(dialog).getByRole("tabpanel"),
      (dialog) => within(dialog).getByRole("button", { name: /Show welcome guide/u }),
      (dialog) => within(dialog).getByRole("button", { name: /Next: Chat and composer/u }),
      (dialog) => within(dialog).getByRole("button", { name: "Close" }),
    ];

    for (const control of controls) {
      const dialog = await openFrom(opener);
      const target = control(dialog);
      target.focus();
      fireEvent.keyDown(target, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(opener).toHaveFocus();
      expect(opener).toHaveAttribute("aria-expanded", "false");
    }
  });

  it("starts fresh when reopened during the closing animation", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const { opener } = renderWithSidebarButton();
    const dialog = await openFrom(opener);
    fireEvent.click(within(dialog).getByRole("tab", { name: "Keyboard" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(opener).toHaveFocus();

    const reopened = await openFrom(opener);
    const first = within(reopened).getByRole("tab", { name: "Getting started" });
    expect(first).toHaveAttribute("aria-selected", "true");
    const field = within(reopened).getByRole("searchbox", { name: "Search help" });
    expect(field).toHaveFocus();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(opener).toHaveFocus();
    await waitFor(() => expect(document.querySelector(".help-guide")).toBeNull());
  });

  it("returns focus to the opener from Close and Done", async () => {
    const { opener } = renderWithSidebarButton();
    let dialog = await openFrom(opener);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(opener).toHaveFocus();

    dialog = await openFrom(opener);
    fireEvent.click(within(dialog).getByRole("tab", { name: "Troubleshooting" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(opener).toHaveFocus();
  });

  it("moves between topics with the arrow keys, the tabs and the footer", async () => {
    const { opener } = renderWithSidebarButton();
    const dialog = await openFrom(opener);
    const tab = (name: string) => within(dialog).getByRole("tab", { name });

    fireEvent.keyDown(tab("Getting started"), { key: "ArrowDown" });
    expect(tab("Chat and composer")).toHaveFocus();
    expect(tab("Chat and composer")).toHaveAttribute("aria-selected", "true");
    expect(tab("Chat and composer")).toHaveAttribute("tabindex", "0");
    expect(tab("Getting started")).toHaveAttribute("tabindex", "-1");
    expect(within(dialog).getByRole("tabpanel", { name: "Chat and composer" }))
      .toHaveTextContent("Type @ to reference a project file");

    fireEvent.keyDown(tab("Chat and composer"), { key: "ArrowUp" });
    fireEvent.keyDown(tab("Getting started"), { key: "ArrowUp" });
    expect(tab("Troubleshooting")).toHaveFocus();
    expect(within(dialog).getByText("Topic 12 of 12")).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: /Next:/u })).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Previous" }));
    expect(tab("Keyboard")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(dialog).getByRole("button", { name: "Next: Troubleshooting" }));
    expect(tab("Troubleshooting")).toHaveAttribute("aria-selected", "true");

    fireEvent.click(tab("Chat and composer"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Previous" }));
    expect(tab("Getting started")).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).queryByRole("button", { name: "Previous" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: /Next: Chat and composer/u })).toHaveFocus();
  });

  it("traps Tab inside the dialog", async () => {
    const { opener } = renderWithSidebarButton();
    const dialog = await openFrom(opener);
    const close = within(dialog).getByRole("button", { name: "Close" });
    const next = within(dialog).getByRole("button", { name: /Next: Chat and composer/u });

    next.focus();
    fireEvent.keyDown(next, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(next).toHaveFocus();
  });

  it("shows shortcuts with the current bindings and keeps demos decorative", async () => {
    const props = hostProps();
    props.shortcutLabel.mockImplementation((action: string) => ({
      search: "⌘Y",
      "new-chat": "⌘N",
      "toggle-sidebar": "⌘B",
      "toggle-terminal": "⌘J",
    })[action]!);
    const { opener } = renderWithSidebarButton(props);
    const dialog = await openFrom(opener);
    fireEvent.click(within(dialog).getByRole("tab", { name: "Keyboard" }));

    const panel = within(dialog).getByRole("tabpanel", { name: "Keyboard" });
    expect([...panel.querySelectorAll(".help-guide-entries kbd")].map((key) => key.textContent))
      .toEqual(["⌘Y", "⌘N", "⌘B", "⌘J"]);
    expect(within(panel).getByText(/⌘, on macOS or Ctrl\+, elsewhere opens and closes Settings\. Search settings finds a setting by name; ↑, ↓ and Enter open it\. Escape clears the search, then leaves Settings\./u)).toBeInTheDocument();
    const demo = panel.querySelector(".welcome-demo");
    expect(demo).toHaveAttribute("aria-hidden", "true");
    expect([...demo!.querySelectorAll(".d-key kbd")].map((key) => key.textContent))
      .toEqual(["⌘Y", "⌘N", "⌘B", "⌘J"]);

    fireEvent.click(within(dialog).getByRole("tab", { name: "Search and history" }));
    expect(within(dialog).getByRole("tabpanel").querySelector(".welcome-demo")).toBeNull();
    expect(within(dialog).getByRole("tabpanel")).toHaveTextContent("Find commands, settings, projects, chats and saved messages.");
  });

  it("runs every jump through an existing action, closes and hands focus back first", async () => {
    const props = hostProps();
    const { opener } = renderWithSidebarButton(props);
    const expectedSettings: string[] = [];
    let commandCalls = 0;

    for (const topic of HELP_TOPICS) {
      for (const target of topic.jumps) {
        const dialog = await openFrom(opener);
        fireEvent.click(within(dialog).getByRole("tab", { name: topic.title }));
        const button = within(dialog).getByRole("button", { name: target.label });
        props.onLeave.mockImplementationOnce(() => expect(opener).toHaveFocus());
        fireEvent.click(button);
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        if ("command" in target) {
          commandCalls += 1;
          expect(props.commands[target.command]).toHaveBeenCalled();
        } else {
          expectedSettings.push(target.settings);
        }
      }
    }

    expect(props.onOpenSettings.mock.calls.map(([target]) => target)).toEqual(expectedSettings.map((section) => ({ section })));
    expect(props.onLeave).toHaveBeenCalledTimes(expectedSettings.length + commandCalls);
    expect(Object.values(props.commands).every((command) => command.mock.calls.length > 0)).toBe(true);
  });

  it("never touches the first-run welcome state", async () => {
    const { opener } = renderWithSidebarButton();
    for (let round = 0; round < 3; round += 1) {
      const dialog = await openFrom(opener);
      expect(welcomeGuideIsOpen()).toBe(false);
      fireEvent.keyDown(dialog, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    expect(window.localStorage.getItem(WELCOME_GUIDE_STORAGE_KEY)).toBeNull();
    expect(welcomeGuideIsOpen()).toBe(false);
  });
});
