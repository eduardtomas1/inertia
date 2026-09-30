import type { RuntimeStore } from "../../database";
import type {
  ProviderFreshSessionFallback,
  ProviderRunResult,
} from "../../provider/contracts";
import { broadcastTurnConversationShell } from "./turn-controller-support";
import type { ActiveTurn, TurnControllerHooks } from "./turn-controller-types";

export function providerSessionUnavailable(result: ProviderRunResult): boolean {
  return result.status === "failed" && result.failure?.sessionUnavailable === true;
}

export function releaseUnavailableProviderSession(
  store: RuntimeStore,
  active: ActiveTurn,
): void {
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
): ProviderFreshSessionFallback | null {
  const expectedSessionId = active.providerInput.sessionId;
  if (
    !expectedSessionId
    || !active.freshSessionRequest
    || active.runState.isTerminal()
    || active.deferredSettlement !== null
    || active.assistantText !== ""
    || active.latestAssistantMessageId !== null
    || active.reasoningText !== ""
    || active.reasoningId !== null
    || active.approvalIds.size > 0
    || active.inputIds.size > 0
    || store.turnLedgerRepository.turnHasProviderActivity(
      active.conversation.id,
      active.turn.id,
    )
  ) return null;
  const request = active.freshSessionRequest(active.turn.userMessageId);
  active.turn = store.turnLedgerRepository.restartOnFreshSession(active.turn.id, {
    expectedSessionId,
    executionContext: request.persistence,
    sessionRecovery: request.sessionRecovery,
    restartedAt,
  });
  const {
    sessionId: _sessionId,
    performanceModeTransition: _performanceModeTransition,
    goalContinuationExpected: _goalContinuationExpected,
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
  hooks.broadcast({
    type: "conversation.detail.invalidated",
    conversationId: active.conversation.id,
  });
  broadcastTurnConversationShell(hooks, active);
  return { prompt: request.executionPrompt };
}
