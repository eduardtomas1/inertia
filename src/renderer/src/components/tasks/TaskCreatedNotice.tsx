import { useEffect, useRef, useState } from "react";
import { CircleCheck, X } from "lucide-react";

import { IconButton } from "../ui";
import { TASK_CREATED_NOTICE_LIFETIME_MS, type TaskCreatedNotice as Notice } from "./taskCreation";
import "./TaskCreation.css";

/**
 * The quiet "Task created" confirmation. It leaves on its own after a while,
 * but never while the pointer rests on it or focus is inside it.
 */
export function TaskCreatedNotice({
  notice,
  onOpenTasks,
  onDismiss,
}: {
  notice: Notice;
  onOpenTasks(): void;
  onDismiss(): void;
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(TASK_CREATED_NOTICE_LIFETIME_MS);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const held = hovered || focused;

  useEffect(() => {
    remaining.current = TASK_CREATED_NOTICE_LIFETIME_MS;
  }, [notice.id]);

  useEffect(() => {
    if (held) return;
    const started = Date.now();
    const timer = window.setTimeout(() => dismiss.current(), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [held, notice.id]);

  const dismissByHand = (): void => {
    const target = notice.returnFocus;
    onDismiss();
    if (target?.isConnected) target.focus({ preventScroll: true });
  };

  return (
    <aside
      className="task-created-notice"
      role="status"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <CircleCheck size={14} aria-hidden="true" />
      <span>
        <strong>Task created</strong>
        <small>{notice.title}</small>
      </span>
      <button
        type="button"
        className="text-button"
        onClick={() => {
          onDismiss();
          onOpenTasks();
        }}
      >
        Open tasks
      </button>
      <IconButton label="Dismiss task confirmation" onClick={dismissByHand}>
        <X size={14} />
      </IconButton>
    </aside>
  );
}
