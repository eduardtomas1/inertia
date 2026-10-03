import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsView } from "../../src/renderer/src/components/SettingsView";
import { SETTINGS_SECTIONS } from "../../src/renderer/src/components/settingsSections";
import { SETTINGS_SECTION_IDS, parseSettingsTarget } from "../../src/renderer/src/lib/settingsTarget";
import { defaultSettings, type Conversation } from "../../src/shared/contracts";
import { conversation } from "./composer-fixtures";
import { settingsViewProps } from "./settings-view-fixtures";

const themeLibraryRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../src/renderer/src/components/ThemeLibrary", () => ({
  ThemeLibrary: () => {
    themeLibraryRenders.count += 1;
    return <div data-setting-id="appearance-mode">Theme library</div>;
  },
}));

const ROWS_WITHOUT_UI_IN_TEST = new Set([
  "desktop-mascot",
  "open-settings",
]);

function settingRowIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-setting-id]")].map((row) => row.dataset.settingId!);
}

beforeEach(() => {
  themeLibraryRenders.count = 0;
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: {
      getPlatform: () => "darwin",
      getAppHealth: vi.fn(async () => null),
      getBackendCredentialState: vi.fn(async () => ({
        profileId: "discord-release-webhook",
        hasSecret: false,
        maskedValue: null,
        credentialGeneration: null,
        storage: { available: true, provider: "keychain" as const, message: null },
      })),
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
});

describe("Settings section registry", () => {
  it("lists every section once, in order, with distinct icons for Discord, Providers and Report an issue", () => {
    expect(SETTINGS_SECTIONS.map(({ id }) => id)).toEqual([
      "general", "snapshots", "projects", "providers", "backends", "connections",
      "discord", "diagnostics", "source", "keybindings", "support", "archive",
    ]);
    expect([...SETTINGS_SECTION_IDS].sort()).toEqual(SETTINGS_SECTIONS.map(({ id }) => id).sort());
    const icon = (id: string) => SETTINGS_SECTIONS.find((section) => section.id === id)!.icon;
    expect(new Set([icon("discord"), icon("providers"), icon("support")]).size).toBe(3);
    const rowIds = SETTINGS_SECTIONS.flatMap(({ rows }) => rows.map(({ id }) => id));
    expect(new Set(rowIds).size).toBe(rowIds.length);
    expect(SETTINGS_SECTIONS.find(({ id }) => id === "keybindings")!.rows)
      .toContainEqual({ id: "open-settings", title: "Open settings", keywords: ["preferences", "comma"], group: "Keyboard shortcuts" });
  });

  it.each(["general", "source", "keybindings", "discord", "archive"] as const)(
    "renders a setting row for every %s row in the registry",
    async (section) => {
      render(<SettingsView {...settingsViewProps({ target: { section }, onReportCommand: undefined })} />);
      const expected = SETTINGS_SECTIONS.find(({ id }) => id === section)!.rows
        .map(({ id }) => id)
        .filter((id) => !ROWS_WITHOUT_UI_IN_TEST.has(id) && id !== "attachment-storage");
      await waitFor(() => expect(settingRowIds()).toEqual(expect.arrayContaining(expected)));
    },
  );

  it("validates settings targets at the navigation boundary", () => {
    expect(parseSettingsTarget({ section: "general", anchor: "terminal-font-size" }))
      .toEqual({ section: "general", anchor: "terminal-font-size" });
    expect(parseSettingsTarget({ section: "diagnostics", selection: { incidentId: "11111111-1111-4111-8111-111111111111" } }))
      .toEqual({ section: "diagnostics", selection: { incidentId: "11111111-1111-4111-8111-111111111111" } });
    for (const value of [
      null,
      { section: "unknown" },
      { section: "general", anchor: "Bad anchor" },
      { section: "general", extra: true },
      { section: "general", selection: { incidentId: "11111111-1111-4111-8111-111111111111" } },
      { section: "projects", projectId: "not-a-uuid" },
    ]) expect(parseSettingsTarget(value)).toBeNull();
  });
});

describe("Settings anchors", () => {
  it("scrolls to the anchored row and focuses its control", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const view = render(<SettingsView {...settingsViewProps({ target: { section: "general", anchor: "terminal-font-size" } })} />);
    await waitFor(() => expect(screen.getByRole("slider", { name: "Terminal font size" })).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });

    view.rerender(<SettingsView {...settingsViewProps({ target: { section: "source", anchor: "ignore-whitespace" } })} />);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Ignore whitespace" })).toHaveFocus());
  });

  it("focuses a row without controls and leaves its look unchanged", async () => {
    render(<SettingsView {...settingsViewProps({ target: { section: "archive", anchor: "archived-threads" } })} />);
    const row = document.querySelector<HTMLElement>('[data-setting-id="archived-threads"]')!;
    await waitFor(() => expect(row).toHaveFocus());
    expect(row).toHaveAttribute("tabindex", "-1");
    expect(row.className).toBe("");
  });

  it("keeps focus on a control after the current section is chosen again and a snapshot arrives", async () => {
    const target = { section: "source" as const };
    const view = render(<SettingsView {...settingsViewProps({ target })} />);
    const navigation = screen.getByRole("button", { name: "Source control" });
    navigation.focus();
    fireEvent.click(navigation);
    const wrap = screen.getByRole("switch", { name: "Wrap long diff lines" });
    wrap.focus();
    view.rerender(<SettingsView {...settingsViewProps({ target, settings: { ...defaultSettings, wrapDiffs: false } })} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wrap).toHaveFocus();
  });

  it("falls back to the section title for an unknown anchor", async () => {
    render(<SettingsView {...settingsViewProps({ target: { section: "source", anchor: "missing-row" } })} />);
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Source control" })).toHaveFocus());
  });
});

describe("Settings render stability", () => {
  it("does not re-render the open section for equal snapshots or unrelated conversation updates", () => {
    const shells = [conversation("11111111-1111-4111-8111-111111111111"), conversation("22222222-2222-4222-8222-222222222222")];
    const props = (conversations: Conversation[], settings = { ...defaultSettings }) => settingsViewProps({
      settings,
      providers: [],
      conversations: conversations.filter(({ archivedAt }) => archivedAt === null),
      archived: conversations.filter(({ archivedAt }) => archivedAt !== null),
      maintenanceStatuses: new Map(),
      maintenanceOperations: new Map(),
    });
    const view = render(<SettingsView {...props(shells)} />);
    expect(themeLibraryRenders.count).toBe(1);

    view.rerender(<SettingsView {...props(shells.map((shell) => ({ ...shell })))} />);
    view.rerender(<SettingsView {...props(shells.map((shell) => ({ ...shell })))} />);
    expect(themeLibraryRenders.count).toBe(1);

    view.rerender(<SettingsView {...props([{ ...shells[0]!, status: "running", updatedAt: "2030-01-01T00:00:00.000Z" }, shells[1]!])} />);
    expect(themeLibraryRenders.count).toBe(1);

    view.rerender(<SettingsView {...props(shells, { ...defaultSettings, theme: "dark" })} />);
    expect(themeLibraryRenders.count).toBe(2);
  });
});
