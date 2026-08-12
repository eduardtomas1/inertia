import {
  isAgentTurnTerminalStatus,
  type AgentTurn,
  type AgentTurnUsageSnapshot,
  type ProviderId,
  type ThreadUsageSnapshot,
} from "../../../shared/contracts";
import { sanitizeProviderActivityDetail } from "../../provider/activity-detail";
import type { ProviderRunFailure } from "../../provider/contracts";
import type { ActiveTurn, TurnTimerScheduler } from "./turn-controller-types";

export const MAX_ASSISTANT_TEXT = 4 * 1024 * 1024;
export const MAX_REASONING_TEXT = 512 * 1024;
export const DEFAULT_TURN_TIMEOUT_MS = 6 * 60 * 60 * 1_000;

export function defaultTurnScheduler(): TurnTimerScheduler {
  return {
    setTimeout: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return timer;
    },
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  };
}

export function providerLabel(providerId: ProviderId): string {
  return providerId === "codex"
    ? "Codex"
    : providerId === "claude"
      ? "Claude"
      : providerId === "cursor"
        ? "Cursor"
        : "OpenCode";
}

export function projectActionKind(name: string): "check" | "service" {
  return /(?:^|[:\s-])(dev|serve|server|start|watch|preview)(?:$|[:\s-])/iu.test(name)
    ? "service"
    : "check";
}

export function boundaryUsage(
  usage: ThreadUsageSnapshot | undefined,
  capturedAt: string,
  providerSessionBound: boolean,
): AgentTurnUsageSnapshot | null {
  if (!usage) return null;
  return {
    usedTokens: usage.usedTokens,
    totalProcessedTokens: usage.totalProcessedTokens,
    totalProcessedScope: usage.totalProcessedScope,
    maxTokens: usage.maxTokens,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    compactsAutomatically: usage.compactsAutomatically,
    providerSessionBound,
    capturedAt,
  };
}

export function updateActiveTurnProviderSession(
  active: Pick<ActiveTurn, "lastUsage" | "sessionAfter">,
  providerSessionId: string,
): void {
  if (active.lastUsage && active.sessionAfter !== providerSessionId) {
    active.lastUsage = {
      ...active.lastUsage,
      providerSessionBound: false,
    };
  }
  active.sessionAfter = providerSessionId;
}

export function previousTurnBoundaryUsage(
  previousTurn: Pick<
    AgentTurn,
    "association" | "providerSessionAfter" | "status" | "usageAtCompletion"
  > | null,
  providerSessionId: string,
): AgentTurnUsageSnapshot | null {
  // The conversation-level usage projection may belong to an older turn.
  // Only the preceding turn's immutable completion, captured while bound to
  // the exact resumed provider session, is a safe cumulative base.
  if (
    !previousTurn
    || previousTurn.association !== "authoritative"
    || !isAgentTurnTerminalStatus(previousTurn.status)
    || !previousTurn.usageAtCompletion
    || previousTurn.usageAtCompletion.providerSessionBound !== true
    || previousTurn.providerSessionAfter !== providerSessionId
  ) {
    return null;
  }
  return { ...previousTurn.usageAtCompletion };
}

export function publicTurnError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "The agent turn failed.";
}

export function providerPromiseFailure(
  active: ActiveTurn,
  error: unknown,
): ProviderRunFailure {
  let activityId: string | undefined;
  for (const id of active.providerActivitiesById.keys()) activityId = id;
  const isCodexAppServer =
    active.providerInput.harnessId === "codex-app-server";
  const message = isCodexAppServer
    ? "The Codex App Server connection closed before the turn completed."
    : "The provider connection closed before the turn completed.";
  const technicalDetail = sanitizeProviderActivityDetail(
    [
      "Reason: transport-closed",
      `Phase: ${active.turn.status}`,
      "Exit code: unavailable",
      "Signal: unavailable",
      "Terminal event: not received",
      `Activity: ${activityId ?? "not reported"}`,
      `Cause: ${publicTurnError(error)}`,
    ].join("\n"),
    { workspaceRoot: active.providerInput.cwd },
  );
  return {
    reason: "transport-closed",
    message,
    phase: active.turn.status,
    ...(activityId ? { activityId } : {}),
    ...(technicalDetail ? { technicalDetail } : {}),
  };
}
