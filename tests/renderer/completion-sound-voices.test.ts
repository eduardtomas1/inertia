import { describe, expect, it } from "vitest";

import { BUILT_IN_COMPLETION_SOUNDS } from "../../src/shared/completion-sound";
import { COMPLETION_SOUND_VOICES } from "../../src/renderer/src/utils/completionSoundPlayer";
import { completionSoundTriggered } from "../../src/renderer/src/hooks/useCompletionSounds";
import { checkingWatcherIds } from "../../src/renderer/src/hooks/useThreadNotifications";
import type { AppSnapshot, ConversationShell } from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts";
import { WATCHED_ID, WATCHER_ID, link, project, shell } from "./watcher-fixtures";

function fakeContext() {
  const stops: number[] = [];
  const param = () => ({
    value: 0,
    setValueAtTime() { return this; },
    exponentialRampToValueAtTime() { return this; },
    linearRampToValueAtTime() { return this; },
  });
  const node = () => ({ connect: (target: unknown) => target });
  const context = {
    createOscillator: () => ({
      ...node(),
      type: "sine",
      frequency: param(),
      detune: param(),
      start() {},
      stop(at: number) { stops.push(at); },
    }),
    createGain: () => ({ ...node(), gain: param() }),
    createBiquadFilter: () => ({ ...node(), type: "lowpass", frequency: param() }),
  };
  return { context: context as unknown as BaseAudioContext, stops };
}

describe("built-in completion sounds", () => {
  it.each(BUILT_IN_COMPLETION_SOUNDS)("%s lasts between 1 and 3 seconds and reports its true end", (sound) => {
    const { context, stops } = fakeContext();
    const start = 10;
    const end = COMPLETION_SOUND_VOICES[sound](context, {} as AudioNode, start);
    expect(stops.length).toBeGreaterThan(0);
    expect(end).toBe(Math.max(...stops));
    expect(end - start).toBeGreaterThanOrEqual(1);
    expect(end - start).toBeLessThanOrEqual(3);
  });
});

describe("completion sounds for watchers", () => {
  const settings = { ...defaultSettings.completionSound, enabled: true, longRunsOnly: false };
  const snapshot = (conversations: ConversationShell[], watchers = [link()]): AppSnapshot => ({
    projects: [project],
    conversations,
    runs: [],
    providers: [],
    settings: defaultSettings,
    activeProjectId: project.id,
    activeConversationId: null,
    watchers,
  });
  const finished = (id: string) => shell(id, "Chat", { status: "completed", completedAt: "2026-10-19T10:50:00.000Z" });
  const running = (id: string) => shell(id, "Chat", { status: "running" });

  const checking = [link({ status: "waking" })];

  it("never rings when only a watcher's check finished", () => {
    const previous = new Map([[WATCHER_ID, running(WATCHER_ID)]]);
    expect(completionSoundTriggered(snapshot([finished(WATCHER_ID)]), previous, new Map(), settings, checkingWatcherIds(checking))).toBe(false);
  });

  it("still rings for the watched chat itself", () => {
    const previous = new Map([[WATCHED_ID, running(WATCHED_ID)], [WATCHER_ID, running(WATCHER_ID)]]);
    expect(completionSoundTriggered(snapshot([finished(WATCHED_ID), finished(WATCHER_ID)]), previous, new Map(), settings, checkingWatcherIds(checking))).toBe(true);
  });

  it("rings when the watcher answers a question the user asked it", () => {
    const previous = new Map([[WATCHER_ID, running(WATCHER_ID)]]);
    expect(completionSoundTriggered(snapshot([finished(WATCHER_ID)]), previous, new Map(), settings, checkingWatcherIds([link()]))).toBe(true);
  });
});
