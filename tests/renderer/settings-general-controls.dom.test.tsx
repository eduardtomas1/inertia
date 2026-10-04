import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsView } from "../../src/renderer/src/components/SettingsView";
import type { SettingsSection } from "../../src/renderer/src/lib/settingsTarget";
import { defaultSettings } from "../../src/shared/contracts";
import { RESTORE_DEFAULTS_SCOPE } from "../../src/shared/restore-defaults";
import { settingsViewProps } from "./settings-view-fixtures";

beforeEach(() => {
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: { getPlatform: () => "darwin", getAppHealth: vi.fn(async () => null) },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
  vi.unstubAllGlobals();
});

describe("Settings radio controls", () => {
  it.each([
    ["appearance", "Interface scale", "Default", "Comfortable", "Compact", { interfaceScale: "comfortable" }],
    ["projects", "Group projects", "Keep separate", "By repository", "By repository and folder", { projectGrouping: "repository" }],
    ["chats", "Usage display", "Compact", "Hidden", "Expanded", { usageDisplayMode: "hidden" }],
    ["appearance", "Text density", "Default", "Comfortable", "Compact", { responseDensity: "comfortable" }],
  ] as const)("moves the %s › %s choice with arrow keys and a single tab stop", async (section: SettingsSection, group, checked, next, previous, update) => {
    const onUpdate = vi.fn(async () => undefined);
    render(<SettingsView {...settingsViewProps({ target: { section }, onUpdate })} />);
    const radios = within(await screen.findByRole("radiogroup", { name: group }));
    const current = radios.getByRole("radio", { name: checked });

    expect(current).toHaveAttribute("aria-checked", "true");
    expect(radios.getAllByRole("radio").filter((radio) => radio.tabIndex === 0))
      .toEqual([current]);

    current.focus();
    fireEvent.keyDown(current, { key: "ArrowRight" });
    expect(radios.getByRole("radio", { name: next })).toHaveFocus();
    expect(onUpdate).toHaveBeenLastCalledWith(update);

    fireEvent.keyDown(current, { key: "ArrowLeft" });
    expect(radios.getByRole("radio", { name: previous })).toHaveFocus();
  });
});

describe("Restore defaults confirmation", () => {
  it("asks inline with Cancel focused, cancels with Escape and restores only after confirmation", async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    const onRestoreDefaults = vi.fn(async () => undefined);
    render(<SettingsView {...settingsViewProps({ target: { section: "data" }, onRestoreDefaults })} />);

    const trigger = await screen.findByRole("button", { name: "Restore defaults…" });
    trigger.focus();
    fireEvent.click(trigger);
    const group = screen.getByRole("group", { name: "Confirm restore defaults" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(within(group).getByText("Restore defaults?")).toBeInTheDocument();
    expect(within(group).getByText("This cannot be undone.")).toBeInTheDocument();
    expect(within(group).queryByText(RESTORE_DEFAULTS_SCOPE)).toBeNull();
    expect(screen.getAllByText(RESTORE_DEFAULTS_SCOPE)).toHaveLength(1);
    expect(within(group).getByRole("button", { name: "Cancel" })).toHaveFocus();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => { within(group).getByRole("button", { name: "Cancel" }).dispatchEvent(escape); });
    expect(escape.defaultPrevented).toBe(true);
    expect(screen.queryByRole("group", { name: "Confirm restore defaults" })).toBeNull();
    expect(trigger).toHaveFocus();
    expect(onRestoreDefaults).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole("group", { name: "Confirm restore defaults" })).getByRole("button", { name: "Cancel" }));
    expect(trigger).toHaveFocus();
    expect(onRestoreDefaults).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    const restore = within(screen.getByRole("group", { name: "Confirm restore defaults" })).getByRole("button", { name: "Restore defaults" });
    expect(restore).toHaveClass("is-danger");
    restore.focus();
    fireEvent.click(restore);
    expect(onRestoreDefaults).toHaveBeenCalledOnce();
    expect(screen.queryByRole("group", { name: "Confirm restore defaults" })).toBeNull();
    expect(trigger).toHaveFocus();
    expect(confirm).not.toHaveBeenCalled();
    expect(await screen.findByText("Defaults restored.")).toBeInTheDocument();
  });

  it("restores defaults without asking when destructive confirmations are off", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const onRestoreDefaults = vi.fn(async () => undefined);
    render(<SettingsView {...settingsViewProps({
      target: { section: "data" },
      settings: { ...defaultSettings, confirmDestructiveActions: false },
      onRestoreDefaults,
    })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Restore defaults" }));

    expect(confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Confirm restore defaults" })).toBeNull();
    expect(onRestoreDefaults).toHaveBeenCalledOnce();
  });
});
