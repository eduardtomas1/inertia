import type {
  AgentApprovalRequest,
  AgentInputRequest,
} from "../../shared/contracts";

export type PendingInteraction = AgentApprovalRequest | AgentInputRequest;

export type PendingInteractionOwner = Pick<
  PendingInteraction,
  "providerId" | "conversationId" | "runId" | "turnId"
>;

/**
 * Provider request identifiers are scoped to one exact provider turn. JSON
 * tuple encoding keeps arbitrary provider-authored identifiers collision-free
 * without reserving a delimiter vocabulary.
 */
export function pendingInteractionKey(
  owner: PendingInteractionOwner,
  requestId: string,
): string {
  return JSON.stringify([
    owner.providerId,
    owner.conversationId,
    owner.runId,
    owner.turnId,
    requestId,
  ]);
}

function matchesExactOwner(
  request: PendingInteraction,
  owner: PendingInteractionOwner,
  requestId: string,
): boolean {
  return request.id === requestId
    && request.providerId === owner.providerId
    && request.conversationId === owner.conversationId
    && request.runId === owner.runId
    && request.turnId === owner.turnId;
}

export function registerPendingInteraction<T extends PendingInteraction>(
  pending: Map<string, T>,
  request: T,
): boolean {
  const key = pendingInteractionKey(request, request.id);
  if (pending.has(key)) return false;
  pending.set(key, request);
  return true;
}

export function pendingInteractionForOwner<T extends PendingInteraction>(
  pending: ReadonlyMap<string, T>,
  owner: PendingInteractionOwner,
  requestId: string,
): T | undefined {
  const request = pending.get(pendingInteractionKey(owner, requestId));
  return request && matchesExactOwner(request, owner, requestId)
    ? request
    : undefined;
}

export function deletePendingInteraction<T extends PendingInteraction>(
  pending: Map<string, T>,
  owner: PendingInteractionOwner,
  requestId: string,
): boolean {
  const key = pendingInteractionKey(owner, requestId);
  const request = pending.get(key);
  return Boolean(
    request
    && matchesExactOwner(request, owner, requestId)
    && pending.delete(key),
  );
}

function deletePendingInteractions<T extends PendingInteraction>(
  pending: Map<string, T>,
  owner: PendingInteractionOwner,
  requestIds: Iterable<string>,
): number {
  let deleted = 0;
  for (const requestId of requestIds) {
    if (deletePendingInteraction(pending, owner, requestId)) deleted += 1;
  }
  return deleted;
}

interface PendingInteractionTurn {
  conversation: { id: string };
  turn: Pick<PendingInteractionOwner, "providerId" | "runId"> & { id: string };
  approvalIds: Set<string>;
  inputIds: Set<string>;
}

export function clearPendingInteractionsForTurn(
  active: PendingInteractionTurn,
  pendingApprovals: Map<string, AgentApprovalRequest>,
  pendingInputs: Map<string, AgentInputRequest>,
): void {
  const owner = {
    providerId: active.turn.providerId,
    conversationId: active.conversation.id,
    runId: active.turn.runId,
    turnId: active.turn.id,
  };
  deletePendingInteractions(pendingApprovals, owner, active.approvalIds);
  deletePendingInteractions(pendingInputs, owner, active.inputIds);
  active.approvalIds.clear();
  active.inputIds.clear();
}

/**
 * Renderer commands intentionally remain narrow. A conversation plus request
 * identifier may resolve only when it names one unambiguous exact owner.
 */
export function pendingInteractionForConversation<T extends PendingInteraction>(
  pending: ReadonlyMap<string, T>,
  conversationId: string,
  requestId: string,
): T | undefined {
  let match: T | undefined;
  for (const request of pending.values()) {
    if (
      request.conversationId !== conversationId
      || request.id !== requestId
    ) continue;
    if (match) return undefined;
    match = request;
  }
  return match;
}
