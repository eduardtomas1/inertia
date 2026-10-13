import { z } from "zod";

export const MAX_TODOS = 200;
export const MAX_TODO_TITLE_CHARS = 200;
export const MAX_TODO_NOTE_CHARS = 2_000;
export const MAX_TODOS_SERIALIZED_BYTES = 512 * 1_024;

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

export const todoDraftSchema = z.object({
  title: todoTitleSchema,
  note: todoNoteSchema.default(""),
  priority: todoPrioritySchema.nullable().default(null),
  dueDate: todoDueDateSchema.nullable().default(null),
}).strict();

export const todoPatchSchema = z.object({
  title: todoTitleSchema.optional(),
  note: todoNoteSchema.optional(),
  priority: todoPrioritySchema.nullable().optional(),
  dueDate: todoDueDateSchema.nullable().optional(),
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
  completedAt: timestampSchema.nullable(),
  conversationId: z.string().uuid().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export type TodoPriority = z.infer<typeof todoPrioritySchema>;
export type TodoDraft = z.infer<typeof todoDraftSchema>;
export type TodoPatch = z.infer<typeof todoPatchSchema>;
export type Todo = z.infer<typeof todoSchema>;

const priorityRank: Record<TodoPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

export function compareTodos(left: Todo, right: Todo): number {
  const leftRank = left.priority ? priorityRank[left.priority] : 4;
  const rightRank = right.priority ? priorityRank[right.priority] : 4;
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function todoPromptContent(todo: Pick<Todo, "title" | "note">): string {
  const note = todo.note.trim();
  return note ? `${todo.title}\n\n${note}` : todo.title;
}

export function todosSerializedBytes(todos: readonly Todo[]): number {
  return new TextEncoder().encode(JSON.stringify(todos)).byteLength;
}
