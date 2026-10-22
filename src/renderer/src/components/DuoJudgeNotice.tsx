import { Columns2, X } from "lucide-react";
import type { ThreadStatus } from "@shared/contracts";
import type { DuoConversationComparison } from "../hooks/useDuoLaunchWatch";
import { IconButton } from "./ui";

type NoticeAction = "retry" | "cancel" | "open" | "read" | "dismiss";

interface NoticeCopy {
  tone: "muted" | "warning" | "failed";
  title: string;
  detail: string | null;
  actions: NoticeAction[];
}

function sideTurnFinished(
  entry: DuoConversationComparison,
  conversationStatus: ThreadStatus,
): boolean {
  return entry.sideStarted
    && conversationStatus !== "running"
    && conversationStatus !== "needs-input";
}

function failureCause(error: string | null): string {
  if (!error) return "Retry it or cancel the judge.";
  return error
    .replace(/^The judge (?:turn failed|could not start|input could not be assembled): /u, "")
    .replace(/ Retry it or cancel the judge\.$/u, "");
}

export function duoJudgeNoticeCopy(
  entry: DuoConversationComparison,
  conversationStatus: ThreadStatus,
): NoticeCopy | null {
  const judge = entry.role === "judge";
  if (!judge && !sideTurnFinished(entry, conversationStatus)) return null;
  const { state, error } = entry.comparison;
  if (state === "completed") {
    return judge
      ? null
      : {
          tone: "muted",
          title: "Verdict is in",
          detail: null,
          actions: ["read", "dismiss"],
        };
  }
  if (state === "waiting") {
    if (error) {
      return {
        tone: "warning",
        title: "Judge is waiting for its folder",
        detail: "Another operation is using it; it starts as soon as the folder is free.",
        actions: [judge ? "cancel" : "open"],
      };
    }
    return judge
      ? {
          tone: "muted",
          title: "Waiting for both chats to finish",
          detail: "The judge starts by itself.",
          actions: ["cancel"],
        }
      : {
          tone: "muted",
          title: "Waiting for the other chat",
          detail: "The judge compares both when it finishes.",
          actions: ["open"],
        };
  }
  if (state === "dispatching" || state === "running") {
    return judge
      ? null
      : {
          tone: "muted",
          title: "Judge is comparing both chats",
          detail: null,
          actions: ["open"],
        };
  }
  if (state === "failed") {
    return {
      tone: "failed",
      title: "Judge didn't finish",
      detail: failureCause(error),
      actions: ["retry", "cancel"],
    };
  }
  if (state === "interrupted") {
    return {
      tone: "warning",
      title: "Judge was interrupted",
      detail: "Inertia couldn't confirm the result.",
      actions: ["retry", "cancel"],
    };
  }
  return null;
}

export function DuoJudgeNotice({
  entry,
  conversationStatus,
  pendingAction,
  onRetry,
  onCancel,
  onOpenJudge,
  onDismiss,
}: {
  entry: DuoConversationComparison;
  conversationStatus: ThreadStatus;
  pendingAction: "retry" | "cancel" | null;
  onRetry: () => void;
  onCancel: () => void;
  onOpenJudge: (conversationId: string) => void;
  onDismiss: () => void;
}): React.JSX.Element | null {
  const copy = duoJudgeNoticeCopy(entry, conversationStatus);
  if (!copy) return null;
  const judgeConversationId = entry.comparison.conversationId;
  const busy = pendingAction !== null;
  return (
    <div
      className={`duo-judge-notice${copy.tone === "failed"
        ? " is-failed"
        : copy.tone === "warning" ? " is-warning" : ""}`}
      role="status"
      aria-live="polite"
    >
      <Columns2 size={14} aria-hidden="true" />
      <span>
        <strong>{copy.title}</strong>
        {copy.detail && <small>{copy.detail}</small>}
      </span>
      {copy.actions.map((action) => {
        if (action === "retry") {
          return (
            <button key={action} type="button" disabled={busy} onClick={onRetry}>
              {pendingAction === "retry" ? "Retrying…" : "Retry"}
            </button>
          );
        }
        if (action === "cancel") {
          return (
            <button key={action} type="button" disabled={busy} onClick={onCancel}>
              {pendingAction === "cancel" ? "Cancelling…" : "Cancel judge"}
            </button>
          );
        }
        if (action === "dismiss") {
          return (
            <IconButton key={action} label="Dismiss verdict notice" onClick={onDismiss}>
              <X size={14} />
            </IconButton>
          );
        }
        return (
          <button
            key={action}
            type="button"
            disabled={!judgeConversationId}
            onClick={() => {
              if (judgeConversationId) onOpenJudge(judgeConversationId);
            }}
          >
            {action === "read" ? "Read verdict" : "Open judge"}
          </button>
        );
      })}
    </div>
  );
}
