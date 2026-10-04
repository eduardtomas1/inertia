import { describe, expect, it } from "vitest";

import { searchSettings } from "../../src/renderer/src/components/settings/settingsMatcher";
import { SETTINGS_ROWS, SETTINGS_SECTION_ROWS, type SettingsSectionRows } from "../../src/renderer/src/components/settingsRows";

const sections: SettingsSectionRows[] = [
  {
    id: "appearance",
    label: "Appearance",
    rows: [
      { id: "theme", sectionId: "appearance", title: "Theme", keywords: ["dark mode", "palette"], group: "Colours" },
      { id: "scale", sectionId: "appearance", title: "Interface scale", keywords: ["zoom", "theme size"], group: "Scale" },
      { id: "glow", sectionId: "appearance", title: "Glow", keywords: ["halo"], group: "Theme extras" },
    ],
  },
  {
    id: "chats",
    label: "Chats",
    rows: [
      { id: "mode", sectionId: "chats", title: "Work mode", keywords: ["build"], group: "New chats" },
      { id: "cafe", sectionId: "chats", title: "Café résumé", keywords: ["accents"], group: "Transcript" },
    ],
  },
];

function ids(query: string, from: readonly SettingsSectionRows[] = sections): string[] {
  return searchSettings(query, from).flatMap(({ results }) => results.map(({ row }) => row.id));
}

describe("settings search matcher", () => {
  it("returns nothing for an empty or punctuation-only query", () => {
    expect(searchSettings("", sections)).toEqual([]);
    expect(searchSettings("   ", sections)).toEqual([]);
    expect(searchSettings(" - · ", sections)).toEqual([]);
  });

  it("ranks title matches above keyword matches above group matches", () => {
    expect(ids("theme")).toEqual(["theme", "scale", "glow"]);
    const [group] = searchSettings("theme", sections);
    expect(group!.results.map(({ score }) => score)).toEqual([9, 4, 2]);
  });

  it("matches word prefixes, not the middle of words", () => {
    expect(ids("sca")).toEqual(["scale"]);
    expect(ids("cale")).toEqual([]);
    expect(ids("ode")).toEqual([]);
  });

  it("requires every query word to match somewhere in the row", () => {
    expect(ids("dark mode")).toEqual(["theme"]);
    expect(ids("mode")).toEqual(["mode", "theme"]);
    expect(ids("dark build")).toEqual([]);
  });

  it("ignores case and diacritics in both the query and the metadata", () => {
    expect(ids("CAFE")).toEqual(["cafe"]);
    expect(ids("resume")).toEqual(["cafe"]);
    expect(ids("Résumé")).toEqual(["cafe"]);
    expect(ids("thème")).toEqual(["theme", "scale", "glow"]);
  });

  it("matches section labels and group labels", () => {
    expect(ids("chats")).toEqual(["mode", "cafe"]);
    expect(ids("transcript")).toEqual(["cafe"]);
  });

  it("orders sections by their best match and keeps registry order between equal scores", () => {
    expect(searchSettings("mode", sections).map(({ label }) => label)).toEqual(["Chats", "Appearance"]);
    expect(searchSettings("a", sections).map(({ label }) => label)).toEqual(["Chats", "Appearance"]);
    const copy = { ...sections[0]!, id: "chats" as const, label: "Copy" };
    expect(searchSettings("glow", [sections[0]!, copy]).map(({ label }) => label)).toEqual(["Appearance", "Copy"]);
    expect(searchSettings("glow", [copy, sections[0]!]).map(({ label }) => label)).toEqual(["Copy", "Appearance"]);
  });

  it("marks the matching prefix of each title word, mapped back through accents", () => {
    const result = (query: string) => searchSettings(query, sections)[0]!.results[0]!;
    expect(result("int sc").ranges).toEqual([[0, 3], [10, 12]]);
    expect(result("cafe").ranges).toEqual([[0, 4]]);
    expect(result("resu").ranges).toEqual([[5, 9]]);
    expect(result("dark").ranges).toEqual([]);
  });

  it.each([
    ["theme", "appearance-mode"],
    ["dark mode", "appearance-mode"],
    ["zoom", "interface-scale"],
    ["font", "interface-scale"],
    ["sounds", "completion-sound"],
    ["mute", "desktop-notifications"],
    ["hotkey", "shortcut-search"],
    ["keyboard shortcuts", "shortcut-search"],
    ["worktree", "new-chat-location"],
    ["screenshot", "snapshot-shortcut"],
    ["backup", "database-backup"],
    ["where my data is", "resource-health"],
    ["logs", "diagnostics-incidents"],
    ["version", "provider-updates"],
    ["mascot", "desktop-mascot"],
    ["quota", "usage-display"],
    ["keybindings", "shortcut-search"],
    ["source control", "wrap-diffs"],
    ["backends", "model-backends"],
    ["connections", "provider-accounts"],
    ["archive", "resource-health"],
  ])("finds %s in the real settings metadata", (query, id) => {
    expect(ids(query, SETTINGS_SECTION_ROWS)).toContain(id);
  });

  it("puts the row titled with the query first in the real settings metadata", () => {
    expect(ids("theme", SETTINGS_SECTION_ROWS)[0]).toBe("appearance-mode");
    expect(ids("interface scale", SETTINGS_SECTION_ROWS)[0]).toBe("interface-scale");
    expect(ids("quota warnings", SETTINGS_SECTION_ROWS)[0]).toBe("quota-warnings");
  });

  it("gives every real row a title, keywords and a group", () => {
    for (const row of SETTINGS_ROWS) {
      expect(row.title.trim()).not.toBe("");
      expect(row.group.trim()).not.toBe("");
      expect(row.keywords.length).toBeGreaterThan(0);
      expect(row.keywords.every((keyword) => keyword.trim() !== "")).toBe(true);
    }
  });
});
