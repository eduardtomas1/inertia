import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Conversation, ServerEvent } from "../../src/shared/contracts";
import { useDraftSkills } from "../../src/renderer/src/hooks/useDraftSkills";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";

const draftId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

function draft(providerId: string, harnessId: string, id = draftId): Conversation {
  return {
    id,
    projectId,
    providerId,
    modelSelection: { harnessId },
  } as unknown as Conversation;
}

function skillsResult(conversationId: string, name = "review"): ServerEvent {
  return {
    type: "request.result",
    requestId: crypto.randomUUID(),
    result: {
      kind: "agent.skills",
      conversationId,
      skills: [{
        id: crypto.randomUUID(),
        conversationId,
        name,
        description: "Review this project.",
        shortDescription: null,
        scope: "repo",
        enabled: true,
        source: "codex-native",
      }],
      skillDiscovery: { truncated: false, warningCount: 0, synchronizedAt: "2030-01-01T00:00:00.000Z" },
    },
  } as ServerEvent;
}

describe("useDraftSkills", () => {
  it("lists skills for a draft from its project and harness, with no chat", async () => {
    const request = vi.fn(async (_command: CommandWithoutId) => skillsResult(draftId));
    const { result } = renderHook(() => useDraftSkills({
      draft: draft("codex", "codex-app-server"), status: "online", request,
    }));
    expect(result.current.capability).toEqual({ kind: "codex-native", available: true, label: "Codex skills" });

    await act(async () => { await result.current.list(); });

    expect(request).toHaveBeenCalledExactlyOnceWith({
      type: "agent.skills.preview",
      payload: { draftConversationId: draftId, projectId, harnessId: "codex-app-server", forceReload: false },
    });
    expect(result.current.skills.map(({ name }) => name)).toEqual(["review"]);
    expect(result.current.loading).toBe(false);
  });

  it("reports unavailable routes without contacting the service", async () => {
    const request = vi.fn(async (_command: CommandWithoutId) => skillsResult(draftId));
    const { result } = renderHook(() => useDraftSkills({
      draft: draft("opencode", "opencode-server"), status: "online", request,
    }));

    await act(async () => { await result.current.list(); });

    expect(result.current.capability).toMatchObject({ kind: "unavailable", available: false });
    expect(request).not.toHaveBeenCalled();
  });

  it("drops a stale list when the draft moves to another provider", async () => {
    let resolve!: (event: ServerEvent) => void;
    const request = vi.fn((_command: CommandWithoutId) => new Promise<ServerEvent>((settle) => { resolve = settle; }));
    const { result, rerender } = renderHook(
      ({ current }: { current: Conversation }) => useDraftSkills({ draft: current, status: "online", request }),
      { initialProps: { current: draft("codex", "codex-app-server") } },
    );
    let pending!: Promise<void>;
    act(() => { pending = result.current.list(); });
    await waitFor(() => expect(result.current.loading).toBe(true));

    rerender({ current: draft("claude", "claude-agent-sdk") });
    await act(async () => { resolve(skillsResult(draftId)); await pending; });

    expect(result.current.skills).toEqual([]);
    expect(result.current.capability).toMatchObject({ kind: "claude-native" });
    expect(result.current.loading).toBe(false);
  });

  it("keeps the reason when discovery fails", async () => {
    const request = vi.fn(async (_command: CommandWithoutId): Promise<ServerEvent> => {
      throw new Error("Codex did not return skills for this project.");
    });
    const { result } = renderHook(() => useDraftSkills({
      draft: draft("codex", "codex-app-server"), status: "online", request,
    }));

    await act(async () => { await result.current.list().catch(() => undefined); });

    expect(result.current.error).toBe("Codex did not return skills for this project.");
    expect(result.current.skills).toEqual([]);
  });
});
