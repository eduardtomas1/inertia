import { randomUUID } from "node:crypto";
import type WebSocket from "ws";

import { RuntimeRequestError } from "../runtime-errors";
import { createTurnInteractionCommandHandler, type TurnInteractionCommandDependencies } from "./commands/turn-interaction-commands";
import { RestartContinuationScheduler } from "./restart-continuation-scheduler";
import { isHeld } from "./update-hold";

const PROVIDER_CLEANUP_WAIT_MS = 30_000;

export interface RestartContinuationRuntime {
  scheduler: RestartContinuationScheduler;
  createPlans(conversationIds: readonly string[]): string[];
  arm(): void;
  start(): void;
}

export function createRestartContinuationRuntime(dependencies: TurnInteractionCommandDependencies,
  options: { signal: AbortSignal; track<T>(operation: () => Promise<T>): Promise<T> }): RestartContinuationRuntime {
  const pending = (conversationId: string): boolean => [...dependencies.pendingApprovals.values(), ...dependencies.pendingInputs.values()]
    .some((request) => request.conversationId === conversationId);
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
        payload: { conversationId: plan.conversationId, content: "Continue from where you stopped.", attachments: [], activate: false } });
    },
  });
  return {
    scheduler,
    createPlans: (conversationIds) => scheduler.createPlans(conversationIds),
    arm: () => scheduler.arm(),
    start: () => scheduler.start(),
  };
}
