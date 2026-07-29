import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  defaultSettings,
  type ServerEvent,
} from "../../src/shared/contracts";
import { useDraftConversation } from "../../src/renderer/src/hooks/useDraftConversation";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";

const projectId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";

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
    );
    expect(hook.result.current.conversation).toBeNull();
    expect(request).not.toHaveBeenCalled();
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
});
