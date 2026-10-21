import { describe, expect, it } from "vitest";

import type {
  AgentApprovalRequest,
  AgentInputRequest,
  AppSnapshot,
  ClientCommand,
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
import { ConversationContextRequestCoordinator } from "../../src/server/runtime/conversation-context-request-coordinator";
import { createDetachedChatRuntimeSecurity } from "../../src/server/runtime/detached-chat-runtime-security";

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
      workingIndicator: {
        ...defaultSettings.workingIndicator,
        style: "automatic",
        color: "lilac",
        glow: true,
      },
    },
    promptPresets: [{ id: "secret-preset" }] as unknown as NonNullable<AppSnapshot["promptPresets"]>,
    todos: [{ id: "secret-task" }] as unknown as NonNullable<AppSnapshot["todos"]>,
    activeProjectId: OTHER_PROJECT,
    activeConversationId: OTHER_CONVERSATION,
  };
}

function resources(): DetachedChatRuntimePolicyResources {
  const current = snapshot();
  return {
    snapshot: () => current,
    subagentConversationId: (traceId) => traceId === REQUEST
      ? CONVERSATION
      : null,
    checkpointConversationId: (checkpointId) =>
      checkpointId === CHECKPOINT ? CONVERSATION : OTHER_CONVERSATION,
    pendingApproval: (conversationId, requestId) =>
      conversationId === CONVERSATION && requestId === REQUEST
      ? ({ conversationId: CONVERSATION } as AgentApprovalRequest)
      : null,
    pendingInput: (conversationId, requestId) =>
      conversationId === CONVERSATION && requestId === REQUEST
      ? ({ conversationId: CONVERSATION } as AgentInputRequest)
      : null,
  };
}

function namedContextRequest(
  conversationId: string,
  sourceConversationId: string,
): AgentInputRequest {
  return {
    id: REQUEST,
    providerId: "codex",
    conversationId,
    runId: RUN,
    turnId: REQUEST,
    questions: [],
    autoResolutionMs: 300_000,
    conversationContextRequest: {
      requestId: REQUEST,
      targetConversationId: conversationId,
      targetTurnId: REQUEST,
      requestedSourceConversationId: sourceConversationId,
      requestedSource: {
        conversationId: sourceConversationId,
        conversationTitle: "Secret",
        projectName: "Secret",
        workspaceLabel: "Project checkout",
        targetWorkspaceLabel: "Project checkout",
        workspaceRelation: "different-workspace",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:05:00.000Z",
    },
  };
}

function namedContextResources(): DetachedChatRuntimePolicyResources {
  return {
    ...resources(),
    pendingInput: (conversationId, requestId) =>
      conversationId === CONVERSATION && requestId === REQUEST
        ? namedContextRequest(CONVERSATION, OTHER_CONVERSATION)
        : null,
  };
}

function agentContextCommands(
  targetConversationId: string,
  sourceConversationId: string,
): ClientCommand[] {
  return [
    {
      type: "conversation.context.agent.source.load",
      requestId: REQUEST,
      payload: {
        contextRequestId: REQUEST,
        sourceConversationId,
        targetConversationId,
      },
    },
    {
      type: "conversation.context.agent.respond",
      requestId: REQUEST,
      payload: {
        decision: "cancel",
        contextRequestId: REQUEST,
        targetConversationId,
      },
    },
    {
      type: "conversation.context.agent.respond",
      requestId: REQUEST,
      payload: {
        decision: "select",
        contextRequestId: REQUEST,
        sourceConversationId,
        targetConversationId,
        acknowledgedWorkspaceDifference: true,
      },
    },
  ];
}

function rejection(command: ClientCommand): string | null {
  return detachedChatCommandRejection(authority, command, resources());
}

function mainRejection(command: ClientCommand): string | null {
  return detachedChatCommandRejection({ kind: "main" }, command, resources());
}

describe("detached chat runtime authority", () => {
  it("preserves appearance-specific presets and custom colors in detached snapshots", () => {
    const state = snapshot();
    state.settings = { ...state.settings, lightColorTheme: "ocean", darkColorTheme: "iris", lightCustomColor: "#0d9488", darkCustomColor: "#f97316", mutedCustomColors: true };
    expect(projectDetachedChatSnapshot(state, CONVERSATION).settings).toMatchObject({
      lightColorTheme: "ocean", darkColorTheme: "iris", lightCustomColor: "#0d9488", darkCustomColor: "#f97316", mutedCustomColors: true,
    });
    state.settings.lightCustomColor = null;
    expect(projectDetachedChatSnapshot(state, CONVERSATION).settings).toMatchObject({ lightCustomColor: null, darkCustomColor: "#f97316" });
  });

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
    expect(projected.todos).toEqual([]);
    expect(projected).not.toHaveProperty("databaseBackup");
    expect(projected.settings).toMatchObject({
      theme: "dark",
      usageDisplayMode: "expanded",
      codexBinaryPath: "",
      workingIndicator: {
        style: "automatic",
        color: "lilac",
        glow: true,
      },
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

  it("passes watcher link removals and live phases only when the link touches the detached chat", () => {
    const LINK = "22222222-2222-4222-8222-222222222222";
    const UNKNOWN_LINK = "44444444-4444-4444-8444-444444444444";
    const links = new Map([[LINK, { watcherConversationId: OTHER_CONVERSATION, watchedConversationId: CONVERSATION }]]);
    const sync = { runtimeGeneration: "33333333-3333-4333-8333-333333333333", latestSequence: 2 };
    const live = (linkId: string, watcherConversationId = OTHER_CONVERSATION): RuntimeSequencedFrame & { type: "runtime.event" } => ({
      type: "runtime.event", sync, scope: { kind: "shell" },
      event: {
        type: "watcher.live", linkId, watcherConversationId, turnId: "turn",
        phase: "reading", label: "Read src/a.ts", at: "2030-01-01T00:00:00.000Z",
      },
    });
    const removed = (linkId: string): RuntimeSequencedFrame & { type: "runtime.event" } => ({
      type: "runtime.event", sync, scope: { kind: "shell" }, event: { type: "watcher.link.removed", linkId },
    });
    const project = (frame: RuntimeSequencedFrame & { type: "runtime.event" }, conversationId = CONVERSATION) =>
      projectRuntimeFrameForAuthority(
        frame,
        { conversationIds: [] },
        { ...authority, conversationId },
        (linkId) => links.get(linkId) ?? null,
      );
    expect(project(live(LINK))).toEqual(live(LINK));
    expect(project(removed(LINK))).toEqual(removed(LINK));
    expect(project(live(LINK), OTHER_CONVERSATION)).toEqual(live(LINK));
    expect(project(live(LINK), "55555555-5555-4555-8555-555555555555")).toEqual({ type: "runtime.cursor", sync });
    expect(project(live(UNKNOWN_LINK))).toEqual({ type: "runtime.cursor", sync });
    expect(project(removed(UNKNOWN_LINK))).toEqual({ type: "runtime.cursor", sync });
    expect(project(live(LINK, CONVERSATION))).toEqual({ type: "runtime.cursor", sync });
    expect(projectRuntimeFrameForAuthority(live(LINK), { conversationIds: [] }, authority))
      .toEqual({ type: "runtime.cursor", sync });
  });

  it("passes the removal of a deleted link to the detached chat it touched, from the sides the event names", () => {
    const LINK = "22222222-2222-4222-8222-222222222222";
    const sync = { runtimeGeneration: "33333333-3333-4333-8333-333333333333", latestSequence: 2 };
    const removed: RuntimeSequencedFrame & { type: "runtime.event" } = {
      type: "runtime.event", sync, scope: { kind: "shell" },
      event: { type: "watcher.link.removed", linkId: LINK, watcherConversationId: OTHER_CONVERSATION, watchedConversationId: CONVERSATION },
    };
    const project = (conversationId: string) =>
      projectRuntimeFrameForAuthority(removed, { conversationIds: [] }, { ...authority, conversationId }, () => null);
    expect(project(CONVERSATION)).toEqual(removed);
    expect(project(OTHER_CONVERSATION)).toEqual(removed);
    expect(project("55555555-5555-4555-8555-555555555555")).toEqual({ type: "runtime.cursor", sync });
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

  it("keeps update-everything commands to the main window", () => {
    const commands: ClientCommand[] = [
      { type: "updates.run", requestId: REQUEST, payload: { providerIds: ["codex"], includeApp: true, continueChats: true } },
      { type: "updates.finish", requestId: REQUEST, payload: { installed: false } },
    ];
    for (const command of commands) {
      expect(rejection(command)).toBe("That request is unavailable in a detached chat.");
      expect(mainRejection(command)).toBeNull();
    }
  });

  it("keeps manual conversation-context commands outside detached authority", () => {
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

    expect(commands.map((command) => detachedChatCommandRejection(
      authority,
      command,
      namedContextResources(),
    ))).toEqual(commands.map(() =>
      "That request is unavailable in a detached chat."));
    expect(commands.map(mainRejection)).toEqual(commands.map(() => null));
  });

  it("lets a detached chat answer its own agent context request for the one chat it names", () => {
    const commands = agentContextCommands(CONVERSATION, OTHER_CONVERSATION);
    expect(commands.map((command) => detachedChatCommandRejection(
      authority,
      command,
      namedContextResources(),
    ))).toEqual(commands.map(() => null));
    expect(commands.map(mainRejection)).toEqual(commands.map(() => null));
  });

  it("refuses agent context answers for another chat, another source, or an open choice", () => {
    const REJECTED = "That request is unavailable in a detached chat.";
    const otherSource = "22222222-2222-4222-8222-222222222222";
    const foreign = agentContextCommands(OTHER_CONVERSATION, OTHER_CONVERSATION);
    expect(foreign.map((command) => detachedChatCommandRejection(authority, command, {
      ...namedContextResources(),
      pendingInput: (conversationId, requestId) =>
        conversationId === OTHER_CONVERSATION && requestId === REQUEST
          ? namedContextRequest(OTHER_CONVERSATION, CONVERSATION)
          : null,
    }))).toEqual(foreign.map(() => REJECTED));
    const [load, , select] = agentContextCommands(CONVERSATION, otherSource);
    expect([load!, select!].map((command) => detachedChatCommandRejection(
      authority,
      command,
      namedContextResources(),
    ))).toEqual([REJECTED, REJECTED]);
    const open = agentContextCommands(CONVERSATION, OTHER_CONVERSATION);
    const unnamed = namedContextRequest(CONVERSATION, OTHER_CONVERSATION);
    unnamed.conversationContextRequest = {
      ...unnamed.conversationContextRequest!,
      requestedSourceConversationId: null,
    };
    delete unnamed.conversationContextRequest.requestedSource;
    expect(open.map((command) => detachedChatCommandRejection(authority, command, {
      ...namedContextResources(),
      pendingInput: () => unnamed,
    }))).toEqual(open.map(() => REJECTED));
    const unsummarized = namedContextRequest(CONVERSATION, OTHER_CONVERSATION);
    delete unsummarized.conversationContextRequest!.requestedSource;
    expect(open.map((command) => detachedChatCommandRejection(authority, command, {
      ...namedContextResources(),
      pendingInput: () => unsummarized,
    }))).toEqual(open.map(() => REJECTED));
    expect(open.map(rejection)).toEqual(open.map(() => REJECTED));
  });

  it("refuses an agent context answer when the pending input does not carry the command's identity", () => {
    const REJECTED = "That request is unavailable in a detached chat.";
    const commands = agentContextCommands(CONVERSATION, OTHER_CONVERSATION);
    const foreignOwner = namedContextRequest(OTHER_CONVERSATION, CONVERSATION);
    foreignOwner.conversationContextRequest = namedContextRequest(
      CONVERSATION,
      OTHER_CONVERSATION,
    ).conversationContextRequest;
    const otherRequest = namedContextRequest(CONVERSATION, OTHER_CONVERSATION);
    otherRequest.conversationContextRequest = {
      ...otherRequest.conversationContextRequest!,
      requestId: "22222222-2222-4222-8222-222222222222",
    };
    for (const pending of [foreignOwner, otherRequest]) {
      expect(commands.map((command) => detachedChatCommandRejection(authority, command, {
        ...namedContextResources(),
        pendingInput: () => pending,
      }))).toEqual(commands.map(() => REJECTED));
    }
  });

  it("authorizes one answer to a live named context request for the window's chat", async () => {
    const pendingInputs = new Map<string, AgentInputRequest>();
    const requestedSource = namedContextRequest(CONVERSATION, OTHER_CONVERSATION)
      .conversationContextRequest!.requestedSource!;
    const coordinator = new ConversationContextRequestCoordinator({
      pendingInputs,
      contextPackets: { requestedSourceSummary: () => requestedSource },
      broadcast: () => undefined,
      broadcastConversationShell: () => undefined,
    });
    const security = createDetachedChatRuntimeSecurity({
      websocketPath: "/runtime",
      store: {
        subagentTrace: () => { throw new Error("Not found."); },
        checkpoint: () => { throw new Error("Not found."); },
      },
      snapshot,
      pendingApprovals: new Map(),
      pendingInputs,
    });
    const outcome = coordinator.request({
      scope: {
        contextRequestId: REQUEST,
        targetConversationId: CONVERSATION,
        targetTurnId: REQUEST,
        targetRunId: RUN,
        toolCallIdHash: "a".repeat(64),
      },
      providerId: "codex",
      requestedSourceConversationId: OTHER_CONVERSATION,
      requestedSource,
      createdAt: "2026-01-01T00:00:00.000Z",
      signal: new AbortController().signal,
    });
    const otherSource = "22222222-2222-4222-8222-222222222222";
    const [, , wrongSource] = agentContextCommands(CONVERSATION, otherSource);
    const [load, , select] = agentContextCommands(CONVERSATION, OTHER_CONVERSATION);

    expect(security.authorizationError(authority, wrongSource!)).toMatchObject({
      type: "request.error",
      message: "That request is unavailable in a detached chat.",
    });
    expect(security.authorizationError(authority, load!)).toBeNull();
    expect(security.authorizationError(authority, select!)).toBeNull();
    expect(coordinator.respond({
      requestId: REQUEST,
      targetConversationId: CONVERSATION,
      selection: { sourceConversationId: OTHER_CONVERSATION, acknowledgedWorkspaceDifference: true },
    })).toBe(true);
    await expect(outcome).resolves.toMatchObject({ kind: "selected" });

    expect(security.authorizationError(authority, select!)).toMatchObject({
      type: "request.error",
      message: "That request is unavailable in a detached chat.",
    });
    expect(coordinator.respond({
      requestId: REQUEST,
      targetConversationId: CONVERSATION,
      selection: { sourceConversationId: OTHER_CONVERSATION, acknowledgedWorkspaceDifference: true },
    })).toBe(false);
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
    expect(detachedChatCommandRejection(authority, {
      type: "agent.subagent.stop",
      requestId: REQUEST,
      payload: { conversationId: CONVERSATION, traceId: REQUEST },
    }, { ...resources(), subagentConversationId: () => OTHER_CONVERSATION })).not.toBeNull();
    expect(rejection({
      type: "agent.subagent.stop",
      requestId: REQUEST,
      payload: { conversationId: CONVERSATION, traceId: OTHER_CONVERSATION },
    })).not.toBeNull();
    expect(rejection({
      type: "activity.mark-seen",
      requestId: REQUEST,
      payload: { runId: "22222222-2222-4222-8222-222222222222" },
    })).not.toBeNull();
  });

  it("keeps host-owned context requests outside generic input authority", () => {
    const command = {
      type: "agent.input.respond",
      requestId: REQUEST,
      payload: {
        conversationId: CONVERSATION,
        requestId: REQUEST,
        answers: {},
      },
    } as ClientCommand;
    expect(rejection(command)).toBeNull();
    expect(detachedChatCommandRejection(authority, command, {
      ...resources(),
      pendingInput: () => ({
        conversationId: CONVERSATION,
        conversationContextRequest: {},
      } as AgentInputRequest),
    })).not.toBeNull();
    expect(mainRejection(command)).toBeNull();
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
      type: "settings.update",
      requestId: REQUEST,
      payload: { workingIndicator: { style: "automatic" } },
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
    for (const command of [
      { type: "todo.create", requestId: REQUEST, payload: { id: REQUEST, title: "Task", note: "", priority: null, dueDate: null } },
      { type: "todo.update", requestId: REQUEST, payload: { id: REQUEST, patch: { completed: true } } },
      { type: "todo.delete", requestId: REQUEST, payload: { id: REQUEST } },
      { type: "todo.start", requestId: REQUEST, payload: { id: REQUEST, conversation: { projectId: PROJECT } } },
      { type: "updates.run", requestId: REQUEST, payload: { providerIds: ["codex"], includeApp: true, continueChats: true } },
      { type: "updates.finish", requestId: REQUEST, payload: { installed: false } },
    ] satisfies ClientCommand[]) {
      expect(rejection(command)).not.toBeNull();
      expect(mainRejection(command)).toBeNull();
    }
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

  it("keeps terminal reattachment outside detached-chat authority", () => {
    const attach: ClientCommand = {
      type: "terminal.attach",
      requestId: REQUEST,
      payload: {
        projectId: PROJECT,
        conversationId: CONVERSATION,
        terminalId: "22222222-2222-4222-8222-222222222222",
        cols: 80,
        rows: 24,
      },
    };

    expect(rejection(attach)).toBe(
      "That request is unavailable in a detached chat.",
    );
    expect(mainRejection(attach)).toBeNull();
  });
});


describe("global message search authority", () => {
  it("denies global search and cross-window focus commands to detached renderers", () => {
    const commands: ClientCommand[] = [
      { type: "conversation.messages.search", requestId: REQUEST, payload: { query: "needle" } },
      { type: "conversation.messages.search.cancel", requestId: REQUEST, payload: { searchRequestId: REQUEST } },
      { type: "conversation.message.reveal", requestId: REQUEST, payload: { projectId: PROJECT, conversationId: CONVERSATION, turnId: "legacy-turn", messageId: REQUEST } },
    ];
    for (const command of commands) {
      expect(rejection(command)).not.toBeNull();
      expect(mainRejection(command)).toBeNull();
    }
  });
});
