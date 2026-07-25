import type { WorkspaceRun } from "./contracts";

export type WorkspaceRunOperationalBucket = "attention" | "active" | "recent" | "hidden";
export type WorkspaceRunAttentionReason = "waiting" | "failure" | null;

export interface WorkspaceRunAttentionView {
  bucket: WorkspaceRunOperationalBucket;
  reason: WorkspaceRunAttentionReason;
  needsAttention: boolean;
  unseen: boolean;
  unread: boolean;
  canMarkSeen: boolean;
  canAcknowledge: boolean;
  canDismiss: boolean;
}

function terminalRun(run: WorkspaceRun): boolean {
  return run.status !== "running" && run.status !== "waiting";
}

/**
 * Canonical operational attention selector shared by Work and Runs.
 *
 * Waiting requests remain actionable regardless of a corrupt or stale
 * disposition. A seen failure still requires an explicit acknowledgement;
 * seeing a successful background completion only clears its unread marker.
 */
export function workspaceRunAttentionView(run: WorkspaceRun): WorkspaceRunAttentionView {
  const unseen = run.attentionState === "unseen";
  const finished = terminalRun(run);

  if (run.status === "waiting") {
    return {
      bucket: "attention",
      reason: "waiting",
      needsAttention: true,
      unseen,
      unread: false,
      canMarkSeen: unseen,
      canAcknowledge: false,
      canDismiss: false,
    };
  }

  if (run.status === "running") {
    return {
      bucket: "active",
      reason: null,
      needsAttention: false,
      unseen: false,
      unread: false,
      canMarkSeen: false,
      canAcknowledge: false,
      canDismiss: false,
    };
  }

  if (run.attentionState === "dismissed") {
    return {
      bucket: "hidden",
      reason: null,
      needsAttention: false,
      unseen: false,
      unread: false,
      canMarkSeen: false,
      canAcknowledge: false,
      canDismiss: false,
    };
  }

  const failureNeedsAttention = run.status === "failed"
    && run.attentionState !== "acknowledged";
  return {
    bucket: failureNeedsAttention ? "attention" : "recent",
    reason: failureNeedsAttention ? "failure" : null,
    needsAttention: failureNeedsAttention,
    unseen,
    unread: run.kind === "agent" && run.status === "succeeded" && unseen,
    canMarkSeen: unseen,
    canAcknowledge: run.attentionState !== "acknowledged",
    canDismiss: finished,
  };
}

export function workspaceRunNeedsAttention(run: WorkspaceRun): boolean {
  return workspaceRunAttentionView(run).needsAttention;
}

export function workspaceRunIsOperationallyVisible(run: WorkspaceRun): boolean {
  return workspaceRunAttentionView(run).bucket !== "hidden";
}

function compareRunRecency(a: WorkspaceRun, b: WorkspaceRun): number {
  return b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id);
}

/**
 * Selects the single canonical agent run representing a conversation in Work.
 * A live/waiting run wins; otherwise the latest run wins even when dismissed,
 * so dismissing it cannot accidentally resurface an older failure.
 */
export function selectConversationWorkspaceRun(
  conversationId: string,
  runs: readonly WorkspaceRun[],
): WorkspaceRun | null {
  const candidates = runs
    .filter((run) => run.kind === "agent" && run.conversationId === conversationId)
    .sort(compareRunRecency);
  return candidates.find((run) => run.status === "running" || run.status === "waiting")
    ?? candidates[0]
    ?? null;
}
