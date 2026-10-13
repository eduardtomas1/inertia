import type { TurnController } from "./turns/turn-controller";
import type {
  RestartContinuationPlanner,
  UpdateInterruptionController,
} from "./update-everything";

const PROVIDER_CLEANUP_WAIT_MS = 30_000;

export const restartContinuationStub: RestartContinuationPlanner = {
  createPlans: () => [],
  arm: () => undefined,
};

export function updateInterruptionStub(
  turns: Pick<TurnController, "activeConversationIds" | "cancel" | "waitForProviderCleanup">,
): UpdateInterruptionController {
  return {
    activeConversationIds: () => turns.activeConversationIds(),
    interruptForUpdate: async (conversationIds) => {
      for (const conversationId of conversationIds) turns.cancel(conversationId);
      return await turns.waitForProviderCleanup(conversationIds, Date.now() + PROVIDER_CLEANUP_WAIT_MS) !== false;
    },
  };
}
