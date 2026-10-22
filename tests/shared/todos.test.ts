import { describe, expect, it } from "vitest";

import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import {
  compareTodoBasics,
  MAX_TODO_NOTE_CHARS,
  MAX_TODO_TITLE_CHARS,
  MAX_TODOS,
  todoDraftSchema,
  todoDueDateSchema,
  todoDueTimeSchema,
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
    dueTime: null,
    projectId: null,
    completedAt: null,
    conversationId: null,
    linkedAt: null,
    createdAt: "2026-10-12T10:00:00.000Z",
    updatedAt: "2026-10-12T10:00:00.000Z",
    ...overrides,
  };
}

describe("task schemas", () => {
  it("trims titles, defaults optional fields and rejects unsafe drafts", () => {
    expect(todoDraftSchema.parse({ title: "  Write notes  " })).toEqual({
      title: "Write notes", note: "", priority: null, dueDate: null, dueTime: null, projectId: null,
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

  it("accepts only real calendar days as due dates", () => {
    for (const valid of ["2026-10-12", "2028-02-29", "2026-12-31"]) {
      expect(todoDueDateSchema.safeParse(valid).success).toBe(true);
    }
    for (const invalid of [
      "2026-02-30", "2027-02-29", "2026-13-01", "2026-00-10", "2026-04-31",
      "2026-1-01", "26-10-12", "2026-10-12T00:00:00.000Z", "", "tomorrow",
    ]) expect(todoDueDateSchema.safeParse(invalid).success).toBe(false);
  });

  it("accepts only 24-hour wall-clock due times and only with a due day", () => {
    for (const valid of ["00:00", "09:05", "15:00", "23:59"]) {
      expect(todoDueTimeSchema.safeParse(valid).success).toBe(true);
    }
    for (const invalid of ["24:00", "7:60", "9:00", "15:00:00", "1500", "3pm", "", "15.00"]) {
      expect(todoDueTimeSchema.safeParse(invalid).success).toBe(false);
    }
    expect(todoDraftSchema.safeParse({ title: "Call", dueDate: "2026-10-21", dueTime: "15:00" }).success).toBe(true);
    const timeOnly = todoDraftSchema.safeParse({ title: "Call", dueTime: "15:00" });
    expect(timeOnly.success).toBe(false);
    expect(timeOnly.error?.issues[0]?.message).toBe("Add a day before a time.");
    expect(todoSchema.safeParse(todo({ dueTime: "15:00" })).success).toBe(false);
    expect(todoSchema.safeParse(todo({ dueDate: "2026-10-21", dueTime: "15:00" })).success).toBe(true);
  });

  it("requires a patch to change something and allows clearing priority and due date", () => {
    expect(todoPatchSchema.safeParse({}).success).toBe(false);
    expect(todoPatchSchema.safeParse({ title: undefined }).success).toBe(false);
    expect(todoPatchSchema.parse({ priority: null })).toEqual({ priority: null });
    expect(todoPatchSchema.parse({ dueDate: null, completed: false })).toEqual({ dueDate: null, completed: false });
    expect(todoPatchSchema.parse({ dueDate: "2026-10-21", dueTime: "15:00" })).toEqual({ dueDate: "2026-10-21", dueTime: "15:00" });
    expect(todoPatchSchema.parse({ dueTime: null, projectId: null })).toEqual({ dueTime: null, projectId: null });
    expect(todoPatchSchema.safeParse({ linkedAt: "2026-10-12T10:00:00.000Z" }).success).toBe(false);
    expect(todoPatchSchema.safeParse({ conversationId: ID }).success).toBe(false);
    expect(todoPatchSchema.safeParse({ completedAt: "2026-10-12T10:00:00.000Z" }).success).toBe(false);
  });

  it("validates stored tasks strictly", () => {
    expect(todoSchema.parse(todo({
      conversationId: PROJECT, completedAt: "2026-10-12T11:00:00.000Z",
      linkedAt: "2026-10-12T10:30:00.000Z", projectId: PROJECT,
    }))).toBeTruthy();
    for (const invalid of [
      todo({ id: "task-1" }),
      todo({ conversationId: "chat-1" }),
      todo({ completedAt: "yesterday" }),
      todo({ linkedAt: "now" }),
      todo({ projectId: "" }),
      todo({ dueDate: "2026-10-21", dueTime: "25:00" }),
      { ...todo(), extra: true },
    ]) expect(todoSchema.safeParse(invalid).success).toBe(false);
  });

  it("validates task commands at the client command boundary", () => {
    const command = (type: string, payload: unknown) => clientCommandSchema.safeParse({ type, requestId: ID, payload });
    expect(command("todo.create", { id: ID, title: "Task" }).success).toBe(true);
    expect(command("todo.create", { title: "Task" }).success).toBe(false);
    expect(command("todo.update", { id: ID, patch: { completed: true } }).success).toBe(true);
    expect(command("todo.update", { id: ID, patch: {} }).success).toBe(false);
    expect(command("todo.delete", { id: ID }).success).toBe(true);
    expect(command("todo.clearDone", { ids: [ID] }).success).toBe(true);
    expect(command("todo.clearDone", { ids: [] }).success).toBe(true);
    expect(command("todo.clearDone", {}).success).toBe(false);
    expect(command("todo.clearDone", { id: ID }).success).toBe(false);
    expect(command("todo.clearDone", { ids: ["task-1"] }).success).toBe(false);
    expect(command("todo.clearDone", { ids: Array.from({ length: MAX_TODOS + 1 }, () => ID) }).success).toBe(false);
    expect(command("todo.create", { id: ID, title: "Task", dueDate: "2026-10-21", dueTime: "15:00", projectId: PROJECT }).success).toBe(true);
    expect(command("todo.create", { id: ID, title: "Task", dueTime: "15:00" }).success).toBe(false);
    expect(command("todo.start", { id: ID, conversation: { projectId: PROJECT }, replaces: PROJECT }).success).toBe(true);
    expect(command("todo.start", { id: ID, conversation: { projectId: PROJECT }, replaces: "chat-1" }).success).toBe(false);
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
    expect([...tasks].sort(compareTodoBasics).map(({ id }) => id.slice(-1))).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
    expect(compareTodoBasics(tasks[0]!, tasks[0]!)).toBe(0);
  });

  it("orders by priority, then due day, untimed before timed, undated last, then creation and id", () => {
    const later = "2026-10-12T11:00:00.000Z";
    const tasks = [
      todo({ id: "b0000000-0000-4000-8000-000000000007", priority: "high" }),
      todo({ id: "b0000000-0000-4000-8000-000000000006", priority: null, dueDate: "2026-10-20" }),
      todo({ id: "b0000000-0000-4000-8000-000000000005", priority: "high", dueDate: "2026-10-22" }),
      todo({ id: "b0000000-0000-4000-8000-000000000004", priority: "high", dueDate: "2026-10-21", dueTime: "15:00", createdAt: later }),
      todo({ id: "b0000000-0000-4000-8000-000000000003", priority: "high", dueDate: "2026-10-21", dueTime: "15:00" }),
      todo({ id: "b0000000-0000-4000-8000-000000000002", priority: "high", dueDate: "2026-10-21", dueTime: "09:30" }),
      todo({ id: "b0000000-0000-4000-8000-000000000001", priority: "high", dueDate: "2026-10-21", createdAt: later }),
      todo({ id: "b0000000-0000-4000-8000-000000000000", priority: "high", dueDate: "2026-10-21", createdAt: later }),
    ];
    expect([...tasks].sort(compareTodoBasics).map(({ id }) => id.slice(-1)))
      .toEqual(["0", "1", "2", "3", "4", "5", "7", "6"]);
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
