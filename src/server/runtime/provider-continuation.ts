import type { ClientCommand, Conversation, ModelSelection } from "../../shared/contracts";
import { isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
import type { RuntimeStore } from "../database";
import { getRepositoryStatus, GitError } from "../git";
import { RuntimeRequestError } from "../runtime-errors";
type ConversationCreatePayload = Extract<ClientCommand, { type: "conversation.create" }>["payload"];

/** A handoff creates a fresh provider session and never rewrites source history. */
export async function createProviderContinuation(
  store: RuntimeStore,
  payload: ConversationCreatePayload,
  route: { providerId: Conversation["providerId"]; selection: ModelSelection },
): Promise<Conversation> {
  const continuation = payload.continuation;
  if (!continuation || !payload.draftConversationId) throw new RuntimeRequestError("The continuation request is incomplete.");
  const validateSource = (): Conversation => {
    const source = store.conversation(continuation.sourceConversationId);
    if (source.projectId !== payload.projectId || source.updatedAt !== continuation.expectedUpdatedAt
      || source.archivedAt || source.mixedProviderHistory) {
      throw new RuntimeRequestError("The source chat changed. Close this dialog and choose the provider again.");
    }
    const latestTurn = store.latestAgentTurnForConversation(source.id);
    if (source.status === "running" || source.status === "needs-input"
      || latestTurn && !isAgentTurnTerminalStatus(latestTurn.status)
      || store.hasRecordedActiveWorkspaceRunForConversation(source.id)
      || store.providerRunOwnership.forConversation(source.id).length > 0) {
      throw new RuntimeRequestError("Wait for the source chat and its processes to stop before continuing with another provider.");
    }
    return source;
  };
  const source = validateSource();
  // This stable destination identity also makes a lost-response retry discoverable.
  const existing = store.shellSnapshot().conversations.find(({ id }) => id === payload.draftConversationId);
  if (existing) {
    const packet = store.contextPackets.list(existing.id).find((item) => item.sourceConversationId === source.id);
    if (existing.projectId === source.projectId && existing.providerId === route.providerId && packet
      && JSON.stringify(existing.modelSelection) === JSON.stringify(route.selection)
      && existing.accessMode === (payload.accessMode ?? "supervised") && existing.interactionMode === (payload.interactionMode ?? "build")
      && !existing.hasHistory && packet.consumedMessageId === null
      && store.contextPackets.matchesDraftSelection(packet.id, existing.id, source.id, continuation.sourceMessageIds)
      && existing.branch === source.branch && existing.worktreePath === source.worktreePath) return store.conversation(existing.id);
    throw new RuntimeRequestError("This continuation already exists with different settings. Choose the provider again.");
  }
  const checkout = store.conversationPath(source.id);
  const reservation = `provider-continuation:${payload.draftConversationId}`;
  if (!store.conversationWork.reserveExclusiveCheckout(reservation, source.projectId, checkout)) {
    throw new RuntimeRequestError("Stop active work in this checkout before continuing with another provider.");
  }
  try {
    let branch: string | null = null;
    try { branch = (await getRepositoryStatus(checkout)).branch; }
    catch (error) { if (!(error instanceof GitError && error.code === "not-repository")) throw error; }
    const current = validateSource();
    if (store.conversationPath(source.id) !== checkout || current.branch !== branch) {
      throw new RuntimeRequestError("The source checkout or branch changed. Refresh the chat before continuing.");
    }
    return store.createContinuationConversation(source.id, payload.title, {
      id: payload.draftConversationId,
      providerId: route.providerId, modelSelection: route.selection,
      accessMode: payload.accessMode ?? "supervised",
      interactionMode: payload.interactionMode ?? "build",
    }, continuation.sourceMessageIds);
  } finally { store.conversationWork.release(reservation); }
}
