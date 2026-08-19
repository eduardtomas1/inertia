import { afterEach, describe, expect, it } from "vitest";

import {
  readSubagentDisclosureOpen,
  writeSubagentDisclosureOpen,
} from "../../src/renderer/src/utils/subagentDisclosurePreference";

afterEach(() => {
  window.localStorage.clear();
});

describe("delegated-agent disclosure preference", () => {
  it("fails folded when storage is malformed or unavailable", () => {
    const identity = { conversationId: "conversation-1", turnId: "turn-1" };
    writeSubagentDisclosureOpen(window.localStorage, identity, true, 10);
    const key = window.localStorage.key(0)!;
    window.localStorage.setItem(key, "corrupt");
    expect(readSubagentDisclosureOpen(window.localStorage, identity)).toBe(false);

    const unavailable = {
      getItem: () => { throw new Error("unavailable"); },
    } as unknown as Storage;
    expect(readSubagentDisclosureOpen(unavailable, identity)).toBe(false);
    expect(() => writeSubagentDisclosureOpen(
      unavailable,
      identity,
      true,
      20,
    )).not.toThrow();
  });

  it("keeps only the 256 most recently opened rosters and removes folded ones", () => {
    for (let index = 0; index < 257; index += 1) {
      writeSubagentDisclosureOpen(window.localStorage, {
        conversationId: "conversation-1",
        turnId: `turn-${index}`,
      }, true, index + 1);
    }

    expect(window.localStorage).toHaveLength(256);
    expect(readSubagentDisclosureOpen(window.localStorage, {
      conversationId: "conversation-1",
      turnId: "turn-0",
    })).toBe(false);
    const newest = { conversationId: "conversation-1", turnId: "turn-256" };
    expect(readSubagentDisclosureOpen(window.localStorage, newest)).toBe(true);

    writeSubagentDisclosureOpen(window.localStorage, newest, false);
    expect(readSubagentDisclosureOpen(window.localStorage, newest)).toBe(false);
    expect(window.localStorage).toHaveLength(255);
  });
});
