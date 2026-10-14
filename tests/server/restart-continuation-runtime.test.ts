// @inertia-test-suite portable
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { randomUUID } from "node:crypto";

import { build } from "esbuild";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import { RuntimeStore } from "../../src/server/database";
import { createTurnInteractionCommandHandler, type TurnInteractionCommandDependencies } from "../../src/server/runtime/commands/turn-interaction-commands";
import { createRestartContinuationRuntime } from "../../src/server/runtime/restart-continuation-runtime";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestIdentity,
  turnControllerTestProviderInfo,
  type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";
import { startTestRuntime } from "../support/test-runtime";

afterEach(cleanupTurnControllerTestDirectories);

const settledAt = () => { const at = new Date().toISOString(); return { startedAt: at, completedAt: at }; };
const notice = "Inertia stopped while your previous turn was running";

function commandDependencies(runtime: TurnControllerTestRuntime, attachments: ConversationAttachmentStore,
  onSkills: () => void = () => undefined): TurnInteractionCommandDependencies {
  let transitionHeld = false;
  return {
    store: runtime.store, turns: runtime.controller, conversationAttachments: attachments,
    backendProfileController: { validateSelection: (selection: unknown) => selection, isExternalSelection: () => false, readiness: async () => null } as unknown as TurnInteractionCommandDependencies["backendProfileController"],
    isolatedRuns: { has: () => false } as unknown as TurnInteractionCommandDependencies["isolatedRuns"],
    workspaceRuns: {} as TurnInteractionCommandDependencies["workspaceRuns"],
    pendingApprovals: new Map(), pendingInputs: new Map(), dataDirectory: runtime.directory, enableProviders: true,
    attachmentResolver: null,
    generatedAttachments: { release: async () => undefined } as unknown as TurnInteractionCommandDependencies["generatedAttachments"],
    workflows: { resolveTurnSkills: async () => {
      onSkills();
      return { inputs: [], routeKey: null };
    }, assertTurnSkillsCurrent: () => undefined } as unknown as TurnInteractionCommandDependencies["workflows"],
    providerTerminalResumes: { isActive: () => transitionHeld,
      acquireWhenAvailable: async () => { transitionHeld = true; return true; }, release: () => { transitionHeld = false; } } as unknown as TurnInteractionCommandDependencies["providerTerminalResumes"],
    providerInfo: () => [turnControllerTestProviderInfo(), { ...turnControllerTestProviderInfo(), id: "claude", label: "Claude" }], broadcast: () => undefined, broadcastSnapshot: () => undefined, send: () => undefined,
  };
}

async function interruptedForUpdate(providerId: "codex" | "claude") {
  const runtime = await createTurnControllerTestRuntime({}, {
    modelSelection: providerNativeModelSelection({ providerId, modelId: "provider-default" }),
  });
  const first = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Refactor the parser." });
  runtime.controller.start(first.turn.id);
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "native-session" });
  await flushTurnControllerTestPromises();
  return { runtime, firstTurnId: first.turn.id };
}

describe.each(["codex", "claude"] as const)("%s chat continued after an app update", (providerId) => {
  it("sends one continuation through ordinary turn admission and resumes the native session", async () => {
    const { runtime, firstTurnId } = await interruptedForUpdate(providerId);
    const attachments = await ConversationAttachmentStore.open(runtime.directory);
    const abort = new AbortController();
    const continuation = createRestartContinuationRuntime(commandDependencies(runtime, attachments), {
      signal: abort.signal, track: async (operation) => await operation(),
    });
    try {
      expect(continuation.createPlans([runtime.conversationId])).toEqual([runtime.conversationId]);
      await expect(runtime.controller.interruptForUpdate([runtime.conversationId], "Inertia")).resolves.toBe(true);
      await continuation.scheduler.tick();
      await flushTurnControllerTestPromises();
      const latest = runtime.store.latestAgentTurnForConversation(runtime.conversationId)!;
      expect(latest.id).not.toBe(firstTurnId);
      expect(runtime.store.restartContinuations.forConversation(runtime.conversationId))
        .toMatchObject({ state: "completed", turnId: latest.id });
      expect(runtime.store.conversationDetail(runtime.conversationId)!.messages.at(-1))
        .toMatchObject({ role: "user", content: "Continue from where you stopped." });
      expect(runtime.provider.runCount).toBe(2);
      expect(latest.providerSessionBefore).toBe("native-session");
      expect(runtime.provider.input?.sessionId).toBe("native-session");
      expect(runtime.provider.input?.prompt).toContain(notice);
      await continuation.scheduler.tick();
      expect(runtime.provider.runCount).toBe(2);
    } finally { abort.abort(); await runtime.controller.dispose(); await attachments.close(); runtime.store.close(); }
  });
});

describe("restart continuation dispatch admission", () => {
  it("never delivers a continuation as a follow-up to an active turn", async () => {
    const conversationId = randomUUID();
    const acquireFollowUpAdmission = vi.fn(() => ({ supportsImages: false, release: vi.fn() }));
    const steer = vi.fn();
    const dependencies = {
      store: { conversation: () => ({ id: conversationId, archivedAt: null }) },
      turns: { isActive: () => true, acquireFollowUpAdmission, steer },
      providerTerminalResumes: { isActive: () => false },
      send: vi.fn(), broadcast: vi.fn(), broadcastSnapshot: vi.fn(),
      restartContinuationDispatch: { planId: randomUUID(), assertCurrent: () => undefined },
    } as unknown as TurnInteractionCommandDependencies;
    await expect(createTurnInteractionCommandHandler(dependencies)(null as unknown as WebSocket, {
      type: "message.send", requestId: randomUUID(), payload: { conversationId, content: "Continue from where you stopped.", attachments: [], activate: false },
    })).rejects.toThrow("busy");
    expect(acquireFollowUpAdmission).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
  });

  it("creates no turn when the plan is cancelled while the message is being prepared", async () => {
    const { runtime, firstTurnId } = await interruptedForUpdate("codex");
    const attachments = await ConversationAttachmentStore.open(runtime.directory);
    const abort = new AbortController();
    const continuation = createRestartContinuationRuntime(commandDependencies(runtime, attachments, () => {
      runtime.store.archiveConversation(runtime.conversationId, true);
    }), { signal: abort.signal, track: async (operation) => await operation() });
    try {
      continuation.createPlans([runtime.conversationId]);
      await runtime.controller.interruptForUpdate([runtime.conversationId], "Inertia");
      await continuation.scheduler.tick();
      await flushTurnControllerTestPromises();
      expect(runtime.store.latestAgentTurnForConversation(runtime.conversationId)?.id).toBe(firstTurnId);
      expect(runtime.provider.runCount).toBe(1);
      expect(runtime.store.restartContinuations.forConversation(runtime.conversationId))
        .toMatchObject({ state: "cancelled", turnId: null, error: "The chat was archived." });
    } finally { abort.abort(); await runtime.controller.dispose(); await attachments.close(); runtime.store.close(); }
  });
});

describe("restart continuation startup placement", () => {
  async function bundledSources(entryPoint: string): Promise<string[]> {
    const result = await build({ entryPoints: [entryPoint], bundle: true, platform: "node", format: "esm",
      packages: "external", write: false, metafile: true, logLevel: "silent" });
    return Object.keys(result.metafile.inputs);
  }

  function seededProfile() {
    const root = mkdtempSync(join(tmpdir(), "inertia-restart-startup-"));
    const dataDirectory = join(root, "data");
    const workspace = join(root, "workspace");
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(workspace);
    const store = new RuntimeStore(join(dataDirectory, "inertia.sqlite"), workspace, { recoverInterruptedRuns: false });
    let conversationId: string;
    try {
      const projectId = store.createProject("Project", workspace).id;
      const conversation = store.createConversation(projectId, "Interrupted task", { model: "gpt-test" });
      conversationId = conversation.id;
      const run = store.createWorkspaceRun({ kind: "agent", projectId, conversationId, label: "Task", detail: null, status: "running", port: null });
      const turn = store.beginAgentTurn({ conversationId, runId: run.id, content: "Refactor the parser.", providerId: conversation.providerId,
        modelSelection: conversation.modelSelection, model: "gpt-test", reasoningEffort: conversation.reasoningEffort,
        interactionMode: conversation.interactionMode, accessMode: conversation.accessMode, configurationRevision: 0,
        association: "authoritative" }).turn;
      store.updateAgentTurnLifecycle(turn.id, { status: "interrupted", terminalReason: "app-update", ...settledAt() });
      store.updateWorkspaceRun(run.id, { status: "failed", finishedAt: new Date().toISOString() });
      const [plan] = store.restartContinuations.createForConversations([{ conversationId, interruptedTurnId: turn.id, routeIdentity: "route" }]);
      store.restartContinuations.claim(plan!);
    } finally { store.close(); }
    const state = () => {
      const reopened = new RuntimeStore(join(dataDirectory, "inertia.sqlite"), workspace, { recoverInterruptedRuns: false });
      try { return reopened.restartContinuations.forConversation(conversationId)?.state; } finally { reopened.close(); }
    };
    return { root, dataDirectory, workspace, state };
  }

  it("reconciles plans during a normal runtime start", async () => {
    const profile = seededProfile();
    try {
      const runtime = await startTestRuntime({ dataDirectory: profile.dataDirectory, defaultWorkspacePath: profile.workspace,
        enableProviders: false, runtimeGenerationId: "00000000-0000-4000-8000-000000000097:1",
        systemBootId: "test:00000000-0000-4000-8000-000000000097" });
      await runtime.close();
      expect(profile.state()).toBe("waiting");
    } finally { rmSync(profile.root, { recursive: true, force: true }); }
  }, 60_000);

  it("never runs while recovery safety mode blocks the runtime", async () => {
    const profile = seededProfile();
    try {
      await expect(startTestRuntime({ dataDirectory: profile.dataDirectory, defaultWorkspacePath: profile.workspace,
        enableProviders: false, priorRuntimeCleanupUnconfirmed: true, runtimeGenerationId: "00000000-0000-4000-8000-000000000098:1",
        systemBootId: "test:00000000-0000-4000-8000-000000000098" })).rejects.toThrow("Runtime startup is blocked");
      expect(profile.state()).toBe("dispatching");
    } finally { rmSync(profile.root, { recursive: true, force: true }); }
  }, 60_000);

  it("starts with the normal runtime and never inside the update candidate validation worker", async () => {
    const runtime = await bundledSources("src/server/index.ts");
    expect(runtime).toContain("src/server/runtime/restart-continuation-runtime.ts");
    expect(runtime).toContain("src/server/usage/runtime.ts");
    const validation = await bundledSources("src/server/app-update-candidate-viability-worker.ts");
    expect(validation.filter((path) => path.startsWith("src/server/runtime/restart-continuation"))).toEqual([]);
    expect(validation).not.toContain("src/server/usage/runtime.ts");
  }, 60_000);
});
