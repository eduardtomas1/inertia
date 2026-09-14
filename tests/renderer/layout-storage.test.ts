import { afterEach, expect, it, vi } from "vitest";
import { layoutStorage } from "../../src/renderer/src/utils/layoutStorage";
import { readSplitConversationId, persistSplitConversationId } from "../../src/renderer/src/utils/splitConversation";
import { readLegacyWorkspaceStartup } from "../../src/renderer/src/utils/workspaceStartup";

afterEach(() => vi.unstubAllGlobals());

it.each(["getter", "operation"])("keeps startup and split preferences usable when storage fails at %s", (failure) => {
  const unavailable = (): never => { throw new Error("Storage unavailable"); };
  vi.stubGlobal("window", failure === "getter"
    ? { get localStorage() { return unavailable(); } }
    : { localStorage: { getItem: unavailable, setItem: unavailable, removeItem: unavailable } });
  expect(readSplitConversationId(layoutStorage)).toBeNull();
  expect(readLegacyWorkspaceStartup(layoutStorage)).toBeNull();
  expect(() => persistSplitConversationId(layoutStorage, "conversation")).not.toThrow();
  expect(() => persistSplitConversationId(layoutStorage, null)).not.toThrow();
});

it("preserves successful preference reads, writes and removal", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("window", { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
  persistSplitConversationId(layoutStorage, "conversation");
  expect(readSplitConversationId(layoutStorage)).toBe("conversation");
  persistSplitConversationId(layoutStorage, null);
  expect(readSplitConversationId(layoutStorage)).toBeNull();
});
