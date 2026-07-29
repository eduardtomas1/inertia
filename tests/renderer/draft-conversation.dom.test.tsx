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
    const request = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.ok",
      requestId: crypto.randomUUID(),
    }));
    const sendMessage = vi.fn(async () => undefined);
    const hook = renderHook(() => useDraftConversation({
      snapshot: null,
      settings: defaultSettings,
      run,
      request,
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
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps isolated-worktree tools unavailable until the draft materializes", () => {
    const hook = renderHook(() => useDraftConversation({
      snapshot: null,
      settings: {
        ...defaultSettings,
        newThreadMode: "worktree",
      },
      run: vi.fn(),
      request: vi.fn(),
      sendMessage: vi.fn(),
      persistedConversationId: null,
      updatePersistedConversation: vi.fn(),
    }));

    act(() => hook.result.current.start(projectId));

    expect(hook.result.current.conversation?.worktreePath).toBeNull();
    expect(hook.result.current.requiresWorkspaceMaterialization).toBe(true);
  });

  it("removes a failed first-send shell without discarding the local draft", async () => {
    const run = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: { kind: "conversation.created", conversationId },
    }));
    const request = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.ok",
      requestId: crypto.randomUUID(),
    }));
    const sendMessage = vi.fn(async () => {
      throw new Error("Provider unavailable");
    });
    const hook = renderHook(() => useDraftConversation({
      snapshot: null,
      settings: defaultSettings,
      run,
      request,
      sendMessage,
      persistedConversationId: null,
      updatePersistedConversation: vi.fn(),
    }));
    act(() => hook.result.current.start(projectId));

    await expect(act(async () => {
      await hook.result.current.sendFromComposer("Keep this draft.", []);
    })).rejects.toThrow("Provider unavailable");
    expect(hook.result.current.conversation?.projectId).toBe(projectId);
    expect(request).toHaveBeenCalledWith({
      type: "conversation.delete",
      payload: { conversationId },
    });
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
      request: vi.fn(),
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
      request: vi.fn(),
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
