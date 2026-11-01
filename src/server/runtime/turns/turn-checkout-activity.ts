import { isAgentTurnTerminalStatus } from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import type { OwnedProviderRun } from "../../persistence/provider-run-ownership-repository";
import type { ProviderRunIdentity } from "../../provider/contracts";
import type { ActiveTurn, TurnProviderRuntime } from "./turn-controller-types";

export function providerConversationIds(
  store: RuntimeStore,
  providers: TurnProviderRuntime,
): string[] {
  return store.shellSnapshot().conversations
    .filter(({ id }) => providers.isRunning(id))
    .map(({ id }) => id);
}

export function hasActiveTurnCheckout(
  store: RuntimeStore,
  providers: TurnProviderRuntime,
  trackedConversationIds: Iterable<string>,
  checkoutPath: string,
): boolean {
  const conversationIds = new Set([
    ...trackedConversationIds,
    ...providerConversationIds(store, providers),
  ]);
  return [...conversationIds].some((conversationId) =>
    store.conversationWork.conversationMatchesCheckout(
      conversationId,
      checkoutPath,
    ));
}

export function checkoutActivityConversationIds(
  store: RuntimeStore,
  providers: TurnProviderRuntime,
  trackedConversationIds: Iterable<string>,
): string[] {
  return [...new Set([
    ...trackedConversationIds,
    ...liveProviderRunConversationIds(store),
    ...providerConversationIds(store, providers),
  ])];
}

export function liveProviderRunOwnership(
  store: RuntimeStore,
  owned: readonly OwnedProviderRun[],
): OwnedProviderRun[] {
  return owned.filter(({ turnId }) =>
    !isAgentTurnTerminalStatus(store.agentTurn(turnId).status));
}

export function providerRecoveryRecords(
  store: RuntimeStore,
  owned: readonly OwnedProviderRun[],
): ProviderRunIdentity[] {
  return owned.flatMap(({ turnId, conversationId, runId }) => {
    const turn = store.agentTurn(turnId);
    return isAgentTurnTerminalStatus(turn.status)
      ? [{ providerId: turn.providerId, conversationId, runId, turnId }]
      : [];
  });
}

export function hasLiveProviderRun(store: RuntimeStore, conversationId: string): boolean {
  return liveProviderRunOwnership(
    store,
    store.providerRunOwnership.forConversation(conversationId),
  ).length > 0;
}

export function liveProviderRunConversationIds(store: RuntimeStore): string[] {
  return liveProviderRunOwnership(store, store.providerRunOwnership.all())
    .map(({ conversationId }) => conversationId);
}

export function turnOwnedProviderRuns(
  store: RuntimeStore,
  conversationId: string,
  turnId: string,
): OwnedProviderRun[] {
  const conversationRuns = store.providerRunOwnership.forConversation(conversationId);
  return [
    ...conversationRuns.filter((run) => run.turnId === turnId),
    ...liveProviderRunOwnership(store, conversationRuns.filter((run) => run.turnId !== turnId)),
  ];
}

export function exitedProviderTurns(
  actives: Iterable<ActiveTurn>,
  providers: TurnProviderRuntime,
): ActiveTurn[] {
  return [...actives].filter((active) =>
    active.providerRunStarted
    && active.deferredSettlement === null
    && !active.runState.isTerminal()
    && !providers.ownsRun(active.conversation.id, { runId: active.turn.runId, turnId: active.turn.id }));
}
