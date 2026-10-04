import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HelpGuideHost } from "../../src/renderer/src/components/HelpGuideHost";
import { SidebarHelpButton } from "../../src/renderer/src/components/sidebar/SidebarHelpButton";
import { HELP_TOPICS } from "../../src/renderer/src/components/welcome-guide/helpTopics";
import { closeHelpGuide } from "../../src/renderer/src/utils/helpGuide";
import type { AppShortcutAction } from "../../src/shared/keybindings";

const LABELS: Record<AppShortcutAction, string> = {
  search: "⌘K",
  "new-chat": "⌘N",
  "toggle-sidebar": "⌘B",
  "toggle-terminal": "⌘J",
};

function hostProps() {
  return {
    shortcutLabel: vi.fn((action: AppShortcutAction) => LABELS[action]),
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

async function openHelp(props = hostProps()) {
  render(
    <>
      <SidebarHelpButton />
      <HelpGuideHost {...props} />
    </>,
  );
  const opener = screen.getByRole("button", { name: "Help" });
  opener.focus();
  fireEvent.click(opener);
  const dialog = await screen.findByRole("dialog", { name: "Help" });
  const field = within(dialog).getByRole("searchbox", { name: "Search help" });
  const type = (value: string) => fireEvent.change(field, { target: { value } });
  return { props, opener, dialog, field, type };
}

function resultNames(dialog: HTMLElement): string[] {
  return within(within(dialog).getByRole("region", { name: "Search results" }))
    .getAllByRole("button")
    .filter((button) => button.classList.contains("help-guide-result"))
    .map((button) => button.querySelector("strong")!.textContent!);
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
  vi.spyOn(HTMLElement.prototype, "getClientRects")
    .mockReturnValue([{}] as unknown as DOMRectList);
});

afterEach(() => {
  act(() => closeHelpGuide());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Help search", () => {
  it("focuses an empty search field above the topic tabs when Help opens", async () => {
    const { dialog, field } = await openHelp();

    expect(field).toHaveFocus();
    expect(field).toHaveValue("");
    expect(field).toHaveAttribute("placeholder", "Search help");
    const tab = within(dialog).getByRole("tab", { name: HELP_TOPICS[0]!.title });
    expect(field.compareDocumentPosition(tab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tab).toHaveAttribute("tabindex", "0");
    expect(within(dialog).getByRole("status")).toHaveTextContent("");
  });

  it("replaces the topics with grouped, highlighted matches while there is a query", async () => {
    const { dialog, type } = await openHelp();

    type("archiv");

    expect(within(dialog).queryByRole("tablist")).toBeNull();
    const results = within(dialog).getByRole("region", { name: "Search results" });
    expect(resultNames(dialog)).toEqual(["Archive", "Organize chats"]);
    expect(within(results).getAllByRole("group").map((group) => group.querySelector("h3")!.textContent))
      .toEqual(["Search and history", "Following work"]);
    expect(within(results).getByRole("group", { name: "Search and history" })).toBeVisible();
    expect([...results.querySelectorAll("mark")].map((mark) => mark.textContent))
      .toEqual(["Archive", "Archive", "archive"]);
    expect(within(dialog).getByRole("status")).toHaveTextContent("2 results");
    const group = within(results).getByRole("group", { name: "Search and history" });
    expect(within(group).getByRole("button", { name: "Open Settings → Data" })).toBeVisible();
    expect(within(results).getByRole("button", { name: "Open Daily work" })).toBeVisible();
  });

  it("finds an entry by its shortcut as the dialog shows it", async () => {
    const { dialog, type } = await openHelp();

    type("cmd j");

    expect(resultNames(dialog)).toEqual(["Terminal", "Terminal"]);
    const results = within(dialog).getByRole("region", { name: "Search results" });
    expect([...results.querySelectorAll(".help-guide-result kbd")].map((key) => key.textContent))
      .toEqual(["⌘J", "⌘J"]);
  });

  it("says when nothing matches", async () => {
    const { dialog, type } = await openHelp();

    type("zebra");

    expect(within(dialog).getByText("No matches.")).toBeVisible();
    expect(within(dialog).getByRole("status")).toHaveTextContent("No matches");
  });

  it("moves between results with the arrow keys and back to the field", async () => {
    const { dialog, field, type } = await openHelp();
    type("folder");
    const results = within(within(dialog).getByRole("region", { name: "Search results" }));
    const result = (name: string) => results.getAllByRole("button", { name })
      .find((button) => button.classList.contains("help-guide-result"))!;
    const first = result("Add a project");
    const second = result("Chats without a project");
    const last = result("Chat commands");

    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(first).toHaveFocus();
    expect(first).toHaveAttribute("tabindex", "0");
    expect(second).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute("tabindex", "0");
    expect(first).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(second, { key: "ArrowDown" });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "ArrowDown" });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "ArrowUp" });
    fireEvent.keyDown(second, { key: "ArrowUp" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowUp" });
    expect(field).toHaveFocus();
    expect(first).toHaveAttribute("tabindex", "0");
  });

  it("clears the query with Escape, keeps the open topic and closes on the next Escape", async () => {
    const { dialog, opener, field, type } = await openHelp();
    fireEvent.click(within(dialog).getByRole("tab", { name: "Keyboard" }));
    type("archiv");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    const focused = document.activeElement as HTMLElement;

    fireEvent.keyDown(focused, { key: "Escape" });

    expect(screen.getByRole("dialog", { name: "Help" })).toBeVisible();
    expect(field).toHaveValue("");
    expect(field).toHaveFocus();
    expect(within(dialog).getByRole("tab", { name: "Keyboard" })).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByRole("status")).toHaveTextContent("");

    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(opener).toHaveFocus();
  });

  it("runs an entry's own action, closing Help and handing focus back first", async () => {
    const props = hostProps();
    const { dialog, opener, type } = await openHelp(props);
    type("themes");
    props.onLeave.mockImplementationOnce(() => expect(opener).toHaveFocus());

    fireEvent.click(within(dialog).getByRole("button", { name: "Themes" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(props.onOpenSettings).toHaveBeenCalledExactlyOnceWith({ section: "appearance" });
    expect(props.onLeave).toHaveBeenCalledOnce();
  });

  it("opens Settings at the row an entry names", async () => {
    const props = hostProps();
    const { dialog, type } = await openHelp(props);
    type("incidents");
    fireEvent.click(within(dialog).getByRole("button", { name: "Diagnostics" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(props.onOpenSettings).toHaveBeenCalledExactlyOnceWith({ section: "help", anchor: "diagnostics-incidents" });
  });

  it("opens the topic of an entry without its own action and clears the query", async () => {
    const props = hostProps();
    const { dialog, field, type } = await openHelp(props);
    fireEvent.click(within(dialog).getByRole("tab", { name: "Keyboard" }));
    type("access modes");

    fireEvent.click(within(dialog).getByRole("button", { name: "Access modes" }));

    expect(field).toHaveValue("");
    const tab = within(dialog).getByRole("tab", { name: "Getting started" });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(tab).toHaveFocus();
    expect(within(dialog).getByRole("tabpanel", { name: "Getting started" })).toHaveTextContent("Access modes");
    expect(props.onLeave).not.toHaveBeenCalled();
    expect(props.onOpenSettings).not.toHaveBeenCalled();
    expect(Object.values(props.commands).every((command) => command.mock.calls.length === 0)).toBe(true);
  });

  it("starts with an empty search when reopened", async () => {
    const { dialog, opener, type } = await openHelp();
    type("archiv");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(opener);
    const reopened = await screen.findByRole("dialog", { name: "Help" });
    const field = within(reopened).getByRole("searchbox", { name: "Search help" });
    expect(field).toHaveValue("");
    expect(field).toHaveFocus();
    expect(within(reopened).getByRole("tablist", { name: "Topics" })).toBeVisible();
  });

  it("shows only Done in the footer while results are shown", async () => {
    const { dialog, opener, type } = await openHelp();
    fireEvent.click(within(dialog).getByRole("tab", { name: "Chat and composer" }));
    type("terminal");

    expect(within(dialog).queryByText(/Topic \d+ of/u)).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /^Next:/u })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Previous" })).toBeNull();

    type("");
    expect(within(dialog).getByText(`Topic 2 of ${HELP_TOPICS.length}`)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Previous" })).toBeVisible();

    type("terminal");
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(opener).toHaveFocus();
  });
});
