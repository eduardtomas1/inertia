// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import type { ClientCommand } from "../../src/shared/contracts";
import { DatabaseRecoveryImportAdmission } from "../../src/server/database-recovery-import-admission";
import { createQueuedMessageRuntime } from "../../src/server/runtime/queued-message-runtime";
import type { TurnInteractionCommandDependencies } from "../../src/server/runtime/commands/turn-interaction-commands";
import {
  cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime,
  flushTurnControllerTestPromises, turnControllerTestProviderInfo,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

async function fixture() {
  let queue: ReturnType<typeof createQueuedMessageRuntime> | undefined;
  const runtime = await createTurnControllerTestRuntime({ onTurnSettled: (turn) => queue?.onTurnSettled(turn) });
  const attachments = await ConversationAttachmentStore.open(runtime.directory);
  const abort = new AbortController();
  const admission = new DatabaseRecoveryImportAdmission();
  let releaseVerification!: () => void;
  const verification = new Promise<void>((resolve) => { releaseVerification = resolve; });
  const verifyProviderInstallation = vi.fn(() => verification);
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
    broadcastSnapshot: () => undefined, send: () => undefined, verifyProviderInstallation,
  };
  queue = createQueuedMessageRuntime(dependencies, {
    signal: abort.signal,
    track: (operation) => admission.admit(operation),
  });
  const enqueue = async (id: string) => {
    await queue!.handler(null as unknown as WebSocket, {
      type: "message.queue.enqueue", requestId: randomUUID(),
      payload: { conversationId: runtime.conversationId, id, content: "Do the next task.", attachments: [] },
    } as ClientCommand);
  };
  const startCompletingTurn = () => {
    const initial = runtime.controller.queue({ conversationId: runtime.conversationId, content: "First task" });
    runtime.controller.start(initial.turn.id);
  };
  return {
    ...runtime, admission, enqueue, startCompletingTurn, verifyProviderInstallation, releaseVerification,
    close: async () => {
      releaseVerification();
      admission.end();
      abort.abort();
      await flushTurnControllerTestPromises();
      await runtime.controller.dispose();
      await attachments.close();
      runtime.store.close();
    },
  };
}

describe("database recovery import and queued message dispatch", () => {
  it("waits for a queued dispatch in message preparation before the import checks for active turns", async () => {
    const f = await fixture();
    try {
      f.startCompletingTurn();
      const id = randomUUID();
      await f.enqueue(id);
      f.provider.resolve({ status: "completed", text: "Done" });
      await vi.waitFor(() => expect(f.verifyProviderInstallation).toHaveBeenCalledOnce());
      expect(f.controller.activeConversationIds()).toEqual([]);

      f.admission.begin();
      let drained = false;
      const draining = f.admission.drain().then(() => { drained = true; });
      await flushTurnControllerTestPromises();
      expect(drained).toBe(false);

      f.releaseVerification();
      await draining;
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted");
      expect(f.controller.activeConversationIds()).toEqual([f.conversationId]);
    } finally { await f.close(); }
  });

  it("holds a queued dispatch woken during an import until the import ends", async () => {
    const f = await fixture();
    try {
      f.releaseVerification();
      f.startCompletingTurn();
      const id = randomUUID();
      await f.enqueue(id);
      f.admission.begin();
      await f.admission.drain();
      const admit = vi.spyOn(f.admission, "admit");

      f.provider.resolve({ status: "completed", text: "Done" });
      await vi.waitFor(() => expect(admit).toHaveBeenCalled());
      await delay(100);
      expect(f.verifyProviderInstallation).not.toHaveBeenCalled();
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("waiting");
      expect(f.provider.runCount).toBe(1);

      f.admission.end();
      await vi.waitFor(() => expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted"));
      expect(f.provider.runCount).toBe(2);
    } finally { await f.close(); }
  });

  it("refuses a second concurrent import", () => {
    const admission = new DatabaseRecoveryImportAdmission();
    admission.begin();
    expect(() => admission.begin()).toThrow("A database recovery import is already active.");
    admission.end();
    expect(admission.isActive()).toBe(false);
  });
});
