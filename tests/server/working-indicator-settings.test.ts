import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import { defaultSettings } from "../../src/shared/contracts/app";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";
import {
  DEFAULT_WORKING_INDICATOR,
  isWorkingIndicatorSettings,
  normalizeHexColor,
  parseWorkingIndicatorJson,
  parseWorkingIndicatorSettings,
  WORKING_INDICATOR_STYLES,
} from "../../src/shared/working-indicator";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function openStore(): Promise<{ databasePath: string; workspacePath: string; store: RuntimeStore }> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-working-indicator-"));
  temporaryDirectories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const databasePath = join(directory, "inertia.sqlite");
  return { databasePath, workspacePath, store: new RuntimeStore(databasePath, workspacePath) };
}

describe("working indicator settings normalisation", () => {
  it("defaults to the classic grid with the approved options", () => {
    expect(DEFAULT_WORKING_INDICATOR).toEqual({
      style: "classic",
      color: "ink",
      customColor: "#ff5fd2",
      glow: false,
      activity: true,
      speed: "normal",
    });
    expect(defaultSettings.workingIndicator).toEqual(DEFAULT_WORKING_INDICATOR);
    expect(defaultSettings.workingIndicator).not.toBe(DEFAULT_WORKING_INDICATOR);
    expect(WORKING_INDICATOR_STYLES).toEqual([
      "classic", "automatic", "working", "searching", "solving", "listening",
      "connecting", "weaving", "composing", "breathing", "shaping",
    ]);
  });

  it.each([
    undefined,
    null,
    "automatic",
    42,
    [],
    { style: "sparkles", color: "plaid", customColor: "red", glow: "yes", activity: 1, speed: 2 },
  ])("normalises %j to the defaults", (value) => {
    expect(parseWorkingIndicatorSettings(value)).toEqual(DEFAULT_WORKING_INDICATOR);
  });

  it("keeps each valid field and repairs only the corrupt ones", () => {
    expect(parseWorkingIndicatorSettings({
      style: "automatic",
      color: "custom",
      customColor: "#ABC",
      glow: true,
      activity: "no",
      speed: "lively",
      extra: "ignored",
    })).toEqual({
      style: "automatic",
      color: "custom",
      customColor: "#aabbcc",
      glow: true,
      activity: true,
      speed: "lively",
    });
  });

  it("normalises colours to lowercase #rrggbb", () => {
    expect(normalizeHexColor("#C77DFF")).toBe("#c77dff");
    expect(normalizeHexColor(" #0f8 ")).toBe("#00ff88");
    for (const invalid of ["c77dff", "#c77df", "#c77dfff0", "rgb(1,2,3)", "#ggg", "", null, 7]) {
      expect(normalizeHexColor(invalid)).toBeNull();
    }
  });

  it("decodes stored JSON defensively", () => {
    expect(parseWorkingIndicatorJson('{"style":"searching","glow":true}')).toEqual({
      ...DEFAULT_WORKING_INDICATOR,
      style: "searching",
      glow: true,
    });
    expect(parseWorkingIndicatorJson("{broken")).toEqual(DEFAULT_WORKING_INDICATOR);
    expect(parseWorkingIndicatorJson(null)).toEqual(DEFAULT_WORKING_INDICATOR);
    expect(parseWorkingIndicatorJson(`{"style":"automatic","pad":"${"x".repeat(600)}"}`))
      .toEqual(DEFAULT_WORKING_INDICATOR);
  });

  it("accepts only the complete canonical shape at the event boundary", () => {
    expect(isWorkingIndicatorSettings({ ...DEFAULT_WORKING_INDICATOR })).toBe(true);
    expect(isWorkingIndicatorSettings({ ...DEFAULT_WORKING_INDICATOR, customColor: "#ABCDEF" })).toBe(false);
    expect(isWorkingIndicatorSettings({ ...DEFAULT_WORKING_INDICATOR, extra: 1 })).toBe(false);
    const { glow: _glow, ...missing } = DEFAULT_WORKING_INDICATOR;
    expect(isWorkingIndicatorSettings(missing)).toBe(false);
  });
});

describe("working indicator persistence", () => {
  it("persists across restart and merges partial updates", async () => {
    const { databasePath, workspacePath, store } = await openStore();
    expect(store.snapshot().settings.workingIndicator).toEqual(DEFAULT_WORKING_INDICATOR);
    store.updateSettings({ workingIndicator: { style: "automatic", color: "lilac" } });
    store.updateSettings({ workingIndicator: { glow: true } });
    store.updateSettings({ theme: "light" });
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.snapshot().settings.workingIndicator).toEqual({
      ...DEFAULT_WORKING_INDICATOR,
      style: "automatic",
      color: "lilac",
      glow: true,
    });
    reopened.updateSettings(defaultSettings);
    expect(reopened.snapshot().settings.workingIndicator).toEqual(DEFAULT_WORKING_INDICATOR);
    reopened.close();
  });

  it("repairs corrupt stored values and bounds the column", async () => {
    const { databasePath, workspacePath, store } = await openStore();
    store.close();
    const database = new Database(databasePath);
    database.prepare("UPDATE app_state SET working_indicator_json = ? WHERE id = 1")
      .run('{"style":"neon-rainbow","color":"accent","speed":"warp"}');
    expect(() => database.prepare("UPDATE app_state SET working_indicator_json = ? WHERE id = 1")
      .run(`"${"x".repeat(600)}"`)).toThrow(/CHECK constraint/u);
    database.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.snapshot().settings.workingIndicator).toEqual({
      ...DEFAULT_WORKING_INDICATOR,
      color: "accent",
    });
    reopened.close();
  });
});

describe("working indicator contracts", () => {
  const command = (workingIndicator: unknown) => ({
    type: "settings.update",
    requestId: crypto.randomUUID(),
    payload: { workingIndicator },
  });

  it("accepts partial updates with supported values only", () => {
    expect(clientCommandSchema.safeParse(command({ style: "automatic" })).success).toBe(true);
    expect(clientCommandSchema.safeParse(command({ ...DEFAULT_WORKING_INDICATOR })).success).toBe(true);
    expect(clientCommandSchema.safeParse(command({ color: "custom", customColor: "#1a2b3c" })).success)
      .toBe(true);
    for (const invalid of [
      { style: "sparkles" },
      { color: "plaid" },
      { customColor: "#ABCDEF" },
      { customColor: "#abc" },
      { glow: "yes" },
      { speed: 1.4 },
      { style: "automatic", extra: true },
    ]) {
      expect(clientCommandSchema.safeParse(command(invalid)).success).toBe(false);
    }
  });

  it("validates the snapshot projection while tolerating legacy snapshots", () => {
    const snapshotEvent = (settings: unknown): unknown => ({
      type: "snapshot.updated",
      snapshot: {
        projects: [],
        conversations: [],
        runs: [],
        providers: [],
        settings,
        activeProjectId: null,
        activeConversationId: null,
      },
    });
    const { workingIndicator: _workingIndicator, ...legacy } = defaultSettings;
    expect(parseServerEvent(snapshotEvent(defaultSettings))).toBeTruthy();
    expect(parseServerEvent(snapshotEvent(legacy))).toBeTruthy();
    expect(() => parseServerEvent(snapshotEvent({
      ...defaultSettings,
      workingIndicator: { ...DEFAULT_WORKING_INDICATOR, style: "sparkles" },
    }))).toThrow("Malformed server event");
  });
});
