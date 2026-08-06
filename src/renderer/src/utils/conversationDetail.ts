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
  const conversation = Object.fromEntries(
    Object.entries(shell).filter(([field]) =>
      field !== "latestTurn"
      && field !== "pendingApproval"
      && field !== "pendingInput"),
  ) as unknown as Conversation;
  const latestTurn = shell.latestTurn;
  if (!latestTurn) return { ...detail, conversation };
  const turnIndex = detail.agentTurns.findIndex(
    ({ id }) => id === latestTurn.id,
  );
  if (turnIndex < 0) return { ...detail, conversation };
  const turn = detail.agentTurns[turnIndex]!;
  if (
    turn.status === latestTurn.status
    && turn.startedAt === latestTurn.startedAt
    && turn.completedAt === latestTurn.completedAt
    && turn.terminalReason === latestTurn.terminalReason
    && turn.updatedAt === latestTurn.updatedAt
  ) {
    return { ...detail, conversation };
  }
  const agentTurns = [...detail.agentTurns];
  agentTurns[turnIndex] = {
    ...turn,
    status: latestTurn.status,
    startedAt: latestTurn.startedAt,
    completedAt: latestTurn.completedAt,
    terminalReason: latestTurn.terminalReason,
    updatedAt: latestTurn.updatedAt,
  };
  return { ...detail, conversation, agentTurns };
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
