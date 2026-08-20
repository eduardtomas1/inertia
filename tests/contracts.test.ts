import { describe, expect, it } from "vitest";
import {
  AGENT_TURN_STATUSES,
  agentTurnAssociationSchema,
  agentTurnStatusSchema,
  canTransitionAgentTurnStatus,
  clientCommandSchema,
  isAgentTurnTerminalStatus,
  MAX_WORKSPACE_FILE_EDIT_BYTES,
  type ServerEvent,
} from "../src/shared/contracts";
import { serverEventSchema } from "../src/shared/contracts/server-event-schema";
import { nativeModelSelection } from "../src/shared/model-routing";

describe("agent turn contract", () => {
  it("defines the complete persisted lifecycle and terminal states", () => {
    expect(AGENT_TURN_STATUSES).toEqual([
      "queued",
      "starting",
      "running",
      "waiting-for-approval",
      "waiting-for-input",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ]);
    for (const status of AGENT_TURN_STATUSES) {
      expect(agentTurnStatusSchema.parse(status)).toBe(status);
      expect(isAgentTurnTerminalStatus(status)).toBe(
        ["completed", "failed", "cancelled", "interrupted"].includes(status),
      );
    }
    expect(agentTurnAssociationSchema.parse("authoritative")).toBe("authoritative");
    expect(agentTurnAssociationSchema.parse("inferred")).toBe("inferred");
    expect(agentTurnAssociationSchema.safeParse("guessed").success).toBe(false);
  });

  it("allows forward and idempotent lifecycle writes but never replaces a terminal outcome", () => {
    expect(canTransitionAgentTurnStatus("queued", "starting")).toBe(true);
    expect(canTransitionAgentTurnStatus("queued", "running")).toBe(true);
    expect(canTransitionAgentTurnStatus("running", "waiting-for-approval")).toBe(true);
    expect(canTransitionAgentTurnStatus("waiting-for-approval", "waiting-for-input")).toBe(true);
    expect(canTransitionAgentTurnStatus("waiting-for-input", "running")).toBe(true);
    expect(canTransitionAgentTurnStatus("running", "completed")).toBe(true);
    expect(canTransitionAgentTurnStatus("completed", "completed")).toBe(true);
    expect(canTransitionAgentTurnStatus("completed", "running")).toBe(false);
    expect(canTransitionAgentTurnStatus("failed", "cancelled")).toBe(false);
  });
});

describe("conversation context contract boundary", () => {
  it("accepts coherent packet provenance and rejects a mismatched payload", () => {
    const content = "Carry the reviewed retry decision.";
    const packet = {
      id: crypto.randomUUID(),
      sourceConversationId: crypto.randomUUID(),
      targetConversationId: crypto.randomUUID(),
      sourceProjectId: crypto.randomUUID(),
      targetProjectId: crypto.randomUUID(),
      sourceConversationTitle: "Architecture decisions",
      sourceProjectName: "Inertia",
      sourceWorkspaceLabel: "Project checkout · main",
      targetWorkspaceLabel: "Project checkout · main",
      workspaceRelation: "same-workspace",
      note: null,
      messageCount: 1,
      characterCount: content.length,
      createdAt: "2026-08-19T09:00:00.000Z",
      consumedMessageId: null,
      consumedAt: null,
      sourceState: "available",
      excerpts: [{
        sourceMessageId: crypto.randomUUID(),
        sourceTurnId: null,
        role: "user",
        content,
        truncated: false,
        createdAt: "2026-08-19T08:59:00.000Z",
      }],
    };
    const event = {
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: { kind: "conversation.context.packet", packet },
    };

    expect(serverEventSchema.safeParse(event).success).toBe(true);
    expect(serverEventSchema.safeParse({
      ...event,
      result: {
        ...event.result,
        packet: { ...packet, characterCount: content.length + 1 },
      },
    }).success).toBe(false);
  });

  it("accepts only question-free host context chooser requests", () => {
    const requestId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    const contextRequest = {
      type: "agent.input.requested",
      request: {
        id: requestId,
        providerId: "codex",
        conversationId,
        runId: "run-context",
        turnId,
        questions: [],
        autoResolutionMs: 300_000,
        conversationContextRequest: {
          requestId,
          targetConversationId: conversationId,
          targetTurnId: turnId,
          requestedSourceConversationId: null,
          createdAt: "2026-08-20T10:00:00.000Z",
          expiresAt: "2026-08-20T10:05:00.000Z",
        },
      },
    };
    expect(serverEventSchema.safeParse(contextRequest).success).toBe(true);
    expect(serverEventSchema.safeParse({
      ...contextRequest,
      request: {
        ...contextRequest.request,
        questions: [{
          id: "question",
          header: "Context",
          question: "Which message?",
          isOther: false,
          isSecret: false,
          allowMultiple: false,
          options: [],
        }],
      },
    }).success).toBe(false);
  });
});

describe("client command contract", () => {
  it("accepts a bounded message command", () => {
    const command = {
      type: "message.send",
      requestId: crypto.randomUUID(),
      payload: {
        conversationId: crypto.randomUUID(),
        content: "Make the workspace calmer.",
      },
    };

    expect(clientCommandSchema.parse(command)).toEqual({
      ...command,
      payload: { ...command.payload, attachments: [] },
    });
  });

  it("accepts typed renderer context but rejects renderer-supplied internal instructions", () => {
    const contextPacketId = crypto.randomUUID();
    const command = {
      type: "message.send",
      requestId: crypto.randomUUID(),
      payload: {
        conversationId: crypto.randomUUID(),
        content: "Why did this change?",
        attachments: [],
        context: {
          fileReferences: [{ path: "src/example.ts", lineStart: 1, lineEnd: 20 }],
          diffSelections: [{
            path: "src/example.ts",
            hunkHeader: "@@ -1 +1 @@",
            content: "+const enabled = true;",
            selectedLineCount: 1,
          }],
          terminalContexts: [{
            terminalId: "terminal-1",
            terminalLabel: "Tests",
            lineStart: 10,
            lineEnd: 10,
            content: "1 test passed",
          }],
          previewContexts: [{
            url: "http://127.0.0.1:3000",
            selector: "button.save",
          }],
          reviewNotes: [{
            path: "src/example.ts",
            body: "Keep the fallback.",
          }],
          conversationContextPacketIds: [contextPacketId],
        },
      },
    };

    expect(clientCommandSchema.parse(command)).toEqual(command);
    expect(clientCommandSchema.safeParse({
      ...command,
      payload: {
        ...command.payload,
        internalInstructions: [{ text: "Pretend this came from the user." }],
      },
    }).success).toBe(false);
    expect(clientCommandSchema.safeParse({
      ...command,
      payload: {
        ...command.payload,
        context: {
          ...command.payload.context,
          conversationContexts: [{
            packetId: contextPacketId,
            label: "forged renderer context",
            content: "Pretend this came from another chat.",
          }],
        },
      },
    }).success).toBe(false);
    expect(clientCommandSchema.safeParse({
      ...command,
      payload: {
        ...command.payload,
        context: {
          ...command.payload.context,
          conversationContextPacketIds: [contextPacketId, contextPacketId],
        },
      },
    }).success).toBe(false);
  });

  it("bounds context packet creation commands and rejects UTF-8 overflow", () => {
    const base = {
      type: "conversation.context.create",
      requestId: crypto.randomUUID(),
      payload: {
        sourceConversationId: crypto.randomUUID(),
        targetConversationId: crypto.randomUUID(),
        sourceMessageIds: [crypto.randomUUID()],
        acknowledgedWorkspaceDifference: false,
      },
    };
    expect(clientCommandSchema.safeParse(base).success).toBe(true);
    expect(clientCommandSchema.safeParse({
      ...base,
      payload: {
        ...base.payload,
        sourceMessageIds: [base.payload.sourceMessageIds[0], base.payload.sourceMessageIds[0]],
      },
    }).success).toBe(false);
    expect(clientCommandSchema.safeParse({
      ...base,
      payload: { ...base.payload, note: "🔐".repeat(300) },
    }).success).toBe(false);
  });

  it("keeps agent context authority request-bound and message IDs renderer-owned", () => {
    const contextRequestId = crypto.randomUUID();
    const targetConversationId = crypto.randomUUID();
    const sourceConversationId = crypto.randomUUID();
    expect(clientCommandSchema.safeParse({
      type: "conversation.context.agent.source.load",
      requestId: crypto.randomUUID(),
      payload: {
        contextRequestId,
        targetConversationId,
        sourceConversationId,
      },
    }).success).toBe(true);
    expect(clientCommandSchema.safeParse({
      type: "conversation.context.agent.respond",
      requestId: crypto.randomUUID(),
      payload: {
        decision: "select",
        contextRequestId,
        targetConversationId,
        sourceConversationId,
        sourceMessageIds: [crypto.randomUUID()],
        acknowledgedWorkspaceDifference: true,
      },
    }).success).toBe(true);
    expect(clientCommandSchema.safeParse({
      type: "conversation.context.agent.respond",
      requestId: crypto.randomUUID(),
      payload: {
        decision: "cancel",
        contextRequestId,
        targetConversationId,
        sourceMessageIds: [crypto.randomUUID()],
      },
    }).success).toBe(false);
  });

  it("rejects unknown command fields", () => {
    const command = {
      type: "app.refresh",
      requestId: crypto.randomUUID(),
      unexpected: true,
    };

    expect(clientCommandSchema.safeParse(command).success).toBe(false);
  });

  it("accepts only bounded usage dashboard ranges", () => {
    const base = {
      type: "usage.dashboard.get",
      requestId: crypto.randomUUID(),
      payload: {
        days: 30,
        fromInclusive: "2026-06-01T00:00:00.000Z",
        toExclusive: "2026-07-01T00:00:00.000Z",
        endDate: "2026-06-30",
        timeZone: "Europe/Madrid",
      },
    };
    for (const days of [7, 30, 90]) {
      expect(clientCommandSchema.safeParse({
        ...base,
        payload: { ...base.payload, days },
      }).success).toBe(true);
    }
    for (const command of [
      { ...base, payload: { ...base.payload, days: 14 } },
      { ...base, payload: { ...base.payload, endDate: "June 30" } },
      { ...base, payload: { ...base.payload, fromInclusive: "yesterday" } },
      { ...base, payload: { ...base.payload, credential: "secret" } },
    ]) {
      expect(clientCommandSchema.safeParse(command).success).toBe(false);
    }
  });

  it("rejects unreasonable terminal dimensions", () => {
    const command = {
      type: "terminal.resize",
      requestId: crypto.randomUUID(),
      payload: {
        terminalId: crypto.randomUUID(),
        cols: 10_000,
        rows: 10_000,
      },
    };

    expect(clientCommandSchema.safeParse(command).success).toBe(false);
  });

  it("accepts only owning identifiers and dimensions for provider terminal resume", () => {
    const command = {
      type: "terminal.provider.resume",
      requestId: crypto.randomUUID(),
      payload: {
        projectId: crypto.randomUUID(),
        conversationId: crypto.randomUUID(),
        terminalId: crypto.randomUUID(),
        cols: 80,
        rows: 24,
      },
    };
    expect(clientCommandSchema.safeParse(command).success).toBe(true);
    for (const injected of [
      { providerId: "codex" },
      { sessionId: "renderer-chosen-session" },
      { executable: "/tmp/codex" },
      { prompt: "renderer-chosen prompt" },
      { env: { OPENAI_API_KEY: "secret" } },
    ]) {
      expect(clientCommandSchema.safeParse({
        ...command,
        payload: { ...command.payload, ...injected },
      }).success).toBe(false);
    }
  });

  it("accepts conflict-checked workspace writes and rejects unbounded payloads", () => {
    const base = {
      type: "workspace.file.write",
      requestId: crypto.randomUUID(),
      payload: {
        projectId: crypto.randomUUID(),
        path: "src/example.ts",
        authorityRef: crypto.randomUUID(),
        expectedDigest: "a".repeat(64),
        content: "export const enabled = true;\n",
      },
    };
    expect(clientCommandSchema.safeParse(base).success).toBe(true);
    expect(clientCommandSchema.safeParse({
      ...base,
      payload: { ...base.payload, expectedDigest: "../stale" },
    }).success).toBe(false);
    expect(clientCommandSchema.safeParse({
      ...base,
      payload: {
        ...base.payload,
        content: "x".repeat(MAX_WORKSPACE_FILE_EDIT_BYTES + 1),
      },
    }).success).toBe(false);
    expect(clientCommandSchema.safeParse({
      ...base,
      payload: {
        ...base.payload,
        content: "🙂".repeat(MAX_WORKSPACE_FILE_EDIT_BYTES / 2),
      },
    }).success).toBe(false);
  });

  it("accepts only scoped UUID targets for workspace-run mutations", () => {
    const runId = crypto.randomUUID();
    for (const type of [
      "activity.stop",
      "activity.dismiss",
      "activity.mark-seen",
      "activity.acknowledge",
    ] as const) {
      expect(clientCommandSchema.safeParse({
        type,
        requestId: crypto.randomUUID(),
        payload: { runId },
      }).success).toBe(true);
      expect(clientCommandSchema.safeParse({
        type,
        requestId: crypto.randomUUID(),
        payload: { runId: "../process", terminalId: crypto.randomUUID() },
      }).success).toBe(false);
    }
  });

  it("accepts only a scoped thread UUID for selection-question cancellation", () => {
    const base = {
      type: "review.selection.cancel",
      requestId: crypto.randomUUID(),
      payload: { conversationId: crypto.randomUUID() },
    } as const;
    expect(clientCommandSchema.safeParse(base).success).toBe(true);
    expect(clientCommandSchema.safeParse({
      ...base,
      payload: { conversationId: "../thread" },
    }).success).toBe(false);
    expect(clientCommandSchema.safeParse({
      ...base,
      payload: { ...base.payload, runId: crypto.randomUUID() },
    }).success).toBe(false);
  });

  it("accepts scoped turn-artifact reads and rejects unbounded or cross-shaped payloads", () => {
    const projectId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    expect(clientCommandSchema.safeParse({
      type: "git.turn.diff",
      requestId,
      payload: { projectId, conversationId, turnId: "turn-1", path: "src/app.ts" },
    }).success).toBe(true);
    expect(clientCommandSchema.safeParse({
      type: "git.turn.compare",
      requestId,
      payload: {
        projectId,
        conversationId,
        earlierTurnId: "turn-1",
        laterTurnId: "turn-2",
      },
    }).success).toBe(true);
    expect(clientCommandSchema.safeParse({
      type: "git.turn.diff",
      requestId,
      payload: {
        projectId,
        conversationId,
        turnId: "turn-1",
        path: "x".repeat(5_000),
        rawRef: "refs/heads/main",
      },
    }).success).toBe(false);
  });

  it("accepts one bounded workspace directory or search and rejects path escapes", () => {
    const projectId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    expect(clientCommandSchema.safeParse({
      type: "workspace.entries",
      requestId,
      payload: { projectId, directory: "src/components" },
    }).success).toBe(true);
    expect(clientCommandSchema.safeParse({
      type: "workspace.entries",
      requestId,
      payload: { projectId, query: "Button" },
    }).success).toBe(true);
    expect(clientCommandSchema.safeParse({
      type: "workspace.entries",
      requestId,
      payload: { projectId, directory: "src", query: "Button" },
    }).success).toBe(false);
    for (const path of [
      "notes\\draft.md",
      "a:file.txt",
      "\\leading-backslash",
      "safe\\..\\literal-name",
    ]) {
      expect(clientCommandSchema.safeParse({
        type: "workspace.file.read",
        requestId,
        payload: { projectId, path },
      }).success).toBe(true);
    }
    expect(clientCommandSchema.safeParse({
      type: "workspace.file.read",
      requestId,
      payload: {
        projectId,
        path: "src/App.java:42",
        fallbackPath: "src/App.java",
      },
    }).success).toBe(true);

    for (const directory of [
      "../outside",
      "src/../../outside",
      "/etc",
    ]) {
      expect(clientCommandSchema.safeParse({
        type: "workspace.entries",
        requestId,
        payload: { projectId, directory },
      }).success).toBe(false);
    }
    expect(clientCommandSchema.safeParse({
      type: "workspace.file.read",
      requestId,
      payload: { projectId, path: "../secret.txt" },
    }).success).toBe(false);
  });

  it("accepts UUID-scoped conversation detail loads and pane subscriptions", () => {
    const command = {
      type: "conversation.detail.load",
      requestId: crypto.randomUUID(),
      payload: { conversationId: crypto.randomUUID() },
    };
    expect(clientCommandSchema.parse(command)).toEqual(command);
    expect(clientCommandSchema.safeParse({
      ...command,
      payload: { conversationId: "all", includeAll: true },
    }).success).toBe(false);

    const subscription = {
      type: "conversation.detail.subscription",
      requestId: crypto.randomUUID(),
      payload: {
        owner: "secondary",
        conversationId: crypto.randomUUID(),
      },
    };
    expect(clientCommandSchema.parse(subscription)).toEqual(subscription);
    expect(clientCommandSchema.parse({
      ...subscription,
      payload: { owner: "secondary", conversationId: null },
    })).toMatchObject({
      type: "conversation.detail.subscription",
      payload: { owner: "secondary", conversationId: null },
    });
    expect(clientCommandSchema.safeParse({
      ...subscription,
      payload: { owner: "background", conversationId: crypto.randomUUID() },
    }).success).toBe(false);
  });

  it("accepts bounded provider refresh commands", () => {
    const refreshAll = {
      type: "provider.refresh",
      requestId: crypto.randomUUID(),
      payload: {},
    };
    const refreshOne = {
      type: "provider.refresh",
      requestId: crypto.randomUUID(),
      payload: { providerId: "codex" },
    };

    expect(clientCommandSchema.parse(refreshAll)).toEqual(refreshAll);
    expect(clientCommandSchema.parse(refreshOne)).toEqual(refreshOne);
  });

  it("accepts only bounded provider maintenance commands", () => {
    const requestId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const valid = [
      {
        type: "provider.maintenance.refresh",
        requestId,
        payload: {},
      },
      {
        type: "provider.maintenance.refresh",
        requestId,
        payload: { providerId: "claude", force: true },
      },
      {
        type: "provider.maintenance.update",
        requestId,
        payload: { providerId: "codex" },
      },
      {
        type: "provider.maintenance.cancel",
        requestId,
        payload: { operationId },
      },
    ];
    for (const command of valid) {
      expect(clientCommandSchema.safeParse(command).success).toBe(true);
    }
    for (const command of [
      {
        type: "provider.maintenance.update",
        requestId,
        payload: { providerId: "unknown" },
      },
      {
        type: "provider.maintenance.cancel",
        requestId,
        payload: { operationId: "../process" },
      },
      {
        type: "provider.maintenance.refresh",
        requestId,
        payload: { force: true, executable: "/tmp/codex" },
      },
    ]) {
      expect(clientCommandSchema.safeParse(command).success).toBe(false);
    }
  });

  it("accepts only supported interface scales", () => {
    const requestId = crypto.randomUUID();
    for (const interfaceScale of ["compact", "default", "comfortable", "large"] as const) {
      expect(clientCommandSchema.safeParse({
        type: "settings.update",
        requestId,
        payload: { interfaceScale },
      }).success).toBe(true);
    }
    expect(clientCommandSchema.safeParse({
      type: "settings.update",
      requestId,
      payload: { interfaceScale: "125%" },
    }).success).toBe(false);
  });

  it("accepts only supported usage display modes", () => {
    const requestId = crypto.randomUUID();
    for (const usageDisplayMode of ["expanded", "compact", "hidden"] as const) {
      expect(clientCommandSchema.safeParse({
        type: "settings.update",
        requestId,
        payload: { usageDisplayMode },
      }).success).toBe(true);
    }
    expect(clientCommandSchema.safeParse({
      type: "settings.update",
      requestId,
      payload: { usageDisplayMode: "popover" },
    }).success).toBe(false);
  });

  it("accepts only supported workspace startup surfaces", () => {
    const requestId = crypto.randomUUID();
    for (const workspaceStartupSurface of ["summary", "tools"] as const) {
      expect(clientCommandSchema.safeParse({
        type: "settings.update",
        requestId,
        payload: { workspaceStartupSurface },
      }).success).toBe(true);
    }
    expect(clientCommandSchema.safeParse({
      type: "settings.update",
      requestId,
      payload: { workspaceStartupSurface: "terminal" },
    }).success).toBe(false);
  });

  it("accepts only boolean final-answer auto-scroll settings", () => {
    const requestId = crypto.randomUUID();
    for (const autoScrollToFinalAnswer of [true, false]) {
      expect(clientCommandSchema.safeParse({
        type: "settings.update",
        requestId,
        payload: { autoScrollToFinalAnswer },
      }).success).toBe(true);
    }
    expect(clientCommandSchema.safeParse({
      type: "settings.update",
      requestId,
      payload: { autoScrollToFinalAnswer: "yes" },
    }).success).toBe(false);
  });

  it("accepts only complete, unique app keybindings", () => {
    const requestId = crypto.randomUUID();
    expect(clientCommandSchema.safeParse({
      type: "settings.update",
      requestId,
      payload: { keybindings: {
        search: "u",
        "new-chat": "y",
        "toggle-sidebar": "g",
        "toggle-terminal": "h",
      } },
    }).success).toBe(true);
    for (const keybindings of [
      { search: "k" },
      { search: "k", "new-chat": "k", "toggle-sidebar": "b", "toggle-terminal": "j" },
      { search: "x", "new-chat": "n", "toggle-sidebar": "b", "toggle-terminal": "j" },
    ]) {
      expect(clientCommandSchema.safeParse({
        type: "settings.update",
        requestId,
        payload: { keybindings },
      }).success).toBe(false);
    }
  });

  it("accepts provider authentication terminals at their dimension boundaries", () => {
    for (const [cols, rows] of [[40, 10], [240, 80]] as const) {
      const command = {
        type: "provider.auth.start",
        requestId: crypto.randomUUID(),
        payload: { providerId: "claude", cols, rows },
      };

      expect(clientCommandSchema.parse(command)).toEqual(command);
    }
  });

  it("rejects malformed provider refresh and authentication commands", () => {
    const requestId = crypto.randomUUID();
    const invalid = [
      { type: "provider.refresh", requestId },
      { type: "provider.refresh", requestId, payload: { providerId: "unknown" } },
      { type: "provider.refresh", requestId, payload: { providerId: "codex", unexpected: true } },
      { type: "provider.auth.start", requestId, payload: { providerId: "unknown", cols: 80, rows: 24 } },
      { type: "provider.auth.start", requestId, payload: { providerId: "codex", cols: 39, rows: 24 } },
      { type: "provider.auth.start", requestId, payload: { providerId: "codex", cols: 80, rows: 81 } },
      { type: "provider.auth.start", requestId, payload: { providerId: "codex", cols: 80, rows: 24, token: "never" } },
    ];

    for (const command of invalid) expect(clientCommandSchema.safeParse(command).success).toBe(false);
  });
});

describe("isolated review result contract", () => {
  it("returns only bounded visible review content and exact execution attribution", () => {
    const event: Extract<ServerEvent, { type: "request.result" }> = {
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: {
        kind: "review.selection.answer",
        answer: {
          conversationId: crypto.randomUUID(),
          fingerprint: "a".repeat(64),
          filePath: "src/example.ts",
          hunkId: "hunk-1",
          selectedLineCount: 3,
          question: "Why?",
          answer: "Because the selected behavior changed.",
          providerId: "codex",
          modelSelection: nativeModelSelection({
            providerId: "codex",
            modelId: "gpt-5.4",
            reasoningEffort: "high",
          }),
          generatedAt: "2026-07-25T12:00:00.000Z",
        },
      },
    };

    expect(event.result).toMatchObject({
      kind: "review.selection.answer",
      answer: {
        providerId: "codex",
        modelSelection: {
          harnessId: "codex-app-server",
          backendProfileId: "builtin:openai",
          modelId: "gpt-5.4",
        },
      },
    });
    expect(event.result).not.toHaveProperty("answer.executionPrompt");
    expect(event.result).not.toHaveProperty("answer.providerSessionId");
  });
});
