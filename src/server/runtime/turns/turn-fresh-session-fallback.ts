import { cliProviderLabel } from "../../../shared/cli-conversations";
import { importedSession } from "../../cli-import/resume-cwd";
import type { RuntimeStore } from "../../database";
import type {
  ProviderFreshSessionFallback,
  ProviderEvent,
  ProviderFreshSessionPrior,
  ProviderRunResult,
} from "../../provider/contracts";
import { broadcastTurnConversationShell } from "./turn-controller-support";
import type { ActiveTurn, TurnControllerHooks } from "./turn-controller-types";

export function providerSessionUnavailable(result: ProviderRunResult): boolean {
  return result.status === "failed" && result.failure?.sessionUnavailable === true;
}

export function recordRejectedProviderResume(
  store: RuntimeStore,
  active: ActiveTurn,
  result: ProviderRunResult,
): void {
  const sessionId = active.providerInput.sessionId;
  if (
    sessionId
    && result.status === "failed"
    && (result.failure?.sessionUnavailable === true || result.failure?.resumeRejected === true)
  ) store.turnLedgerRepository.recordRejectedResume(active.turn.id, sessionId);
}

export function importedSessionUnavailableMessage(
  store: RuntimeStore,
  active: ActiveTurn,
  result: ProviderRunResult,
): string | null {
  const provider = providerSessionUnavailable(result) ? importedSession(store, active.conversation.id, active.providerInput.sessionId)?.providerId : null;
  return provider ? `The original ${cliProviderLabel(provider)} session for this imported chat is no longer available.` : null;
}

export function releaseUnavailableProviderSession(
  store: RuntimeStore,
  active: ActiveTurn,
): void {
  const sessionId = active.providerInput.sessionId;
  if (importedSession(store, active.conversation.id, sessionId)) return;
  // Without a session id the lookup would match any backing of the route.
  const backing = sessionId ? store.orchestration.backings.find({ threadId: active.conversation.id,
    providerId: active.turn.providerId, workspaceKey: store.conversationPath(active.conversation.id),
    identity: active.turn.continuationIdentity, nativeSessionId: sessionId }) : null;
  if (backing) store.orchestration.backings.invalidate(backing, "native-resume-failed");
  active.sessionAfter = null;
  store.updateConversation(active.conversation.id, {
    providerSessionId: null,
    continuationIdentity: null,
  });
}

export function applyFreshSessionFallback(
  store: RuntimeStore,
  hooks: TurnControllerHooks,
  active: ActiveTurn,
  restartedAt: string,
  prior: ProviderFreshSessionPrior,
  route: (attemptId: string | null) => (event: ProviderEvent) => void,
): ProviderFreshSessionFallback | null {
  const expectedSessionId = active.providerInput.sessionId;
  if (
    !expectedSessionId
    || !active.freshSessionRequest
    || active.runState.isTerminal()
    || active.deferredSettlement !== null
    // A Stop records its interrupt before it cancels; that run is being stopped, not recovered (T3 recovers only a
    // run still `starting`).
    || store.orchestration.runControl.target(active.turn.runId)?.interruptRequested === true
    || active.assistantText !== ""
    || active.latestAssistantMessageId !== null
    || active.reasoningText !== ""
    || active.reasoningId !== null
    || active.approvalIds.size > 0
    || active.inputIds.size > 0
    || importedSession(store, active.conversation.id, expectedSessionId) !== null
    || store.turnLedgerRepository.turnHasProviderActivity(
      active.conversation.id,
      active.turn.id,
    )
  ) return null;
  const request = active.freshSessionRequest(active.turn.userMessageId);
  // The restart and the provider_recovery attempt replacement commit together;
  // a stale expected attempt refuses both and the rejected resume stands.
  const restarted = store.orchestration.restartOnFreshSession({
    turn: active.turn,
    expectedSessionId,
    expectedAttemptId: active.attemptId ?? null,
    prepared: request.contextHandoff,
    priorCleanup: prior.priorCleanup,
  }, () => store.turnLedgerRepository.restartOnFreshSession(active.turn.id, {
    expectedSessionId,
    executionContext: request.persistence,
    sessionRecovery: request.sessionRecovery,
    restartedAt,
  }));
  active.turn = restarted.result;
  active.attemptId = restarted.attemptId;
  const {
    sessionId: _sessionId,
    performanceModeTransition: _performanceModeTransition,
    goalContinuationExpected: _goalContinuationExpected,
    nativeContinuation: _nativeContinuation,
    ...providerInput
  } = active.providerInput;
  active.providerInput = {
    ...providerInput,
    prompt: request.executionPrompt,
    imagePaths: request.imagePaths,
  };
  active.conversation = {
    ...active.conversation,
    providerSessionId: null,
    continuationIdentity: null,
  };
  active.sessionAfter = null;
  active.lastUsage = null;
  active.freshSessionRequest = null;
  // The restart is committed. A failed broadcast must not make the wrapper keep
  // the rejected attempt's result for a turn that already moved on.
  try {
    hooks.broadcast({
      type: "conversation.detail.invalidated",
      conversationId: active.conversation.id,
    });
    broadcastTurnConversationShell(hooks, active);
  } catch {
    // Clients reconcile from the next snapshot.
  }
  // The fresh harness reports under the replacement attempt.
  return { prompt: request.executionPrompt, onEvent: route(active.attemptId) };
}
