import type { TurnProviderRuntime } from "./turn-controller-types";

/**
 * Sends the advisory cancellation signal without letting a malformed provider
 * suppress owner-scoped stopOwned settlement.
 */
export function requestProviderCancellation(
  providers: Pick<TurnProviderRuntime, "cancel">,
  conversationId: string,
): void {
  try {
    providers.cancel(conversationId);
  } catch {
    // stopOwned is the sole cleanup authority for a started provider run.
  }
}
