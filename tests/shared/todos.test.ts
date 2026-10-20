import { describe, expect, it } from "vitest";

import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import {
  boundTodoText,
  compareTodos,
  MAX_TODO_NOTE_CHARS,
  MAX_TODO_TITLE_CHARS,
  todoDraftFromMessage,
  todoDraftFromPlanStep,
  todoDraftSchema,
  todoDueDateSchema,
  todoPatchSchema,
  todoPromptContent,
  todoSchema,
  todosSerializedBytes,
  type Todo,
} from "../../src/shared/todos";

const ID = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";

function todo(overrides: Partial<Todo> = {}): Todo {
  return {
    id: ID,
    title: "Task",
    note: "",
    priority: null,
    dueDate: null,
    completedAt: null,
    conversationId: null,
    createdAt: "2026-10-12T10:00:00.000Z",
    updatedAt: "2026-10-12T10:00:00.000Z",
    ...overrides,
  };
}

describe("task schemas", () => {
  it("trims titles, defaults optional fields and rejects unsafe drafts", () => {
    expect(todoDraftSchema.parse({ title: "  Write notes  " })).toEqual({
      title: "Write notes", note: "", priority: null, dueDate: null,
    });
    for (const invalid of [
      { title: "" },
      { title: "   " },
      { title: "x".repeat(MAX_TODO_TITLE_CHARS + 1) },
      { title: "One\ntwo" },
      { title: "One\rtwo" },
      { title: "Nul\0" },
      { title: "Task", note: "n".repeat(MAX_TODO_NOTE_CHARS + 1) },
      { title: "Task", note: "\0" },
      { title: "Task", priority: "soon" },
      { title: "Task", extra: true },
    ]) expect(todoDraftSchema.safeParse(invalid).success).toBe(false);
    expect(todoDraftSchema.safeParse({ title: "x".repeat(MAX_TODO_TITLE_CHARS), note: "n".repeat(MAX_TODO_NOTE_CHARS) }).success).toBe(true);
  });

  it("accepts an optional chat link on a draft", () => {
    expect(todoDraftSchema.parse({ title: "Task", conversationId: ID })).toEqual({
      title: "Task", note: "", priority: null, dueDate: null, conversationId: ID,
    });
    expect(todoDraftSchema.parse({ title: "Task" })).not.toHaveProperty("conversationId");
    for (const conversationId of ["chat-1", "", null]) {
      expect(todoDraftSchema.safeParse({ title: "Task", conversationId }).success).toBe(false);
    }
  });

  it("accepts only real calendar days as due dates", () => {
    for (const valid of ["2026-10-12", "2028-02-29", "2026-12-31"]) {
      expect(todoDueDateSchema.safeParse(valid).success).toBe(true);
    }
    for (const invalid of [
      "2026-02-30", "2027-02-29", "2026-13-01", "2026-00-10", "2026-04-31",
      "2026-1-01", "26-10-12", "2026-10-12T00:00:00.000Z", "", "tomorrow",
    ]) expect(todoDueDateSchema.safeParse(invalid).success).toBe(false);
  });

  it("requires a patch to change something and allows clearing priority and due date", () => {
    expect(todoPatchSchema.safeParse({}).success).toBe(false);
    expect(todoPatchSchema.safeParse({ title: undefined }).success).toBe(false);
    expect(todoPatchSchema.parse({ priority: null })).toEqual({ priority: null });
    expect(todoPatchSchema.parse({ dueDate: null, completed: false })).toEqual({ dueDate: null, completed: false });
    expect(todoPatchSchema.safeParse({ conversationId: ID }).success).toBe(false);
    expect(todoPatchSchema.safeParse({ completedAt: "2026-10-12T10:00:00.000Z" }).success).toBe(false);
  });

  it("validates stored tasks strictly", () => {
    expect(todoSchema.parse(todo({ conversationId: PROJECT, completedAt: "2026-10-12T11:00:00.000Z" }))).toBeTruthy();
    for (const invalid of [
      todo({ id: "task-1" }),
      todo({ conversationId: "chat-1" }),
      todo({ completedAt: "yesterday" }),
      { ...todo(), extra: true },
    ]) expect(todoSchema.safeParse(invalid).success).toBe(false);
  });

  it("validates task commands at the client command boundary", () => {
    const command = (type: string, payload: unknown) => clientCommandSchema.safeParse({ type, requestId: ID, payload });
    expect(command("todo.create", { id: ID, title: "Task" }).success).toBe(true);
    expect(command("todo.create", { title: "Task" }).success).toBe(false);
    expect(command("todo.create", { id: ID, title: "Task", conversationId: ID, projectId: PROJECT }).success).toBe(true);
    expect(command("todo.create", { id: ID, title: "Task", conversationId: ID }).success).toBe(false);
    expect(command("todo.create", { id: ID, title: "Task", projectId: PROJECT }).success).toBe(false);
    expect(command("todo.create", { id: ID, title: "Task", conversationId: ID, projectId: "project" }).success).toBe(false);
    expect(command("todo.update", { id: ID, patch: { completed: true } }).success).toBe(true);
    expect(command("todo.update", { id: ID, patch: {} }).success).toBe(false);
    expect(command("todo.delete", { id: ID }).success).toBe(true);
    expect(command("todo.start", { id: ID, conversation: { projectId: PROJECT, accessMode: "auto-edit", useWorktree: true } }).success).toBe(true);
    for (const forbidden of [{ title: "Chat" }, { activate: true }, { draftConversationId: ID }]) {
      expect(command("todo.start", { id: ID, conversation: { projectId: PROJECT, ...forbidden } }).success).toBe(false);
    }
  });
});

describe("task ordering and prompt", () => {
  it("orders by priority, then creation time, then id", () => {
    const later = "2026-10-12T11:00:00.000Z";
    const tasks = [
      todo({ id: "a0000000-0000-4000-8000-000000000006", priority: null }),
      todo({ id: "a0000000-0000-4000-8000-000000000005", priority: "low" }),
      todo({ id: "a0000000-0000-4000-8000-000000000004", priority: "medium", createdAt: later }),
      todo({ id: "a0000000-0000-4000-8000-000000000003", priority: "medium" }),
      todo({ id: "a0000000-0000-4000-8000-000000000002", priority: "high" }),
      todo({ id: "a0000000-0000-4000-8000-000000000001", priority: "urgent", createdAt: later }),
      todo({ id: "a0000000-0000-4000-8000-000000000000", priority: "urgent", createdAt: later }),
    ];
    expect([...tasks].sort(compareTodos).map(({ id }) => id.slice(-1))).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
    expect(compareTodos(tasks[0]!, tasks[0]!)).toBe(0);
  });

  it("sends the title alone or the title, a blank line and the trimmed note", () => {
    expect(todoPromptContent({ title: "Fix the build", note: "" })).toBe("Fix the build");
    expect(todoPromptContent({ title: "Fix the build", note: "  \n " })).toBe("Fix the build");
    expect(todoPromptContent({ title: "Fix the build", note: "\n Only on Linux.\nSee CI. \n" }))
      .toBe("Fix the build\n\nOnly on Linux.\nSee CI.");
  });

  it("measures the serialized list in UTF-8 bytes", () => {
    expect(todosSerializedBytes([])).toBe(2);
    expect(todosSerializedBytes([todo({ title: "é" })])).toBe(new TextEncoder().encode(JSON.stringify([todo({ title: "é" })])).byteLength);
  });
});

describe("tasks made from chat text", () => {
  const valid = (draft: { title: string; note: string } | null) =>
    todoDraftSchema.safeParse(draft).success;

  it("bounds text to a limit without splitting characters and marks the cut", () => {
    expect(boundTodoText("short", 10)).toBe("short");
    expect(boundTodoText("abcdefghij", 10)).toBe("abcdefghij");
    expect(boundTodoText("abcd efghijk", 6)).toBe("abcd…");
    const emoji = boundTodoText(`${"x".repeat(7)}😀😀`, 9);
    expect(emoji).toBe(`${"x".repeat(7)}…`);
    expect(emoji.length).toBeLessThanOrEqual(9);
  });

  it("names a message task after its first non-empty line and keeps the text as its note", () => {
    const draft = todoDraftFromMessage("\r\n  \n  Fix   the\tbuild  \r\nIt fails on Linux.\n");
    expect(draft).toEqual({ title: "Fix the build", note: "Fix   the\tbuild  \r\nIt fails on Linux." });
    expect(valid(draft)).toBe(true);
    expect(todoDraftFromMessage("  Ship it  ")).toEqual({ title: "Ship it", note: "" });
    expect(todoDraftFromMessage("Nul\0 byte\nmore\0")).toEqual({ title: "Nul byte", note: "Nul byte\nmore" });
    for (const empty of ["", "  \n\t\r\n", "\0"]) expect(todoDraftFromMessage(empty)).toBeNull();
  });

  it("bounds a long message's title and note to the task limits", () => {
    const draft = todoDraftFromMessage(`${"t".repeat(MAX_TODO_TITLE_CHARS + 50)}\n${"n".repeat(MAX_TODO_NOTE_CHARS)}`)!;
    expect(draft.title).toHaveLength(MAX_TODO_TITLE_CHARS);
    expect(draft.title.endsWith("…")).toBe(true);
    expect(draft.note).toHaveLength(MAX_TODO_NOTE_CHARS);
    expect(draft.note.endsWith("…")).toBe(true);
    expect(valid(draft)).toBe(true);
  });

  it("notes which chat's plan a step came from, followed by its detail", () => {
    expect(todoDraftFromPlanStep({ title: " Add the  migration ", detail: null }, "Release prep")).toEqual({
      title: "Add the migration", note: "From the plan in Release prep",
    });
    expect(todoDraftFromPlanStep({ title: "Test it", detail: "  Run the fixtures.  " }, "  ")).toEqual({
      title: "Test it", note: "From the plan in this chat\n\nRun the fixtures.",
    });
    const long = todoDraftFromPlanStep(
      { title: "s".repeat(MAX_TODO_TITLE_CHARS * 2), detail: "d".repeat(MAX_TODO_NOTE_CHARS) },
      "Chat",
    );
    expect(valid(long)).toBe(true);
    expect(long?.note.endsWith("…")).toBe(true);
    expect(todoDraftFromPlanStep({ title: "  " }, "Chat")).toBeNull();
  });
});
