import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  defaultSettings,
  type AppSnapshot,
  type Conversation,
  type ConversationShell,
  type ProviderInfo,
  type ServerEvent,
} from "../../src/shared/contracts";
import { conversationHasHistory } from "../../src/shared/continuation-policy";
import { Composer } from "../../src/renderer/src/components/Composer";
import type { ComposerProps } from "../../src/renderer/src/components/composer/types";
import { visibleChatConversation } from "../../src/renderer/src/components/workspace-scene/createWorkspaceSceneModel";
import { useConversationProjection } from "../../src/renderer/src/hooks/useConversationProjection";
import { useDraftConversation } from "../../src/renderer/src/hooks/useDraftConversation";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import { RuntimeCommandError } from "../../src/renderer/src/utils/connectionMessages";
import { composerProps, conversation, provider } from "./composer-fixtures";

const projectId = "11111111-1111-4111-8111-111111111111";
const savedConversationId = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const catalogState = {
  freshness: "fresh" as const,
  provenance: "provider" as const,
  updatedAt: "2026-08-01T00:00:00.000Z",
  lastAttemptedAt: "2026-08-01T00:00:00.000Z",
  refreshing: false,
};
const model = {
  id: "codex-route",
  label: "Codex Route",
  description: "Current route",
  isDefault: true,
  inputModalities: ["text" as const],
  reasoningOptions: [],
  defaultReasoningEffort: "",
};
const codexProvider: ProviderInfo = {
  ...provider,
  models: [model],
  metadataState: { models: catalogState, rateLimits: catalogState },
};
const claudeProvider: ProviderInfo = {
  ...codexProvider,
  id: "claude",
  label: "Claude",
  models: [{ ...model, id: "claude-route", label: "Claude Route", description: "Destination route" }],
};

/** Chooses the Claude route, then shows the chat as the runtime reports it after the update. */
async function chooseClaudeInPlace(
  view: ReturnType<typeof render>,
  current: Conversation,
  props: Partial<ComposerProps>,
  onUpdateConversation: Mock<ComposerProps["onUpdateConversation"]>,
): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /Choose model/u }));
  fireEvent.click(await screen.findByRole("button", { name: /^Claude, / }));
  const claudeRoute = screen.getByTitle("Claude Route").closest("button");
  if (!claudeRoute) throw new Error("Expected the Claude route action.");
  fireEvent.click(claudeRoute);
  await waitFor(() => expect(onUpdateConversation).toHaveBeenCalledOnce());
  const update = onUpdateConversation.mock.calls[0]![0];
  expect(update).toMatchObject({ providerId: "claude" });
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  view.rerender(<Composer {...composerProps({ ...current, ...update }, props)} />);
}

describe("composer provider history", () => {
  it.each([
    ["published history that is not loaded", { hasHistory: true }],
    ["a shell from before history was published", {}],
    ["an unused draft", { hasHistory: false }],
  ] as const)("switches the provider in place with the published history fact for %s", async (_case, published) => {
    const onUpdateConversation = vi.fn<ComposerProps["onUpdateConversation"]>(async () => undefined);
    const current = { ...conversation("published-history"), ...published };
    const props = { providers: [codexProvider, claudeProvider], hasVisibleHistory: false, onUpdateConversation };
    const view = render(<Composer {...composerProps(current, props)} />);

    await chooseClaudeInPlace(view, current, props, onUpdateConversation);
  });

  it.each([
    ["a cleanly rejected first send", () => Promise.reject(new RuntimeCommandError("Provider unavailable", "rejected"))],
    ["an undelivered first send", () => Promise.reject(new RuntimeCommandError("Reconnecting", "not-sent"))],
    ["an accepted first send", () => Promise.resolve({
      kind: "message.accepted" as const,
      conversationId: savedConversationId,
      turnId: "turn-1",
      userMessageId: "message-1",
      disposition: "new-turn" as const,
    })],
    ["an ambiguous first send", () => Promise.reject(new RuntimeCommandError("Disconnected", "ambiguous"))],
  ] as const)("switches the provider in place after the first send of a saved draft: %s", async (_case, send) => {
    const run = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.result",
      requestId: "create",
      result: { kind: "conversation.created", conversationId: savedConversationId },
    }));
    const updatePersistedConversation = vi.fn(async () => undefined);
    const draft = renderHook(() => useDraftConversation({
      snapshot: null,
      settings: defaultSettings,
      run,
      sendMessage: vi.fn(send),
      persistedConversationId: null,
      updatePersistedConversation,
    }));
    act(() => draft.result.current.start(projectId));
    await act(async () => {
      await draft.result.current.sendFromComposer("First message", []).catch(() => undefined);
    });
    const onUpdateConversation = vi.fn<ComposerProps["onUpdateConversation"]>(
      (update) => draft.result.current.updateConversation(update),
    );
    const current = draft.result.current.conversation!;
    const props = { providers: [codexProvider, claudeProvider], hasVisibleHistory: false, onUpdateConversation };
    const view = render(<Composer {...composerProps(current, props)} />);

    await chooseClaudeInPlace(view, current, props, onUpdateConversation);
    expect(updatePersistedConversation).toHaveBeenCalledWith(
      savedConversationId,
      expect.objectContaining({ providerId: "claude" }),
    );
    expect(run).toHaveBeenCalledOnce();
  });

  it.each((["main window", "split pane", "detached window"] as const).flatMap((surface) => [
    [surface, false],
    [surface, true],
  ] as const))("keeps the published history fact after detail hydration in the %s (history: %s)", async (surface, hasHistory) => {
    const shell: ConversationShell = {
      ...conversation(savedConversationId),
      hasHistory,
      latestTurn: null,
      pendingApproval: false,
      pendingInput: false,
    };
    const snapshot: AppSnapshot = {
      projects: [],
      conversations: [shell],
      providers: [codexProvider, claudeProvider],
      backendProfiles: [],
      backendDefaults: [],
      runs: [],
      activeProjectId: projectId,
      activeConversationId: savedConversationId,
      settings: defaultSettings,
    };
    const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => (
      command.type === "conversation.detail.load"
        ? { type: "request.result", requestId: "detail", result: {
            kind: "conversation.detail",
            conversationId: savedConversationId,
            state: "ready",
            detail: {
              conversation: conversation(savedConversationId),
              agentTurns: [], turnGitArtifacts: [], messages: [], activities: [], subagents: [], reasonings: [],
              usage: [], plans: [], goals: [], checkpoints: [], reviewSummaries: [], reviewStates: [], reviewNotes: [],
            },
          } }
        : { type: "request.ok", requestId: "ok" }
    ));
    const projection = renderHook(() => useConversationProjection({
      snapshot,
      status: "online",
      request,
      subscribe: () => () => undefined,
      ...(surface === "main window" ? {} : { targetConversationId: savedConversationId }),
      enabled: true,
      autoOpenPlan: false,
      onOpenPlan: vi.fn(),
      onTerminal: vi.fn(),
    }));
    await waitFor(() => expect(projection.result.current.detail).not.toBeNull());
    const { conversation: shellConversation, detail } = projection.result.current;
    const visible = surface === "detached window"
      ? detail?.conversation ?? shellConversation
      : visibleChatConversation(null, detail?.conversation ?? null, shellConversation);
    expect(conversationHasHistory(visible!)).toBe(hasHistory);
    const onUpdateConversation = vi.fn<ComposerProps["onUpdateConversation"]>(async () => undefined);
    const props = { providers: [codexProvider, claudeProvider], hasVisibleHistory: false, onUpdateConversation };
    const view = render(<Composer {...composerProps(visible!, props)} />);

    await chooseClaudeInPlace(view, visible!, props, onUpdateConversation);
  });
});
