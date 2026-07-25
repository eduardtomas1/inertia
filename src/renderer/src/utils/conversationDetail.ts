import type {
  Conversation,
  ConversationDetail,
  ConversationDetailResult,
  ConversationDetailViewState,
  ConversationShell,
} from "@shared/contracts";

export function mergeConversationShell(
  detail: ConversationDetail,
  shell: ConversationShell,
): ConversationDetail {
  const conversation: Conversation = {
    ...detail.conversation,
    id: shell.id,
    projectId: shell.projectId,
    title: shell.title,
    providerId: shell.providerId,
    model: shell.model,
    reasoningEffort: shell.reasoningEffort,
    interactionMode: shell.interactionMode,
    accessMode: shell.accessMode,
    status: shell.status,
    attentionKind: shell.attentionKind,
    branch: shell.branch,
    worktreePath: shell.worktreePath,
    providerSessionId: shell.providerSessionId,
    archivedAt: shell.archivedAt,
    settledAt: shell.settledAt,
    completedAt: shell.completedAt,
    lastViewedAt: shell.lastViewedAt,
    createdAt: shell.createdAt,
    updatedAt: shell.updatedAt,
  };
  return { ...detail, conversation };
}

/**
 * Resolve an authoritative detail response without allowing a stale request
 * or a temporarily shell-only conversation to flash as missing.
 */
export function resolveConversationDetail(
  current: ConversationDetailViewState | null,
  expectedConversationId: string,
  result: ConversationDetailResult,
  shell: ConversationShell | null,
): ConversationDetailViewState | null {
  if (
    result.conversationId !== expectedConversationId
    || (current && current.conversationId !== expectedConversationId)
  ) {
    return current;
  }
  if (result.state === "missing" && shell?.id === expectedConversationId) {
    return current?.state === "ready"
      ? current
      : { conversationId: expectedConversationId, state: "loading" };
  }
  if (result.state === "ready" && shell?.id === expectedConversationId) {
    return { ...result, detail: mergeConversationShell(result.detail, shell) };
  }
  return result;
}
