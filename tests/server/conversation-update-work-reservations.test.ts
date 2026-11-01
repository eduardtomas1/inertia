import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentWorkflowState, ClientCommand } from "../../src/shared/contracts";
import {
  modelSelectionSchema,
  nativeModelSelection,
} from "../../src/shared/model-routing";
import { RuntimeStore } from "../../src/server/database";
import type { AgentWorkflowController } from "../../src/server/runtime/agent-workflow-controller";
import { createAgentWorkflowCommandHandler } from "../../src/server/runtime/commands/agent-workflow-commands";
import {
  createConversationCommandHandler,
  type ConversationCommandDependencies,
} from "../../src/server/runtime/commands/conversation-commands";

const temporaryDirectories: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function codexConversation() {
  const directory = mkdtempSync(join(tmpdir(), "inertia-conversation-update-work-"));
  temporaryDirectories.push(directory);
  const workspace = join(directory, "workspace");
  mkdirSync(workspace);
  const store = new RuntimeStore(join(directory, "runtime.sqlite"), workspace, {
    recoverInterruptedRuns: false,
  });
  stores.push(store);
  const project = store.createProject("Work reservations", workspace);
  const conversation = store.createConversation(project.id, "Finished turn", {
    modelSelection: modelSelectionSchema.parse(nativeModelSelection({
      providerId: "codex",
      modelId: "gpt-test",
      reasoningEffort: "high",
    })),
  });
  store.updateConversation(conversation.id, { providerSessionId: "finished-thread" });
  return { store, conversationId: conversation.id };
}

function workflowState(conversationId: string): AgentWorkflowState {
  return {
    conversationId,
    goals: [],
    skills: [],
    goalCapability: { kind: "codex-native", available: true, label: "Codex native goal" },
    skillsCapability: { kind: "unavailable", available: false, label: "Skills unavailable", reason: "Fixture" },
    goalRefreshWarning: null,
    skillDiscovery: { truncated: false, warningCount: 0, synchronizedAt: null },
    refreshedAt: "2030-01-01T00:00:00.000Z",
  };
}

function modeUpdate(
  conversationId: string,
  interactionMode: "build" | "plan",
): Extract<ClientCommand, { type: "conversation.update" }> {
  return {
    type: "conversation.update",
    requestId: "11111111-1111-4111-8111-111111111111",
    payload: { conversationId, interactionMode },
  };
}

describe("conversation updates during background provider work", () => {
  it("applies a work-mode choice while a provider workflow refresh holds the checkout", async () => {
    const { store, conversationId } = codexConversation();
    let settleRefresh!: () => void;
    const refresh = vi.fn(async () => await new Promise<AgentWorkflowState>((resolve) => {
      settleRefresh = () => resolve(workflowState(conversationId));
    }));
    const workflows = createAgentWorkflowCommandHandler({
      workflows: { refresh, state: vi.fn() } as unknown as AgentWorkflowController,
      providerTerminalResumes: { isActive: vi.fn(() => false) },
      conversationWork: store.conversationWork,
      broadcast: vi.fn(),
      send: vi.fn(),
    });
    const conversations = createConversationCommandHandler({
      store,
      backendProfileController: { isExternalSelection: vi.fn(() => false) },
    } as unknown as ConversationCommandDependencies);

    const refreshing = workflows({} as never, {
      type: "agent.workflow.load",
      requestId: "22222222-2222-4222-8222-222222222222",
      payload: { conversationId, refresh: true },
    });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(store.conversationWork.reserve(conversationId)).toBe(false);

    await expect(conversations({} as never, modeUpdate(conversationId, "plan")))
      .resolves.toBe("mutation");
    expect(store.conversation(conversationId).interactionMode).toBe("plan");

    settleRefresh();
    await expect(refreshing).resolves.toBe("handled");
    expect(store.conversationWork.reserve(conversationId)).toBe(true);
    await expect(conversations({} as never, modeUpdate(conversationId, "build")))
      .rejects.toThrow("Stop the active run or review before changing its agent configuration.");
    expect(store.conversation(conversationId).interactionMode).toBe("plan");
    store.conversationWork.release(conversationId);
  });
});
