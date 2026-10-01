import { describe, expect, it } from "vitest";

import { SETTINGS_SECTIONS } from "../../src/renderer/src/components/settingsSections";
import {
  HELP_COMMANDS,
  HELP_TOPICS,
  type HelpTopic,
} from "../../src/renderer/src/components/welcome-guide/helpTopics";
import { WELCOME_TOPICS } from "../../src/renderer/src/components/welcome-guide/welcomeGuideModel";
import { DEFAULT_APP_KEYBINDINGS } from "../../src/shared/keybindings";
import {
  RIGHT_PANEL_SURFACE_META,
  RIGHT_PANEL_SURFACES,
} from "../../src/renderer/src/utils/rightPanelSurfaces";

const SETTINGS_ARROW = "Settings → ";

function helpTopicProblems(topics: readonly HelpTopic[]): string[] {
  const problems: string[] = [];
  const sectionLabels = new Map(SETTINGS_SECTIONS.map(({ id, label }) => [id as string, label]));
  const commands = new Set<string>(HELP_COMMANDS);
  const shortcuts = new Set(Object.keys(DEFAULT_APP_KEYBINDINGS));
  const demos = new Set<string>(WELCOME_TOPICS.map(({ id }) => id));
  const topicIds = new Set<string>();
  for (const topic of topics) {
    if (topicIds.has(topic.id)) problems.push(`${topic.id}: duplicate topic`);
    topicIds.add(topic.id);
    if (topic.entries.length === 0) problems.push(`${topic.id}: no entries`);
    if (topic.demo !== undefined && !demos.has(topic.demo)) {
      problems.push(`${topic.id}: unknown demo ${topic.demo}`);
    }
    const names = topic.entries.map(({ name }) => name);
    if (new Set(names).size !== names.length) problems.push(`${topic.id}: duplicate entry`);
    for (const entry of topic.entries) {
      if (entry.shortcut !== undefined && !shortcuts.has(entry.shortcut)) {
        problems.push(`${topic.id}: unknown shortcut ${entry.shortcut}`);
      }
    }
    for (const jump of topic.jumps) {
      if ("command" in jump) {
        if (!commands.has(jump.command)) problems.push(`${topic.id}: unknown command ${jump.command}`);
        continue;
      }
      const label = sectionLabels.get(jump.settings);
      if (!label) problems.push(`${topic.id}: unknown settings section ${jump.settings}`);
      else if (jump.label !== `Open ${SETTINGS_ARROW}${label}`) {
        problems.push(`${topic.id}: jump label ${jump.label} does not name ${label}`);
      }
    }
    const text = [
      topic.title,
      topic.summary,
      ...topic.entries.flatMap(({ name, detail }) => [name, detail]),
      ...topic.jumps.map(({ label }) => label),
    ];
    for (const value of text) {
      if (value.trim() !== value || value.length === 0) problems.push(`${topic.id}: blank or padded text`);
      if (/[<>]|:\/\//u.test(value)) problems.push(`${topic.id}: markup or address in ${value}`);
      for (const mention of value.split(SETTINGS_ARROW).slice(1)) {
        if (![...sectionLabels.values()].some((label) => mention.startsWith(label))) {
          problems.push(`${topic.id}: unknown settings mention ${mention}`);
        }
      }
    }
  }
  return problems;
}

describe("help topics", () => {
  it("only reference commands, settings sections, shortcuts and demos that exist", () => {
    expect(helpTopicProblems(HELP_TOPICS)).toEqual([]);
  });

  it("reports every kind of broken reference", () => {
    const broken = {
      id: "broken",
      title: "Broken",
      summary: "Open Settings → Appearance.",
      demo: "missing",
      entries: [{ name: "Entry", detail: "Visit https://example.com", shortcut: "open-help" }],
      jumps: [
        { label: "Run", command: "missing-command" },
        { label: "Open Settings → Themes", settings: "themes" },
        { label: "Open Settings → Anything", settings: "general" },
      ],
    } as unknown as HelpTopic;

    expect(helpTopicProblems([broken, broken])).toEqual(expect.arrayContaining([
      "broken: duplicate topic",
      "broken: unknown demo missing",
      "broken: unknown shortcut open-help",
      "broken: unknown command missing-command",
      "broken: unknown settings section themes",
      "broken: jump label Open Settings → Anything does not name General",
      "broken: markup or address in Visit https://example.com",
      "broken: unknown settings mention Appearance.",
    ]));
  });

  it("covers the features the first-run tour introduces and groups the rest", () => {
    expect(HELP_TOPICS.map(({ title }) => title)).toEqual([
      "Getting started",
      "Chat and composer",
      "Following work",
      "Workspace tools",
      "Side by side",
      "Review and ship",
      "Search and history",
      "Usage and limits",
      "Snapshots and devices",
      "Appearance",
      "Keyboard",
      "Troubleshooting",
    ]);
    expect(new Set(HELP_TOPICS.flatMap(({ demo }) => (demo ? [demo] : []))))
      .toEqual(new Set(["work", "split", "ship", "limits", "keys"]));
    const keyboard = HELP_TOPICS.find(({ id }) => id === "keys")!;
    expect(keyboard.entries.flatMap(({ shortcut }) => (shortcut ? [shortcut] : [])))
      .toEqual(Object.keys(DEFAULT_APP_KEYBINDINGS));
  });

  it("names every right panel surface by its current label", () => {
    const entries = HELP_TOPICS.flatMap(({ entries: topicEntries }) => topicEntries);
    const surfaces = entries.find(({ name }) => name === "Surfaces")!;
    for (const surface of RIGHT_PANEL_SURFACES) {
      expect(surfaces.detail).toContain(RIGHT_PANEL_SURFACE_META[surface].label);
    }
    const delegated = entries.find(({ name }) => name === "Plan, goal and subagents")!;
    expect(delegated.detail).toContain(`${RIGHT_PANEL_SURFACE_META.agents.label} surface`);
  });
});
