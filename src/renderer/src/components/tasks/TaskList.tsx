import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { ChevronRight, Ellipsis, Flag } from "lucide-react";
import clsx from "clsx";
import { MAX_TODO_TITLE_CHARS, type Todo } from "@shared/todos";

import type { TodoDueLabel } from "../../utils/todoDates";
import { IconButton } from "../ui";
import type { TaskStatus } from "./taskStatus";

export type TaskMenuAnchor = { x: number; y: number };
export type TaskCompletionPhase = "hold" | "collapsing";
export type TaskOpenTarget = "title" | null;

export const TASKS_DONE_MENU_ID = "tasks-done-menu";

export function taskRowMenuId(todoId: string): string {
  return `task-actions-${todoId}`;
}

function rowTitles(list: Element | null | undefined): HTMLElement[] {
  return list
    ? [...list.querySelectorAll<HTMLElement>(".task-row-slot:not(.is-collapsing) [data-task-title]")]
    : [];
}

export function focusTaskTitle(todoId: string): boolean {
  const title = document.querySelector<HTMLElement>(`[data-task-title="${todoId}"]`);
  if (!title) return false;
  title.focus();
  return true;
}

export function focusTaskNeighbour(todoId: string): void {
  const slot = document.querySelector(`[data-task-id="${todoId}"]`);
  if (!slot) return;
  const titles = rowTitles(slot.parentElement);
  const own = slot.querySelector<HTMLElement>("[data-task-title]");
  const index = own ? titles.indexOf(own) : -1;
  const neighbour = index >= 0 ? titles[index + 1] ?? titles[index - 1] : undefined;
  const view = slot.closest(".tasks-view");
  const fallback = slot.closest(".tasks-done")
    ? view?.querySelector<HTMLElement>(".tasks-done-toggle")
    : view?.querySelector<HTMLElement>(".task-add-input");
  (neighbour ?? fallback)?.focus();
}

function menuKey(event: ReactKeyboardEvent<HTMLElement>): boolean {
  return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}

function useSyncedAnimation(ref: RefObject<HTMLElement | null>, live: boolean): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!live || !element || typeof element.getAnimations !== "function") return;
    for (const animation of element.getAnimations()) animation.startTime = 0;
  }, [live, ref]);
}

function TaskStatusWord({ status }: { status: TaskStatus }): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  useSyncedAnimation(ref, status.live);
  return (
    <span
      ref={ref}
      className={clsx("task-status", status.tone && `is-${status.tone}`, status.live && "is-live")}
    >
      {status.word}
    </span>
  );
}

export interface TaskRowHandlers {
  onToggle: (todo: Todo) => void;
  onOpen: (todo: Todo, target?: TaskOpenTarget) => void;
  onCloseDetail: (todo: Todo) => void;
  onDelete: (todo: Todo) => void;
  onOpenMenu: (todo: Todo, anchor: TaskMenuAnchor, trigger: HTMLElement | null, toggle?: boolean) => void;
  onRowFocus: (todo: Todo) => void;
  onNavigate: (event: ReactKeyboardEvent<HTMLElement>, todo: Todo) => boolean;
}

interface TaskRowProps extends TaskRowHandlers {
  todo: Todo;
  status: TaskStatus | null;
  due: TodoDueLabel | null;
  checked: boolean;
  completing: TaskCompletionPhase | null;
  selected: boolean;
  tabbable: boolean;
  menuOpen: boolean;
  disabled: boolean;
}

function rowWord(status: TaskStatus | null, due: TodoDueLabel | null): string | null {
  return status?.word ?? due?.text ?? null;
}

const TaskRow = memo(function TaskRow({
  todo,
  status,
  due,
  checked,
  completing,
  selected,
  tabbable,
  menuOpen,
  disabled,
  onToggle,
  onOpen,
  onCloseDetail,
  onDelete,
  onOpenMenu,
  onRowFocus,
  onNavigate,
}: TaskRowProps): React.JSX.Element {
  const actionsRef = useRef<HTMLButtonElement>(null);
  const done = todo.completedAt !== null && completing === null;
  const word = done ? null : rowWord(status, due);
  const checkLabel = checked
    ? `Mark as not done: ${todo.title}`
    : `Mark as done: ${todo.title}${word ? ` (${word})` : ""}`;

  const onTitleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.shiftKey && event.key !== "F10") return;
    if (onNavigate(event, todo)) return;
    switch (event.key) {
      case "Enter":
      case "ArrowRight":
        event.preventDefault();
        onOpen(todo);
        return;
      case "F2":
        event.preventDefault();
        onOpen(todo, "title");
        return;
      case " ":
        event.preventDefault();
        if (!disabled) onToggle(todo);
        return;
      case "Delete":
      case "Backspace":
        event.preventDefault();
        if (!disabled) onDelete(todo);
        return;
      case "ArrowLeft":
        event.preventDefault();
        onCloseDetail(todo);
        return;
      default:
    }
  };

  return (
    <li
      className={clsx(
        "task-row-slot",
        completing && "is-completing",
        completing === "collapsing" && "is-collapsing",
      )}
      data-task-id={todo.id}
    >
      <div
        className={clsx("task-row", selected && "is-selected", menuOpen && "has-menu", completing && "is-completing")}
        onContextMenu={(event) => {
          event.preventDefault();
          onOpenMenu(todo, { x: event.clientX, y: event.clientY }, actionsRef.current);
        }}
        onKeyDown={(event) => {
          if (!menuKey(event)) return;
          event.preventDefault();
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          const focused = document.activeElement instanceof HTMLElement
            && event.currentTarget.contains(document.activeElement)
            ? document.activeElement
            : actionsRef.current;
          onOpenMenu(todo, { x: bounds.left + 24, y: bounds.bottom }, focused);
        }}
      >
        <input
          type="checkbox"
          className="task-check"
          tabIndex={-1}
          aria-label={checkLabel}
          checked={checked}
          disabled={disabled}
          onChange={() => onToggle(todo)}
        />
        <button
          type="button"
          className="task-title"
          data-task-title={todo.id}
          tabIndex={tabbable ? 0 : -1}
          aria-current={selected ? "true" : undefined}
          onFocus={() => onRowFocus(todo)}
          onClick={() => onOpen(todo)}
          onKeyDown={onTitleKeyDown}
          onKeyUp={(event) => {
            if (event.key === " ") event.preventDefault();
          }}
        >
          <span className="task-title-text">{todo.title}</span>
          {!done && status?.word && <TaskStatusWord status={status} />}
          {!done && !status?.word && due && (
            <span className={clsx("task-due", due.overdue && "is-overdue", due.today && !due.overdue && "is-today")}>
              {due.text}
            </span>
          )}
          {!done && todo.priority === "urgent" && (
            <span className="task-urgent"><span aria-hidden="true">!</span><span className="visually-hidden">Urgent</span></span>
          )}
          {!done && todo.priority === "high" && (
            <span className="task-high"><Flag size={14} aria-hidden="true" /><span className="visually-hidden">High priority</span></span>
          )}
        </button>
        <IconButton
          ref={actionsRef}
          label={`Actions for ${todo.title}`}
          className="task-actions"
          tabIndex={-1}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? taskRowMenuId(todo.id) : undefined}
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            onOpenMenu(todo, { x: bounds.left, y: bounds.bottom + 4 }, event.currentTarget, true);
          }}
        >
          <Ellipsis size={14} aria-hidden="true" />
        </IconButton>
      </div>
    </li>
  );
});

export interface TaskRowModel {
  todo: Todo;
  status: TaskStatus | null;
  due: TodoDueLabel | null;
  checked: boolean;
  completing: TaskCompletionPhase | null;
}

export interface TaskListProps extends Omit<TaskRowHandlers, "onRowFocus" | "onNavigate"> {
  openRows: readonly TaskRowModel[];
  doneRows: readonly TaskRowModel[];
  doneCount: number;
  doneOpen: boolean;
  selectedId: string | null;
  menuTodoId: string | null;
  doneMenuOpen: boolean;
  disabled: boolean;
  addInputRef: RefObject<HTMLInputElement | null>;
  onCreate: (title: string, handOff: boolean) => Promise<boolean>;
  onToggleDoneList: () => void;
  onOpenDoneMenu: (anchor: TaskMenuAnchor, trigger: HTMLElement | null, toggle?: boolean) => void;
}

function rovingId(rows: readonly TaskRowModel[], ...preferred: (string | null)[]): string | null {
  for (const id of preferred) {
    if (id && rows.some(({ todo, completing }) => todo.id === id && completing !== "collapsing")) return id;
  }
  return rows.find(({ completing }) => completing !== "collapsing")?.todo.id ?? null;
}

export function TaskList({
  openRows,
  doneRows,
  doneCount,
  doneOpen,
  selectedId,
  menuTodoId,
  doneMenuOpen,
  disabled,
  addInputRef,
  onCreate,
  onToggle,
  onOpen,
  onCloseDetail,
  onDelete,
  onOpenMenu,
  onToggleDoneList,
  onOpenDoneMenu,
}: TaskListProps): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const doneToggleRef = useRef<HTMLButtonElement>(null);
  const doneActionsRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (selectedId) setActiveId(selectedId);
  }, [selectedId]);

  const openTabbable = rovingId(openRows, activeId, selectedId);
  const doneTabbable = rovingId(doneRows, activeId, selectedId);

  const onRowFocus = useCallback((todo: Todo) => setActiveId(todo.id), []);

  const onNavigate = useCallback((event: ReactKeyboardEvent<HTMLElement>, todo: Todo): boolean => {
    const column = columnRef.current;
    const slot = column?.querySelector(`[data-task-id="${todo.id}"]`);
    const list = slot?.parentElement;
    if (!column || !list) return false;
    const titles = rowTitles(list);
    const index = titles.findIndex((title) => title.dataset.taskTitle === todo.id);
    const inDone = list.classList.contains("tasks-done-list");
    let next: HTMLElement | null | undefined;
    switch (event.key) {
      case "ArrowDown":
        next = titles[index + 1] ?? (inDone ? titles[index] : addInputRef.current);
        break;
      case "ArrowUp":
        next = index > 0 ? titles[index - 1] : inDone ? doneToggleRef.current : titles[0];
        break;
      case "Home":
        next = titles[0];
        break;
      case "End":
        next = titles.at(-1);
        break;
      default:
        return false;
    }
    event.preventDefault();
    next?.focus();
    return true;
  }, [addInputRef]);

  const handlers: TaskRowHandlers = {
    onToggle,
    onOpen,
    onCloseDetail,
    onDelete,
    onOpenMenu,
    onRowFocus,
    onNavigate,
  };

  const firstTitle = (list: string): HTMLElement | undefined => rowTitles(columnRef.current?.querySelector(list))[0];
  const lastTitle = (list: string): HTMLElement | undefined => rowTitles(columnRef.current?.querySelector(list)).at(-1);

  const submit = (handOff: boolean): boolean => {
    const title = draft.trim();
    if (!title) return false;
    setDraft("");
    void onCreate(title, handOff).then((created) => {
      if (!created) setDraft((current) => current || title);
    });
    return true;
  };

  const renderRows = (rows: readonly TaskRowModel[], tabbable: string | null) => rows.map((row) => (
    <TaskRow
      {...handlers}
      key={row.todo.id}
      todo={row.todo}
      status={row.status}
      due={row.due}
      checked={row.checked}
      completing={row.completing}
      selected={selectedId === row.todo.id}
      tabbable={tabbable === row.todo.id}
      menuOpen={menuTodoId === row.todo.id}
      disabled={disabled}
    />
  ));

  return (
    <div className="tasks-list-column" ref={columnRef}>
      {openRows.length > 0 && (
        <ul className="tasks-list tasks-open-list" aria-label="To do">
          {renderRows(openRows, openTabbable)}
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
            } else if (event.key === "ArrowDown" && doneToggleRef.current) {
              event.preventDefault();
              doneToggleRef.current.focus();
            } else if (event.key === "ArrowUp") {
              const last = lastTitle(".tasks-open-list");
              if (!last) return;
              event.preventDefault();
              last.focus();
            }
          }}
        />
      </div>
      {doneCount > 0 && (
        <div className="tasks-done">
          <div className={clsx("tasks-done-heading", doneMenuOpen && "has-menu")}>
            <button
              ref={doneToggleRef}
              type="button"
              className="tasks-done-toggle"
              aria-expanded={doneOpen}
              aria-controls={doneOpen ? "tasks-done-list" : undefined}
              onClick={onToggleDoneList}
              onKeyDown={(event) => {
                if (menuKey(event)) {
                  event.preventDefault();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  onOpenDoneMenu({ x: bounds.left, y: bounds.bottom + 4 }, event.currentTarget);
                  return;
                }
                if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                const target = event.key === "ArrowUp"
                  ? addInputRef.current
                  : event.key === "ArrowDown" && doneOpen ? firstTitle(".tasks-done-list") : null;
                if (!target) return;
                event.preventDefault();
                target.focus();
              }}
            >
              {`Done ${doneCount}`}
              <ChevronRight size={14} aria-hidden="true" />
            </button>
            <IconButton
              ref={doneActionsRef}
              label="Done actions"
              className="task-actions"
              tabIndex={-1}
              aria-haspopup="menu"
              aria-expanded={doneMenuOpen}
              aria-controls={doneMenuOpen ? TASKS_DONE_MENU_ID : undefined}
              onClick={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                onOpenDoneMenu({ x: bounds.left, y: bounds.bottom + 4 }, event.currentTarget, true);
              }}
            >
              <Ellipsis size={14} aria-hidden="true" />
            </IconButton>
          </div>
          {doneOpen && doneRows.length > 0 && (
            <ul className="tasks-list tasks-done-list" id="tasks-done-list" aria-label="Done">
              {renderRows(doneRows, doneTabbable)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
