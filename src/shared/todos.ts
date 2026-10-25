import { z } from "zod";

export const MAX_OPEN_TODOS = 200;
export const MAX_DONE_TODOS = 200;
export const MAX_TODOS = MAX_OPEN_TODOS + MAX_DONE_TODOS;
export const MAX_TODO_TITLE_CHARS = 200;
export const MAX_TODO_NOTE_CHARS = 2_000;
export const MAX_TODOS_SERIALIZED_BYTES = 1_024 * 1_024;

export const TODO_PRIORITIES = ["urgent", "high", "medium", "low"] as const;

const timestampSchema = z.string().datetime({ offset: true });

export const todoPrioritySchema = z.enum(TODO_PRIORITIES);

export const todoTitleSchema = z.string()
  .trim()
  .min(1)
  .max(MAX_TODO_TITLE_CHARS)
  .refine((value) => !/[\0\r\n]/u.test(value), "Task titles must stay on one line.");

export const todoNoteSchema = z.string()
  .max(MAX_TODO_NOTE_CHARS)
  .refine((value) => !value.includes("\0"), "Task notes cannot contain NUL bytes.");

export const todoDueDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "Task due dates are calendar days.")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day;
  }, "Task due dates must be real calendar days.");

export const todoDueTimeSchema = z.string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/u, "Task due times look like 15:00.");

export const TODO_TIME_WITHOUT_DATE_MESSAGE = "Add a day before a time.";

export function dueTimeRequiresDate(value: { dueDate?: string | null; dueTime?: string | null }): boolean {
  return !value.dueTime || Boolean(value.dueDate);
}

export const todoDraftFieldsSchema = z.object({
  title: todoTitleSchema,
  note: todoNoteSchema.default(""),
  priority: todoPrioritySchema.nullable().default(null),
  dueDate: todoDueDateSchema.nullable().default(null),
  dueTime: todoDueTimeSchema.nullable().default(null),
  projectId: z.string().min(1).nullable().default(null),
}).strict();

export const todoDraftSchema = todoDraftFieldsSchema.refine(dueTimeRequiresDate, TODO_TIME_WITHOUT_DATE_MESSAGE);

export const todoPatchSchema = z.object({
  title: todoTitleSchema.optional(),
  note: todoNoteSchema.optional(),
  priority: todoPrioritySchema.nullable().optional(),
  dueDate: todoDueDateSchema.nullable().optional(),
  dueTime: todoDueTimeSchema.nullable().optional(),
  projectId: z.string().min(1).nullable().optional(),
  completed: z.boolean().optional(),
}).strict().refine(
  (patch) => Object.values(patch).some((value) => value !== undefined),
  "A task update must change at least one field.",
);

export const todoSchema = z.object({
  id: z.string().uuid(),
  title: todoTitleSchema,
  note: todoNoteSchema,
  priority: todoPrioritySchema.nullable(),
  dueDate: todoDueDateSchema.nullable(),
  dueTime: todoDueTimeSchema.nullable(),
  projectId: z.string().min(1).nullable(),
  completedAt: timestampSchema.nullable(),
  conversationId: z.string().uuid().nullable(),
  linkedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict().refine(dueTimeRequiresDate, TODO_TIME_WITHOUT_DATE_MESSAGE);

export type TodoPriority = z.infer<typeof todoPrioritySchema>;
export type TodoPatch = z.infer<typeof todoPatchSchema>;
export type Todo = z.infer<typeof todoSchema>;

const priorityRank: Record<TodoPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

type ComparableTodo = Pick<Todo, "id" | "priority" | "dueDate" | "dueTime" | "createdAt">;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function todoDueKey(todo: Pick<Todo, "dueDate" | "dueTime">): string {
  return `${todo.dueDate ?? "9999-12-31"} ${todo.dueTime ?? ""}`;
}

export function compareTodoBasics(left: ComparableTodo, right: ComparableTodo): number {
  const leftRank = left.priority ? priorityRank[left.priority] : 4;
  const rightRank = right.priority ? priorityRank[right.priority] : 4;
  if (leftRank !== rightRank) return leftRank - rightRank;
  const due = compareText(todoDueKey(left), todoDueKey(right));
  if (due !== 0) return due;
  const created = compareText(left.createdAt, right.createdAt);
  return created !== 0 ? created : compareText(left.id, right.id);
}

export function todoPromptContent(todo: Pick<Todo, "title" | "note">): string {
  const note = todo.note.trim();
  return note ? `${todo.title}\n\n${note}` : todo.title;
}

export function todosSerializedBytes(todos: readonly Todo[]): number {
  return new TextEncoder().encode(JSON.stringify(todos)).byteLength;
}
