import { useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { ChevronRight, Ellipsis } from "lucide-react";
import clsx from "clsx";
import { MAX_TODO_TITLE_CHARS, type Todo } from "@shared/todos";

import { todoDueLabel } from "../../utils/todoDates";
import { IconButton } from "../ui";
import type { TaskStatusWord } from "./taskModel";

export type TaskMenuAnchor = { x: number; y: number };

export function taskRowMenuId(todoId: string): string {
  return `task-actions-${todoId}`;
}

export function focusTaskNeighbour(todoId: string): void {
  const row = document.querySelector(`[data-task-id="${todoId}"]`);
  if (!row) return;
  const sibling = row.nextElementSibling ?? row.previousElementSibling;
  const fallback = row.closest(".tasks-done")
    ? row.closest(".tasks-view")?.querySelector<HTMLElement>(".tasks-done-toggle")
    : row.closest(".tasks-view")?.querySelector<HTMLElement>(".task-add-input");
  (sibling?.querySelector<HTMLElement>(".task-check") ?? fallback)?.focus();
}

function menuKey(event: ReactKeyboardEvent<HTMLElement>): boolean {
  return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}

interface TaskRowProps {
  todo: Todo;
  now: Date;
  selected: boolean;
  status: TaskStatusWord | null;
  menuOpen: boolean;
  disabled: boolean;
  onToggle: (todo: Todo) => void;
  onOpen: (todo: Todo) => void;
  onOpenMenu: (todo: Todo, anchor: TaskMenuAnchor, toggle?: boolean) => void;
  setMenuTrigger: (todoId: string, node: HTMLButtonElement | null) => void;
}

function TaskRow({
  todo,
  now,
  selected,
  status,
  menuOpen,
  disabled,
  onToggle,
  onOpen,
  onOpenMenu,
  setMenuTrigger,
}: TaskRowProps): React.JSX.Element {
  const due = todo.dueDate && !todo.completedAt ? todoDueLabel(todo.dueDate, now) : null;
  return (
    <li
      className={clsx("task-row", selected && "is-selected", menuOpen && "has-menu")}
      data-task-id={todo.id}
      onContextMenu={(event) => {
        if ((event.target as HTMLElement).closest("input")) return;
        event.preventDefault();
        onOpenMenu(todo, { x: event.clientX, y: event.clientY });
      }}
    >
      <input
        type="checkbox"
        className="task-check"
        aria-label={todo.title}
        checked={todo.completedAt !== null}
        disabled={disabled}
        onChange={() => onToggle(todo)}
      />
      <button
        type="button"
        className="task-title"
        data-task-title={todo.id}
        aria-current={selected ? "true" : undefined}
        onClick={() => onOpen(todo)}
        onKeyDown={(event) => {
          if (!menuKey(event)) return;
          event.preventDefault();
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          onOpenMenu(todo, { x: bounds.left + 24, y: bounds.bottom });
        }}
      >
        <span className="task-title-text">{todo.title}</span>
        {due && <span className="task-due">{due}</span>}
        {status && <span className={clsx("task-status", status === "Failed" && "is-failed")}>{status}</span>}
        {todo.priority === "urgent" && !todo.completedAt && (
          <span className="task-urgent"><span aria-hidden="true">!</span><span className="visually-hidden">Urgent</span></span>
        )}
      </button>
      <IconButton
        ref={(node) => setMenuTrigger(todo.id, node)}
        label={`Actions for ${todo.title}`}
        className="task-actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? taskRowMenuId(todo.id) : undefined}
        onClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          onOpenMenu(todo, { x: bounds.left, y: bounds.bottom + 4 }, true);
        }}
      >
        <Ellipsis size={14} aria-hidden="true" />
      </IconButton>
    </li>
  );
}

export interface TaskListProps {
  openTodos: readonly Todo[];
  doneTodos: readonly Todo[];
  now: Date;
  selectedId: string | null;
  menuTodoId: string | null;
  disabled: boolean;
  addInputRef: RefObject<HTMLInputElement | null>;
  statusFor: (todo: Todo) => TaskStatusWord | null;
  onCreate: (title: string, handOff: boolean) => Promise<boolean>;
  onToggle: (todo: Todo) => void;
  onOpen: (todo: Todo) => void;
  onOpenMenu: (todo: Todo, anchor: TaskMenuAnchor, toggle?: boolean) => void;
  setMenuTrigger: (todoId: string, node: HTMLButtonElement | null) => void;
}

export function TaskList({
  openTodos,
  doneTodos,
  now,
  selectedId,
  menuTodoId,
  disabled,
  addInputRef,
  statusFor,
  onCreate,
  onToggle,
  onOpen,
  onOpenMenu,
  setMenuTrigger,
}: TaskListProps): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const [doneOpen, setDoneOpen] = useState(false);
  const rowProps = { now, disabled, onToggle, onOpen, onOpenMenu, setMenuTrigger };

  const submit = (handOff: boolean): boolean => {
    const title = draft.trim();
    if (!title) return false;
    setDraft("");
    void onCreate(title, handOff).then((created) => {
      if (!created) setDraft((current) => current || title);
    });
    return true;
  };

  return (
    <div className="tasks-list-column">
      {openTodos.length > 0 && (
        <ul className="tasks-list" aria-label="To do">
          {openTodos.map((todo) => (
            <TaskRow
              {...rowProps}
              key={todo.id}
              todo={todo}
              selected={selectedId === todo.id}
              status={statusFor(todo)}
              menuOpen={menuTodoId === todo.id}
            />
          ))}
        </ul>
      )}
      <div className="task-add">
        <span className="task-check is-placeholder" aria-hidden="true" />
        <input
          ref={addInputRef}
          className="task-add-input"
          aria-label="Add a task"
          placeholder="Add a task, or press Tab to hand it to an agent"
          value={draft}
          maxLength={MAX_TODO_TITLE_CHARS}
          disabled={disabled}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              submit(false);
            } else if (event.key === "Tab" && !event.shiftKey && submit(true)) {
              event.preventDefault();
            }
          }}
        />
      </div>
      {doneTodos.length > 0 && (
        <div className="tasks-done">
          <button
            type="button"
            className="tasks-done-toggle"
            aria-expanded={doneOpen}
            aria-controls={doneOpen ? "tasks-done-list" : undefined}
            onClick={() => setDoneOpen((open) => !open)}
          >
            {`Done ${doneTodos.length}`}
            <ChevronRight size={14} aria-hidden="true" />
          </button>
          {doneOpen && (
            <ul className="tasks-list tasks-done-list" id="tasks-done-list" aria-label="Done">
              {doneTodos.map((todo) => (
                <TaskRow
                  {...rowProps}
                  key={todo.id}
                  todo={todo}
                  selected={selectedId === todo.id}
                  status={null}
                  menuOpen={menuTodoId === todo.id}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
