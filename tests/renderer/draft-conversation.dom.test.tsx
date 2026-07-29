import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  defaultSettings,
  type AppSnapshot,
  type Project,
  type ServerEvent,
} from "../../src/shared/contracts";
import { useDraftConversation } from "../../src/renderer/src/hooks/useDraftConversation";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import {
  buildDraftConversation,
  buildNewConversationPayload,
} from "../../src/renderer/src/lib/newConversation";
import { RuntimeCommandError } from "../../src/renderer/src/utils/connectionMessages";
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
): AppSnapshot {
  return {
    ...snapshot,
    activeConversationId: status === "idle" ? null : conversationId,
    conversations: [{
      ...buildDraftConversation(
        buildNewConversationPayload(projectId, defaultSettings),
        { id: conversationId, now },
      ),
      title,
      status,
      latestTurn: null,
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

  it("keeps a new-project chat local until its first message is sent", async () => {
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
    const sendMessage = vi.fn(async () => undefined);
    const hook = renderHook(() => useDraftConversation({
      snapshot: null,
      settings: defaultSettings,
      run,
      sendMessage,
      persistedConversationId: null,
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

    await act(async () => {
      await hook.result.current.sendFromComposer(
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
    expect(hook.result.current.conversation).toBeNull();
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
      .mockResolvedValueOnce(undefined);
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

    const restored = renderHook(() => useDraftConversation({
      snapshot: materializedSnapshot(),
      settings: defaultSettings,
      run,
      sendMessage,
      // The empty server-owned shell is now active, but that alone does not
      // prove the first message arrived.
      persistedConversationId: conversationId,
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
    const sendMessage = vi.fn(async () => undefined);
    const hook = renderHook(() => useDraftConversation({
      snapshot,
      settings: defaultSettings,
      run,
      sendMessage,
      persistedConversationId: null,
      updatePersistedConversation: vi.fn(),
    }));
    act(() => hook.result.current.start(projectId));

    let sending!: Promise<void>;
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
