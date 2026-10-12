import type Database from "better-sqlite3";
import type { z } from "zod";

import {
  MAX_TODOS,
  MAX_TODOS_SERIALIZED_BYTES,
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
  completed_at: string | null;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
}

export type TodoCreateInput = z.input<typeof todoDraftSchema> & { id: string };

export class TodoRepositoryError extends Error {}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new TodoRepositoryError(parsed.error.issues[0]?.message ?? "The task is invalid.");
  }
  return parsed.data;
}

function todoFromRow(row: TodoRow): Todo {
  return todoSchema.parse({
    id: row.id,
    title: row.title,
    note: row.note,
    priority: row.priority,
    dueDate: row.due_date,
    completedAt: row.completed_at,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export class TodoRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  list(): Todo[] {
    return (this.database.prepare(`
      SELECT id, title, note, priority, due_date, completed_at,
        conversation_id, created_at, updated_at
      FROM todos
      ORDER BY created_at ASC, id ASC
    `).all() as TodoRow[]).map(todoFromRow);
  }

  get(todoId: string): Todo | null {
    return this.list().find(({ id }) => id === todoId) ?? null;
  }

  create(input: TodoCreateInput): Todo {
    const { id, ...fields } = input;
    const draft = parse(todoDraftSchema, fields);
    return this.database.transaction(() => {
      const current = this.list();
      if (current.length >= MAX_TODOS) {
        throw new TodoRepositoryError(`Tasks are limited to ${MAX_TODOS}.`);
      }
      if (current.some((todo) => todo.id === id)) {
        throw new TodoRepositoryError("That task already exists.");
      }
      const timestamp = this.now();
      const todo = parse(todoSchema, {
        ...draft,
        id,
        completedAt: null,
        conversationId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      this.assertSerializedBound([...current, todo]);
      this.database.prepare(`
        INSERT INTO todos (
          id, title, note, priority, due_date, completed_at,
          conversation_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)
      `).run(
        todo.id,
        todo.title,
        todo.note,
        todo.priority,
        todo.dueDate,
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
      return this.write(current, {
        ...existing,
        title: patch.title ?? existing.title,
        note: patch.note ?? existing.note,
        priority: patch.priority === undefined ? existing.priority : patch.priority,
        dueDate: patch.dueDate === undefined ? existing.dueDate : patch.dueDate,
        completedAt,
      });
    })();
  }

  link(todoId: string, conversationId: string): Todo {
    return this.database.transaction(() => {
      const current = this.list();
      const existing = this.require(current, todoId);
      if (existing.conversationId !== null) {
        throw new TodoRepositoryError("That task is already handed to an agent.");
      }
      return this.write(current, { ...existing, conversationId, completedAt: null });
    })();
  }

  delete(todoId: string): void {
    this.database.transaction(() => {
      this.require(this.list(), todoId);
      this.database.prepare("DELETE FROM todos WHERE id = ?").run(todoId);
    })();
  }

  private write(current: readonly Todo[], candidate: Todo): Todo {
    const next = parse(todoSchema, { ...candidate, updatedAt: this.now() });
    this.assertSerializedBound(current.map((todo) => todo.id === next.id ? next : todo));
    this.database.prepare(`
      UPDATE todos SET
        title = ?, note = ?, priority = ?, due_date = ?, completed_at = ?,
        conversation_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.title,
      next.note,
      next.priority,
      next.dueDate,
      next.completedAt,
      next.conversationId,
      next.updatedAt,
      next.id,
    );
    return next;
  }

  private require(todos: readonly Todo[], todoId: string): Todo {
    const todo = todos.find(({ id }) => id === todoId);
    if (!todo) throw new TodoRepositoryError("That task no longer exists.");
    return todo;
  }

  private assertSerializedBound(todos: readonly Todo[]): void {
    if (todosSerializedBytes(todos) > MAX_TODOS_SERIALIZED_BYTES) {
      throw new TodoRepositoryError("Tasks exceed the safe local storage limit.");
    }
  }
}
