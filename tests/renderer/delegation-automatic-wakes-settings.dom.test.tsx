import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsView } from "../../src/renderer/src/components/SettingsView";
import { defaultSettings } from "../../src/shared/contracts";
import { settingsViewProps } from "./settings-view-fixtures";

const TITLE = "Continue chats automatically when delegated tasks finish";

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: { getPlatform: () => "darwin", getAppHealth: vi.fn(async () => null) },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
});

describe("Automatic delegated wakes setting", () => {
  it("is on by default in the Chats section and turns off with settings.update", async () => {
    const onUpdate = vi.fn(async () => undefined);
    render(<SettingsView {...settingsViewProps({ target: { section: "chats" }, onUpdate })} />);

    const group = await screen.findByRole("region", { name: "Delegated tasks" });
    const toggle = within(group).getByRole("switch", { name: TITLE });
    expect(defaultSettings.delegationAutomaticWakes).toBe(true);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(within(group).getByText("When off, finished results wait in the chat's Delegated work panel until you choose Continue with results."))
      .toBeInTheDocument();

    toggle.focus();
    fireEvent.click(toggle);
    expect(onUpdate).toHaveBeenLastCalledWith({ delegationAutomaticWakes: false });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(toggle).toHaveFocus();
  });

  it("shows the saved choice", async () => {
    render(<SettingsView {...settingsViewProps({
      target: { section: "chats" },
      settings: { ...defaultSettings, delegationAutomaticWakes: false },
    })} />);
    expect(await screen.findByRole("switch", { name: TITLE })).toHaveAttribute("aria-checked", "false");
  });

  it.each(["delegated tasks", "subagents", "continue"])("finds the setting by searching for %s", async (query) => {
    render(<SettingsView {...settingsViewProps({ target: { section: "appearance" } })} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Search settings" }), { target: { value: query } });
    const results = screen.getByRole("listbox", { name: "Matching settings" });
    fireEvent.click(within(within(results).getByRole("group", { name: "Chats" })).getByRole("option", { name: TITLE }));
    await waitFor(() => {
      const row = document.querySelector<HTMLElement>('[data-setting-id="delegation-automatic-wakes"]');
      expect(row?.contains(document.activeElement)).toBe(true);
    });
  });
});
