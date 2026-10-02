// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import { createTurnInteractionCommandHandler, type TurnInteractionCommandDependencies } from "../../src/server/runtime/commands/turn-interaction-commands";
import { queuedRouteIdentity } from "../../src/server/persistence/queued-message-repository";
import { LimitResetScheduler } from "../../src/server/usage/limit-reset-scheduler";
import { cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime, flushTurnControllerTestPromises, turnControllerTestProviderInfo } from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);
describe("reset dispatch through ordinary turn admission", () => {
  it("never delivers a reset continuation as a follow-up to an active turn", async () => {
    const conversationId = randomUUID();
    const acquireFollowUpAdmission = vi.fn(() => ({ supportsImages: false, release: vi.fn() }));
    const steer = vi.fn();
    const dependencies = {
      store: { conversation: () => ({ id: conversationId, archivedAt: null }) },
      turns: { isActive: () => true, acquireFollowUpAdmission, steer },
      providerTerminalResumes: { isActive: () => false },
      send: vi.fn(), broadcast: vi.fn(), broadcastSnapshot: vi.fn(),
      limitResetDispatch: { planId: randomUUID(), assertCurrent: () => undefined },
    } as unknown as TurnInteractionCommandDependencies;
    await expect(createTurnInteractionCommandHandler(dependencies)(null as unknown as WebSocket, {
      type: "message.send", requestId: randomUUID(), payload: { conversationId, content: "Continue from where you stopped.", attachments: [], activate: false },
    })).rejects.toThrow("busy");
    expect(acquireFollowUpAdmission).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps the durable reset claim and turn acceptance atomic (cancel=%s)", async (cancel) => {
    const runtime = await createTurnControllerTestRuntime();
    const attachments = await ConversationAttachmentStore.open(runtime.directory);
    const abort = new AbortController();
    const scheduler = new LimitResetScheduler({ store: runtime.store, signal: abort.signal, enabled: true,
      busy: () => false, readAccount: async () => null, dispatch: async () => undefined,
      changed: () => undefined, track: (operation) => operation() });
    let transitionHeld = false;
    try {
      const failed = runtime.controller.queue({ conversationId: runtime.conversationId, content: "First task" });
      runtime.controller.start(failed.turn.id);
      await flushTurnControllerTestPromises();
      runtime.provider.resolve({ status: "failed", text: "Usage limit reached" });
      await flushTurnControllerTestPromises();
      await runtime.controller.waitForProviderCleanup([runtime.conversationId]);
      const conversation = runtime.store.conversation(runtime.conversationId);
      const id = randomUUID();
      const plan = { id, conversationId: conversation.id, failedTurnId: failed.turn.id,
        routeIdentity: queuedRouteIdentity(conversation), accountIdentity: "verified", resetsAt: new Date().toISOString(),
        nextAttemptAt: new Date().toISOString(), attempts: 0, state: "waiting" as const, error: null, turnId: null };
      runtime.store.limitResets.save(plan); runtime.store.limitResets.claim(plan);
      const dependencies: TurnInteractionCommandDependencies = {
        store: runtime.store, turns: runtime.controller, conversationAttachments: attachments,
        backendProfileController: { validateSelection: (selection: unknown) => selection, isExternalSelection: () => false, readiness: async () => null } as unknown as TurnInteractionCommandDependencies["backendProfileController"],
        isolatedRuns: { has: () => false } as unknown as TurnInteractionCommandDependencies["isolatedRuns"],
        workspaceRuns: {} as TurnInteractionCommandDependencies["workspaceRuns"],
        pendingApprovals: new Map(), pendingInputs: new Map(), dataDirectory: runtime.directory, enableProviders: true,
        attachmentResolver: null,
        generatedAttachments: { release: async () => undefined } as unknown as TurnInteractionCommandDependencies["generatedAttachments"],
        workflows: { resolveTurnSkills: async () => {
          if (cancel) scheduler.cancel(conversation.id, id);
          return { inputs: [], routeKey: null };
        }, assertTurnSkillsCurrent: () => undefined } as unknown as TurnInteractionCommandDependencies["workflows"],
        providerTerminalResumes: { isActive: () => transitionHeld,
          acquireWhenAvailable: async () => { transitionHeld = true; return true; }, release: () => { transitionHeld = false; } } as unknown as TurnInteractionCommandDependencies["providerTerminalResumes"],
        providerInfo: () => [turnControllerTestProviderInfo()], broadcast: () => undefined, broadcastSnapshot: () => undefined, send: () => undefined,
        limitResetDispatch: { planId: id, assertCurrent: () => scheduler.assertDispatch(plan) },
      };
      const result = createTurnInteractionCommandHandler(dependencies)(null as unknown as WebSocket, {
        type: "message.send", requestId: id, payload: { conversationId: conversation.id, content: "Continue from where you stopped.", attachments: [], activate: false },
      });
      if (cancel) await expect(result).rejects.toThrow();
      else await result;
      await flushTurnControllerTestPromises();
      expect(runtime.store.limitResets.get(conversation.id)?.state).toBe(cancel ? "cancelled" : "completed");
      expect(runtime.provider.runCount).toBe(cancel ? 1 : 2);
      expect(runtime.store.latestAgentTurnForConversation(conversation.id)?.id === failed.turn.id).toBe(cancel);
    } finally { abort.abort(); await runtime.controller.dispose(); await attachments.close(); runtime.store.close(); }
  });
});
