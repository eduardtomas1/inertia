import { EventEmitter } from "node:events";

import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import type { TurnInteractionCommandDependencies } from "../../src/server/runtime/commands/turn-interaction-commands";
import { createRestartContinuationRuntime } from "../../src/server/runtime/restart-continuation-runtime";
import { finishUpdateEverything, runUpdateEverything, type UpdateEverythingDependencies } from "../../src/server/runtime/update-everything";
import { isHeld, release } from "../../src/server/runtime/update-hold";
import type { ProviderMaintenanceOperation } from "../../src/shared/provider-maintenance";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestIdentity,
  turnControllerTestProviderInfo,
  type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

afterEach(async () => {
  release();
  await cleanupTurnControllerTestDirectories();
});

function commandDependencies(runtime: TurnControllerTestRuntime, attachments: ConversationAttachmentStore): TurnInteractionCommandDependencies {
  return {
    store: runtime.store, turns: runtime.controller, conversationAttachments: attachments,
    backendProfileController: { validateSelection: (selection: unknown) => selection, isExternalSelection: () => false, readiness: async () => null } as unknown as TurnInteractionCommandDependencies["backendProfileController"],
    isolatedRuns: { has: () => false } as unknown as TurnInteractionCommandDependencies["isolatedRuns"],
    workspaceRuns: {} as TurnInteractionCommandDependencies["workspaceRuns"],
    pendingApprovals: new Map(), pendingInputs: new Map(), dataDirectory: runtime.directory, enableProviders: true,
    attachmentResolver: null,
    generatedAttachments: { release: async () => undefined } as unknown as TurnInteractionCommandDependencies["generatedAttachments"],
    workflows: { resolveTurnSkills: async () => ({ inputs: [], routeKey: null }), assertTurnSkillsCurrent: () => undefined } as unknown as TurnInteractionCommandDependencies["workflows"],
    providerTerminalResumes: { isActive: () => false, acquireWhenAvailable: async () => true, release: () => undefined } as unknown as TurnInteractionCommandDependencies["providerTerminalResumes"],
    providerInfo: () => [turnControllerTestProviderInfo()], broadcast: () => undefined, broadcastSnapshot: () => undefined, send: () => undefined,
  };
}

async function runningChat() {
  const runtime = await createTurnControllerTestRuntime();
  const first = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Refactor the parser." });
  runtime.controller.start(first.turn.id);
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "native-session" });
  await flushTurnControllerTestPromises();
  const attachments = await ConversationAttachmentStore.open(runtime.directory);
  const abort = new AbortController();
  const continuation = createRestartContinuationRuntime(commandDependencies(runtime, attachments), {
    signal: abort.signal, track: async (operation) => await operation(),
  });
  const close = async () => { abort.abort(); await runtime.controller.dispose(); await attachments.close(); runtime.store.close(); };
  return { runtime, firstTurnId: first.turn.id, continuation, close };
}

const preparation = { isAdmissionClosed: () => false };
const owner = (): WebSocket => Object.assign(new EventEmitter(), { readyState: 1 }) as unknown as WebSocket;

function maintenance(duringUpdate: () => Promise<void>) {
  const done: ProviderMaintenanceOperation = {
    id: "00000000-0000-4000-8000-000000000001", providerId: "codex", status: "succeeded", startedAt: null, finishedAt: null,
    beforeVersion: "1.0.0", afterVersion: "2.0.0", targetVersion: "2.0.0", message: "Provider updated.", output: null, outputTruncated: false,
  };
  return {
    current: () => [],
    startUpdate: vi.fn(async () => ({ ...done, status: "queued" as const })),
    settled: vi.fn(async () => { await duringUpdate(); return done; }),
  };
}

describe("update everything with restart continuation", () => {
  it("continues an interrupted chat once, only after the provider-only run releases its hold", async () => {
    const { runtime, firstTurnId, continuation, close } = await runningChat();
    try {
      const result = await runUpdateEverything({
        store: runtime.store, turns: runtime.controller, restartContinuation: continuation, preparation,
        maintenance: maintenance(async () => {
          expect(runtime.store.agentTurn(firstTurnId)).toMatchObject({ status: "interrupted", terminalReason: "app-update" });
          await continuation.scheduler.tick();
          expect(runtime.provider.runCount).toBe(1);
        }),
      } as unknown as UpdateEverythingDependencies, { providerIds: ["codex"], includeApp: false, continueChats: true }, owner());

      expect(result.interruptedConversationIds).toEqual([runtime.conversationId]);
      expect(isHeld()).toBe(false);
      await continuation.scheduler.tick();
      await flushTurnControllerTestPromises();
      expect(runtime.provider.runCount).toBe(2);
      expect(runtime.provider.input?.sessionId).toBe("native-session");
      expect(runtime.store.conversationDetail(runtime.conversationId)!.messages.at(-1))
        .toMatchObject({ role: "user", content: "Continue from where you stopped." });
      await continuation.scheduler.tick();
      expect(runtime.provider.runCount).toBe(2);
    } finally { await close(); }
  });

  it("keeps the continuation waiting through the app install hand-off until the renderer finishes without installing", async () => {
    const { runtime, continuation, close } = await runningChat();
    try {
      await runUpdateEverything({
        store: runtime.store, turns: runtime.controller, restartContinuation: continuation, preparation, maintenance: maintenance(async () => undefined),
      } as unknown as UpdateEverythingDependencies, { providerIds: [], includeApp: true, continueChats: true }, owner());
      await continuation.scheduler.tick();
      expect(runtime.provider.runCount).toBe(1);
      expect(runtime.store.restartContinuations.forConversation(runtime.conversationId)).toMatchObject({ state: "waiting" });

      finishUpdateEverything(false);
      await continuation.scheduler.tick();
      await flushTurnControllerTestPromises();
      expect(runtime.provider.runCount).toBe(2);
    } finally { await close(); }
  });

  it("stops without a plan when the user turned continuation off", async () => {
    const { runtime, firstTurnId, continuation, close } = await runningChat();
    try {
      await runUpdateEverything({
        store: runtime.store, turns: runtime.controller, restartContinuation: continuation, preparation, maintenance: maintenance(async () => undefined),
      } as unknown as UpdateEverythingDependencies, { providerIds: ["codex"], includeApp: false, continueChats: false }, owner());
      await continuation.scheduler.tick();
      expect(runtime.store.agentTurn(firstTurnId)).toMatchObject({ status: "interrupted", terminalReason: "app-update" });
      expect(runtime.store.restartContinuations.forConversation(runtime.conversationId)).toBeNull();
      expect(runtime.provider.runCount).toBe(1);
    } finally { await close(); }
  });
});
