import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  defaultSettings,
  type AppSnapshot,
  type ChatMessage,
  type ConversationShell,
  type ServerEvent,
} from "../../src/shared/contracts";
import type { SecretRequestReference } from "../../src/shared/agent-secrets";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { useConversationProjection } from "../../src/renderer/src/hooks/useConversationProjection";
import { storedMessageSupersedesLive } from "../../src/renderer/src/utils/terminalTurnProjection";
import {
  workspaceSceneCallbacks,
  type WorkspaceSceneActions,
} from "../../src/renderer/src/components/workspace-scene/createWorkspaceSceneModel";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";

function secretRef(update: Partial<SecretRequestReference> = {}): SecretRequestReference {
  return {
    requestId: REQUEST_ID,
    title: "Tailscale auth key",
    description: "Create a reusable auth key.",
    ttlHours: 24,
    status: "pending",
    answeredAt: null,
    expiresAt: null,
    storage: null,
    ...update,
  };
}

function secretMessage(secretRequest: SecretRequestReference): ChatMessage {
  return {
    id: "msg-secret-1",
    conversationId: CONVERSATION_ID,
    turnId: "turn-1",
    role: "system",
    content: `Asked for a secret: ${secretRequest.title}`,
    attachments: [],
    createdAt: "2026-10-29T12:00:00.000Z",
    secretRequest,
  };
}

function shell(status: ConversationShell["status"]): ConversationShell {
  return {
    id: CONVERSATION_ID,
    projectId: "project-1",
    title: "Secrets chat",
    providerId: "codex",
    model: "default",
    modelSelection: providerNativeModelSelection({
      providerId: "codex",
      modelId: "default",
      reasoningEffort: "medium",
    }),
    continuationIdentity: null,
    reasoningEffort: "medium",
    interactionMode: "build",
    accessMode: "supervised",
    branch: null,
    worktreePath: null,
    status,
    attentionKind: status === "needs-input" ? "input" : null,
    settledAt: null,
    archivedAt: null,
    createdAt: "2026-10-29T11:59:00.000Z",
    updatedAt: status === "needs-input" ? "2026-10-29T12:00:00.000Z" : "2026-10-29T12:00:05.000Z",
    completedAt: null,
    lastViewedAt: null,
    providerSessionId: null,
    latestTurn: null,
    pendingApproval: false,
    pendingInput: status === "needs-input",
  };
}

function makeSnapshot(status: ConversationShell["status"]): AppSnapshot {
  return {
    projects: [],
    conversations: [shell(status)],
    providers: [],
    backendProfiles: [],
    backendDefaults: [],
    runs: [],
    activeProjectId: "project-1",
    activeConversationId: CONVERSATION_ID,
    settings: { ...defaultSettings },
  };
}

function detailResponse(messages: ChatMessage[]): ServerEvent {
  return {
    type: "request.result",
    requestId: crypto.randomUUID(),
    result: {
      kind: "conversation.detail",
      conversationId: CONVERSATION_ID,
      state: "ready",
      detail: {
        conversation: shell("needs-input"),
        agentTurns: [],
        turnGitArtifacts: [],
        messages,
        activities: [],
        subagents: [],
        reasonings: [],
        usage: [],
        plans: [],
        goals: [],
        checkpoints: [],
        reviewSummaries: [],
        reviewStates: [],
        reviewNotes: [],
      },
    },
  } as unknown as ServerEvent;
}

function createEventSource() {
  const listeners = new Set<(event: ServerEvent) => void>();
  return {
    subscribe: vi.fn((listener: (event: ServerEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit(event: ServerEvent) {
      act(() => {
        for (const listener of listeners) listener(event);
      });
    },
  };
}

describe("storedMessageSupersedesLive", () => {
  const pending = secretMessage(secretRef());
  const saved = secretMessage(secretRef({
    status: "saved",
    answeredAt: "2026-10-29T12:00:10.000Z",
    expiresAt: "2026-10-30T12:00:10.000Z",
    storage: "keychain",
  }));
  const declined = secretMessage(secretRef({
    status: "declined",
    answeredAt: "2026-10-29T12:00:10.000Z",
  }));
  const revoked = secretMessage(secretRef({
    status: "revoked",
    answeredAt: "2026-10-29T12:00:10.000Z",
    expiresAt: "2026-10-30T12:00:10.000Z",
    storage: "keychain",
  }));
  const expired = secretMessage(secretRef({
    status: "expired",
    answeredAt: "2026-10-29T12:00:10.000Z",
    expiresAt: "2026-10-30T12:00:10.000Z",
    storage: "keychain",
  }));

  it("never lets a lower-ranked stored secret request supersede a newer live status", () => {
    expect(storedMessageSupersedesLive(pending, saved)).toBe(false);
    expect(storedMessageSupersedesLive(pending, declined)).toBe(false);
    expect(storedMessageSupersedesLive(pending, revoked)).toBe(false);
    expect(storedMessageSupersedesLive(pending, expired)).toBe(false);
    expect(storedMessageSupersedesLive(saved, revoked)).toBe(false);
    expect(storedMessageSupersedesLive(saved, expired)).toBe(false);
  });

  it("lets an equal or higher-ranked stored secret request supersede live", () => {
    expect(storedMessageSupersedesLive(pending, secretMessage(secretRef()))).toBe(true);
    expect(storedMessageSupersedesLive(saved, pending)).toBe(true);
    expect(storedMessageSupersedesLive(revoked, pending)).toBe(true);
    expect(storedMessageSupersedesLive(revoked, saved)).toBe(true);
    expect(storedMessageSupersedesLive(saved, secretMessage(saved.secretRequest!))).toBe(true);
  });

  it("returns false when stored lacks secretRequest or content differs", () => {
    expect(storedMessageSupersedesLive({ ...pending, secretRequest: undefined }, pending)).toBe(false);
    expect(storedMessageSupersedesLive({ ...saved, content: "Different" }, saved)).toBe(false);
  });
});

describe("useConversationProjection secret request monotonic updates", () => {
  it("does not revert a live saved or terminal secret card when conversation.shell.updated fires", async () => {
    const source = createEventSource();
    const pending = secretMessage(secretRef());
    const saved = secretMessage(secretRef({
      status: "saved",
      answeredAt: "2026-10-29T12:00:10.000Z",
      expiresAt: "2026-10-30T12:00:10.000Z",
      storage: "keychain",
    }));
    const revoked = secretMessage(secretRef({
      status: "revoked",
      answeredAt: "2026-10-29T12:00:10.000Z",
      expiresAt: "2026-10-30T12:00:10.000Z",
      storage: "keychain",
    }));
    let storedMessages: ChatMessage[] = [pending];
    const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => (
      command.type === "conversation.detail.load"
        ? detailResponse(storedMessages)
        : { type: "request.ok", requestId: crypto.randomUUID() }
    ));

    const hook = renderHook(
      ({ snapshot }: { snapshot: AppSnapshot }) => useConversationProjection({
        snapshot,
        status: "online",
        request,
        subscribe: source.subscribe,
        enabled: true,
        autoOpenPlan: false,
        onOpenPlan: vi.fn(),
        onTerminal: vi.fn(),
      }),
      { initialProps: { snapshot: makeSnapshot("needs-input") } },
    );

    await waitFor(() => expect(hook.result.current.messages).toEqual([pending]));

    // Live save arrives before detail reloads, followed by shell update (needs-input -> running).
    source.emit({ type: "conversation.message.persisted", message: saved });
    expect(hook.result.current.messages[0]?.secretRequest?.status).toBe("saved");

    hook.rerender({ snapshot: makeSnapshot("running") });
    expect(hook.result.current.messages[0]?.secretRequest?.status).toBe("saved");
    expect(hook.result.current.liveMessages).toEqual([saved]);

    // Live revoke arrives while stored detail is still pending (or even after stored catches up to saved).
    storedMessages = [saved];
    source.emit({ type: "conversation.detail.invalidated", conversationId: CONVERSATION_ID });
    await waitFor(() => expect(hook.result.current.liveMessages).toEqual([]));
    expect(hook.result.current.messages[0]?.secretRequest?.status).toBe("saved");

    source.emit({ type: "conversation.message.persisted", message: revoked });
    hook.rerender({ snapshot: makeSnapshot("completed") });
    expect(hook.result.current.messages[0]?.secretRequest?.status).toBe("revoked");
    expect(hook.result.current.liveMessages).toEqual([revoked]);

    // Once authoritative detail catches up to revoked, live override is evicted cleanly.
    storedMessages = [revoked];
    source.emit({ type: "conversation.detail.invalidated", conversationId: CONVERSATION_ID });
    await waitFor(() => expect(hook.result.current.liveMessages).toEqual([]));
    expect(hook.result.current.messages[0]?.secretRequest?.status).toBe("revoked");
  });
});

describe("workspaceSceneCallbacks secret request runner", () => {
  it("caches a stable passive non-reporting runner for secret-request commands", async () => {
    const run = vi.fn(async (): Promise<ServerEvent> => ({ type: "request.ok", requestId: "ok" }));
    const actions = { run, stopSubagent: vi.fn(), openSettings: vi.fn() } as unknown as WorkspaceSceneActions;
    const setActionError = vi.fn();

    const first = workspaceSceneCallbacks(actions, setActionError);
    const second = workspaceSceneCallbacks(actions, setActionError);
    expect(first.runSecretRequestCommand).toBe(second.runSecretRequestCommand);

    const command = {
      type: "secret-request.decline",
      payload: { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
    } as const;
    await first.runSecretRequestCommand("secret-request.decline", command);
    expect(run).toHaveBeenCalledWith("secret-request.decline", command, {
      reportError: false,
      passive: true,
    });
  });
});
