import { randomUUID } from "node:crypto";
import type WebSocket from "ws";

import { RuntimeRequestError } from "../runtime-errors";
import { createTurnInteractionCommandHandler, type TurnInteractionCommandDependencies } from "./commands/turn-interaction-commands";
import { RestartContinuationScheduler } from "./restart-continuation-scheduler";
import { PROVIDER_CLEANUP_WAIT_MS } from "./turns/turn-admission-coordinator";
import { isHeld } from "./update-hold";

/**
 * Sent as the user's message when a turn that an app update cut short is
 * continued. The cut turn may have left a command or other action finished or
 * still running, so the agent is asked to confirm before repeating one.
 */
export const RESTART_CONTINUATION_PROMPT =
  "Continue from where you stopped. Inertia restarted while your last turn was running, so a command or other action it started may have finished or may still be running. Before you repeat an action that changes state, check that it did not already take effect and is not still running. If you cannot tell, say so instead of repeating it.";

export interface RestartContinuationRuntime {
  scheduler: RestartContinuationScheduler;
  createPlans(conversationIds: readonly string[]): string[];
  arm(): void;
  start(): void;
}

export function createRestartContinuationRuntime(dependencies: TurnInteractionCommandDependencies,
  options: { signal: AbortSignal; track<T>(operation: () => Promise<T>): Promise<T>; hasPendingSecret?: (conversationId: string) => boolean }): RestartContinuationRuntime {
  const pending = (conversationId: string): boolean => [...dependencies.pendingApprovals.values(), ...dependencies.pendingInputs.values()]
    .some((request) => request.conversationId === conversationId)
    || (options.hasPendingSecret?.(conversationId) ?? dependencies.turns.secretRequests?.hasPending(conversationId) ?? false);
  const scheduler = new RestartContinuationScheduler({
    store: dependencies.store, signal: options.signal, enabled: dependencies.enableProviders, held: isHeld,
    busy: (conversationId) => dependencies.turns.isActive(conversationId)
      || dependencies.store.hasActiveWorkspaceRunForConversation(conversationId)
      || dependencies.providerTerminalResumes.isActive(conversationId),
    pendingInteraction: pending,
    track: options.track,
    dispatch: async (plan, guard) => {
      if (!await dependencies.turns.waitForProviderCleanup([plan.conversationId], Date.now() + PROVIDER_CLEANUP_WAIT_MS)) {
        throw new RuntimeRequestError("The interrupted turn is still closing.");
      }
      guard();
      const handler = createTurnInteractionCommandHandler({ ...dependencies,
        restartContinuationDispatch: { planId: plan.id, assertCurrent: guard }, send: () => undefined });
      await handler(null as unknown as WebSocket, { type: "message.send", requestId: randomUUID(),
        payload: { conversationId: plan.conversationId, content: RESTART_CONTINUATION_PROMPT, attachments: [], activate: false } });
    },
  });
  return {
    scheduler,
    createPlans: (conversationIds) => scheduler.createPlans(conversationIds),
    arm: () => scheduler.arm(),
    start: () => scheduler.start(),
  };
}
