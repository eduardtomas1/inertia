import { describe, expect, it } from "vitest";

import {
  MAX_PROMPT_STASH_ENTRIES,
  PROMPT_STASH_STORAGE_KEY,
  addPromptStashEntry,
  advanceRecurringPrompt,
  promptStashRouteMatches,
  persistPromptStashUpdate,
  readPromptStash,
  removePromptStashEntry,
  setPromptStashRecurrence,
  type PromptStashEntry,
  writePromptStash,
} from "../../src/renderer/src/utils/promptStash";

const route = {
  harnessId: "codex-app-server",
  backendProfileId: "native:codex:app-server",
  modelId: "gpt-5.6-sol",
  reasoningEffort: "xhigh",
} as const;

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: (key: string) =>
      key === PROMPT_STASH_STORAGE_KEY ? value : null,
    setItem: (key: string, next: string) => {
      if (key === PROMPT_STASH_STORAGE_KEY) value = next;
    },
    value: () => value,
  };
}

describe("bounded prompt stash", () => {
  it("persists text with route identity and removes restored entries", () => {
    const storage = memoryStorage();
    const entries = addPromptStashEntry([], "Investigate the lifecycle.", route, {
      id: "stash-one",
      now: "2026-07-29T10:00:00.000Z",
    });

    expect(writePromptStash(storage, entries)).toBe(true);
    expect(readPromptStash(storage)).toEqual(entries);
    expect(removePromptStashEntry(entries, "stash-one")).toEqual([]);
    expect(promptStashRouteMatches(route, entries[0]!.route)).toBe(true);
    expect(promptStashRouteMatches(
      { ...route, reasoningEffort: "high" },
      entries[0]!.route,
    )).toBe(false);
  });

  it("keeps only the newest bounded set and ignores malformed storage", () => {
    let entries: PromptStashEntry[] = [];
    for (let index = 0; index < MAX_PROMPT_STASH_ENTRIES + 4; index += 1) {
      entries = addPromptStashEntry(
        entries,
        `Prompt ${index}`,
        route,
        {
          id: `stash-${index}`,
          now: `2026-07-29T10:${String(index).padStart(2, "0")}:00.000Z`,
        },
      );
    }
    expect(entries).toHaveLength(MAX_PROMPT_STASH_ENTRIES);
    expect(entries[0]?.content).toBe(
      `Prompt ${MAX_PROMPT_STASH_ENTRIES + 3}`,
    );
    expect(readPromptStash(memoryStorage("{broken"))).toEqual([]);
  });

  it("bounds retained UTF-8 bytes as well as the entry count", () => {
    const storage = memoryStorage();
    let entries: PromptStashEntry[] = [];
    for (let index = 0; index < MAX_PROMPT_STASH_ENTRIES; index += 1) {
      entries = addPromptStashEntry(
        entries,
        "界".repeat(20_000),
        route,
        {
          id: `unicode-${index}`,
          now: `2026-07-29T11:${String(index).padStart(2, "0")}:00.000Z`,
        },
      );
    }
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(MAX_PROMPT_STASH_ENTRIES);
    expect(writePromptStash(storage, entries)).toBe(true);
    expect(new TextEncoder().encode(storage.value() ?? "").byteLength)
      .toBeLessThanOrEqual(256 * 1024);
    expect(readPromptStash(storage)).toEqual(entries);
  });

  it("does not publish an in-memory update when persistence fails", () => {
    const entries = addPromptStashEntry(
      [],
      "Keep this prompt safe.",
      route,
      { id: "safe-prompt", now: "2026-07-29T12:00:00.000Z" },
    );
    const failingStorage = {
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };

    expect(persistPromptStashUpdate(
      failingStorage,
      entries,
      () => [],
    )).toBeNull();
    expect(entries).toHaveLength(1);
  });

  it("keeps recurring prompts after restore and advances their reminder", () => {
    const entries = addPromptStashEntry([], "Review open work.", route, {
      id: "recurring-one",
      now: "2026-07-29T10:00:00.000Z",
    });
    const scheduled = setPromptStashRecurrence(
      entries,
      "recurring-one",
      "daily",
      Date.parse("2026-07-29T10:00:00.000Z"),
    );
    expect(scheduled[0]).toMatchObject({
      recurrence: "daily",
      nextDueAt: "2026-07-30T10:00:00.000Z",
    });
    expect(advanceRecurringPrompt(
      scheduled,
      "recurring-one",
      Date.parse("2026-07-30T10:00:00.000Z"),
    )[0]).toMatchObject({
      recurrence: "daily",
      nextDueAt: "2026-07-31T10:00:00.000Z",
    });
    expect(setPromptStashRecurrence(
      scheduled,
      "recurring-one",
      undefined,
    )[0]).not.toHaveProperty("recurrence");
  });
});
