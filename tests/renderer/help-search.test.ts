import { describe, expect, it } from "vitest";

import type { AppShortcutAction } from "../../src/shared/keybindings";
import {
  HELP_INDEX,
  HELP_SEARCH_LIMIT,
  groupHelpHits,
  helpSearchWords,
  highlightHelpText,
  indexHelpTopics,
  searchHelp,
} from "../../src/renderer/src/components/welcome-guide/helpSearch";
import type { HelpTopic } from "../../src/renderer/src/components/welcome-guide/helpTopics";

const macLabel = (action: AppShortcutAction): string => ({
  search: "⌘K",
  "new-chat": "⌘N",
  "toggle-sidebar": "⌘B",
  "toggle-terminal": "⌘J",
})[action];

const otherLabel = (action: AppShortcutAction): string => macLabel(action).replace("⌘", "Ctrl+");

const TOPICS: readonly HelpTopic[] = [
  {
    id: "one",
    title: "Usage and limits",
    summary: "Summary text.",
    entries: [
      { name: "History", detail: "Recorded usage across chats." },
      { name: "Snooze until reset", detail: "Hide the chat until the limit resets." },
    ],
    jumps: [],
  },
  {
    id: "two",
    title: "Workspace tools",
    summary: "Summary text.",
    entries: [
      { name: "Terminal", detail: "Run commands in the project.", shortcut: "toggle-terminal" },
      { name: "Organize chats", detail: "Pin, snooze or archive a chat in its actions." },
      { name: "Crème themes", detail: "Choose a usage color." },
      { name: "Search everything", detail: "Open the palette.", shortcut: "search" },
    ],
    jumps: [],
  },
];

const INDEX = indexHelpTopics(TOPICS);

function names(query: string, label = macLabel, limit?: number): string[] {
  return searchHelp(query, label, INDEX, limit).hits.map(({ entry }) => entry.name);
}

describe("help search words", () => {
  it("lowercases, folds diacritics, splits on punctuation and spells out the command key", () => {
    expect(helpSearchWords("Settings → Model backends, Shift+F10 and Crème brûlée"))
      .toEqual(["settings", "model", "backends", "shift", "f10", "and", "creme", "brulee"]);
    expect(helpSearchWords("⌘K")).toEqual(["cmd", "command", "k"]);
    expect(helpSearchWords("  /plan @file $skill  ")).toEqual(["plan", "file", "skill"]);
    expect(helpSearchWords(" \t ")).toEqual([]);
  });
});

describe("help search", () => {
  it("returns nothing for an empty or punctuation-only query", () => {
    expect(searchHelp("", macLabel, INDEX)).toEqual({ words: [], hits: [], total: 0 });
    expect(searchHelp("  → + ", macLabel, INDEX)).toEqual({ words: [], hits: [], total: 0 });
  });

  it("matches word prefixes, not the middle of words", () => {
    expect(names("snooz")).toEqual(["Snooze until reset", "Organize chats"]);
    expect(names("ooze")).toEqual([]);
  });

  it("requires every query word to match", () => {
    expect(names("snooze pin")).toEqual(["Organize chats"]);
    expect(names("snooze terminal")).toEqual([]);
  });

  it("ranks name matches over shortcut, topic title and detail matches, then keeps document order", () => {
    expect(names("terminal")).toEqual(["Terminal"]);
    expect(names("usage")).toEqual(["History", "Snooze until reset", "Crème themes"]);
    expect(names("chat")).toEqual(["Organize chats", "History", "Snooze until reset"]);
    expect(names("search")).toEqual(["Search everything"]);
    expect(names("k")).toEqual(["Search everything"]);
  });

  it("matches the shortcut label the dialog shows and the shortcut's action name", () => {
    expect(names("cmd k")).toEqual(["Search everything"]);
    expect(names("⌘j")).toEqual(["Terminal"]);
    expect(names("ctrl k")).toEqual([]);
    expect(names("ctrl k", otherLabel)).toEqual(["Search everything"]);
    expect(names("Ctrl+J", otherLabel)).toEqual(["Terminal"]);
    expect(names("toggle")).toEqual(["Terminal"]);
  });

  it("folds diacritics in the query and the text", () => {
    expect(names("creme")).toEqual(["Crème themes"]);
    expect(names("CRÈME")).toEqual(["Crème themes"]);
    expect(names("thémes")).toEqual(["Crème themes"]);
  });

  it("caps the hits and reports how many matched", () => {
    const result = searchHelp("a", macLabel, INDEX, 2);
    expect(result.hits.map(({ entry }) => entry.name)).toEqual(["History", "Snooze until reset"]);
    expect(result.total).toBe(4);
    expect(HELP_SEARCH_LIMIT).toBe(30);
    const everything = searchHelp("s", macLabel);
    expect(everything.total).toBeGreaterThan(HELP_SEARCH_LIMIT);
    expect(everything.hits).toHaveLength(HELP_SEARCH_LIMIT);
  });

  it("groups hits under their topic in order of each topic's best hit", () => {
    const groups = groupHelpHits(searchHelp("usage", macLabel, INDEX).hits);
    expect(groups.map(({ topic, hits }) => [topic.title, hits.map(({ entry }) => entry.name)])).toEqual([
      ["Usage and limits", ["History", "Snooze until reset"]],
      ["Workspace tools", ["Crème themes"]],
    ]);
    expect(groupHelpHits([])).toEqual([]);
  });

  it("indexes every Help entry once", () => {
    expect(HELP_INDEX).toHaveLength(new Set(HELP_INDEX.map(({ entry }) => entry)).size);
    expect(searchHelp("snooz", macLabel).hits.map(({ entry }) => entry.name))
      .toEqual(["Organize chats", "Resume at reset"]);
    expect(searchHelp("no project", macLabel).hits.map(({ entry }) => entry.name))
      .toEqual(["Chats without a project"]);
  });
});

describe("help search highlighting", () => {
  it("marks whole words that start with a query word", () => {
    expect(highlightHelpText("Snooze, then resume at reset.", ["snooz", "res"])).toEqual([
      { text: "Snooze", match: true },
      { text: ", then ", match: false },
      { text: "resume", match: true },
      { text: " at ", match: false },
      { text: "reset", match: true },
      { text: ".", match: false },
    ]);
  });

  it("folds diacritics when marking and leaves text without matches whole", () => {
    expect(highlightHelpText("Crème themes", ["creme"])).toEqual([
      { text: "Crème", match: true },
      { text: " themes", match: false },
    ]);
    expect(highlightHelpText("Nothing here", ["zzz"])).toEqual([{ text: "Nothing here", match: false }]);
    expect(highlightHelpText("Anything", [])).toEqual([{ text: "Anything", match: false }]);
  });
});
