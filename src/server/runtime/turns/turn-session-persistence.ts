import type { AgentTurn, Conversation } from "../../../shared/contracts";
import { continuationIdentityForSelection } from "../../../shared/model-routing";
import type { RuntimeStore } from "../../database";
import type { ProviderSteerReadCallback } from "../../provider/types";
import type { ActiveTurn } from "./turn-controller-types";

declare module "../../provider/contracts" {
  interface ProviderRunCallbacks {
    onSteerRead?: ProviderSteerReadCallback;
  }
}

function sameConversationContinuationIdentity(
  conversation: Conversation,
  turn: Pick<AgentTurn, "providerId" | "continuationIdentity">,
): boolean {
  if (conversation.providerId !== turn.providerId) return false;
  const target = turn.continuationIdentity;
  const selectionIdentity = continuationIdentityForSelection(
    conversation.modelSelection,
    conversation.continuationIdentity?.endpointIdentity ?? null,
    target.modelIdentity !== null,
  );
  if (
    selectionIdentity.harnessId !== target.harnessId
    || selectionIdentity.backendProfileId !== target.backendProfileId
    || selectionIdentity.backendConfigurationRevision !== target.backendConfigurationRevision
    || (selectionIdentity.performanceModeIdentity ?? null) !== (target.performanceModeIdentity ?? null)
  ) {
    return false;
  }
  if (target.modelIdentity !== null && conversation.modelSelection.modelId !== target.modelIdentity) {
    return false;
  }
  const persisted = conversation.continuationIdentity;
  if (persisted !== null) {
    if (
      persisted.harnessId !== target.harnessId
      || persisted.backendProfileId !== target.backendProfileId
      || persisted.backendConfigurationRevision !== target.backendConfigurationRevision
      || (persisted.endpointIdentity ?? null) !== (target.endpointIdentity ?? null)
      || (persisted.modelIdentity ?? null) !== (target.modelIdentity ?? null)
      || (persisted.performanceModeIdentity ?? null) !== (target.performanceModeIdentity ?? null)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Active-turn session overwrite guard (Phase 5 Pkg 3 / Decision 4.8):
 * When a chat switches provider/harness/profile while Turn 1 is still running,
 * `conversation.update` clears `conversations.provider_session_id = null`.
 * Never overwrite the conversation's live session pointer with Turn 1's stale
 * session; V2 `backings.observeSession()` already recorded Turn 1's backing
 * durably under its own `providerInstanceId`.
 */
export function persistActiveTurnConversationSession(
  store: RuntimeStore,
  active: ActiveTurn,
  sessionId: string,
): boolean {
  if (typeof store.conversation === "function") {
    let current: Conversation;
    try {
      current = store.conversation(active.conversation.id);
    } catch {
      return false;
    }
    if (!sameConversationContinuationIdentity(current, active.turn)) {
      return false;
    }
  }
  store.updateConversation(active.conversation.id, {
    providerSessionId: sessionId,
    continuationIdentity: active.turn.continuationIdentity,
  });
  return true;
}

/**
 * Routes a harness's `onSteerRead(steerId, readAt)` callback to the durable
 * `run-control.steer-read` projection for the active turn's current attempt.
 */
export function recordActiveTurnSteerRead(
  store: RuntimeStore,
  active: ActiveTurn,
  fallbackAttemptId: string | null,
  steerId: string,
  readAt: string,
): boolean {
  const attemptId = active.attemptId ?? fallbackAttemptId;
  if (!attemptId || !steerId) return false;
  try {
    return store.orchestration.runControl.recordSteerRead({
      conversationId: active.conversation.id,
      projectId: active.conversation.projectId,
      runId: active.turn.runId,
      attemptId,
      effectId: steerId,
      readAt,
    });
  } catch {
    return false;
  }
}
