import {
  isAgentTurnTerminalStatus,
  type AgentTurn,
  type AgentTurnUsageSnapshot,
  type ThreadUsageSnapshot,
} from "../../../shared/contracts";
import { staleProviderSessionDecision } from "../../../shared/continuation-policy";
import {
  providerFailureActivityDetail,
  sanitizeProviderFailureSummary,
} from "../../provider/activity-detail";
import type {
  ProviderRunFailure,
  ProviderRunResult,
} from "../../provider/contracts";
import { PROVIDER_INFO } from "../../provider/catalog";
import type {
  ActiveTurn,
  TurnControllerHooks,
  TurnTimerScheduler,
} from "./turn-controller-types";

export const MAX_ASSISTANT_TEXT = 4 * 1024 * 1024;
export const MAX_REASONING_TEXT = 512 * 1024;
export const DEFAULT_TURN_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
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
  publishTurnProjection(() => hooks.broadcastConversationShell
    ? hooks.broadcastConversationShell(active.conversation.id)
    : hooks.broadcastSnapshot());
}

export function broadcastTurnSnapshot(hooks: TurnControllerHooks): void {
  publishTurnProjection(() => hooks.broadcastSnapshot());
}

function publishTurnProjection(publish: () => void | Promise<void>): void {
  const failed = (): void => {
    console.warn("A turn update could not be published. Reconnect to load the saved state.");
  };
  try {
    const publication = publish();
    if (publication) void Promise.resolve(publication).catch(failed);
  } catch { failed(); }
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

export function normalizedProviderRunFailure(
  active: ActiveTurn,
  result: ProviderRunResult,
  sessionUnavailableMessage: string | null = null,
): ProviderRunFailure {
  const reported = result.failure;
  const reason = reported?.reason
    ?? (result.signal !== null
      ? "process-signal"
      : result.exitCode !== null
        ? "process-exit"
        : "provider-error");
  const fallback = `${PROVIDER_INFO[result.providerId].name} could not complete the request.`;
  const message = reported?.sessionUnavailable === true
    ? sessionUnavailableMessage ?? staleProviderSessionDecision().reason
    : sanitizeProviderFailureSummary(
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
    ...(reported?.usageLimited ? { usageLimited: true as const } : {}),
    technicalDetail,
  };
}
