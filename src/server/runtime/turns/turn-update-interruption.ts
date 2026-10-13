import type { RuntimeStore } from "../../database";

export const UPDATE_INTERRUPTION_CLEANUP_MS = 30_000;

export function updateInterruptionMessage(store: Pick<RuntimeStore, "restartContinuations">, conversationId: string, turnId: string): string {
  const plan = store.restartContinuations.forConversation(conversationId);
  return plan?.state === "waiting" && plan.interruptedTurnId === turnId
    ? "Stopped to update Inertia. The chat continues after the update."
    : "Stopped to update Inertia.";
}
