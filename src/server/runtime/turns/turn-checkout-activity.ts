import type { RuntimeStore } from "../../database";
import type { TurnProviderRuntime } from "./turn-controller-types";

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
