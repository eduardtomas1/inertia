import { describe, expect, it } from "vitest";

import { removeLegacyDisclosurePreferences } from "../../src/renderer/src/utils/legacyDisclosurePreferences";

function memoryStorage(entries: Record<string, string>): Storage {
  const values = new Map(Object.entries(entries));
  return {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
  };
}

describe("legacy delegated-task disclosure preferences", () => {
  it("removes every old open-state key and nothing else", () => {
    const storage = memoryStorage({
      ...Object.fromEntries(Array.from({ length: 256 }, (_, index) =>
        [`inertia:subagent-disclosure:v1:conversation-${index}:turn-${index}`, "1"])),
      "inertia:layout": "{}",
      "inertia:subagent-disclosure:v2:keep": "1",
    });
    removeLegacyDisclosurePreferences(() => storage);
    expect(Array.from({ length: storage.length }, (_, index) => storage.key(index)).sort())
      .toEqual(["inertia:layout", "inertia:subagent-disclosure:v2:keep"]);
  });

  it("does nothing when storage is unavailable or fails", () => {
    expect(() => removeLegacyDisclosurePreferences(() => { throw new Error("blocked"); })).not.toThrow();
    const failing = memoryStorage({ "inertia:subagent-disclosure:v1:a:b": "1" });
    failing.removeItem = () => { throw new Error("quota"); };
    expect(() => removeLegacyDisclosurePreferences(() => failing)).not.toThrow();
  });
});
