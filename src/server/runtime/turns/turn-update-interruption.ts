import type { RuntimeStore } from "../../database";

export function updateInterruptionMessage(store: Pick<RuntimeStore, "restartContinuations">, conversationId: string, turnId: string): string {
  const plan = store.restartContinuations.forConversation(conversationId);
  return plan?.state === "waiting" && plan.interruptedTurnId === turnId
    ? "Stopped to update Inertia. The chat continues after the update."
    : "Stopped to update Inertia.";
}
