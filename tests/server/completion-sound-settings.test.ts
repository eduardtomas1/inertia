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
  completionSoundDue,
  completionSoundName,
  DEFAULT_COMPLETION_SOUND,
  isCompletionSoundSettings,
  parseCompletionSoundJson,
  parseCompletionSoundSettings,
} from "../../src/shared/completion-sound";

const temporaryDirectories: string[] = [];
const ding = { file: "0123456789abcdef.mp3", name: "Ding" } as const;
const rain = { file: "fedcba9876543210.wav", name: "Rain" } as const;
const NUL = String.fromCharCode(0);
const BELL = String.fromCharCode(7);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e);
const LONE_HIGH_SURROGATE = String.fromCharCode(0xd800);
const LONE_LOW_SURROGATE = String.fromCharCode(0xdfff);

function clips(count: number): Array<{ file: string; name: string }> {
  return Array.from({ length: count }, (_, index) => ({ file: `${index.toString(16).padStart(16, "0")}.wav`, name: `Clip ${index}` }));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function openStore(): Promise<{ databasePath: string; workspacePath: string; store: RuntimeStore }> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-completion-sound-"));
  temporaryDirectories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const databasePath = join(directory, "inertia.sqlite");
  return { databasePath, workspacePath, store: new RuntimeStore(databasePath, workspacePath) };
}

describe("completion sound settings normalisation", () => {
  it("is off by default and leaves visual notifications alone", () => {
    expect(DEFAULT_COMPLETION_SOUND).toEqual({
      enabled: false,
      sound: "chime",
      library: [],
      longRunsOnly: false,
      longRunSeconds: 60,
    });
    expect(defaultSettings.completionSound).toEqual(DEFAULT_COMPLETION_SOUND);
    expect(defaultSettings.completionSound).not.toBe(DEFAULT_COMPLETION_SOUND);
    expect(defaultSettings.completionSound.library).not.toBe(DEFAULT_COMPLETION_SOUND.library);
    expect(defaultSettings.desktopNotifications).toBe(true);
  });

  it.each([
    undefined,
    null,
    "bell",
    [],
    { enabled: "yes", sound: "kazoo", library: [{ file: "../x.mp3", name: "x" }], longRunsOnly: 1, longRunSeconds: 2 },
  ])("normalises %j to the defaults", (value) => {
    expect(parseCompletionSoundSettings(value)).toEqual(DEFAULT_COMPLETION_SOUND);
  });

  it("keeps valid fields and never selects a sound missing from the library", () => {
    expect(parseCompletionSoundSettings({
      enabled: true,
      sound: rain.file,
      library: [ding],
      longRunsOnly: true,
      longRunSeconds: 300,
    })).toEqual({ enabled: true, sound: "chime", library: [ding], longRunsOnly: true, longRunSeconds: 300 });
    expect(parseCompletionSoundSettings({ sound: rain.file, library: [ding, rain], longRunSeconds: 7201 }))
      .toEqual({ ...DEFAULT_COMPLETION_SOUND, sound: rain.file, library: [ding, rain] });
  });

  it("repairs the library: drops invalid and duplicate files, cleans names and caps its size", () => {
    expect(parseCompletionSoundSettings({ library: clips(12) }).library).toEqual(clips(8));
    expect(parseCompletionSoundSettings({ library: [
      ding,
      { ...ding, name: "Duplicate" },
      { file: "0123456789abcdef.exe", name: "Program" },
      { file: rain.file, name: `  Soft${NUL}   rain  ` },
      { file: "1111111111111111.ogg" },
      "loose",
    ] }).library).toEqual([ding, { file: rain.file, name: "Soft rain" }]);
  });

  it("keeps display names short and free of control characters", () => {
    expect(completionSoundName(`  Ding${NUL}${RIGHT_TO_LEFT_OVERRIDE} `)).toBe("Ding");
    expect(completionSoundName(BELL)).toBe("My sound");
    expect([...completionSoundName("é".repeat(200))]).toHaveLength(48);
  });

  it("drops lone surrogates from display names and keeps complete pairs", () => {
    expect(completionSoundName(`${LONE_HIGH_SURROGATE}Ding${LONE_LOW_SURROGATE}`)).toBe("Ding");
    expect(completionSoundName(LONE_HIGH_SURROGATE.repeat(48))).toBe("My sound");
    expect(completionSoundName("Bell \u{1f514}")).toBe("Bell \u{1f514}");
  });

  it("decodes stored JSON defensively", () => {
    expect(parseCompletionSoundJson(null)).toEqual(DEFAULT_COMPLETION_SOUND);
    expect(parseCompletionSoundJson("{not json")).toEqual(DEFAULT_COMPLETION_SOUND);
    expect(parseCompletionSoundJson(`{"enabled":true,"x":"${"y".repeat(2100)}"}`)).toEqual(DEFAULT_COMPLETION_SOUND);
    expect(parseCompletionSoundJson('{"enabled":true,"sound":"bell"}'))
      .toEqual({ ...DEFAULT_COMPLETION_SOUND, enabled: true, sound: "bell" });
    expect(JSON.stringify({ ...DEFAULT_COMPLETION_SOUND, library: clips(8).map((clip) => ({ ...clip, name: "é".repeat(48) })) }).length)
      .toBeLessThanOrEqual(2048);
  });

  it("accepts only the complete canonical shape at the event boundary", () => {
    expect(isCompletionSoundSettings({ ...DEFAULT_COMPLETION_SOUND })).toBe(true);
    expect(isCompletionSoundSettings({ ...DEFAULT_COMPLETION_SOUND, sound: ding.file, library: [ding, rain] })).toBe(true);
    expect(isCompletionSoundSettings({ ...DEFAULT_COMPLETION_SOUND, sound: ding.file })).toBe(false);
    expect(isCompletionSoundSettings({ ...DEFAULT_COMPLETION_SOUND, library: [ding, ding] })).toBe(false);
    expect(isCompletionSoundSettings({ ...DEFAULT_COMPLETION_SOUND, library: [{ ...ding, name: " Ding" }] })).toBe(false);
    expect(isCompletionSoundSettings({ ...DEFAULT_COMPLETION_SOUND, library: clips(9) })).toBe(false);
    expect(isCompletionSoundSettings({ ...DEFAULT_COMPLETION_SOUND, longRunSeconds: 4 })).toBe(false);
    expect(isCompletionSoundSettings({ ...DEFAULT_COMPLETION_SOUND, extra: 1 })).toBe(false);
    const { longRunsOnly: _longRunsOnly, ...missing } = DEFAULT_COMPLETION_SOUND;
    expect(isCompletionSoundSettings(missing)).toBe(false);
  });

  it("is due for every finished task unless only long tasks should ring", () => {
    const enabled = { ...DEFAULT_COMPLETION_SOUND, enabled: true };
    expect(completionSoundDue(DEFAULT_COMPLETION_SOUND, 600_000)).toBe(false);
    expect(completionSoundDue(enabled, null)).toBe(true);
    expect(completionSoundDue(enabled, 1_000)).toBe(true);
    const longOnly = { ...enabled, longRunsOnly: true, longRunSeconds: 300 };
    expect(completionSoundDue(longOnly, 299_999)).toBe(false);
    expect(completionSoundDue(longOnly, 300_000)).toBe(true);
    expect(completionSoundDue(longOnly, null)).toBe(false);
  });
});

describe("completion sound persistence", () => {
  it("persists across restart and merges partial updates", async () => {
    const { databasePath, workspacePath, store } = await openStore();
    expect(store.snapshot().settings.completionSound).toEqual(DEFAULT_COMPLETION_SOUND);
    store.updateSettings({ completionSound: { enabled: true, sound: rain.file, library: [ding, rain] } });
    store.updateSettings({ completionSound: { longRunsOnly: true, longRunSeconds: 600 } });
    store.updateSettings({ desktopNotifications: false });
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.snapshot().settings.completionSound).toEqual({
      enabled: true,
      sound: rain.file,
      library: [ding, rain],
      longRunsOnly: true,
      longRunSeconds: 600,
    });
    reopened.updateSettings({ completionSound: { library: [{ ...ding, name: "Door" }] } });
    expect(reopened.snapshot().settings.completionSound)
      .toMatchObject({ sound: "chime", library: [{ ...ding, name: "Door" }] });
    reopened.updateSettings(defaultSettings);
    expect(reopened.snapshot().settings.completionSound).toEqual(DEFAULT_COMPLETION_SOUND);
    reopened.close();
  });

  it("stores eight names of 48 lone surrogates within the column bound", async () => {
    const { databasePath, workspacePath, store } = await openStore();
    const library = clips(8).map((clip) => ({
      file: clip.file as `${string}.wav`,
      name: LONE_HIGH_SURROGATE.repeat(48),
    }));
    expect(() => store.updateSettings({ completionSound: { enabled: true, library } })).not.toThrow();
    store.close();
    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.snapshot().settings.completionSound).toMatchObject({
      enabled: true,
      library: clips(8).map((clip) => ({ ...clip, name: "My sound" })),
    });
    reopened.close();
  });

  it("repairs corrupt stored values and bounds the column", async () => {
    const { databasePath, workspacePath, store } = await openStore();
    store.close();
    const database = new Database(databasePath);
    database.prepare("UPDATE app_state SET completion_sound_json = ? WHERE id = 1")
      .run('{"enabled":true,"sound":"kazoo","longRunSeconds":-3}');
    expect(() => database.prepare("UPDATE app_state SET completion_sound_json = ? WHERE id = 1")
      .run(`"${"x".repeat(2100)}"`)).toThrow(/CHECK constraint/u);
    database.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.snapshot().settings.completionSound).toEqual({ ...DEFAULT_COMPLETION_SOUND, enabled: true });
    reopened.close();
  });
});

describe("completion sound contracts", () => {
  const command = (completionSound: unknown) => ({
    type: "settings.update",
    requestId: crypto.randomUUID(),
    payload: { completionSound },
  });

  it("accepts partial updates with supported values only", () => {
    expect(clientCommandSchema.safeParse(command({ enabled: true })).success).toBe(true);
    expect(clientCommandSchema.safeParse(command({ ...DEFAULT_COMPLETION_SOUND })).success).toBe(true);
    expect(clientCommandSchema.safeParse(command({ sound: ding.file, library: [ding, rain] })).success).toBe(true);
    expect(clientCommandSchema.safeParse(command({ library: [] })).success).toBe(true);
    for (const invalid of [
      { sound: "kazoo" },
      { sound: "../0123456789abcdef.mp3" },
      { library: [{ file: "/etc/passwd", name: "x" }] },
      { library: [{ file: "0123456789abcdef.exe", name: "x" }] },
      { library: [{ ...ding, path: "/tmp/x" }] },
      { library: [ding, ding] },
      { library: [{ ...ding, name: "" }] },
      { library: clips(9) },
      { longRunSeconds: 4 },
      { longRunSeconds: 60.5 },
      { longRunSeconds: 7201 },
      { enabled: "yes" },
      { enabled: true, extra: true },
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
    const { completionSound: _completionSound, ...legacy } = defaultSettings;
    expect(parseServerEvent(snapshotEvent(defaultSettings))).toBeTruthy();
    expect(parseServerEvent(snapshotEvent(legacy))).toBeTruthy();
    expect(() => parseServerEvent(snapshotEvent({
      ...defaultSettings,
      completionSound: { ...DEFAULT_COMPLETION_SOUND, sound: "kazoo" },
    }))).toThrow("Malformed server event");
  });

  it("completes a legacy snapshot with the default sound settings when it is decoded", () => {
    const { completionSound: _completionSound, ...legacy } = defaultSettings;
    const snapshot = {
      projects: [],
      conversations: [],
      runs: [],
      providers: [],
      settings: legacy,
      activeProjectId: null,
      activeConversationId: null,
    };
    const sync = { runtimeGeneration: "legacy-runtime", latestSequence: 1 };
    const decoded = [
      parseServerEvent({ type: "server.welcome", protocolVersion: 1, snapshot }),
      parseServerEvent({ type: "snapshot.updated", snapshot }),
      parseServerEvent({ type: "runtime.event", sync, scope: { kind: "shell" }, event: { type: "snapshot.updated", snapshot } }),
    ].map((event) => {
      const carried = event.type === "runtime.event" ? event.event : event;
      if (carried.type !== "server.welcome" && carried.type !== "snapshot.updated") throw new Error(carried.type);
      return carried.snapshot.settings;
    });
    for (const settings of decoded) {
      expect(settings.completionSound).toEqual(DEFAULT_COMPLETION_SOUND);
      expect(settings).toEqual({ ...legacy, completionSound: DEFAULT_COMPLETION_SOUND });
    }
    expect(decoded[0]!.completionSound).not.toBe(decoded[1]!.completionSound);
    expect(snapshot.settings).not.toHaveProperty("completionSound");
    const current = { ...snapshot, settings: { ...defaultSettings, completionSound: { ...DEFAULT_COMPLETION_SOUND, enabled: true, library: [] } } };
    const kept = parseServerEvent({ type: "snapshot.updated", snapshot: current });
    expect(kept.type === "snapshot.updated" && kept.snapshot.settings.completionSound).toEqual(current.settings.completionSound);
  });
});
