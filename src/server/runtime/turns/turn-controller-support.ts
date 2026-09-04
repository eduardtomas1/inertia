import {
  isAgentTurnTerminalStatus,
  type AgentTurn,
  type AgentTurnUsageSnapshot,
  type ProviderId,
  type ThreadUsageSnapshot,
} from "../../../shared/contracts";
import {
  providerFailureActivityDetail,
  sanitizeProviderFailureSummary,
} from "../../provider/activity-detail";
import type {
  ProviderRunFailure,
  ProviderRunResult,
} from "../../provider/contracts";
import type {
  ActiveTurn,
  TurnControllerHooks,
  TurnTimerScheduler,
} from "./turn-controller-types";

export const MAX_ASSISTANT_TEXT = 4 * 1024 * 1024;
export const MAX_REASONING_TEXT = 512 * 1024;
/** Maximum provider silence, not an absolute turn lifetime. */
export const DEFAULT_TURN_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
/** Fail-safe ceiling for one owned provider process, even if it stays noisy. */
export const DEFAULT_TURN_MAX_LIFETIME_MS = 24 * 60 * 60 * 1_000;

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

export function broadcastTurnConversationShell(
  hooks: TurnControllerHooks,
  active: ActiveTurn,
): void {
  if (hooks.broadcastConversationShell) {
    hooks.broadcastConversationShell(active.conversation.id);
  } else {
    hooks.broadcastSnapshot();
  }
}

export function providerLabel(providerId: ProviderId): string {
  return providerId === "codex"
    ? "Codex"
    : providerId === "claude"
      ? "Claude"
      : providerId === "cursor"
        ? "Cursor"
        : providerId === "gemini"
          ? "Gemini"
          : providerId === "kimi"
            ? "Kimi Code"
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
  const technicalDetail = providerFailureActivityDetail({
    reason: "transport-closed",
    phase: active.turn.status,
    exitCode: null,
    signal: null,
    terminalEvent: "not received",
    activityId,
    cleanupConfirmed: false,
    cause: publicTurnError(error),
    stack: error instanceof Error ? error.stack : undefined,
    workspaceRoot: active.providerInput.cwd,
  });
  return {
    reason: "transport-closed",
    message,
    phase: active.turn.status,
    ...(activityId ? { activityId } : {}),
    ...(technicalDetail ? { technicalDetail } : {}),
  };
}

/**
 * Converts every failed harness result into the same safe, durable envelope.
 * Existing harness errors keep their user-visible value only after the same
 * path/credential/content-key scrubber used by persisted provider activity.
 * Typed ProviderRunFailure context remains the richer diagnostic source.
 */
export function normalizedProviderRunFailure(
  active: ActiveTurn,
  result: ProviderRunResult,
): ProviderRunFailure {
  const reported = result.failure;
  const reason = reported?.reason
    ?? (result.signal !== null
      ? "process-signal"
      : result.exitCode !== null
        ? "process-exit"
        : "provider-error");
  const fallback = `${providerLabel(result.providerId)} could not complete the request.`;
  const message = sanitizeProviderFailureSummary(
    result.error ?? reported?.message,
    fallback,
    { workspaceRoot: active.providerInput.cwd },
  );
  const technicalDetail = providerFailureActivityDetail({
    reason,
    phase: reported?.phase ?? active.turn.status,
    exitCode: result.exitCode,
    signal: result.signal,
    terminalEvent: reported?.terminalEvent,
    activityId: reported?.activityId,
    cleanupConfirmed: result.cleanupConfirmed,
    cause: result.error,
    technicalDetail: reported?.technicalDetail,
    workspaceRoot: active.providerInput.cwd,
  });
  return {
    reason,
    message,
    phase: reported?.phase ?? active.turn.status,
    ...(reported?.terminalEvent ? { terminalEvent: reported.terminalEvent } : {}),
    ...(reported?.activityId ? { activityId: reported.activityId } : {}),
    technicalDetail,
  };
}
