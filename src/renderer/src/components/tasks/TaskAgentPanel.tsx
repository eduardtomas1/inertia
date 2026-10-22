import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import type { ConversationShell } from "@shared/contracts";
import type { Todo } from "@shared/todos";

import { finishedLabel, formatTaskDay } from "./taskModel";
import { taskCanHandOffAgain, type TaskNeed, type TaskStatus } from "./taskStatus";

export interface TaskHandoffRender {
  retry: boolean;
  onCancel?: () => void;
}

export interface TaskAgentPanelProps {
  todo: Todo;
  status: TaskStatus;
  shell: ConversationShell | null;
  providerLabel: string;
  now: number;
  offline: boolean;
  startingLocally: boolean;
  renderHandoff: (options: TaskHandoffRender) => ReactNode;
  onOpenChat: () => void;
  onStop: () => void;
  onMarkDone: () => void;
  onReopen: () => void;
}

interface Well {
  headline: string;
  detail: string | null;
  tone: string | null;
  live: boolean;
}

const NEED_HEADLINES: Record<TaskNeed, string> = {
  approval: "wants your OK",
  input: "asked you a question",
  limited: "hit a usage limit",
};

function wellFor(
  todo: Todo,
  status: TaskStatus,
  shell: ConversationShell | null,
  providerLabel: string,
  now: number,
): Well | null {
  switch (status.kind) {
    case "todo":
      return null;
    case "starting":
      return { headline: "Starting…", detail: null, tone: "muted", live: true };
    case "working":
      return { headline: `${providerLabel} is working on it`, detail: null, tone: "working", live: false };
    case "needs":
      return {
        headline: `${providerLabel} ${NEED_HEADLINES[status.need ?? "approval"]}`,
        detail: null,
        tone: status.tone,
        live: false,
      };
    case "review":
      return {
        headline: finishedLabel(shell?.latestTurn?.completedAt ?? shell?.completedAt ?? null, now),
        detail: null,
        tone: "completed",
        live: false,
      };
    case "failed":
      return { headline: "Failed", detail: status.reason, tone: "failed", live: false };
    case "stopped":
      return { headline: "Stopped", detail: null, tone: "muted", live: false };
    case "archived":
      return { headline: "This chat was archived.", detail: null, tone: "muted", live: false };
    case "parked":
      return { headline: "The chat never started.", detail: null, tone: "muted", live: false };
    case "done":
      return {
        headline: todo.completedAt ? `Done · ${formatTaskDay(todo.completedAt, new Date(now))}` : "Done",
        detail: null,
        tone: "muted",
        live: false,
      };
  }
}

export function TaskAgentPanel({
  todo,
  status,
  shell,
  providerLabel,
  now,
  offline,
  startingLocally,
  renderHandoff,
  onOpenChat,
  onStop,
  onMarkDone,
  onReopen,
}: TaskAgentPanelProps): React.JSX.Element {
  const [retrying, setRetrying] = useState(false);
  const retryRef = useRef<HTMLButtonElement>(null);
  const focusRetry = useRef(false);
  const kind = status.kind;
  const canRetry = taskCanHandOffAgain(kind);

  useEffect(() => {
    if (!canRetry && kind !== "starting") setRetrying(false);
  }, [canRetry, kind]);

  useLayoutEffect(() => {
    if (retrying || !focusRetry.current) return;
    focusRetry.current = false;
    retryRef.current?.focus();
  }, [retrying]);

  const cancelRetry = (): void => {
    focusRetry.current = true;
    setRetrying(false);
  };

  const formVisible = kind === "todo" || (retrying && canRetry);
  const formMounted = formVisible || (startingLocally && kind === "starting");
  const well = wellFor(todo, status, shell, providerLabel, now);
  const chatReady = shell !== null && !(kind === "starting" && startingLocally);
  const linked = todo.conversationId !== null;
  const showChat = kind === "starting" || (linked && kind !== "todo" && (kind !== "done" || shell !== null));
  const chatPrimary = kind === "working" || kind === "needs";
  const retryLabel = kind === "failed" ? "Try again" : "Hand off again";

  return (
    <div className="task-agent">
      {well && (
        <div className={clsx("task-well", well.tone && `is-${well.tone}`)}>
          <p className={clsx("task-well-headline", well.live && "is-live")}>{well.headline}</p>
          {well.detail && <p className="task-well-detail">{well.detail}</p>}
        </div>
      )}
      {formMounted && (
        <div
          className="task-agent-form"
          hidden={!formVisible || undefined}
          onKeyDown={(event) => {
            if (!retrying || event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
            if (event.target instanceof HTMLSelectElement) return;
            event.preventDefault();
            cancelRetry();
          }}
        >
          {renderHandoff({
            retry: retrying && canRetry,
            onCancel: kind === "todo" ? undefined : cancelRetry,
          })}
        </div>
      )}
      {!formVisible && (
        <div className="task-actions-row">
          {kind === "working" && (
            <button key="stop" type="button" className="secondary-button" disabled={offline} onClick={onStop}>
              Stop
            </button>
          )}
          {showChat && (
            <button
              key="chat"
              type="button"
              className={chatPrimary ? "primary-button" : "secondary-button"}
              data-task-chat=""
              aria-disabled={chatReady ? undefined : "true"}
              onClick={() => {
                if (chatReady) onOpenChat();
              }}
            >
              Open chat
            </button>
          )}
          {kind === "review" && (
            <button key="done" type="button" className="primary-button" disabled={offline} onClick={onMarkDone}>
              Mark as done
            </button>
          )}
          {canRetry && (
            <button
              key="retry"
              ref={retryRef}
              type="button"
              className="primary-button"
              disabled={offline}
              onClick={() => setRetrying(true)}
            >
              {retryLabel}
            </button>
          )}
          {kind === "done" && (
            <button key="reopen" type="button" className="primary-button" disabled={offline} onClick={onReopen}>
              Reopen
            </button>
          )}
        </div>
      )}
    </div>
  );
}
