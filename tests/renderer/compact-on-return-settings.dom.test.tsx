import { fireEvent, render, screen, within } from "@testing-library/react";
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

describe("Compact large chats setting", () => {
  it("compacts when you return by default and maps every choice onto both stored settings", async () => {
    const onUpdate = vi.fn(async () => undefined);
    render(<SettingsView {...settingsViewProps({ target: { section: "chats" }, onUpdate })} />);

    const group = await screen.findByRole("radiogroup", { name: "Compact large chats" });
    expect(defaultSettings.compactOnReturn).toBe("offer");
    expect(defaultSettings.compactBeforeCacheExpires).toBe(false);
    expect(within(group).getByRole("radio", { name: "When you return" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/Send becomes Compact and send/u)).toBeInTheDocument();

    fireEvent.click(within(group).getByRole("radio", { name: "Before the cache expires" }));
    expect(onUpdate).toHaveBeenLastCalledWith({ compactOnReturn: "offer", compactBeforeCacheExpires: true });
    fireEvent.click(within(group).getByRole("radio", { name: "Never" }));
    expect(onUpdate).toHaveBeenLastCalledWith({ compactOnReturn: "never", compactBeforeCacheExpires: false });
  });

  it.each([
    [{ compactOnReturn: "never" as const, compactBeforeCacheExpires: false }, "Never"],
    [{ compactOnReturn: "never" as const, compactBeforeCacheExpires: true }, "Never"],
    [{ compactOnReturn: "offer" as const, compactBeforeCacheExpires: true }, "Before the cache expires"],
  ])("shows the saved choice for %j", async (saved, label) => {
    render(<SettingsView {...settingsViewProps({
      target: { section: "chats" },
      settings: { ...defaultSettings, ...saved },
    })} />);
    const group = await screen.findByRole("radiogroup", { name: "Compact large chats" });
    expect(within(group).getByRole("radio", { name: label })).toHaveAttribute("aria-checked", "true");
  });
});

describe("Auto-compact Claude chats setting", () => {
  it("starts at 400K tokens and stores Claude Code's own default as null", async () => {
    const onUpdate = vi.fn(async () => undefined);
    render(<SettingsView {...settingsViewProps({ target: { section: "chats" }, onUpdate })} />);

    const select = await screen.findByRole("combobox", { name: "Auto-compact Claude chats after" });
    expect(defaultSettings.claudeAutoCompactWindow).toBe(400_000);
    expect(select).toHaveValue("400000");
    expect(within(select).getAllByRole("option").map((option) => option.textContent))
      .toEqual(["200K tokens", "300K tokens", "400K tokens", "600K tokens", "Claude Code default"]);

    fireEvent.change(select, { target: { value: "claude-code-default" } });
    expect(onUpdate).toHaveBeenLastCalledWith({ claudeAutoCompactWindow: null });
    fireEvent.change(select, { target: { value: "200000" } });
    expect(onUpdate).toHaveBeenLastCalledWith({ claudeAutoCompactWindow: 200_000 });
  });

  it("shows Claude Code's default for a cleared window", async () => {
    render(<SettingsView {...settingsViewProps({
      target: { section: "chats" },
      settings: { ...defaultSettings, claudeAutoCompactWindow: null },
    })} />);
    expect(await screen.findByRole("combobox", { name: "Auto-compact Claude chats after" })).toHaveValue("claude-code-default");
  });
});

describe("Auto-compact Codex chats setting", () => {
  it("starts at 300K tokens and stores Codex's own default as null", async () => {
    const onUpdate = vi.fn(async () => undefined);
    render(<SettingsView {...settingsViewProps({ target: { section: "chats" }, onUpdate })} />);

    const select = await screen.findByRole("combobox", { name: "Auto-compact Codex chats after" });
    expect(defaultSettings.codexAutoCompactTokenLimit).toBe(300_000);
    expect(select).toHaveValue("300000");
    expect(within(select).getAllByRole("option").map((option) => option.textContent))
      .toEqual(["200K tokens", "300K tokens", "400K tokens", "Codex default"]);
    expect(screen.getByText(/90% of the model's context/u)).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "codex-default" } });
    expect(onUpdate).toHaveBeenLastCalledWith({ codexAutoCompactTokenLimit: null });
    fireEvent.change(select, { target: { value: "400000" } });
    expect(onUpdate).toHaveBeenLastCalledWith({ codexAutoCompactTokenLimit: 400_000 });
  });

  it("shows Codex's default for a cleared limit", async () => {
    render(<SettingsView {...settingsViewProps({
      target: { section: "chats" },
      settings: { ...defaultSettings, codexAutoCompactTokenLimit: null },
    })} />);
    expect(await screen.findByRole("combobox", { name: "Auto-compact Codex chats after" })).toHaveValue("codex-default");
  });
});
