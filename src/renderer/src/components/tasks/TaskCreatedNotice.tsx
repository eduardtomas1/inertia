import { CircleCheck, X } from "lucide-react";

import { IconButton } from "../ui";
import type { TaskCreatedNotice as Notice } from "./taskCreation";
import "./TaskCreation.css";

export function TaskCreatedNotice({
  notice,
  onOpenTasks,
  onDismiss,
}: {
  notice: Notice;
  onOpenTasks(): void;
  onDismiss(): void;
}): React.JSX.Element {
  return (
    <aside className="task-created-notice" role="status">
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
      <IconButton label="Dismiss task confirmation" onClick={onDismiss}>
        <X size={14} />
      </IconButton>
    </aside>
  );
}
