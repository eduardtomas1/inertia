import type { ConversationShell } from "@shared/contracts";
import type { Todo } from "@shared/todos";

import type { SidebarThreadStatus } from "../../utils/sidebarModel";

export const TASK_START_GRACE_MS = 60_000;

export type TaskStatusKind =
  | "todo"
  | "starting"
  | "working"
  | "needs"
  | "review"
  | "failed"
  | "stopped"
  | "archived"
  | "parked"
  | "done";

export type TaskBucket = "needs-you" | "working" | "to-do" | "done";
export type TaskStatusTone = "working" | "approval" | "input" | "failed" | "completed" | "muted";
export type TaskNeed = "approval" | "input" | "limited";

export interface TaskStatus {
  kind: TaskStatusKind;
  bucket: TaskBucket;
  word: string | null;
  tone: TaskStatusTone | null;
  live: boolean;
  need: TaskNeed | null;
  reason: string | null;
}

export interface TaskStatusInput {
  todo: Pick<Todo, "completedAt" | "conversationId" | "linkedAt">;
  status: SidebarThreadStatus | null;
  shell: Pick<ConversationShell, "archivedAt" | "latestTurn"> | null;
  now: number;
  starting: boolean;
}

const NEED_WORDS: Record<TaskNeed, string> = {
  approval: "Needs your OK",
  input: "Asked you a question",
  limited: "Hit a usage limit",
};

function status(
  kind: TaskStatusKind,
  bucket: TaskBucket,
  word: string | null,
  tone: TaskStatusTone | null,
  extra: Partial<Pick<TaskStatus, "live" | "need" | "reason">> = {},
): TaskStatus {
  return { kind, bucket, word, tone, live: extra.live ?? false, need: extra.need ?? null, reason: extra.reason ?? null };
}

function withinStartGrace(linkedAt: string | null, now: number): boolean {
  if (!linkedAt) return false;
  const linked = Date.parse(linkedAt);
  return Number.isFinite(linked) && now - linked < TASK_START_GRACE_MS;
}

export function deriveTaskStatus({ todo, status: chat, shell, now, starting }: TaskStatusInput): TaskStatus {
  if (todo.completedAt !== null) return status("done", "done", null, null);
  if (starting) return status("starting", "working", "Starting…", "muted", { live: true });
  if (todo.conversationId === null) return status("todo", "to-do", null, null);
  const turn = shell?.latestTurn ?? null;
  const fresh = withinStartGrace(todo.linkedAt, now);
  if (!shell || chat === null) {
    return fresh
      ? status("starting", "working", "Starting…", "muted", { live: true })
      : status("parked", "to-do", "Not started", "muted");
  }
  if (shell.archivedAt !== null) return status("archived", "to-do", "Chat archived", "muted");
  if (chat === "approval" || chat === "input" || chat === "limited") {
    return status("needs", "needs-you", NEED_WORDS[chat], chat === "input" ? "input" : "approval", { need: chat });
  }
  if (chat === "working") return status("working", "working", "Working…", "working", { live: true });
  if (chat === "failed") {
    return status("failed", "needs-you", "Failed", "failed");
  }
  if (chat === "completed") return status("review", "needs-you", "Ready for you", "completed");
  if (!turn) {
    return fresh
      ? status("starting", "working", "Starting…", "muted", { live: true })
      : status("parked", "to-do", "Not started", "muted");
  }
  if (turn.status === "completed") return status("review", "needs-you", "Ready for you", "completed");
  if (turn.status === "cancelled" || turn.status === "interrupted") {
    return status("stopped", "to-do", "Stopped", "muted");
  }
  if (turn.status === "failed") {
    return status("failed", "needs-you", "Failed", "failed");
  }
  return status("working", "working", "Working…", "working", { live: true });
}

const BUCKET_RANK: Record<TaskStatusKind, number> = {
  needs: 0,
  failed: 1,
  review: 2,
  working: 3,
  starting: 4,
  todo: 5,
  stopped: 5,
  archived: 5,
  parked: 5,
  done: 6,
};

export function taskStatusRank(kind: TaskStatusKind): number {
  return BUCKET_RANK[kind];
}

export function taskCanHandOffAgain(kind: TaskStatusKind): boolean {
  return kind === "failed" || kind === "stopped" || kind === "archived" || kind === "parked";
}

export function tasksSummary(statuses: readonly TaskStatus[], doneCount: number): string {
  const count = (bucket: TaskBucket): number => statuses.filter((entry) => entry.bucket === bucket).length;
  const needs = count("needs-you");
  const working = count("working");
  const toDo = count("to-do");
  const parts = [
    needs > 0 ? `${needs} need${needs === 1 ? "s" : ""} you` : null,
    working > 0 ? `${working} working` : null,
    toDo > 0 ? `${toDo} to do` : null,
  ].filter((part): part is string => part !== null);
  if (parts.length > 0) return parts.join(" · ");
  return doneCount > 0 ? "All done" : "Add anything you need to do";
}
