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
const OTHER_RUN = "22222222-2222-4222-8222-222222222222";
const TURN = "33333333-3333-4333-8333-333333333333";
const OTHER_TURN = "44444444-4444-4444-8444-444444444444";
const LAUNCH = "55555555-5555-4555-8555-555555555555";
const JUDGED_LAUNCH = "66666666-6666-4666-8666-666666666666";
const OTHER_LAUNCH = "77777777-7777-4777-8777-777777777777";
const TERMINAL = "88888888-8888-4888-8888-888888888888";
const FINGERPRINT = "a".repeat(64);

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
    promptPresets: [{ id: "review-preset" }] as unknown as NonNullable<AppSnapshot["promptPresets"]>,
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
    turnConversationId: (turnId) => ({
      [TURN]: CONVERSATION,
      [OTHER_TURN]: OTHER_CONVERSATION,
    })[turnId] ?? null,
    duoLaunchConversationIds: (launchId) => ({
      [LAUNCH]: [CONVERSATION, OTHER_CONVERSATION],
      [JUDGED_LAUNCH]: [OTHER_CONVERSATION, "99999999-9999-4999-8999-999999999999", CONVERSATION],
      [OTHER_LAUNCH]: [OTHER_CONVERSATION, "99999999-9999-4999-8999-999999999999"],
    })[launchId] ?? null,
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
    expect(projected.promptPresets).toEqual([{ id: "review-preset" }]);
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
    expect(frame({
      type: "runtime.event",
      sync,
      scope: { kind: "shell" },
      event: { type: "todos.updated", todos: [] },
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

  it("lets a detached chat compact and send to itself on the same terms as a message", () => {
    type CompactAndSend = Extract<ClientCommand, { type: "conversation.compact-and-send" }>;
    const compactAndSend = (
      payload: Partial<CompactAndSend["payload"]> = {},
    ): CompactAndSend => ({
      type: "conversation.compact-and-send",
      requestId: REQUEST,
      payload: {
        conversationId: CONVERSATION,
        content: "hello",
        attachments: [],
        activate: false,
        reason: "on-return",
        ...payload,
      },
    });
    expect(rejection(compactAndSend())).toBeNull();
    expect(rejection(compactAndSend({ context: { fileReferences: [{ path: "src/app.ts" }] } }))).toBeNull();
    expect(rejection(compactAndSend({ activate: true }))).not.toBeNull();
    expect(rejection(compactAndSend({ activate: undefined }))).not.toBeNull();
    expect(rejection(compactAndSend({ context: { conversationContextPacketIds: [REQUEST] } }))).not.toBeNull();
    expect(rejection(compactAndSend({ conversationId: OTHER_CONVERSATION }))).not.toBeNull();
    expect(mainRejection(compactAndSend({ activate: true }))).toBeNull();
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
        agentTurn: () => { throw new Error("Not found."); },
        findPairedLaunch: () => null,
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
      payload: { profileId: "codex-local", modelIds: ["gpt-5"] },
    })).toBeNull();
    expect(rejection({
      type: "backend.profile.probe",
      requestId: REQUEST,
      payload: { profileId: "codex-local" },
    })).not.toBeNull();
    expect(rejection({
      type: "backend.profile.probe",
      requestId: REQUEST,
      payload: { profileId: "codex-local", modelIds: ["gpt-5", "gpt-4"] },
    })).not.toBeNull();
    expect(rejection({
      type: "backend.profile.discover-models",
      requestId: REQUEST,
      payload: { profileId: "codex-local" },
    })).not.toBeNull();
    expect(rejection({
      type: "provider.maintenance.update",
      requestId: REQUEST,
      payload: { providerId: "codex" },
    })).not.toBeNull();
    const clearDone: ClientCommand = { type: "todo.clearDone", requestId: REQUEST, payload: { ids: [] } };
    expect(rejection(clearDone)).not.toBeNull();
    expect(mainRejection(clearDone)).toBeNull();
    for (const command of [
      { type: "todo.create", requestId: REQUEST, payload: { id: REQUEST, title: "Task", note: "", priority: null, dueDate: null, dueTime: null, projectId: null } },
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

  it("allows workspace entries only in the owning workspace", () => {
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
  });
});


const REJECTED = "That request is unavailable in a detached chat.";

interface WorkspaceScope {
  projectId: string;
  conversationId?: string;
}

const OWNED_SCOPE: WorkspaceScope = { projectId: PROJECT, conversationId: CONVERSATION };
const FOREIGN_SCOPES: WorkspaceScope[] = [
  { projectId: PROJECT, conversationId: OTHER_CONVERSATION },
  { projectId: OTHER_PROJECT, conversationId: OTHER_CONVERSATION },
  { projectId: OTHER_PROJECT, conversationId: CONVERSATION },
  { projectId: PROJECT },
];

function gitCommands(scope: WorkspaceScope): ClientCommand[] {
  const nested = { ...scope, repositoryPath: "packages/app", authorityRef: REQUEST };
  const selection = {
    ...scope,
    fingerprint: FINGERPRINT,
    filePath: "src/app.ts",
    hunkId: "hunk-1",
    lineIds: ["line-1"],
  };
  return [
    { type: "git.refresh", requestId: REQUEST, payload: scope },
    { type: "git.workspace.refresh", requestId: REQUEST, payload: scope },
    { type: "git.diff", requestId: REQUEST, payload: { ...scope, authorityRef: REQUEST } },
    { type: "git.workspace.diff", requestId: REQUEST, payload: { ...nested, path: "src/app.ts" } },
    { type: "git.selection.inspect", requestId: REQUEST, payload: selection },
    {
      type: "git.selection.revert",
      requestId: REQUEST,
      payload: {
        ...selection,
        authorityRef: REQUEST,
        expected: {
          diffFingerprint: FINGERPRINT,
          fileFingerprint: FINGERPRINT,
          hunkFingerprint: FINGERPRINT,
          selectionFingerprint: FINGERPRINT,
          gitStateFingerprint: FINGERPRINT,
        },
      },
    },
    { type: "git.selection.undo", requestId: REQUEST, payload: { ...scope, operationId: REQUEST, authorityRef: REQUEST } },
    { type: "git.branches", requestId: REQUEST, payload: { ...scope, authorityRef: REQUEST } },
    { type: "git.branch.create", requestId: REQUEST, payload: { ...nested, name: "feature" } },
    { type: "git.branch.switch", requestId: REQUEST, payload: { ...scope, name: "main", remote: true } },
    { type: "git.fetch", requestId: REQUEST, payload: nested },
    { type: "git.pull", requestId: REQUEST, payload: scope },
    { type: "git.push", requestId: REQUEST, payload: nested },
    {
      type: "git.commit",
      requestId: REQUEST,
      payload: {
        ...scope,
        message: "Commit",
        paths: ["src/app.ts"],
        reviewReceipt: { authorityRef: REQUEST, fingerprint: FINGERPRINT },
      },
    },
    { type: "git.pr.open", requestId: REQUEST, payload: scope },
    { type: "git.pr.confidence", requestId: REQUEST, payload: nested },
    { type: "git.pr.create", requestId: REQUEST, payload: { ...scope, title: "Change", body: "", draft: true } },
    { type: "review.selection.ask", requestId: REQUEST, payload: { ...selection, conversationId: scope.conversationId ?? "" } },
    { type: "review.selection.revise", requestId: REQUEST, payload: { ...selection, conversationId: scope.conversationId ?? "", comment: "Smaller" } },
    {
      type: "review.summary.generate",
      requestId: REQUEST,
      payload: { projectId: scope.projectId, conversationId: scope.conversationId ?? "", fingerprint: FINGERPRINT },
    },
  ];
}

function workspaceCommands(scope: WorkspaceScope): ClientCommand[] {
  return [
    { type: "workspace.entries", requestId: REQUEST, payload: scope },
    { type: "workspace.entries", requestId: REQUEST, payload: { ...scope, directory: "src" } },
    { type: "workspace.entries", requestId: REQUEST, payload: { ...scope, query: "app" } },
    { type: "workspace.file.read", requestId: REQUEST, payload: { ...scope, path: "src/app.ts", fallbackPath: "src/index.ts" } },
    {
      type: "workspace.file.write",
      requestId: REQUEST,
      payload: { ...scope, path: "src/app.ts", authorityRef: REQUEST, expectedDigest: FINGERPRINT, content: "export {};" },
    },
  ];
}

function terminalCommands(scope: WorkspaceScope): ClientCommand[] {
  return [
    { type: "terminal.create", requestId: REQUEST, payload: { ...scope, cols: 80, rows: 24 } },
    { type: "terminal.attach", requestId: REQUEST, payload: { ...scope, terminalId: TERMINAL, cols: 80, rows: 24 } },
    {
      type: "terminal.provider.resume",
      requestId: REQUEST,
      payload: { projectId: scope.projectId, conversationId: scope.conversationId ?? "", terminalId: TERMINAL, cols: 80, rows: 24 },
    },
    { type: "project.actions", requestId: REQUEST, payload: scope },
    {
      type: "project.action.run",
      requestId: REQUEST,
      payload: { ...scope, actionId: "dev", terminalId: TERMINAL, cols: 80, rows: 24 },
    },
  ];
}

function expectOnlyOwnedScope(commands: (scope: WorkspaceScope) => ClientCommand[]): void {
  expect(commands(OWNED_SCOPE).map(rejection)).toEqual(commands(OWNED_SCOPE).map(() => null));
  for (const scope of FOREIGN_SCOPES) {
    expect(commands(scope).map(rejection)).toEqual(commands(scope).map(() => REJECTED));
    expect(commands(scope).map(mainRejection)).toEqual(commands(scope).map(() => null));
  }
  expect(commands(OWNED_SCOPE).map((command) => detachedChatCommandRejection(authority, command, {
    ...resources(),
    snapshot: () => ({ ...snapshot(), conversations: [conversation(OTHER_CONVERSATION, OTHER_PROJECT)] }),
  }))).toEqual(commands(OWNED_SCOPE).map(() => REJECTED));
}

describe("detached chat workspace tool authority", () => {
  it("scopes Git status, diffs, branches, remotes, commits, pull requests and review questions to the owned checkout", () => {
    expectOnlyOwnedScope(gitCommands);
  });

  it("opens turn diffs and comparisons only for turns the owned conversation recorded", () => {
    const diff = (turnId: string, conversationId = CONVERSATION): ClientCommand => ({
      type: "git.turn.diff",
      requestId: REQUEST,
      payload: { projectId: PROJECT, conversationId, turnId, path: "src/app.ts" },
    });
    const compare = (earlierTurnId: string, laterTurnId: string): ClientCommand => ({
      type: "git.turn.compare",
      requestId: REQUEST,
      payload: { projectId: PROJECT, conversationId: CONVERSATION, earlierTurnId, laterTurnId },
    });
    expect(rejection(diff(TURN))).toBeNull();
    expect(rejection(compare(TURN, TURN))).toBeNull();
    expect(rejection(diff(OTHER_TURN))).toBe(REJECTED);
    expect(rejection(diff("unknown-turn"))).toBe(REJECTED);
    expect(rejection(diff(OTHER_TURN, OTHER_CONVERSATION))).toBe(REJECTED);
    expect(rejection(compare(TURN, OTHER_TURN))).toBe(REJECTED);
    expect(rejection(compare(OTHER_TURN, TURN))).toBe(REJECTED);
    expect(rejection({
      type: "git.turn.diff",
      requestId: REQUEST,
      payload: { projectId: OTHER_PROJECT, conversationId: CONVERSATION, turnId: TURN },
    })).toBe(REJECTED);
    expect(mainRejection(diff(OTHER_TURN, OTHER_CONVERSATION))).toBeNull();
  });

  it("keeps review notes, review state and review cancellation on the owned conversation", () => {
    const commands = (conversationId: string): ClientCommand[] => [
      {
        type: "review.state.set",
        requestId: REQUEST,
        payload: { conversationId, scope: "hunk", path: "src/app.ts", hunkId: "hunk-1", targetFingerprint: FINGERPRINT, reviewed: true },
      },
      {
        type: "review.note.create",
        requestId: REQUEST,
        payload: { conversationId, path: "src/app.ts", hunkId: null, lineIds: [], targetFingerprint: FINGERPRINT, body: "Check this" },
      },
      { type: "review.note.update", requestId: REQUEST, payload: { conversationId, noteId: REQUEST, body: "Checked" } },
      { type: "review.note.delete", requestId: REQUEST, payload: { conversationId, noteId: REQUEST } },
      { type: "review.selection.cancel", requestId: REQUEST, payload: { conversationId } },
      { type: "review.summary.cancel", requestId: REQUEST, payload: { conversationId } },
    ];
    expect(commands(CONVERSATION).map(rejection)).toEqual(commands(CONVERSATION).map(() => null));
    expect(commands(OTHER_CONVERSATION).map(rejection)).toEqual(commands(OTHER_CONVERSATION).map(() => REJECTED));
    expect(commands(OTHER_CONVERSATION).map(mainRejection)).toEqual(commands(OTHER_CONVERSATION).map(() => null));
  });

  it("lets the Files panel list folders, read and save files only in the owned checkout", () => {
    expectOnlyOwnedScope(workspaceCommands);
  });

  it("opens terminals, provider resume and project actions only in the owned checkout", () => {
    expectOnlyOwnedScope(terminalCommands);
  });

  it("leaves terminal input, resizing, detaching and closing to the socket that owns the terminal", () => {
    const commands: ClientCommand[] = [
      { type: "terminal.input", requestId: REQUEST, payload: { terminalId: TERMINAL, data: "ls\r" } },
      { type: "terminal.resize", requestId: REQUEST, payload: { terminalId: TERMINAL, cols: 100, rows: 30 } },
      { type: "terminal.detach", requestId: REQUEST, payload: { terminalId: TERMINAL } },
      { type: "terminal.close", requestId: REQUEST, payload: { terminalId: TERMINAL } },
    ];
    expect(commands.map(rejection)).toEqual(commands.map(() => null));
  });

  it("controls background work only for runs of the owned conversation", () => {
    const activity = (runId: string): ClientCommand[] => [
      { type: "activity.stop", requestId: REQUEST, payload: { runId } },
      { type: "activity.dismiss", requestId: REQUEST, payload: { runId } },
      { type: "activity.acknowledge", requestId: REQUEST, payload: { runId } },
    ];
    expect(activity(RUN).map(rejection)).toEqual([null, null, null]);
    expect(activity(OTHER_RUN).map(rejection)).toEqual([REJECTED, REJECTED, REJECTED]);
    expect(activity("unknown-run").map(rejection)).toEqual([REJECTED, REJECTED, REJECTED]);
    expect(activity(OTHER_RUN).map(mainRejection)).toEqual([null, null, null]);
    const tasks = (conversationId: string): ClientCommand => ({
      type: "conversation.background-tasks.get",
      requestId: REQUEST,
      payload: { conversationId, before: null },
    });
    expect(rejection(tasks(CONVERSATION))).toBeNull();
    expect(rejection(tasks(OTHER_CONVERSATION))).toBe(REJECTED);
  });

  it("reads provider limits without editing limit sources or resets", () => {
    expect(rejection({ type: "usage.limits.get", requestId: REQUEST, payload: { refresh: true, force: false, background: true } })).toBeNull();
    expect(rejection({ type: "usage.limits.get", requestId: REQUEST, payload: { refresh: false } })).toBeNull();
    for (const command of [
      { type: "usage.source.remove", requestId: REQUEST, payload: { id: REQUEST } },
      { type: "usage.reset.prepare", requestId: REQUEST, payload: { accountId: "account" } },
      { type: "usage.reset.confirm", requestId: REQUEST, payload: { confirmationId: REQUEST, confirmed: true } },
      { type: "usage.dashboard.get", requestId: REQUEST, payload: { days: 7, fromInclusive: "2026-01-01T00:00:00.000Z", toExclusive: "2026-01-08T00:00:00.000Z", endDate: "2026-01-07", timeZone: "UTC" } },
    ] satisfies ClientCommand[]) {
      expect(rejection(command)).toBe(REJECTED);
      expect(mainRejection(command)).toBeNull();
    }
  });

  it("manages the user's own prompt presets", () => {
    const commands: ClientCommand[] = [
      { type: "prompt-preset.create", requestId: REQUEST, payload: { name: "Review", body: "Review this.", route: null } },
      { type: "prompt-preset.update", requestId: REQUEST, payload: { presetId: REQUEST, expectedRevision: 1, name: "Check" } },
      { type: "prompt-preset.duplicate", requestId: REQUEST, payload: { presetId: REQUEST, expectedRevision: 1 } },
      { type: "prompt-preset.delete", requestId: REQUEST, payload: { presetId: REQUEST, expectedRevision: 1 } },
      { type: "prompt-preset.reorder", requestId: REQUEST, payload: { expectedPresetIds: [REQUEST, RUN], presetIds: [RUN, REQUEST] } },
    ];
    expect(commands.map(rejection)).toEqual(commands.map(() => null));
  });
});

describe("detached chat title menu authority", () => {
  it("renames, pins and snoozes only the owned conversation", () => {
    const update = (payload: Record<string, unknown>): ClientCommand => ({
      type: "conversation.update",
      requestId: REQUEST,
      payload: { conversationId: CONVERSATION, ...payload },
    } as ClientCommand);
    for (const payload of [
      { title: "Renamed" },
      { pinned: true },
      { pinned: false },
      { snoozedUntil: "2030-01-01T09:00:00.000Z" },
      { snoozedUntil: null },
    ]) {
      expect(rejection(update(payload))).toBeNull();
      expect(rejection(update({ ...payload, conversationId: OTHER_CONVERSATION }))).toBe(REJECTED);
    }
    expect(rejection(update({ model: "gpt-5" }))).toBe(REJECTED);
    expect(rejection(update({ reasoningEffort: "high" }))).toBe(REJECTED);
    expect(rejection(update({}))).toBe(REJECTED);
  });

  it("settles, reopens, marks unread and regenerates the title only for the owned conversation", () => {
    const commands = (conversationId: string): ClientCommand[] => ([
      "conversation.settle",
      "conversation.unsettle",
      "conversation.mark-unread",
      "conversation.regenerate-title",
    ] as const).map((type) => ({ type, requestId: REQUEST, payload: { conversationId } }));
    expect(commands(CONVERSATION).map(rejection)).toEqual([null, null, null, null]);
    expect(commands(OTHER_CONVERSATION).map(rejection)).toEqual([REJECTED, REJECTED, REJECTED, REJECTED]);
    expect(commands(OTHER_CONVERSATION).map(mainRejection)).toEqual([null, null, null, null]);
    for (const type of ["conversation.archive", "conversation.unarchive", "conversation.delete"] as const) {
      expect(rejection({ type, requestId: REQUEST, payload: { conversationId: CONVERSATION } })).toBe(REJECTED);
    }
  });
});

describe("detached chat Duo authority", () => {
  it("sweeps pending Duo launches only in the owned project", () => {
    const pending = (projectIds: string[]): ClientCommand => ({
      type: "duo.pending",
      requestId: REQUEST,
      payload: { projectIds, page: 1 },
    });
    expect(rejection(pending([PROJECT]))).toBeNull();
    expect(rejection(pending([OTHER_PROJECT]))).toBe(REJECTED);
    expect(rejection(pending([PROJECT, OTHER_PROJECT]))).toBe(REJECTED);
    expect(mainRejection(pending([PROJECT, OTHER_PROJECT]))).toBeNull();
  });

  it("reads, retries and cancels Duo comparisons only for launches that include the owned conversation", () => {
    const commands = (launchId: string): ClientCommand[] => ([
      "duo.status",
      "duo.comparison.retry",
      "duo.comparison.cancel",
    ] as const).map((type) => ({ type, requestId: REQUEST, payload: { launchId } }));
    expect(commands(LAUNCH).map(rejection)).toEqual([null, null, null]);
    expect(commands(JUDGED_LAUNCH).map(rejection)).toEqual([null, null, null]);
    expect(commands(OTHER_LAUNCH).map(rejection)).toEqual([REJECTED, REJECTED, REJECTED]);
    expect(commands(REQUEST).map(rejection)).toEqual([REJECTED, REJECTED, REJECTED]);
    expect(commands(OTHER_LAUNCH).map(mainRejection)).toEqual([null, null, null]);
    for (const type of ["duo.dispatch", "duo.cancel", "duo.acknowledge"] as const) {
      expect(rejection({ type, requestId: REQUEST, payload: { launchId: LAUNCH } })).toBe(REJECTED);
    }
  });
});

describe("detached chat projection for chat surfaces", () => {
  const chatSettings = (): AppSnapshot["settings"] => ({
    ...defaultSettings,
    terminalFontSize: 17,
    wrapDiffs: true,
    ignoreWhitespace: true,
    autoOpenPlan: false,
    compactOnReturn: "never",
    desktopNotifications: false,
    quotaWarnings: { enabled: false, firstThreshold: 15 },
    keybindings: { search: "g", "new-chat": "h", "toggle-sidebar": "u", "toggle-terminal": "y", tasks: "t" },
    newThreadMode: "worktree",
    defaultAccessMode: "full",
    codexBinaryPath: "/Users/someone/bin/codex",
    discordReleaseRepositoryUrl: "https://github.com/someone/release-notes",
    completionSound: {
      enabled: true,
      sound: "0123456789abcdef.mp3",
      library: [{ file: "0123456789abcdef.mp3", name: "Private recording" }],
      longRunsOnly: true,
      longRunSeconds: 120,
    },
  });
  const projectedSettings = () => projectDetachedChatSnapshot(
    { ...snapshot(), settings: chatSettings() },
    CONVERSATION,
  ).settings;

  it("projects every chat setting the window reads, including the ones it used to reset", () => {
    expect(projectedSettings()).toMatchObject({
      terminalFontSize: 17,
      wrapDiffs: true,
      ignoreWhitespace: true,
      autoOpenPlan: false,
      compactOnReturn: "never",
      desktopNotifications: false,
      quotaWarnings: { enabled: false, firstThreshold: 15 },
      keybindings: { search: "g", "new-chat": "h", "toggle-sidebar": "u", "toggle-terminal": "y", tasks: "t" },
      newThreadMode: "worktree",
      defaultAccessMode: "full",
    });
    const { codexBinaryPath: _codex, discordReleaseRepositoryUrl: _discord, completionSound: _sound, ...shared } = chatSettings();
    expect(projectedSettings()).toMatchObject(shared);
  });

  it.each([
    ["codexBinaryPath", "names a local executable that only provider setup in the main window uses"],
    ["discordReleaseRepositoryUrl", "configures release announcements, which only the main window sends"],
    ["completionSound", "is played by the main window and lists the user's imported sound files"],
  ] as const)("keeps %s at its default because it %s", (key, _reason) => {
    expect(projectedSettings()[key]).toEqual(defaultSettings[key]);
    expect(JSON.stringify(projectedSettings())).not.toMatch(/someone|Private recording/u);
  });

  it("keeps the owned project's actions and preferences in the projected project", () => {
    const state = snapshot();
    const preferences = { actions: [{ id: "dev", name: "Dev", executable: "npm", args: ["run", "dev"] }] };
    state.projects = state.projects.map((project) => project.id === PROJECT
      ? { ...project, preferences } as AppSnapshot["projects"][number]
      : project);
    expect(projectDetachedChatSnapshot(state, CONVERSATION).projects).toEqual([
      expect.objectContaining({ id: PROJECT, preferences }),
    ]);
  });

  it("forwards Git invalidation only for the owned conversation's checkout", () => {
    const sync = { runtimeGeneration: "33333333-3333-4333-8333-333333333333", latestSequence: 3 };
    const invalidated = (projectId: string, conversationId: string | null): RuntimeSequencedFrame & { type: "runtime.event" } => ({
      type: "runtime.event",
      sync,
      scope: { kind: "shell" },
      event: { type: "workspace.git.invalidated", requestId: REQUEST, projectId, conversationId },
    });
    const project = (frame: RuntimeSequencedFrame & { type: "runtime.event" }) =>
      projectRuntimeFrameForAuthority(frame, { conversationIds: [CONVERSATION] }, authority);
    expect(project(invalidated(PROJECT, CONVERSATION))).toEqual(invalidated(PROJECT, CONVERSATION));
    expect(project(invalidated(PROJECT, OTHER_CONVERSATION))).toEqual({ type: "runtime.cursor", sync });
    expect(project(invalidated(PROJECT, null))).toEqual({ type: "runtime.cursor", sync });
    expect(projectRuntimeFrameForAuthority(
      invalidated(OTHER_PROJECT, OTHER_CONVERSATION),
      { conversationIds: [] },
      { kind: "main" },
    )).toEqual(invalidated(OTHER_PROJECT, OTHER_CONVERSATION));
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
