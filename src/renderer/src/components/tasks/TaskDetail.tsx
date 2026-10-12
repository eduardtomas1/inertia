import { useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarDays, Flag, X } from "lucide-react";
import clsx from "clsx";
import {
  MAX_TODO_NOTE_CHARS,
  MAX_TODO_TITLE_CHARS,
  type Todo,
  type TodoPatch,
} from "@shared/todos";

import { todoDueLabel } from "../../utils/todoDates";
import { IconButton } from "../ui";
import { TASK_PRIORITY_LABELS, type TaskStatusWord } from "./taskModel";
import type { TaskMenuAnchor } from "./TaskList";

export type TaskDetailMenu = "due" | "priority";
export type TaskFocusTarget = "title" | "agent";

const NOTE_SAVE_DELAY_MS = 600;
const FOCUSABLE = "button:not(:disabled), select:not(:disabled), input:not(:disabled)";

export interface TaskDetailProps {
  todo: Todo;
  now: Date;
  leaving: boolean;
  status: TaskStatusWord | null;
  canOpenChat: boolean;
  focusTarget: TaskFocusTarget | null;
  openMenu: TaskDetailMenu | null;
  handoff: ReactNode;
  onFocusHandled: () => void;
  onUpdate: (patch: TodoPatch) => void;
  onClose: () => void;
  onOpenChat: () => void;
  onToggleMenu: (menu: TaskDetailMenu, anchor: TaskMenuAnchor) => void;
  setMenuTrigger: (menu: TaskDetailMenu, node: HTMLButtonElement | null) => void;
}

function anchorBelow(element: HTMLElement): TaskMenuAnchor {
  const bounds = element.getBoundingClientRect();
  return { x: bounds.left, y: bounds.bottom + 4 };
}

export function TaskDetail({
  todo,
  now,
  leaving,
  status,
  canOpenChat,
  focusTarget,
  openMenu,
  handoff,
  onFocusHandled,
  onUpdate,
  onClose,
  onOpenChat,
  onToggleMenu,
  setMenuTrigger,
}: TaskDetailProps): React.JSX.Element {
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const agentRef = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState(todo.title);
  const [note, setNote] = useState(todo.note);
  const savedTitle = useRef(todo.title);
  const savedNote = useRef(todo.note);
  const editing = useRef<"title" | "note" | null>(null);
  const noteTimer = useRef<number | null>(null);
  const noteDraft = useRef(todo.note);
  const update = useRef(onUpdate);
  update.current = onUpdate;

  useEffect(() => {
    savedTitle.current = todo.title;
    if (editing.current !== "title") setTitle(todo.title);
  }, [todo.title]);

  useEffect(() => {
    savedNote.current = todo.note;
    if (editing.current !== "note" && noteTimer.current === null) {
      noteDraft.current = todo.note;
      setNote(todo.note);
    }
  }, [todo.note]);

  const flushNote = (): void => {
    if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
    noteTimer.current = null;
    if (noteDraft.current === savedNote.current) return;
    savedNote.current = noteDraft.current;
    update.current({ note: noteDraft.current });
  };
  const flushNoteRef = useRef(flushNote);
  flushNoteRef.current = flushNote;
  useEffect(() => () => flushNoteRef.current(), []);

  const saveTitle = (): void => {
    const next = title.trim();
    if (!next) {
      setTitle(savedTitle.current);
      return;
    }
    setTitle(next);
    if (next === savedTitle.current) return;
    savedTitle.current = next;
    onUpdate({ title: next });
  };

  useEffect(() => {
    if (!focusTarget) return;
    if (focusTarget === "title") {
      titleRef.current?.focus();
      titleRef.current?.select();
    } else {
      agentRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }
    onFocusHandled();
  }, [focusTarget, onFocusHandled]);

  const close = (): void => {
    if (editing.current === "title") saveTitle();
    flushNote();
    onClose();
  };

  const dueLabel = todo.dueDate ? todoDueLabel(todo.dueDate, now) : null;
  const priorityLabel = todo.priority ? TASK_PRIORITY_LABELS[todo.priority] : null;

  return (
    <aside
      className={clsx("task-detail", leaving && "is-leaving")}
      aria-label="Task details"
      aria-hidden={leaving || undefined}
      inert={leaving || undefined}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
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
          onFocus={() => { editing.current = "title"; }}
          onBlur={() => {
            editing.current = null;
            saveTitle();
          }}
          onChange={(event) => setTitle(event.currentTarget.value.replace(/[\r\n]+/gu, " "))}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            saveTitle();
          }}
        />
        <IconButton label="Close task details" className="task-detail-close" onClick={close}>
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
        onFocus={() => { editing.current = "note"; }}
        onBlur={() => {
          editing.current = null;
          flushNote();
        }}
        onChange={(event) => {
          const value = event.currentTarget.value;
          setNote(value);
          noteDraft.current = value;
          if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
          noteTimer.current = window.setTimeout(flushNote, NOTE_SAVE_DELAY_MS);
        }}
      />
      <div className="task-detail-chips">
        <button
          type="button"
          ref={(node) => setMenuTrigger("due", node)}
          className={clsx("task-chip", dueLabel && "is-set")}
          aria-label={dueLabel ? `Due date: ${dueLabel}` : "Due date"}
          aria-haspopup="menu"
          aria-expanded={openMenu === "due"}
          aria-controls={openMenu === "due" ? "task-due-menu" : undefined}
          onClick={(event) => onToggleMenu("due", anchorBelow(event.currentTarget))}
        >
          <CalendarDays size={14} aria-hidden="true" />
          {dueLabel ?? "Due"}
        </button>
        <button
          type="button"
          ref={(node) => setMenuTrigger("priority", node)}
          className={clsx("task-chip", priorityLabel && "is-set", todo.priority === "urgent" && "is-urgent")}
          aria-label={priorityLabel ? `Priority: ${priorityLabel}` : "Priority"}
          aria-haspopup="menu"
          aria-expanded={openMenu === "priority"}
          aria-controls={openMenu === "priority" ? "task-priority-menu" : undefined}
          onClick={(event) => onToggleMenu("priority", anchorBelow(event.currentTarget))}
        >
          {todo.priority === "urgent"
            ? <span className="task-urgent" aria-hidden="true">!</span>
            : <Flag size={14} aria-hidden="true" />}
          {priorityLabel ?? "Priority"}
        </button>
      </div>
      <div className="task-detail-agent" ref={agentRef}>
        {todo.conversationId ? (
          <div className="task-linked">
            {status && <span className={clsx("task-status", status === "Failed" && "is-failed")}>{status}</span>}
            <button type="button" className="secondary-button" disabled={!canOpenChat} onClick={onOpenChat}>
              Open chat
            </button>
          </div>
        ) : handoff}
      </div>
    </aside>
  );
}
