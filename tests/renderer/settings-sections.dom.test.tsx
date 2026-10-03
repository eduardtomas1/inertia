import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsView } from "../../src/renderer/src/components/SettingsView";
import { defaultSettings } from "../../src/shared/contracts";
import { DEFAULT_APP_KEYBINDINGS } from "../../src/shared/keybindings";
import { conversation } from "./composer-fixtures";
import { settingsProvider, settingsViewProps } from "./settings-view-fixtures";

function row(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-setting-id="${id}"]`)!;
}

beforeEach(() => {
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: { getPlatform: () => "darwin", getAppHealth: vi.fn(async () => null) },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
});

describe("Review settings", () => {
  it("saves diff preferences and confirms each save in its row", async () => {
    const onUpdate = vi.fn(async () => undefined);
    render(<SettingsView {...settingsViewProps({ target: { section: "chats" }, onUpdate })} />);
    expect(screen.getByRole("heading", { level: 3, name: "Review and terminal" })).toBeVisible();

    fireEvent.click(screen.getByRole("switch", { name: "Wrap long diff lines" }));
    expect(onUpdate).toHaveBeenCalledWith({ wrapDiffs: !defaultSettings.wrapDiffs });
    fireEvent.click(screen.getByRole("switch", { name: "Ignore whitespace" }));
    expect(onUpdate).toHaveBeenLastCalledWith({ ignoreWhitespace: !defaultSettings.ignoreWhitespace });
    await waitFor(() => expect(within(row("wrap-diffs")).getByRole("status")).toHaveTextContent("Saved"));
    expect(within(row("ignore-whitespace")).getByRole("status")).toHaveTextContent("Saved");
  });
});

describe("Keyboard settings", () => {
  it("resets custom shortcuts to the defaults and is unavailable at the defaults", async () => {
    const onUpdate = vi.fn(async () => undefined);
    const custom = { ...DEFAULT_APP_KEYBINDINGS, search: "g" as const };
    const view = render(<SettingsView {...settingsViewProps({
      target: { section: "keyboard" },
      settings: { ...defaultSettings, keybindings: custom },
      onUpdate,
    })} />);
    const reset = screen.getByRole("button", { name: "Reset shortcuts" });
    expect(screen.getByLabelText("Search everything key")).toHaveValue("g");

    fireEvent.click(reset);
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({ keybindings: DEFAULT_APP_KEYBINDINGS });
    expect(screen.getByLabelText("Search everything key")).toHaveValue("k");
    expect(reset).toBeDisabled();
    expect(await within(row("reset-shortcuts")).findByText("Saved")).toHaveAttribute("role", "status");

    view.rerender(<SettingsView {...settingsViewProps({ target: { section: "keyboard" }, onUpdate })} />);
    expect(reset).toBeDisabled();
  });

  it("restores the saved shortcuts and shows an error when the save fails", async () => {
    const onUpdate = vi.fn(async () => { throw new Error("offline"); });
    render(<SettingsView {...settingsViewProps({ target: { section: "keyboard" }, onUpdate })} />);
    fireEvent.change(screen.getByLabelText("New chat key"), { target: { value: "h" } });
    expect(await within(row("shortcut-new-chat")).findByRole("alert")).toHaveTextContent("Couldn't save. Try again.");
    expect(screen.getByLabelText("New chat key")).toHaveValue("n");
  });
});

describe("Archived chats", () => {
  it("restores an archived chat and counts archived chats in the navigation", async () => {
    const archived = { ...conversation("33333333-3333-4333-8333-333333333333"), title: "Old investigation", archivedAt: "2026-09-01T00:00:00.000Z" };
    const onUnarchive = vi.fn();
    render(<SettingsView {...settingsViewProps({
      target: { section: "data" },
      providers: [settingsProvider("codex", "Codex")],
      archived: [archived],
      onUnarchive,
    })} />);
    expect(screen.getByRole("button", { name: /^Data 1$/u })).toHaveAttribute("aria-current", "page");
    const thread = within(await screen.findByRole("list", { name: "Archived chats" }));
    expect(thread.getByText("Old investigation")).toBeVisible();
    fireEvent.click(thread.getByRole("button", { name: "Restore Old investigation" }));
    expect(onUnarchive).toHaveBeenCalledExactlyOnceWith(archived);
  });
});

describe("Provider settings memory", () => {
  it("keeps the selected provider and tab while moving between sections", async () => {
    render(<SettingsView {...settingsViewProps({
      target: { section: "agents" },
      providers: [settingsProvider("codex", "Codex"), settingsProvider("claude", "Claude")],
    })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Configure Claude" }));
    fireEvent.click(screen.getByRole("tab", { name: /Models/u }));
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(await screen.findByRole("button", { name: "Configure Claude" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("tab", { name: /Models/u })).toHaveAttribute("aria-selected", "true");
  });
});

describe("Codex executable settings", () => {
  it("browses for a Codex executable and returns to automatic discovery", async () => {
    const onUpdate = vi.fn(async () => undefined);
    const onChooseCodexBinary = vi.fn();
    render(<SettingsView {...settingsViewProps({
      target: { section: "agents" },
      providers: [settingsProvider("codex", "Codex")],
      settings: { ...defaultSettings, codexBinaryPath: "/opt/codex/bin/codex" },
      onUpdate,
      onChooseCodexBinary,
    })} />);
    expect(await screen.findByLabelText("Codex executable path")).toHaveValue("/opt/codex/bin/codex");
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    expect(onChooseCodexBinary).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Use automatic" }));
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({ codexBinaryPath: "" });
    expect(await within(row("provider-binary-path")).findByText("Saved")).toBeInTheDocument();
  });

  it("shows a failed return to automatic discovery in the binary path field", async () => {
    let reject!: (error: Error) => void;
    const onUpdate = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    render(<SettingsView {...settingsViewProps({
      target: { section: "agents" },
      providers: [settingsProvider("codex", "Codex")],
      settings: { ...defaultSettings, codexBinaryPath: "/opt/codex/bin/codex" },
      onUpdate,
    })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Use automatic" }));
    await act(async () => reject(new Error("rejected")));
    expect(within(row("provider-binary-path")).getByRole("alert")).toHaveTextContent("Couldn't save. Try again.");
  });
});
