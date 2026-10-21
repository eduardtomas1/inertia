import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { defaultSettings, type AppSnapshot, type ServerEvent } from "../../src/shared/contracts";
import type { WatcherWakeSummary } from "../../src/shared/watcher";
import { useConversationProjection } from "../../src/renderer/src/hooks/useConversationProjection";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import { taskTurn } from "./background-task-fixtures";
import { PROJECT_ID, WATCHER_ID, project, shell, wakeId } from "./watcher-fixtures";

const watcherChat = shell(WATCHER_ID, "Watcher · Reviewer · Refactor parser", { status: "running" });

const snapshot: AppSnapshot = {
  projects: [project],
  conversations: [watcherChat],
  providers: [],
  backendProfiles: [],
  backendDefaults: [],
  runs: [],
  activeProjectId: PROJECT_ID,
  activeConversationId: WATCHER_ID,
  settings: { ...defaultSettings },
};

describe("an open watcher chat", () => {
  it("takes a check's wake summary from a detail invalidated while its turn runs", async () => {
    const listeners = new Set<(event: ServerEvent) => void>();
    const emit = (event: ServerEvent): void => act(() => {
      for (const listener of listeners) listener(event);
    });
    const turn = taskTurn({ id: "watcher-check-turn", conversationId: WATCHER_ID, status: "running", completedAt: null });
    const wake: WatcherWakeSummary = {
      wakeId: wakeId(1),
      turnId: turn.id,
      sequence: 1,
      trigger: "activity",
      outcome: null,
      eventsCovered: 3,
      itemsTruncated: 0,
      itemsOmitted: 0,
      guardState: null,
    };
    let watcherWakes: WatcherWakeSummary[] = [];
    const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => command.type === "conversation.detail.load"
      ? {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "conversation.detail",
            conversationId: WATCHER_ID,
            state: "ready",
            detail: {
              conversation: watcherChat,
              agentTurns: [turn],
              turnGitArtifacts: [],
              messages: [],
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
              watcherWakes,
            },
          },
        }
      : { type: "request.ok", requestId: crypto.randomUUID() });
    const hook = renderHook(() =>
      useConversationProjection({
        snapshot,
        status: "online",
        request,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        enabled: true,
        autoOpenPlan: false,
        onOpenPlan: vi.fn(),
        onTerminal: vi.fn(),
      }));
    await waitFor(() => expect(hook.result.current.detail?.watcherWakes).toEqual([]));

    watcherWakes = [wake];
    emit({ type: "conversation.detail.invalidated", conversationId: WATCHER_ID });
    await waitFor(() => expect(hook.result.current.detail?.watcherWakes).toEqual([wake]));

    watcherWakes = [{ ...wake, outcome: "silent" }];
    emit({ type: "conversation.detail.invalidated", conversationId: WATCHER_ID });
    await waitFor(() => expect(hook.result.current.detail?.watcherWakes?.[0]?.outcome).toBe("silent"));
  });
});
