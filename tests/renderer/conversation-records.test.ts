import { describe, expect, it, vi } from "vitest";

import { recordsOwnedByConversation } from "../../src/renderer/src/utils/conversationRecords";

describe("records owned by a conversation", () => {
  it("scans an unchanged record list once and keeps the filtered list stable", () => {
    const records = [
      { id: "a", conversationId: "chat" },
      { id: "b", conversationId: "other" },
      { id: "c", conversationId: "chat" },
    ];
    const every = vi.spyOn(records, "every");
    const first = recordsOwnedByConversation(records, "chat");
    const second = recordsOwnedByConversation(records, "chat");
    expect(first.map(({ id }) => id)).toEqual(["a", "c"]);
    expect(second).toBe(first);
    expect(every).toHaveBeenCalledTimes(1);
    expect(recordsOwnedByConversation(records, "other").map(({ id }) => id)).toEqual(["b"]);
    expect(recordsOwnedByConversation(records, null)).toEqual([]);
  });

  it("returns the list itself when every record belongs to the conversation", () => {
    const records = [{ id: "a", conversationId: "chat" }];
    expect(recordsOwnedByConversation(records, "chat")).toBe(records);
    const next = [...records, { id: "b", conversationId: "chat" }];
    expect(recordsOwnedByConversation(next, "chat")).toBe(next);
  });
});
