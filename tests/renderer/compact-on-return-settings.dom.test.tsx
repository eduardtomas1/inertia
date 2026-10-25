import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsView } from "../../src/renderer/src/components/SettingsView";
import { defaultSettings } from "../../src/shared/contracts";
import { settingsViewProps } from "./settings-view-fixtures";

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

describe("Compact on return setting", () => {
  it("offers by default and turns the offer off with settings.update", async () => {
    const onUpdate = vi.fn(async () => undefined);
    render(<SettingsView {...settingsViewProps({ target: { section: "chats" }, onUpdate })} />);

    const group = await screen.findByRole("radiogroup", { name: "Compact large API chats when you return" });
    expect(defaultSettings.compactOnReturn).toBe("offer");
    expect(within(group).getByRole("radio", { name: "Offer" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Offers Compact and send when you return to a chat of 200K tokens or more on an Anthropic or OpenAI API key after its prompt cache has expired. Later turns then cost less. Enter follows the button."))
      .toBeInTheDocument();

    fireEvent.click(within(group).getByRole("radio", { name: "Never" }));
    expect(onUpdate).toHaveBeenLastCalledWith({ compactOnReturn: "never" });
  });

  it("shows the saved choice", async () => {
    render(<SettingsView {...settingsViewProps({
      target: { section: "chats" },
      settings: { ...defaultSettings, compactOnReturn: "never" },
    })} />);
    const group = await screen.findByRole("radiogroup", { name: "Compact large API chats when you return" });
    expect(within(group).getByRole("radio", { name: "Never" })).toHaveAttribute("aria-checked", "true");
  });

  it.each(["1 hour", "prompt cache"])("finds the Accounts and API keys row by searching for %s", async (query) => {
    render(<SettingsView {...settingsViewProps({ target: { section: "appearance" } })} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Search settings" }), { target: { value: query } });
    const results = screen.getByRole("listbox", { name: "Matching settings" });
    expect(within(within(results).getByRole("group", { name: "Agents" }))
      .getByRole("option", { name: "Accounts and API keys" })).toBeInTheDocument();
  });

  it.each(["prompt cache", "compact on return", "summarize"])("finds the setting by searching for %s", async (query) => {
    render(<SettingsView {...settingsViewProps({ target: { section: "appearance" } })} />);
    const field = screen.getByRole("combobox", { name: "Search settings" });
    fireEvent.change(field, { target: { value: query } });
    const results = screen.getByRole("listbox", { name: "Matching settings" });
    const option = within(within(results).getByRole("group", { name: "Chats" }))
      .getByRole("option", { name: "Compact large API chats when you return" });

    fireEvent.click(option);
    await waitFor(() => {
      const row = document.querySelector<HTMLElement>('[data-setting-id="compact-on-return"]');
      expect(row?.contains(document.activeElement)).toBe(true);
    });
  });
});
