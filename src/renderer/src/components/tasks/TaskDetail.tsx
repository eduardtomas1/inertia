import { useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarDays, Ellipsis, Flag, FolderOpen, MessageSquare, X } from "lucide-react";
import clsx from "clsx";
import {
  MAX_TODO_NOTE_CHARS,
  MAX_TODO_TITLE_CHARS,
  type Todo,
  type TodoPatch,
} from "@shared/todos";

import { todoDueLabel } from "../../utils/todoDates";
import { IconButton } from "../ui";
import { TaskDuePicker } from "./TaskDuePicker";
import { TASK_PRIORITY_LABELS } from "./taskModel";
import type { TaskMenuAnchor } from "./TaskList";

export type TaskDetailMenu = "priority" | "project" | "more";
export type TaskFocusTarget = "title" | "agent" | "chat";

const NOTE_SAVE_DELAY_MS = 600;
const FOCUSABLE = "button:not(:disabled), select:not(:disabled), input:not(:disabled)";

export const TASK_DETAIL_MENU_IDS: Record<TaskDetailMenu, string> = {
  priority: "task-priority-menu",
  project: "task-project-menu",
  more: "task-more-menu",
};

export interface TaskDetailProps {
  todo: Todo;
  now: number;
  leaving: boolean;
  offline: boolean;
  projectName: string | null;
  /** Title of the chat the task was written from, when that chat still exists. */
  sourceChatTitle?: string | null;
  onOpenSourceChat?: () => void;
  focusTarget: TaskFocusTarget | null;
  openMenu: TaskDetailMenu | null;
  agent: ReactNode;
  onFocusHandled: () => void;
  onUpdate: (patch: TodoPatch) => Promise<boolean>;
  onClose: () => void;
  onSubmit: () => void;
  onToggleMenu: (menu: TaskDetailMenu, anchor: TaskMenuAnchor, trigger: HTMLElement) => void;
}

function anchorBelow(element: HTMLElement): TaskMenuAnchor {
  const bounds = element.getBoundingClientRect();
  return { x: bounds.left, y: bounds.bottom + 4 };
}

function useLatest<Value>(value: Value): { readonly current: Value } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export function TaskDetail({
  todo,
  now,
  leaving,
  offline,
  projectName,
  sourceChatTitle = null,
  onOpenSourceChat,
  focusTarget,
  openMenu,
  agent,
  onFocusHandled,
  onUpdate,
  onClose,
  onSubmit,
  onToggleMenu,
}: TaskDetailProps): React.JSX.Element {
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const agentRef = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState(todo.title);
  const [note, setNote] = useState(todo.note);
  const [dueOpen, setDueOpen] = useState(false);
  const savedTitle = useRef(todo.title);
  const savedNote = useRef(todo.note);
  const pendingTitle = useRef<string | null>(null);
  const pendingNote = useRef<string | null>(null);
  const titleDirty = useRef(false);
  const noteDirty = useRef(false);
  const noteTimer = useRef<number | null>(null);
  const titleDraft = useRef(todo.title);
  const noteDraft = useRef(todo.note);
  const update = useLatest(onUpdate);
  const latestTodo = useLatest(todo);

  const showTitle = (value: string): void => {
    titleDraft.current = value;
    setTitle(value);
  };
  const showNote = (value: string): void => {
    noteDraft.current = value;
    setNote(value);
  };

  useEffect(() => {
    savedTitle.current = todo.title;
    if (!titleDirty.current && pendingTitle.current === null) showTitle(todo.title);
  }, [todo.title]);

  useEffect(() => {
    savedNote.current = todo.note;
    if (!noteDirty.current && pendingNote.current === null) showNote(todo.note);
  }, [todo.note]);

  const flushNote = (): void => {
    if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
    noteTimer.current = null;
    if (!noteDirty.current) return;
    noteDirty.current = false;
    const next = noteDraft.current;
    if (next === (pendingNote.current ?? savedNote.current)) return;
    pendingNote.current = next;
    void update.current({ note: next }).then((saved) => {
      if (pendingNote.current !== next) return;
      pendingNote.current = null;
      if (saved) {
        savedNote.current = next;
      } else if (!noteDirty.current) {
        showNote(latestTodo.current.note);
      }
    });
  };

  const saveTitle = (): void => {
    const base = pendingTitle.current ?? savedTitle.current;
    if (!titleDirty.current) {
      showTitle(base);
      return;
    }
    titleDirty.current = false;
    const next = titleDraft.current.trim();
    if (!next) {
      showTitle(base);
      return;
    }
    showTitle(next);
    if (next === base) return;
    pendingTitle.current = next;
    void update.current({ title: next }).then((saved) => {
      if (pendingTitle.current !== next) return;
      pendingTitle.current = null;
      if (saved) {
        savedTitle.current = next;
      } else if (!titleDirty.current) {
        showTitle(latestTodo.current.title);
      }
    });
  };

  const flushRef = useLatest(() => {
    saveTitle();
    flushNote();
  });
  const finalFlushRef = useLatest(() => {
    if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
    if (!noteDirty.current) return;
    noteDirty.current = false;
    if (noteDraft.current !== (pendingNote.current ?? savedNote.current)) {
      void update.current({ note: noteDraft.current });
    }
  });

  useEffect(() => {
    const flush = (): void => flushRef.current();
    const finalFlush = finalFlushRef;
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      finalFlush.current();
    };
  }, [finalFlushRef, flushRef]);

  useEffect(() => {
    if (!focusTarget) return;
    if (focusTarget === "title") {
      titleRef.current?.focus();
      titleRef.current?.select();
      onFocusHandled();
      return;
    }
    const target = agentRef.current?.querySelector<HTMLElement>(
      focusTarget === "chat" ? "[data-task-chat]" : FOCUSABLE,
    );
    if (!target) return;
    target.focus();
    onFocusHandled();
  });

  const close = (): void => {
    saveTitle();
    flushNote();
    onClose();
  };

  const due = todoDueLabel(todo, new Date(now));
  const priorityLabel = todo.priority ? TASK_PRIORITY_LABELS[todo.priority] : null;
  const menuChip = (menu: TaskDetailMenu) => ({
    "aria-haspopup": "menu" as const,
    "aria-expanded": openMenu === menu,
    "aria-controls": openMenu === menu ? TASK_DETAIL_MENU_IDS[menu] : undefined,
    onClick: (event: React.MouseEvent<HTMLButtonElement>) =>
      onToggleMenu(menu, anchorBelow(event.currentTarget), event.currentTarget),
  });

  return (
    <aside
      className={clsx("task-detail", leaving && "is-leaving")}
      aria-label="Task details"
      aria-hidden={leaving || undefined}
      inert={leaving || undefined}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing) return;
        if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          saveTitle();
          flushNote();
          onSubmit();
          return;
        }
        if (event.key !== "Escape" || event.target instanceof HTMLSelectElement) return;
        event.preventDefault();
        close();
      }}
    >
      <div className="task-detail-heading">
        <textarea
          ref={titleRef}
          className="task-detail-title"
          aria-label="Title"
          value={title}
          maxLength={MAX_TODO_TITLE_CHARS}
          rows={1}
          readOnly={offline}
          onBlur={saveTitle}
          onChange={(event) => {
            titleDirty.current = true;
            showTitle(event.currentTarget.value.replace(/[\r\n]+/gu, " "));
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey) return;
            event.preventDefault();
            saveTitle();
          }}
        />
        <IconButton
          label={`More actions for ${todo.title}`}
          className="task-detail-icon"
          {...menuChip("more")}
        >
          <Ellipsis size={14} aria-hidden="true" />
        </IconButton>
        <IconButton label="Close task details" className="task-detail-icon task-detail-close" onClick={close}>
          <X size={14} aria-hidden="true" />
        </IconButton>
      </div>
      <textarea
        className="task-detail-note"
        aria-label="Note"
        placeholder="Add a note"
        value={note}
        maxLength={MAX_TODO_NOTE_CHARS}
        rows={1}
        readOnly={offline}
        onBlur={flushNote}
        onChange={(event) => {
          noteDirty.current = true;
          showNote(event.currentTarget.value);
          if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
          noteTimer.current = window.setTimeout(flushNote, NOTE_SAVE_DELAY_MS);
        }}
      />
      <div className="task-detail-chips">
        <button
          type="button"
          className={clsx("task-chip", due && "is-set", due?.overdue && "is-overdue")}
          aria-label={due ? `Due date: ${due.text}` : "Due date"}
          aria-haspopup="dialog"
          aria-expanded={dueOpen}
          disabled={offline}
          onClick={() => setDueOpen(true)}
        >
          <CalendarDays size={14} aria-hidden="true" />
          {due?.text ?? "Due"}
        </button>
        <button
          type="button"
          className={clsx("task-chip", priorityLabel && "is-set", todo.priority === "urgent" && "is-urgent")}
          aria-label={priorityLabel ? `Priority: ${priorityLabel}` : "Priority"}
          disabled={offline}
          {...menuChip("priority")}
        >
          {todo.priority === "urgent"
            ? <span className="task-urgent" aria-hidden="true">!</span>
            : <Flag size={14} aria-hidden="true" />}
          {priorityLabel ?? "Priority"}
        </button>
        <button
          type="button"
          className={clsx("task-chip task-project-chip", projectName && "is-set")}
          aria-label={projectName ? `Project: ${projectName}` : "Project"}
          disabled={offline}
          {...menuChip("project")}
        >
          <FolderOpen size={14} aria-hidden="true" />
          <span className="task-chip-text">{projectName ?? "Project"}</span>
        </button>
        {sourceChatTitle !== null && onOpenSourceChat && (
          <button
            type="button"
            className="task-chip task-source-chip is-set"
            title="Open this chat"
            onClick={onOpenSourceChat}
          >
            <MessageSquare size={14} aria-hidden="true" />
            <span className="task-chip-text">From chat {sourceChatTitle}</span>
          </button>
        )}
      </div>
      <div className="task-detail-agent" ref={agentRef}>
        {agent}
      </div>
      {dueOpen && (
        <TaskDuePicker
          dueDate={todo.dueDate}
          dueTime={todo.dueTime}
          now={new Date(now)}
          onCommit={(value) => {
            setDueOpen(false);
            if (value.dueDate !== todo.dueDate || value.dueTime !== todo.dueTime) void onUpdate(value);
          }}
          onClose={() => setDueOpen(false)}
        />
      )}
    </aside>
  );
}
