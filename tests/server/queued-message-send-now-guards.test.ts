// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import { createQueuedMessageRuntime } from "../../src/server/runtime/queued-message-runtime";
import { CHECKOUT_RESTORE_IN_PROGRESS } from "../../src/server/runtime/conversation-work-authority";
import { hold, release, UPDATE_HOLD_MESSAGE } from "../../src/server/runtime/update-hold";
import type { TurnInteractionCommandDependencies } from "../../src/server/runtime/commands/turn-interaction-commands";
import {
  cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime,
  flushTurnControllerTestPromises, turnControllerTestIdentity, turnControllerTestProviderInfo,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

async function fixture() {
  let queue: ReturnType<typeof createQueuedMessageRuntime> | undefined;
  const runtime = await createTurnControllerTestRuntime({ onTurnSettled: (turn) => queue?.onTurnSettled(turn) });
  const attachments = await ConversationAttachmentStore.open(runtime.directory);
  const abort = new AbortController();
  const dependencies: TurnInteractionCommandDependencies = {
    store: runtime.store, turns: runtime.controller, conversationAttachments: attachments,
    backendProfileController: {
      validateSelection: (selection: unknown) => selection,
      isExternalSelection: () => false, readiness: async () => null,
    } as unknown as TurnInteractionCommandDependencies["backendProfileController"],
    isolatedRuns: { has: () => false } as unknown as TurnInteractionCommandDependencies["isolatedRuns"],
    workspaceRuns: {} as TurnInteractionCommandDependencies["workspaceRuns"],
    pendingApprovals: new Map(), pendingInputs: new Map(), dataDirectory: runtime.directory, enableProviders: true,
    attachmentResolver: {
      resolvePayloads: async () => [], releaseAll: async () => undefined, relinquishAll: async () => undefined,
    } as unknown as TurnInteractionCommandDependencies["attachmentResolver"],
    generatedAttachments: { release: async () => undefined } as unknown as TurnInteractionCommandDependencies["generatedAttachments"],
    workflows: { resolveTurnSkills: async () => ({ inputs: [], routeKey: null }), assertTurnSkillsCurrent: () => undefined } as unknown as TurnInteractionCommandDependencies["workflows"],
    providerTerminalResumes: { isActive: () => false, acquireWhenAvailable: async () => true, release: () => undefined } as unknown as TurnInteractionCommandDependencies["providerTerminalResumes"],
    providerInfo: () => [turnControllerTestProviderInfo()], broadcast: () => undefined,
    broadcastSnapshot: () => undefined, send: () => undefined,
  };
  queue = createQueuedMessageRuntime(dependencies, { signal: abort.signal, track: (operation) => operation() });
  const queued = (queueHeld = false) => {
    const id = randomUUID();
    runtime.store.orchestration.queue.enqueue({ conversationId: runtime.conversationId, itemId: id, content: "Send me now.", queueHeld });
    return id;
  };
  return {
    ...runtime, queue, queued,
    close: async () => {
      abort.abort();
      await flushTurnControllerTestPromises();
      await runtime.controller.dispose();
      await attachments.close();
      runtime.store.close();
    },
  };
}

describe("Private Connect send now", () => {
  it("refuses to steer a queued message into the running turn during an update hold", async () => {
    const f = await fixture();
    let owner: number | undefined;
    try {
      const initial = f.controller.queue({ conversationId: f.conversationId, content: "First task" });
      f.controller.start(initial.turn.id);
      f.provider.emit({ ...turnControllerTestIdentity(f), type: "status", status: "running" });
      const id = f.queued();
      owner = hold();
      await expect(f.queue.sendNow(f.conversationId, id, randomUUID(), { textOnly: true })).rejects.toThrow(UPDATE_HOLD_MESSAGE);
      await flushTurnControllerTestPromises();
      expect(f.provider.steerCalls).toEqual([]);
      expect(f.store.orchestration.queue.getItem(id)).toMatchObject({ state: "waiting", dispatchOrdinal: 0 });
    } finally { release(owner); await f.close(); }
  });

  it("refuses to send a queued message while its checkout is being restored", async () => {
    const f = await fixture();
    try {
      const id = f.queued(true);
      expect(f.store.conversationWork.reserve(f.conversationId)).toBe(true);
      expect(f.store.conversationWork.claimRestoreCheckout(f.conversationId)).toBe(true);
      await expect(f.queue.sendNow(f.conversationId, id, randomUUID(), { textOnly: true }))
        .rejects.toThrow(CHECKOUT_RESTORE_IN_PROGRESS);
      f.store.conversationWork.releaseRestoreCheckout(f.conversationId);
      f.store.conversationWork.release(f.conversationId);
      await flushTurnControllerTestPromises();
      expect(f.provider.runCount).toBe(0);
      expect(f.store.orchestration.queue.getItem(id)).toMatchObject({ state: "waiting", dispatchOrdinal: 0 });
    } finally { await f.close(); }
  });
});
