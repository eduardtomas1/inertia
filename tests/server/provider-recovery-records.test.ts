// @inertia-test-suite portable
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import { providerCleanupIncident } from "../../src/server/provider/run-cleanup-settlement";
import { stopOwnedManagedTurn } from "../../src/server/runtime/managed-turn-ownership";
import {
  createConversationCommandHandler,
  type ConversationCommandDependencies,
} from "../../src/server/runtime/commands/conversation-commands";
import {
  createProjectWorkspaceCommandHandler,
  type ProjectWorkspaceCommandDependencies,
} from "../../src/server/runtime/commands/project-workspace-commands";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTurnControllerTestDirectories();
});

async function forceDetachedTurn(runtime: TurnControllerTestRuntime) {
  const queued = runtime.controller.queue({
    conversationId: runtime.conversationId,
    content: "Work until stopped.",
  });
  expect(runtime.controller.start(queued.turn.id)).toBe(true);
  await flushTurnControllerTestPromises();
  let released = false;
  const isRunning = runtime.provider.isRunning.bind(runtime.provider);
  vi.spyOn(runtime.provider, "isRunning").mockImplementation((id) => !released && isRunning(id));
  vi.spyOn(runtime.provider, "stopOwned").mockImplementation(async () => {
    released = true;
    return "force-detached";
  });
  return queued.turn;
}

async function stopForceDetached(runtime: TurnControllerTestRuntime) {
  const turn = await forceDetachedTurn(runtime);
  expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
  await flushTurnControllerTestPromises();
  await runtime.controller.drainSettlementTasks();
  expect(runtime.store.agentTurn(turn.id).status).toBe("cancelled");
  expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId))
    .toEqual([expect.objectContaining({ turnId: turn.id, runId: turn.runId })]);
  return turn;
}

function conversationHandler(
  runtime: TurnControllerTestRuntime,
  reportIncident: ConversationCommandDependencies["reportIncident"],
) {
  return createConversationCommandHandler({
    store: runtime.store,
    conversationAttachments: { release: vi.fn(async () => undefined) } as never,
    providers: {} as never,
    backendProfileController: {} as never,
    workspaceRuns: {} as never,
    providerTerminalResumes: new ProviderTerminalResumeRegistry(runtime.store.conversationWork),
    runtimeSync: {} as never,
    deletedConversationIds: new Set(),
    dataDirectory: "/data",
    rememberDeletedConversation: vi.fn(),
    forgetRemoteTranscript: vi.fn(),
    broadcastSnapshot: vi.fn(),
    publicError: (error) => String(error),
    send: vi.fn(),
    reportIncident,
  });
}

function projectHandler(
  runtime: TurnControllerTestRuntime,
  reportIncident: ProjectWorkspaceCommandDependencies["reportIncident"],
) {
  return createProjectWorkspaceCommandHandler({
    dataDirectory: "/data",
    store: runtime.store,
    conversationAttachments: { release: vi.fn(async () => undefined) } as never,
    workspaceRuns: {} as never,
    turns: runtime.controller,
    providers: runtime.provider as never,
    providerTerminalResumes: new ProviderTerminalResumeRegistry(runtime.store.conversationWork),
    terminals: {} as never,
    secureFiles: {} as never,
    secureFileAuthorities: {} as never,
    workspacePath: () => runtime.workspace,
    rememberDeletedConversation: vi.fn(),
    forgetRemoteTranscript: vi.fn(),
    broadcastSnapshot: vi.fn(),
    send: vi.fn(),
    reportIncident,
  });
}

describe("provider run recovery records", () => {
  it("does not count a finished turn's kept ownership row as active checkout work", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      await stopForceDetached(runtime);
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
      expect(runtime.controller.hasActiveCheckout(runtime.workspace)).toBe(false);
    } finally {
      runtime.store.close();
    }
  });

  it("reports a managed stop as done once the turn is finalized with its ownership row kept", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = await forceDetachedTurn(runtime);
      await expect(stopOwnedManagedTurn(
        runtime.store,
        runtime.controller,
        runtime.conversationId,
        { turnId: turn.id, runId: turn.runId },
      )).resolves.toBeUndefined();
      expect(runtime.store.agentTurn(turn.id).status).toBe("cancelled");
      expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId))
        .toHaveLength(1);
    } finally {
      runtime.store.close();
    }
  });

  it("deletes a chat whose finished turn kept its ownership row and records one cleanup incident", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = await stopForceDetached(runtime);
      const reportIncident = vi.fn();
      await expect(conversationHandler(runtime, reportIncident)({} as never, {
        type: "conversation.delete",
        requestId: randomUUID(),
        payload: { conversationId: runtime.conversationId },
      })).resolves.toBe("mutation");
      expect(runtime.store.providerRunOwnership.all()).toEqual([]);
      expect(reportIncident.mock.calls).toEqual([[providerCleanupIncident({
        providerId: "codex",
        conversationId: runtime.conversationId,
        runId: turn.runId,
        turnId: turn.id,
      })]]);
    } finally {
      runtime.store.close();
    }
  });

  it("removes a project whose finished turn kept its ownership row and records one cleanup incident", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = await stopForceDetached(runtime);
      const projectId = runtime.store.conversation(runtime.conversationId).projectId;
      runtime.store.createProject("Other project", runtime.directory);
      const reportIncident = vi.fn();
      await expect(projectHandler(runtime, reportIncident)({} as never, {
        type: "project.remove",
        requestId: randomUUID(),
        payload: { projectId },
      })).resolves.toBe("mutation");
      expect(runtime.store.providerRunOwnership.all()).toEqual([]);
      expect(reportIncident.mock.calls).toEqual([[providerCleanupIncident({
        providerId: "codex",
        conversationId: runtime.conversationId,
        runId: turn.runId,
        turnId: turn.id,
      })]]);
    } finally {
      runtime.store.close();
    }
  });

  it("keeps refusing chat deletion while an unfinished turn owns a provider run", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = await forceDetachedTurn(runtime);
      expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId))
        .toEqual([expect.objectContaining({ turnId: turn.id })]);
      const reportIncident = vi.fn();
      await expect(conversationHandler(runtime, reportIncident)({} as never, {
        type: "conversation.delete",
        requestId: randomUUID(),
        payload: { conversationId: runtime.conversationId },
      })).rejects.toThrow("Provider process cleanup is unconfirmed.");
      expect(runtime.store.providerRunOwnership.all()).toHaveLength(1);
      expect(reportIncident).not.toHaveBeenCalled();
    } finally {
      runtime.store.close();
    }
  });
});
