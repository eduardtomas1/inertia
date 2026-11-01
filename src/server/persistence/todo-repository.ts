import type Database from "better-sqlite3";
import type { z } from "zod";

import {
  MAX_DONE_TODOS,
  MAX_OPEN_TODOS,
  MAX_TODOS,
  MAX_TODOS_SERIALIZED_BYTES,
  TODO_TIME_WITHOUT_DATE_MESSAGE,
  todoDraftSchema,
  todoPatchSchema,
  todoSchema,
  todosSerializedBytes,
  type Todo,
  type TodoPatch,
} from "../../shared/todos";

interface TodoRow {
  id: string;
  title: string;
  note: string;
  priority: string | null;
  due_date: string | null;
  due_time: string | null;
  project_id: string | null;
  completed_at: string | null;
  conversation_id: string | null;
  linked_at: string | null;
  source_conversation_id: string | null;
  created_at: string;
  updated_at: string;
}

export type TodoCreateInput = z.input<typeof todoDraftSchema> & { id: string };

export interface TodoLinkOptions {
  replaces?: string;
}

export const TODO_OPEN_LIMIT_MESSAGE =
  `You have ${MAX_OPEN_TODOS} open tasks. Finish or delete some first.`;
export const TODO_MISSING_MESSAGE = "That task no longer exists.";
export const TODO_PROJECT_MISSING_MESSAGE = "That project no longer exists.";
export const TODO_SOURCE_CHAT_MISSING_MESSAGE = "That chat no longer exists.";
export const TODO_SOURCE_CHAT_PROJECT_MESSAGE = "The chat does not belong to this project.";
export const TODO_ALREADY_LINKED_MESSAGE = "That task is already handed to an agent.";
export const TODO_HANDED_OFF_ELSEWHERE_MESSAGE =
  "This task was handed off somewhere else in the meantime.";
export const TODO_DONE_HANDOFF_MESSAGE = "Reopen the task before handing it off.";

export class TodoRepositoryError extends Error {}

const TODO_COLUMNS = `
  id, title, note, priority, due_date, due_time, project_id, completed_at,
  conversation_id, linked_at, source_conversation_id, created_at, updated_at
`;

const COMPLETED_AT_PLACEHOLDER = new Date(0).toISOString();

const warnedRowIds = new Set<string>();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new TodoRepositoryError(parsed.error.issues[0]?.message ?? "The task is invalid.");
  }
  return parsed.data;
}

function warnMalformedRow(id: unknown): void {
  const label = JSON.stringify(String(id).slice(0, 64));
  if (warnedRowIds.has(label) || warnedRowIds.size >= MAX_TODOS) return;
  warnedRowIds.add(label);
  console.warn(`A malformed task row ${label} was left out of the task list.`);
}

function todoFromRow(row: TodoRow): Todo | null {
  const parsed = todoSchema.safeParse({
    id: row.id,
    title: row.title,
    note: row.note,
    priority: row.priority,
    dueDate: row.due_date,
    dueTime: row.due_time,
    projectId: row.project_id,
    completedAt: row.completed_at,
    conversationId: row.conversation_id,
    linkedAt: row.linked_at,
    sourceConversationId: row.source_conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  if (parsed.success) return parsed.data;
  warnMalformedRow(row.id);
  return null;
}

export function assertTodoCanHandOff(todo: Todo, replaces: string | undefined): void {
  if (todo.completedAt !== null) throw new TodoRepositoryError(TODO_DONE_HANDOFF_MESSAGE);
  if (replaces === undefined) {
    if (todo.conversationId !== null) throw new TodoRepositoryError(TODO_ALREADY_LINKED_MESSAGE);
    return;
  }
  if (todo.conversationId !== replaces) {
    throw new TodoRepositoryError(TODO_HANDED_OFF_ELSEWHERE_MESSAGE);
  }
}

export class TodoRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  list(): Todo[] {
    return (this.database.prepare(`
      SELECT ${TODO_COLUMNS}
      FROM todos
      ORDER BY created_at ASC, id ASC
    `).all() as TodoRow[]).flatMap((row) => todoFromRow(row) ?? []);
  }

  get(todoId: string): Todo | null {
    const row = this.database.prepare(`
      SELECT ${TODO_COLUMNS}
      FROM todos
      WHERE id = ?
    `).get(todoId) as TodoRow | undefined;
    return row ? todoFromRow(row) : null;
  }

  create(input: TodoCreateInput): Todo {
    const { id, ...fields } = input;
    const { sourceConversationId = null, ...draft } = parse(todoDraftSchema, fields);
    return this.database.transaction(() => {
      if (this.openCount() >= MAX_OPEN_TODOS) {
        throw new TodoRepositoryError(TODO_OPEN_LIMIT_MESSAGE);
      }
      if (this.database.prepare("SELECT 1 FROM todos WHERE id = ?").get(id)) {
        throw new TodoRepositoryError("That task already exists.");
      }
      this.assertProject(draft.projectId);
      if (sourceConversationId !== null) this.assertSourceConversation(sourceConversationId, draft.projectId);
      const timestamp = this.now();
      const todo = parse(todoSchema, {
        ...draft,
        id,
        completedAt: null,
        conversationId: null,
        linkedAt: null,
        sourceConversationId,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      this.makeRoom([...this.list(), todo], todo.id);
      this.database.prepare(`
        INSERT INTO todos (${TODO_COLUMNS})
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
      `).run(
        todo.id,
        todo.title,
        todo.note,
        todo.priority,
        todo.dueDate,
        todo.dueTime,
        todo.projectId,
        todo.conversationId,
        todo.linkedAt,
        todo.sourceConversationId ?? null,
        todo.createdAt,
        todo.updatedAt,
      );
      return todo;
    })();
  }

  update(todoId: string, input: TodoPatch): Todo {
    const { completed, ...patch } = parse(todoPatchSchema, input);
    return this.database.transaction(() => {
      const current = this.list();
      const existing = this.require(current, todoId);
      const completedAt = completed === undefined
        ? existing.completedAt
        : completed ? existing.completedAt ?? this.now() : null;
      if (existing.completedAt !== null && completedAt === null
        && this.openCount() >= MAX_OPEN_TODOS) {
        throw new TodoRepositoryError(TODO_OPEN_LIMIT_MESSAGE);
      }
      const dueDate = patch.dueDate === undefined ? existing.dueDate : patch.dueDate;
      const dueTime = patch.dueTime !== undefined
        ? patch.dueTime
        : patch.dueDate === null ? null : existing.dueTime;
      if (dueTime !== null && dueDate === null) {
        throw new TodoRepositoryError(TODO_TIME_WITHOUT_DATE_MESSAGE);
      }
      if (patch.projectId !== undefined) this.assertProject(patch.projectId);
      const next = this.write(current, {
        ...existing,
        title: patch.title ?? existing.title,
        note: patch.note ?? existing.note,
        priority: patch.priority === undefined ? existing.priority : patch.priority,
        dueDate,
        dueTime,
        projectId: patch.projectId === undefined ? existing.projectId : patch.projectId,
        completedAt,
      });
      if (existing.completedAt === null && completedAt !== null) this.pruneDone();
      return next;
    })();
  }

  link(todoId: string, conversationId: string, options: TodoLinkOptions = {}): Todo {
    return this.database.transaction(() => {
      const current = this.list();
      const existing = this.require(current, todoId);
      assertTodoCanHandOff(existing, options.replaces);
      return this.write(current, {
        ...existing,
        conversationId,
        linkedAt: this.now(),
        projectId: this.conversationProjectId(conversationId) ?? existing.projectId,
      });
    })();
  }

  delete(todoId: string): void {
    this.database.transaction(() => {
      if (this.database.prepare("DELETE FROM todos WHERE id = ?").run(todoId).changes === 0) {
        throw new TodoRepositoryError(TODO_MISSING_MESSAGE);
      }
    })();
  }

  clearDone(todoIds: readonly string[]): number {
    const remove = this.database.prepare(
      "DELETE FROM todos WHERE id = ? AND completed_at IS NOT NULL",
    );
    return this.database.transaction(() =>
      todoIds.reduce((count, todoId) => count + remove.run(todoId).changes, 0))();
  }

  private openCount(): number {
    return (this.database.prepare(
      "SELECT COUNT(*) AS count FROM todos WHERE completed_at IS NULL",
    ).get() as { count: number }).count;
  }

  private pruneDone(): void {
    this.database.prepare(`
      DELETE FROM todos
      WHERE completed_at IS NOT NULL
        AND id NOT IN (
          SELECT id FROM todos
          WHERE completed_at IS NOT NULL
          ORDER BY completed_at DESC, id DESC
          LIMIT ?
        )
    `).run(MAX_DONE_TODOS);
  }

  private conversationProjectId(conversationId: string): string | null {
    const conversation = this.database.prepare(
      "SELECT project_id FROM conversations WHERE id = ?",
    ).get(conversationId) as { project_id: string | null } | undefined;
    return conversation?.project_id ?? null;
  }

  private assertSourceConversation(conversationId: string, projectId: string | null): void {
    const conversation = this.database.prepare(
      "SELECT project_id FROM conversations WHERE id = ?",
    ).get(conversationId) as { project_id: string | null } | undefined;
    if (!conversation) throw new TodoRepositoryError(TODO_SOURCE_CHAT_MISSING_MESSAGE);
    if (conversation.project_id !== projectId) {
      throw new TodoRepositoryError(TODO_SOURCE_CHAT_PROJECT_MESSAGE);
    }
  }

  private assertProject(projectId: string | null): void {
    if (projectId === null) return;
    if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new TodoRepositoryError(TODO_PROJECT_MISSING_MESSAGE);
    }
  }

  private write(current: readonly Todo[], candidate: Todo): Todo {
    const next = parse(todoSchema, { ...candidate, updatedAt: this.now() });
    this.makeRoom(current.map((todo) => todo.id === next.id ? next : todo), next.id);
    this.database.prepare(`
      UPDATE todos SET
        title = ?, note = ?, priority = ?, due_date = ?, due_time = ?,
        project_id = ?, completed_at = ?, conversation_id = ?, linked_at = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      next.title,
      next.note,
      next.priority,
      next.dueDate,
      next.dueTime,
      next.projectId,
      next.completedAt,
      next.conversationId,
      next.linkedAt,
      next.updatedAt,
      next.id,
    );
    return next;
  }

  private require(todos: readonly Todo[], todoId: string): Todo {
    const todo = todos.find(({ id }) => id === todoId);
    if (!todo) throw new TodoRepositoryError(TODO_MISSING_MESSAGE);
    return todo;
  }

  private makeRoom(todos: readonly Todo[], keepId: string): void {
    const bytes = (todo: Todo): number => todosSerializedBytes([
      todo.completedAt === null ? { ...todo, completedAt: COMPLETED_AT_PLACEHOLDER } : todo,
    ]) - 2;
    let total = todos.reduce((sum, todo) => sum + bytes(todo) + 1, 1);
    const evicted: string[] = [];
    const oldestDone = todos
      .filter(({ id, completedAt }) => completedAt !== null && id !== keepId)
      .sort((left, right) => left.completedAt!.localeCompare(right.completedAt!, "en") || left.id.localeCompare(right.id, "en"));
    for (const todo of oldestDone) {
      if (total <= MAX_TODOS_SERIALIZED_BYTES) break;
      total -= bytes(todo) + 1;
      evicted.push(todo.id);
    }
    if (total > MAX_TODOS_SERIALIZED_BYTES) {
      throw new TodoRepositoryError("Tasks exceed the safe local storage limit.");
    }
    const remove = this.database.prepare("DELETE FROM todos WHERE id = ?");
    for (const id of evicted) remove.run(id);
  }
}
