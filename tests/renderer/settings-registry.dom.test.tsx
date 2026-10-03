import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsView } from "../../src/renderer/src/components/SettingsView";
import { SETTINGS_SECTIONS } from "../../src/renderer/src/components/settingsSections";
import { SETTINGS_SECTION_IDS, legacySettingsTarget, parseSettingsTarget } from "../../src/renderer/src/lib/settingsTarget";
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
  "working-indicator-activity",
  "snapshot-shortcut",
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
  it("lists the nine sections once, in order, with distinct icons and unique row ids", () => {
    expect(SETTINGS_SECTIONS.map(({ id, label }) => [id, label])).toEqual([
      ["appearance", "Appearance"], ["chats", "Chats"], ["notifications", "Notifications"], ["keyboard", "Keyboard"],
      ["projects", "Projects"], ["agents", "Agents"], ["devices", "Devices & integrations"], ["data", "Data"], ["help", "Help"],
    ]);
    expect([...SETTINGS_SECTION_IDS]).toEqual(SETTINGS_SECTIONS.map(({ id }) => id));
    expect(new Set(SETTINGS_SECTIONS.map(({ icon }) => icon)).size).toBe(SETTINGS_SECTIONS.length);
    const rowIds = SETTINGS_SECTIONS.flatMap(({ rows }) => rows.map(({ id }) => id));
    expect(new Set(rowIds).size).toBe(rowIds.length);
    expect(SETTINGS_SECTIONS.find(({ id }) => id === "keyboard")!.rows)
      .toContainEqual({ id: "open-settings", title: "Open settings", keywords: ["preferences", "comma"], group: "App shortcuts" });
  });

  it.each([
    "general", "snapshots", "providers", "backends", "connections", "discord", "diagnostics", "source", "keybindings", "support", "archive",
  ] as const)("maps the old %s section to an existing section and row", (legacy) => {
    const target = legacySettingsTarget(legacy);
    const section = SETTINGS_SECTIONS.find(({ id }) => id === target.section);
    expect(section).toBeDefined();
    if (target.anchor) expect(section!.rows.map(({ id }) => id)).toContain(target.anchor);
  });

  it.each(["appearance", "chats", "keyboard", "data"] as const)(
    "renders a setting row for every %s row in the registry",
    async (section) => {
      render(<SettingsView {...settingsViewProps({ target: { section }, onReportCommand: undefined })} />);
      const expected = SETTINGS_SECTIONS.find(({ id }) => id === section)!.rows
        .map(({ id }) => id)
        .filter((id) => !ROWS_WITHOUT_UI_IN_TEST.has(id) && !id.startsWith("attachment-"));
      await waitFor(() => expect(settingRowIds()).toEqual(expect.arrayContaining(expected)));
    },
  );

  it("validates settings targets at the navigation boundary and maps old section ids", () => {
    expect(parseSettingsTarget({ section: "chats", anchor: "terminal-font-size" }))
      .toEqual({ section: "chats", anchor: "terminal-font-size" });
    expect(parseSettingsTarget({ section: "diagnostics", selection: { incidentId: "11111111-1111-4111-8111-111111111111" } }))
      .toEqual({ section: "help", anchor: "diagnostics-incidents", selection: { incidentId: "11111111-1111-4111-8111-111111111111" } });
    expect(parseSettingsTarget({ section: "backends", profileId: "custom:team" }))
      .toEqual({ section: "agents", anchor: "model-backends", profileId: "custom:team" });
    expect(parseSettingsTarget({ section: "source", anchor: "ignore-whitespace" }))
      .toEqual({ section: "chats", anchor: "ignore-whitespace" });
    for (const value of [
      null,
      { section: "unknown" },
      { section: "toString" },
      { section: "appearance", anchor: "Bad anchor" },
      { section: "appearance", extra: true },
      { section: "appearance", selection: { incidentId: "11111111-1111-4111-8111-111111111111" } },
      { section: "projects", projectId: "not-a-uuid" },
    ]) expect(parseSettingsTarget(value)).toBeNull();
  });
});

describe("Settings anchors", () => {
  it("scrolls to the anchored row and focuses its control", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const view = render(<SettingsView {...settingsViewProps({ target: { section: "chats", anchor: "terminal-font-size" } })} />);
    await waitFor(() => expect(screen.getByRole("slider", { name: "Terminal font size" })).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });

    view.rerender(<SettingsView {...settingsViewProps({ target: { section: "appearance", anchor: "interface-scale" } })} />);
    await waitFor(() => expect(within(screen.getByRole("radiogroup", { name: "Interface scale" })).getByRole("radio", { name: "Default" })).toHaveFocus());

    view.rerender(<SettingsView {...settingsViewProps({ target: { section: "chats", anchor: "ignore-whitespace" } })} />);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Ignore whitespace" })).toHaveFocus());
  });

  it("focuses a row without controls and leaves its look unchanged", async () => {
    render(<SettingsView {...settingsViewProps({ target: { section: "keyboard", anchor: "open-settings" } })} />);
    await waitFor(() => expect(document.querySelector<HTMLElement>('[data-setting-id="open-settings"]')).toHaveFocus());
    const row = document.querySelector<HTMLElement>('[data-setting-id="open-settings"]')!;
    expect(row).toHaveAttribute("tabindex", "-1");
    expect(row.className).toBe("setting-row");
  });

  it("keeps focus on a control after the current section is chosen again and a snapshot arrives", async () => {
    const target = { section: "chats" as const };
    const view = render(<SettingsView {...settingsViewProps({ target })} />);
    const navigation = screen.getByRole("button", { name: "Chats" });
    navigation.focus();
    fireEvent.click(navigation);
    const wrap = screen.getByRole("switch", { name: "Wrap long diff lines" });
    wrap.focus();
    view.rerender(<SettingsView {...settingsViewProps({ target, settings: { ...defaultSettings, wrapDiffs: false } })} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wrap).toHaveFocus();
  });

  it("falls back to the section title for an unknown anchor", async () => {
    render(<SettingsView {...settingsViewProps({ target: { section: "chats", anchor: "missing-row" } })} />);
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Chats" })).toHaveFocus());
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
