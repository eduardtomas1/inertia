import { describe, expect, it } from "vitest";

import type {
  AgentApprovalRequest,
  AgentInputRequest,
  AppSnapshot,
  ClientCommand,
  ConversationDetail,
  RuntimeSequencedFrame,
} from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts/app";
import {
  projectDetachedChatSnapshot,
  projectRuntimeFrameForAuthority,
} from "../../src/server/runtime/detached-chat-runtime-projection";
import {
  detachedChatCommandRejection,
  type DetachedChatRuntimePolicyResources,
} from "../../src/server/runtime/detached-chat-runtime-policy";
import type { RuntimeClientAuthority } from "../../src/server/runtime/runtime-client-authority";

const CONVERSATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_CONVERSATION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_PROJECT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RUN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CHECKPOINT = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const REQUEST = "11111111-1111-4111-8111-111111111111";

const authority: RuntimeClientAuthority = {
  kind: "detached-chat",
  conversationId: CONVERSATION,
  clientId: "window-7",
};

function conversation(id: string, projectId: string) {
  return {
    id,
    projectId,
    title: id === CONVERSATION ? "Scoped" : "Secret",
    providerId: "codex",
    modelSelection: {
      harnessId: "codex",
      backendProfileId: "codex-local",
      backendConfigurationRevision: "builtin",
      modelId: "gpt-5",
      reasoningEffort: null,
      providerOptions: {},
      capabilities: [],
    },
    continuationIdentity: null,
    model: "gpt-5",
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    status: "idle",
    attentionKind: null,
    branch: null,
    worktreePath: null,
    providerSessionId: null,
    archivedAt: null,
    settledAt: null,
    completedAt: null,
    lastViewedAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    latestTurn: null,
    pendingApproval: false,
    pendingInput: false,
  } as unknown as AppSnapshot["conversations"][number];
}

function snapshot(): AppSnapshot {
  return {
    projects: [
      { id: PROJECT, name: "Scoped", path: "/scoped" },
      { id: OTHER_PROJECT, name: "Secret", path: "/secret" },
    ] as AppSnapshot["projects"],
    conversations: [
      conversation(CONVERSATION, PROJECT),
      conversation(OTHER_CONVERSATION, OTHER_PROJECT),
    ],
    runs: [
      { id: RUN, conversationId: CONVERSATION, projectId: PROJECT },
      {
        id: "22222222-2222-4222-8222-222222222222",
        conversationId: OTHER_CONVERSATION,
        projectId: OTHER_PROJECT,
      },
    ] as AppSnapshot["runs"],
    providers: [{
      id: "codex",
      label: "Codex",
      maintenance: { providerId: "codex" },
    }] as AppSnapshot["providers"],
    maintenanceOperations: [{ providerId: "codex" }] as unknown as AppSnapshot["maintenanceOperations"],
    backendProfiles: [{ id: "codex-local" }] as unknown as AppSnapshot["backendProfiles"],
    backendDefaults: [{ projectId: OTHER_PROJECT }] as unknown as AppSnapshot["backendDefaults"],
    databaseBackup: { lastValidatedAt: "2026-01-01T00:00:00.000Z" },
    settings: {
      ...defaultSettings,
      theme: "dark",
      usageDisplayMode: "expanded",
      codexBinaryPath: "/secret/codex",
    },
    promptPresets: [{ id: "secret-preset" }] as unknown as NonNullable<AppSnapshot["promptPresets"]>,
    activeProjectId: OTHER_PROJECT,
    activeConversationId: OTHER_CONVERSATION,
  };
}

function resources(): DetachedChatRuntimePolicyResources {
  const current = snapshot();
  return {
    snapshot: () => current,
    detail: (conversationId) => conversationId === CONVERSATION
      ? ({ subagents: [{ id: REQUEST }] } as ConversationDetail)
      : null,
    checkpointConversationId: (checkpointId) =>
      checkpointId === CHECKPOINT ? CONVERSATION : OTHER_CONVERSATION,
    pendingApproval: (requestId) => requestId === REQUEST
      ? ({ conversationId: CONVERSATION } as AgentApprovalRequest)
      : null,
    pendingInput: (requestId) => requestId === REQUEST
      ? ({ conversationId: CONVERSATION } as AgentInputRequest)
      : null,
  };
}

function rejection(command: ClientCommand): string | null {
  return detachedChatCommandRejection(authority, command, resources());
}

function mainRejection(command: ClientCommand): string | null {
  return detachedChatCommandRejection({ kind: "main" }, command, resources());
}

describe("detached chat runtime authority", () => {
  it("projects a welcome snapshot to one chat without global mutation state", () => {
    const projected = projectDetachedChatSnapshot(snapshot(), CONVERSATION);

    expect(projected.projects.map(({ id }) => id)).toEqual([PROJECT]);
    expect(projected.conversations.map(({ id }) => id)).toEqual([
      CONVERSATION,
    ]);
    expect(projected.runs.map(({ id }) => id)).toEqual([RUN]);
    expect(projected.providers[0]).not.toHaveProperty("maintenance");
    expect(projected.maintenanceOperations).toEqual([]);
    expect(projected.backendDefaults).toEqual([]);
    expect(projected.promptPresets).toEqual([]);
    expect(projected).not.toHaveProperty("databaseBackup");
    expect(projected.settings).toMatchObject({
      theme: "dark",
      usageDisplayMode: "expanded",
      codexBinaryPath: "",
    });
    expect(projected.activeConversationId).toBe(CONVERSATION);
    expect(projected.activeProjectId).toBe(PROJECT);
    expect(JSON.stringify(projected)).not.toContain("Secret");
  });

  it("turns unrelated shell and detail mutations into cursor-only frames", () => {
    const frame = (event: RuntimeSequencedFrame & { type: "runtime.event" }) =>
      projectRuntimeFrameForAuthority(
        event,
        { conversationIds: [OTHER_CONVERSATION] },
        authority,
      );
    const sync = {
      runtimeGeneration: "33333333-3333-4333-8333-333333333333",
      latestSequence: 1,
    };

    expect(frame({
      type: "runtime.event",
      sync,
      scope: { kind: "conversation-detail", conversationId: OTHER_CONVERSATION },
      event: {
        type: "agent.text",
        conversationId: OTHER_CONVERSATION,
        runId: "run",
        turnId: "turn",
        text: "secret",
      },
    })).toEqual({ type: "runtime.cursor", sync });
    expect(frame({
      type: "runtime.event",
      sync,
      scope: { kind: "shell" },
      event: {
        type: "conversation.shell.updated",
        conversation: conversation(OTHER_CONVERSATION, OTHER_PROJECT),
        runs: [],
      },
    })).toEqual({ type: "runtime.cursor", sync });
    expect(frame({
      type: "runtime.event",
      sync,
      scope: { kind: "shell" },
      event: {
        type: "provider.maintenance.updated",
        providers: [],
      },
    })).toEqual({ type: "runtime.cursor", sync });
  });

  it("requires detached messages to target the owner without activation", () => {
    type MessageCommand = Extract<ClientCommand, { type: "message.send" }>;
    const message = (activate?: boolean): MessageCommand => ({
      type: "message.send",
      requestId: REQUEST,
      payload: {
        conversationId: CONVERSATION,
        content: "hello",
        attachments: [],
        ...(activate === undefined ? {} : { activate }),
      },
    });
    expect(rejection(message(false))).toBeNull();
    expect(rejection({
      ...message(false),
      payload: {
        ...message(false).payload,
        context: { conversationContextPacketIds: [] },
      },
    })).toBeNull();
    const contextualMessage: ClientCommand = {
      ...message(false),
      payload: {
        ...message(false).payload,
        context: { conversationContextPacketIds: [REQUEST] },
      },
    };
    expect(rejection(contextualMessage)).not.toBeNull();
    expect(mainRejection(contextualMessage)).toBeNull();
    expect(rejection(message(true))).not.toBeNull();
    expect(rejection(message())).not.toBeNull();
    expect(rejection({
      ...message(false),
      payload: {
        ...message(false).payload,
        conversationId: OTHER_CONVERSATION,
      },
    } as ClientCommand)).not.toBeNull();
  });

  it("keeps every conversation-context command outside detached authority", () => {
    const commands: ClientCommand[] = [
      {
        type: "conversation.context.source.load",
        requestId: REQUEST,
        payload: {
          sourceConversationId: OTHER_CONVERSATION,
          targetConversationId: CONVERSATION,
        },
      },
      {
        type: "conversation.context.agent.source.load",
        requestId: REQUEST,
        payload: {
          contextRequestId: REQUEST,
          sourceConversationId: OTHER_CONVERSATION,
          targetConversationId: CONVERSATION,
        },
      },
      {
        type: "conversation.context.agent.respond",
        requestId: REQUEST,
        payload: {
          decision: "cancel",
          contextRequestId: REQUEST,
          targetConversationId: CONVERSATION,
        },
      },
      {
        type: "conversation.context.create",
        requestId: REQUEST,
        payload: {
          sourceConversationId: OTHER_CONVERSATION,
          targetConversationId: CONVERSATION,
          sourceMessageIds: [REQUEST],
          acknowledgedWorkspaceDifference: true,
        },
      },
      {
        type: "conversation.context.load",
        requestId: REQUEST,
        payload: {
          packetId: REQUEST,
          targetConversationId: CONVERSATION,
        },
      },
      {
        type: "conversation.context.remove",
        requestId: REQUEST,
        payload: {
          packetId: REQUEST,
          targetConversationId: CONVERSATION,
        },
      },
    ];

    expect(commands.map(rejection)).toEqual(commands.map(() =>
      "That request is unavailable in a detached chat."));
    expect(commands.map(mainRejection)).toEqual(commands.map(() => null));
  });

  it("binds indirect resource identities to the owned conversation", () => {
    expect(rejection({
      type: "activity.mark-seen",
      requestId: REQUEST,
      payload: { runId: RUN },
    })).toBeNull();
    expect(rejection({
      type: "checkpoint.revert",
      requestId: REQUEST,
      payload: { conversationId: CONVERSATION, checkpointId: CHECKPOINT },
    })).toBeNull();
    expect(rejection({
      type: "agent.subagent.stop",
      requestId: REQUEST,
      payload: { conversationId: CONVERSATION, traceId: REQUEST },
    })).toBeNull();
    expect(rejection({
      type: "activity.mark-seen",
      requestId: REQUEST,
      payload: { runId: "22222222-2222-4222-8222-222222222222" },
    })).not.toBeNull();
  });

  it("permits only the popup's narrow global and route-supporting actions", () => {
    expect(rejection({
      type: "settings.update",
      requestId: REQUEST,
      payload: { usageDisplayMode: "compact" },
    })).toBeNull();
    expect(rejection({
      type: "settings.update",
      requestId: REQUEST,
      payload: { theme: "dark" },
    })).not.toBeNull();
    expect(rejection({
      type: "provider.refresh",
      requestId: REQUEST,
      payload: { providerId: "codex" },
    })).toBeNull();
    expect(rejection({
      type: "backend.profile.probe",
      requestId: REQUEST,
      payload: { profileId: "codex-local", modelId: "gpt-5" },
    })).toBeNull();
    expect(rejection({
      type: "provider.maintenance.update",
      requestId: REQUEST,
      payload: { providerId: "codex" },
    })).not.toBeNull();
    expect(rejection({
      type: "prompt-preset.delete",
      requestId: REQUEST,
      payload: { presetId: REQUEST, expectedRevision: 1 },
    })).not.toBeNull();
  });

  it("allows only search mentions in the owning workspace", () => {
    expect(rejection({
      type: "workspace.entries",
      requestId: REQUEST,
      payload: {
        projectId: PROJECT,
        conversationId: CONVERSATION,
        query: "src",
      },
    })).toBeNull();
    expect(rejection({
      type: "workspace.entries",
      requestId: REQUEST,
      payload: {
        projectId: OTHER_PROJECT,
        conversationId: CONVERSATION,
        query: "src",
      },
    })).not.toBeNull();
    expect(rejection({
      type: "workspace.entries",
      requestId: REQUEST,
      payload: {
        projectId: PROJECT,
        conversationId: CONVERSATION,
        directory: "src",
      },
    })).not.toBeNull();
  });
});
