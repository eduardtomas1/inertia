import { RuntimeRequestError } from "../runtime-errors";
import { publicLimitResetPlan } from "../persistence/limit-reset-repository";
import type WebSocket from "ws";
import type { UsageLimitsService } from "../usage/limits-service";
import { LimitResetScheduler } from "../usage/limit-reset-scheduler";
import { defineRuntimeCommandHandler } from "./commands/command-router";
import { createTurnInteractionCommandHandler, type TurnInteractionCommandDependencies } from "./commands/turn-interaction-commands";

export function createLimitResetRuntime(dependencies: TurnInteractionCommandDependencies, limits: UsageLimitsService,
  options: { signal: AbortSignal; track<T>(operation: () => Promise<T>): Promise<T> }) {
  const scheduler = new LimitResetScheduler({
    store: dependencies.store, signal: options.signal, enabled: dependencies.enableProviders,
    readAccount: (providerId, force, model, cwd, interactive) => limits.nativeAccount(providerId, force, model, cwd, interactive),
    cachedAccount: (providerId, model, cwd) => limits.cachedNativeAccount(providerId, model, cwd),
    busy: (conversationId) => dependencies.turns.isActive(conversationId)
      || dependencies.store.hasActiveWorkspaceRunForConversation(conversationId)
      || dependencies.providerTerminalResumes.isActive(conversationId),
    track: options.track,
    changed: (conversationId) => {
      if (options.signal.aborted) return;
      dependencies.broadcast({ type: "conversation.detail.invalidated", conversationId });
      dependencies.broadcastSnapshot();
    },
    dispatch: async (plan, guard) => {
      if (!await dependencies.turns.waitForProviderCleanup([plan.conversationId], Date.now() + 30_000)) throw new RuntimeRequestError("The previous turn is still closing. Resume this chat manually.");
      guard();
      const handler = createTurnInteractionCommandHandler({ ...dependencies,
        limitResetDispatch: { planId: plan.id, assertCurrent: guard }, send: () => undefined });
      await handler(null as unknown as WebSocket, { type: "message.send", requestId: plan.id,
        payload: { conversationId: plan.conversationId, content: "Continue from where you stopped.", attachments: [], activate: false } });
    },
  });
  const handler = defineRuntimeCommandHandler([
    "conversation.limit-reset.get", "conversation.limit-reset.schedule", "conversation.limit-reset.cancel", "conversation.limit-reset.snooze",
    "conversation.limit-reset.resume",
  ], async (socket, command) => {
    switch (command.type) {
      case "conversation.limit-reset.get":
        dependencies.send(socket, { type: "request.result", requestId: command.requestId, result: await scheduler.get(command.payload.conversationId) });
        break;
      case "conversation.limit-reset.schedule":
        dependencies.send(socket, { type: "request.result", requestId: command.requestId, result: await scheduler.schedule(command.payload) });
        break;
      case "conversation.limit-reset.resume":
        dependencies.send(socket, { type: "request.result", requestId: command.requestId, result: await scheduler.resume(command.payload) });
        break;
      case "conversation.limit-reset.cancel": {
        dependencies.store.conversation(command.payload.conversationId);
        scheduler.cancel(command.payload.conversationId, command.payload.id);
        const plan = dependencies.store.limitResets.get(command.payload.conversationId);
        dependencies.send(socket, { type: "request.result", requestId: command.requestId, result: {
          kind: "conversation.limit-reset", conversationId: command.payload.conversationId,
          offer: null, plan: plan ? publicLimitResetPlan(plan) : null,
        } });
        break;
      }
      case "conversation.limit-reset.snooze":
        await scheduler.snooze(command.payload);
        dependencies.send(socket, { type: "request.result", requestId: command.requestId, result: await scheduler.get(command.payload.conversationId) });
        break;
      default: return "not-handled";
    }
    return "handled";
  });
  return { handler, start: () => scheduler.start() };
}
