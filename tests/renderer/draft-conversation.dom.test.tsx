import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  defaultSettings,
  type AppSnapshot,
  type Project,
  type ServerEvent,
} from "../../src/shared/contracts";
import { useDraftConversation } from "../../src/renderer/src/hooks/useDraftConversation";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import {
  buildDraftConversation,
  buildNewConversationPayload,
} from "../../src/renderer/src/lib/newConversation";
import { RuntimeCommandError } from "../../src/renderer/src/utils/connectionMessages";
import type {
  TranscriptMessageSendAcceptance,
} from "../../src/renderer/src/utils/transcriptNavigation";
import {
  readPersistedMaterializedDraftConversation,
} from "../../src/renderer/src/utils/draftConversationPersistence";

const projectId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const now = "2026-07-29T10:00:00.000Z";
const project: Project = {
  id: projectId,
  name: "Inertia",
  path: "/workspace/inertia",
  normalizedPath: "/workspace/inertia",
  repositoryIdentity: null,
  repositoryRoot: null,
  repositoryRelativePath: "",
  groupingMode: null,
  gitRepositoryLimit: 64,
  color: "#6366f1",
  status: "ready",
  createdAt: now,
  updatedAt: now,
};
const snapshot: AppSnapshot = {
  projects: [project],
  conversations: [],
  providers: [],
  backendProfiles: [],
  backendDefaults: [],
  runs: [],
  activeProjectId: projectId,
  activeConversationId: null,
  settings: defaultSettings,
};

function materializedSnapshot(
  status: "idle" | "running" | "completed" = "idle",
  title = "New chat",
  latestTurnId: string | null = null,
): AppSnapshot {
  const conversation = buildDraftConversation(
    buildNewConversationPayload(projectId, defaultSettings),
    { id: conversationId, now },
  );
  const selection = conversation.modelSelection;
  return {
    ...snapshot,
    activeConversationId: status === "idle" ? null : conversationId,
    conversations: [{
      ...conversation,
      title,
      status,
      latestTurn: latestTurnId
        ? {
            id: latestTurnId,
            runId: `${latestTurnId}-run`,
            status: "running",
            providerId: conversation.providerId,
            harnessId: selection.harnessId,
            backendProfileId: selection.backendProfileId,
            modelSelection: selection,
            continuationIdentity: {
              harnessId: selection.harnessId,
              backendProfileId: selection.backendProfileId,
              backendConfigurationRevision:
                selection.backendConfigurationRevision,
              modelIdentity: selection.modelId,
              endpointIdentity: null,
            },
            model: selection.modelId,
            reasoningEffort: selection.reasoningEffort ?? "medium",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            terminalReason: null,
            updatedAt: now,
          }
        : null,
      pendingApproval: false,
      pendingInput: false,
    }],
  };
}

describe("useDraftConversation", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: vi.fn(),
        getItem: vi.fn(() => null),
        key: vi.fn(() => null),
        length: 0,
        removeItem: vi.fn(),
        setItem: vi.fn(),
      } satisfies Storage,
    });
  });

  it("starts from the project backend default before the global default", () => {
    const globalSelection = providerNativeModelSelection({
      providerId: "codex",
      modelId: "global-model",
    });
    const projectSelection = providerNativeModelSelection({
      providerId: "claude",
      modelId: "project-model",
    });
    const hook = renderHook(() => useDraftConversation({
      snapshot: {
        ...snapshot,
        backendDefaults: [
          { scope: "global", projectId: null, selection: globalSelection, updatedAt: now },
          { scope: "project", projectId, selection: projectSelection, updatedAt: now },
        ],
      },
      settings: defaultSettings,
      run: vi.fn(),
      sendMessage: vi.fn(),
      persistedConversationId: null,
      updatePersistedConversation: vi.fn(),
    }));

    act(() => hook.result.current.start(projectId));

    expect(hook.result.current.conversation?.modelSelection)
      .toEqual(projectSelection);
  });

  it("keeps a new-project chat local until its first message is sent", async () => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: vi.fn(() => values.clear()),
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        key: vi.fn((index: number) => [...values.keys()][index] ?? null),
        get length() {
          return values.size;
        },
        removeItem: vi.fn((key: string) => values.delete(key)),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      } satisfies Storage,
    });
    const run = vi.fn(async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type !== "conversation.create") {
        throw new Error(`Unexpected command ${command.type}`);
      }
      return {
        type: "request.result",
        requestId: crypto.randomUUID(),
        result: { kind: "conversation.created", conversationId },
      };
    });
    const sendMessage = vi.fn(async () => ({
      kind: "message.accepted" as const,
      conversationId,
      turnId: "turn-1",
      userMessageId: "message-1",
      disposition: "new-turn" as const,
    }));
    let currentSnapshot: AppSnapshot | null = null;
    let persistedId: string | null = null;
    const hook = renderHook(() => useDraftConversation({
      snapshot: currentSnapshot,
      settings: defaultSettings,
      run,
      sendMessage,
      persistedConversationId: persistedId,
      updatePersistedConversation: vi.fn(),
    }));

    act(() => hook.result.current.start(projectId));
    expect(hook.result.current.conversation).toMatchObject({
      projectId,
      status: "idle",
      providerSessionId: null,
    });
    expect(hook.result.current.requiresWorkspaceMaterialization).toBe(false);
    expect(run).not.toHaveBeenCalled();

    const draftId = hook.result.current.conversation?.id;
    let acceptance: TranscriptMessageSendAcceptance | null | undefined;
    await act(async () => {
      acceptance = await hook.result.current.sendFromComposer(
        "Start with the current implementation.",
        [],
      );
    });
    expect(run).toHaveBeenCalledWith(
      "conversation.create:draft",
      expect.objectContaining({
        type: "conversation.create",
        payload: expect.objectContaining({
          projectId,
          activate: false,
        }),
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      conversationId,
      "Start with the current implementation.",
      [],
      undefined,
      true,
    );
    expect(acceptance).toMatchObject({
      conversationId,
      materializedFromConversationId: draftId,
      turnId: "turn-1",
    });
    expect(hook.result.current.conversation?.id).toBe(draftId);
    expect(readPersistedMaterializedDraftConversation()).toMatchObject({
      acceptedTurnId: "turn-1",
      acceptedUserMessageId: "message-1",
      draftConversationId: draftId,
      materializedConversationId: conversationId,
    });

    await expect(hook.result.current.sendFromComposer(
      "Do not send this twice.",
      [],
    )).rejects.toThrow("was accepted");
    expect(sendMessage).toHaveBeenCalledTimes(1);

    currentSnapshot = materializedSnapshot(
      "running",
      "Start with the current implementation.",
      "turn-1",
    );
    hook.rerender();
    expect(hook.result.current.conversation?.id).toBe(draftId);
    expect(readPersistedMaterializedDraftConversation()).not.toBeNull();

    persistedId = conversationId;
    hook.rerender();
    expect(hook.result.current.conversation).toBeNull();
    expect(readPersistedMaterializedDraftConversation()).toBeNull();
  });

  it("rejects a mismatched materialized acceptance and blocks a duplicate", async () => {
    const run = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: { kind: "conversation.created", conversationId },
    }));
    const sendMessage = vi.fn(async () => ({
      kind: "message.accepted" as const,
      conversationId: "33333333-3333-4333-8333-333333333333",
      turnId: "wrong-turn",
      userMessageId: "wrong-message",
      disposition: "new-turn" as const,
    }));
    const hook = renderHook(() => useDraftConversation({
      snapshot: null,
      settings: defaultSettings,
      run,
      sendMessage,
      persistedConversationId: null,
      updatePersistedConversation: vi.fn(),
    }));
    act(() => hook.result.current.start(projectId));
    const draftId = hook.result.current.conversation?.id;

    await act(async () => {
      await expect(hook.result.current.sendFromComposer(
        "Acknowledge only this chat.",
        [],
      )).rejects.toThrow("different chat");
    });

    expect(hook.result.current.conversation?.id).toBe(draftId);
    await expect(hook.result.current.sendFromComposer(
      "Do not retry an uncertain acceptance.",
      [],
    )).rejects.toThrow("reconciling");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft visible when the accepted snapshot precedes the response", async () => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: vi.fn(() => values.clear()),
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        key: vi.fn((index: number) => [...values.keys()][index] ?? null),
        get length() {
          return values.size;
        },
        removeItem: vi.fn((key: string) => values.delete(key)),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      } satisfies Storage,
    });
    const run = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: { kind: "conversation.created", conversationId },
    }));
    let settleAcceptance!: (value: TranscriptMessageSendAcceptance) => void;
    const sendMessage = vi.fn(() => (
      new Promise<TranscriptMessageSendAcceptance>((resolve) => {
        settleAcceptance = resolve;
      })
    ));
    let currentSnapshot: AppSnapshot | null = null;
    let persistedId: string | null = null;
    const hook = renderHook(() => useDraftConversation({
      snapshot: currentSnapshot,
      settings: defaultSettings,
      run,
      sendMessage,
      persistedConversationId: persistedId,
      updatePersistedConversation: vi.fn(),
    }));
    act(() => hook.result.current.start(projectId));
    const draftId = hook.result.current.conversation?.id;
    let sending!: Promise<TranscriptMessageSendAcceptance | null>;
    act(() => {
      sending = hook.result.current.sendFromComposer(
        "Snapshot this request before replying.",
        [],
      );
    });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());

    currentSnapshot = materializedSnapshot(
      "running",
      "Snapshot this request before replying.",
      "turn-snapshot-first",
    );
    persistedId = conversationId;
    hook.rerender();
    expect(hook.result.current.conversation?.id).toBe(draftId);

    let acceptance: TranscriptMessageSendAcceptance | null = null;
    await act(async () => {
      settleAcceptance({
        kind: "message.accepted",
        conversationId,
        turnId: "turn-snapshot-first",
        userMessageId: "message-snapshot-first",
        disposition: "new-turn",
      });
      acceptance = await sending;
    });
    expect(acceptance).toMatchObject({
      materializedFromConversationId: draftId,
      turnId: "turn-snapshot-first",
    });
    expect(hook.result.current.conversation).toBeNull();
    expect(readPersistedMaterializedDraftConversation()).toBeNull();
  });

  it("reconciles an accepted in-memory draft when localStorage is unavailable", async () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: vi.fn(() => {
          throw new Error("storage unavailable");
        }),
        getItem: vi.fn(() => {
          throw new Error("storage unavailable");
        }),
        key: vi.fn(() => null),
        length: 0,
        removeItem: vi.fn(() => {
          throw new Error("storage unavailable");
        }),
        setItem: vi.fn(() => {
          throw new Error("storage unavailable");
        }),
      } satisfies Storage,
    });
    const run = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: { kind: "conversation.created", conversationId },
    }));
    const sendMessage = vi.fn(async () => ({
      kind: "message.accepted" as const,
      conversationId,
      turnId: "turn-memory-only",
      userMessageId: "message-memory-only",
      disposition: "new-turn" as const,
    }));
    let currentSnapshot: AppSnapshot | null = null;
    let persistedId: string | null = null;
    const hook = renderHook(() => useDraftConversation({
      snapshot: currentSnapshot,
      settings: defaultSettings,
      run,
      sendMessage,
      persistedConversationId: persistedId,
      updatePersistedConversation: vi.fn(),
    }));
    act(() => hook.result.current.start(projectId));
    const draftId = hook.result.current.conversation?.id;
    await act(async () => {
      await hook.result.current.sendFromComposer("Keep this in memory.", []);
    });
    expect(hook.result.current.conversation?.id).toBe(draftId);

    currentSnapshot = materializedSnapshot(
      "running",
      "Keep this in memory.",
      "turn-memory-only",
    );
    persistedId = conversationId;
    hook.rerender();
    expect(hook.result.current.conversation).toBeNull();
  });

  it("requires the exact durable accepted turn after remount", async () => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: vi.fn(() => values.clear()),
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        key: vi.fn((index: number) => [...values.keys()][index] ?? null),
        get length() {
          return values.size;
        },
        removeItem: vi.fn((key: string) => values.delete(key)),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      } satisfies Storage,
    });
    const run = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: { kind: "conversation.created", conversationId },
    }));
    const sendMessage = vi.fn(async () => ({
      kind: "message.accepted" as const,
      conversationId,
      turnId: "turn-durable-exact",
      userMessageId: "message-durable-exact",
      disposition: "new-turn" as const,
    }));
    const first = renderHook(() => useDraftConversation({
      snapshot: null,
      settings: defaultSettings,
      run,
      sendMessage,
      persistedConversationId: null,
      updatePersistedConversation: vi.fn(),
    }));
    act(() => first.result.current.start(projectId));
    const draftId = first.result.current.conversation?.id;
    await act(async () => {
      await first.result.current.sendFromComposer("Persist the exact turn.", []);
    });
    expect(readPersistedMaterializedDraftConversation()).toMatchObject({
      acceptedTurnId: "turn-durable-exact",
      draftConversationId: draftId,
    });
    first.unmount();

    let currentSnapshot = materializedSnapshot(
      "running",
      "Persist the exact turn.",
    );
    const restored = renderHook(() => useDraftConversation({
      snapshot: currentSnapshot,
      settings: defaultSettings,
      run,
      sendMessage,
      persistedConversationId: conversationId,
      updatePersistedConversation: vi.fn(),
    }));
    expect(restored.result.current.conversation?.id).toBe(draftId);

    currentSnapshot = materializedSnapshot(
      "running",
      "Persist the exact turn.",
      "turn-unrelated",
    );
    restored.rerender();
    expect(restored.result.current.conversation?.id).toBe(draftId);

    currentSnapshot = materializedSnapshot(
      "running",
      "Persist the exact turn.",
      "turn-durable-exact",
    );
    restored.rerender();
    expect(restored.result.current.conversation).toBeNull();
    expect(readPersistedMaterializedDraftConversation()).toBeNull();
  });

  it("keeps isolated-worktree tools unavailable until the draft materializes", () => {
    const hook = renderHook(() => useDraftConversation({
      snapshot: null,
      settings: {
        ...defaultSettings,
        newThreadMode: "worktree",
      },
      run: vi.fn(),
      sendMessage: vi.fn(),
      persistedConversationId: null,
      updatePersistedConversation: vi.fn(),
    }));

    act(() => hook.result.current.start(projectId));

    expect(hook.result.current.conversation?.worktreePath).toBeNull();
    expect(hook.result.current.requiresWorkspaceMaterialization).toBe(true);
  });

  it("reconciles an ambiguous first send without restoring or resending the draft", async () => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: vi.fn(() => values.clear()),
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        key: vi.fn((index: number) => [...values.keys()][index] ?? null),
        get length() {
          return values.size;
        },
        removeItem: vi.fn((key: string) => values.delete(key)),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      } satisfies Storage,
    });
    const run = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: { kind: "conversation.created", conversationId },
    }));
    const sendMessage = vi.fn(async () => {
      throw new RuntimeCommandError(
        "The local service disconnected before finishing the request.",
        "ambiguous",
      );
    });
    let currentSnapshot: AppSnapshot | null = null;
    let persistedId: string | null = null;
    const hook = renderHook(() => useDraftConversation({
      snapshot: currentSnapshot,
      settings: defaultSettings,
      run,
      sendMessage,
      persistedConversationId: persistedId,
      updatePersistedConversation: vi.fn(),
    }));
    act(() => hook.result.current.start(projectId));
    const draftId = hook.result.current.conversation?.id;
    const promptStorageKey = `inertia:draft:${draftId}`;
    const persistedPrompt = JSON.stringify({
      message: "Keep this draft.",
    });
    values.set(promptStorageKey, persistedPrompt);

    let sendError: unknown;
    await act(async () => {
      try {
        await hook.result.current.sendFromComposer("Keep this draft.", []);
      } catch (error) {
        sendError = error;
      }
    });
    expect(sendError).toMatchObject({ message: expect.stringContaining("disconnected") });
    expect(hook.result.current.conversation?.id).toBe(draftId);
    expect(readPersistedMaterializedDraftConversation()).toMatchObject({
      acceptedTurnId: null,
      draftConversationId: draftId,
      materializedConversationId: conversationId,
      conversation: { id: draftId, projectId },
    });
    expect(values.get(promptStorageKey)).toBe(persistedPrompt);

    await expect(hook.result.current.sendFromComposer(
      "Keep this draft.",
      [],
    )).rejects.toThrow("reconciling");
    expect(run).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    currentSnapshot = materializedSnapshot(
      "running",
      "Keep this draft.",
    );
    persistedId = conversationId;
    hook.rerender();
    expect(hook.result.current.conversation).toBeNull();
    expect(readPersistedMaterializedDraftConversation()).toBeNull();
    expect(values.has(promptStorageKey)).toBe(false);
  });

  it("retries a definitely unsent first message against the same materialized chat", async () => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: vi.fn(() => values.clear()),
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        key: vi.fn((index: number) => [...values.keys()][index] ?? null),
        get length() {
          return values.size;
        },
        removeItem: vi.fn((key: string) => values.delete(key)),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      } satisfies Storage,
    });
    const run = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: { kind: "conversation.created", conversationId },
    }));
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new RuntimeCommandError(
        "The local service is reconnecting. Try again in a moment.",
        "not-sent",
      ))
      .mockResolvedValueOnce({
        kind: "message.accepted" as const,
        conversationId,
        turnId: "turn-retry",
        userMessageId: "message-retry",
        disposition: "new-turn" as const,
      });
    const hook = renderHook(() => useDraftConversation({
      snapshot: null,
      settings: defaultSettings,
      run,
      sendMessage,
      persistedConversationId: null,
      updatePersistedConversation: vi.fn(),
    }));
    act(() => hook.result.current.start(projectId));
    const draftId = hook.result.current.conversation?.id;
    const promptStorageKey = `inertia:draft:${draftId}`;
    const persistedPrompt = JSON.stringify({
      message: "Send once the socket returns.",
    });
    values.set(promptStorageKey, persistedPrompt);

    await act(async () => {
      await hook.result.current.sendFromComposer(
        "Send once the socket returns.",
        [],
      ).catch(() => undefined);
    });
    expect(hook.result.current.conversation?.id).toBe(draftId);
    expect(values.get(promptStorageKey)).toBe(persistedPrompt);
    hook.unmount();

    let reconciledSnapshot = materializedSnapshot();
    let reconciledId: string | null = conversationId;
    const restored = renderHook(() => useDraftConversation({
      snapshot: reconciledSnapshot,
      settings: defaultSettings,
      run,
      sendMessage,
      // The empty server-owned shell is now active, but that alone does not
      // prove the first message arrived.
      persistedConversationId: reconciledId,
      updatePersistedConversation: vi.fn(),
    }));
    expect(restored.result.current.conversation?.id).toBe(draftId);
    expect(values.get(promptStorageKey)).toBe(persistedPrompt);
    await act(async () => {
      await restored.result.current.sendFromComposer(
        "Send once the socket returns.",
        [],
      );
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]?.[0]).toBe(conversationId);
    expect(sendMessage.mock.calls[1]?.[0]).toBe(conversationId);
    expect(restored.result.current.conversation?.id).toBe(draftId);
    expect(readPersistedMaterializedDraftConversation()).toMatchObject({
      acceptedTurnId: "turn-retry",
      draftConversationId: draftId,
      materializedConversationId: conversationId,
    });

    reconciledSnapshot = materializedSnapshot(
      "running",
      "Send once the socket returns.",
      "turn-retry",
    );
    reconciledId = conversationId;
    restored.rerender();
    expect(restored.result.current.conversation).toBeNull();
    expect(readPersistedMaterializedDraftConversation()).toBeNull();
    expect(values.has(promptStorageKey)).toBe(false);
  });

  it("restores a new-project draft identity after the renderer remounts", () => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: vi.fn(() => values.clear()),
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        key: vi.fn((index: number) => [...values.keys()][index] ?? null),
        get length() {
          return values.size;
        },
        removeItem: vi.fn((key: string) => values.delete(key)),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      } satisfies Storage,
    });
    const options = {
      snapshot,
      settings: defaultSettings,
      run: vi.fn(),
      sendMessage: vi.fn(),
      persistedConversationId: null,
      updatePersistedConversation: vi.fn(),
    };
    const first = renderHook(() => useDraftConversation(options));

    act(() => first.result.current.start(projectId));
    const draftId = first.result.current.conversation?.id;
    expect(draftId).toBeTruthy();
    first.unmount();

    const restored = renderHook(() => useDraftConversation(options));
    expect(restored.result.current.conversation).toMatchObject({
      id: draftId,
      projectId,
    });
  });

  it("does not reactivate a draft chat after its owner navigates away", async () => {
    let settleCreation: ((event: ServerEvent) => void) | null = null;
    const run = vi.fn(() => new Promise<ServerEvent>((resolve) => {
      settleCreation = resolve;
    }));
    const sendMessage = vi.fn(async () => null);
    const hook = renderHook(() => useDraftConversation({
      snapshot,
      settings: defaultSettings,
      run,
      sendMessage,
      persistedConversationId: null,
      updatePersistedConversation: vi.fn(),
    }));
    act(() => hook.result.current.start(projectId));

    let sending!: Promise<unknown>;
    act(() => {
      sending = hook.result.current.sendFromComposer(
        "Keep working in the chat I left.",
        [],
      );
    });
    act(() => hook.result.current.clear());
    await act(async () => {
      settleCreation?.({
        type: "request.result",
        requestId: crypto.randomUUID(),
        result: { kind: "conversation.created", conversationId },
      });
      await sending;
    });

    expect(sendMessage).toHaveBeenCalledWith(
      conversationId,
      "Keep working in the chat I left.",
      [],
      undefined,
      false,
    );
    expect(hook.result.current.conversation).toBeNull();
  });
});
