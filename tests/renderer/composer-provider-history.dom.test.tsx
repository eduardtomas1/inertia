import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defaultSettings,
  type AppSnapshot,
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

describe("composer provider history", () => {
  it.each([
    ["published history that is not loaded", { hasHistory: true }, true],
    ["a shell from before history was published", {}, true],
    ["an unused draft", { hasHistory: false }, false],
  ] as const)("uses the published history fact for %s", async (_case, published, established) => {
    const onUpdateConversation = vi.fn<ComposerProps["onUpdateConversation"]>(async () => undefined);
    const onCreateConversationForSelection = vi.fn(async () => undefined);
    render(<Composer {...composerProps({ ...conversation("published-history"), ...published }, {
      providers: [codexProvider, claudeProvider],
      hasVisibleHistory: false,
      onUpdateConversation,
      onCreateConversationForSelection,
    })} />);
    fireEvent.click(screen.getByRole("button", { name: /Choose model/u }));
    fireEvent.click(await screen.findByRole("button", { name: /^Claude, / }));
    const claudeRoute = screen.getByTitle("Claude Route").closest("button");
    if (!claudeRoute) throw new Error("Expected the Claude route action.");
    fireEvent.click(claudeRoute);

    if (established) {
      expect(await screen.findByRole("alertdialog"))
        .toHaveTextContent("Start a new chat to use a different provider.");
      expect(onUpdateConversation).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(onUpdateConversation).toHaveBeenCalledOnce());
      expect(onUpdateConversation.mock.calls[0]?.[0]).toMatchObject({ providerId: "claude" });
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    }
    expect(onCreateConversationForSelection).not.toHaveBeenCalled();
  });

  it.each([
    ["a cleanly rejected first send", () => Promise.reject(new RuntimeCommandError("Provider unavailable", "rejected")), false],
    ["an undelivered first send", () => Promise.reject(new RuntimeCommandError("Reconnecting", "not-sent")), false],
    ["an accepted first send", () => Promise.resolve({
      kind: "message.accepted" as const,
      conversationId: savedConversationId,
      turnId: "turn-1",
      userMessageId: "message-1",
      disposition: "new-turn" as const,
    }), true],
    ["an ambiguous first send", () => Promise.reject(new RuntimeCommandError("Disconnected", "ambiguous")), true],
  ] as const)("uses the first send outcome of a saved draft for %s", async (_case, send, established) => {
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
    const onCreateConversationForSelection = vi.fn(async () => undefined);
    render(<Composer {...composerProps(draft.result.current.conversation!, {
      providers: [codexProvider, claudeProvider],
      hasVisibleHistory: false,
      onUpdateConversation: draft.result.current.updateConversation,
      onCreateConversationForSelection,
    })} />);
    fireEvent.click(screen.getByRole("button", { name: /Choose model/u }));
    fireEvent.click(await screen.findByRole("button", { name: /^Claude, / }));
    const claudeRoute = screen.getByTitle("Claude Route").closest("button");
    if (!claudeRoute) throw new Error("Expected the Claude route action.");
    fireEvent.click(claudeRoute);

    if (established) {
      expect(await screen.findByRole("alertdialog"))
        .toHaveTextContent("Start a new chat to use a different provider.");
      expect(updatePersistedConversation).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(updatePersistedConversation).toHaveBeenCalledOnce());
      expect(updatePersistedConversation).toHaveBeenCalledWith(
        savedConversationId,
        expect.objectContaining({ providerId: "claude" }),
      );
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    }
    expect(onCreateConversationForSelection).not.toHaveBeenCalled();
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
    const onCreateConversationForSelection = vi.fn(async () => undefined);
    render(<Composer {...composerProps(visible!, {
      providers: [codexProvider, claudeProvider],
      hasVisibleHistory: false,
      onUpdateConversation,
      onCreateConversationForSelection: surface === "detached window" ? undefined : onCreateConversationForSelection,
    })} />);
    fireEvent.click(screen.getByRole("button", { name: /Choose model/u }));
    fireEvent.click(await screen.findByRole("button", { name: /^Claude, / }));
    const claudeRoute = screen.getByTitle("Claude Route").closest("button");
    if (!claudeRoute) throw new Error("Expected the Claude route action.");
    fireEvent.click(claudeRoute);

    if (!hasHistory) {
      await waitFor(() => expect(onUpdateConversation).toHaveBeenCalledOnce());
      expect(onUpdateConversation.mock.calls[0]?.[0]).toMatchObject({ providerId: "claude" });
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(screen.queryByText(/Return this chat to the main window/u)).not.toBeInTheDocument();
    } else if (surface === "detached window") {
      expect(await screen.findByText(/Return this chat to the main window/u)).toBeInTheDocument();
      expect(onUpdateConversation).not.toHaveBeenCalled();
    } else {
      expect(await screen.findByRole("alertdialog"))
        .toHaveTextContent("Start a new chat to use a different provider.");
      expect(onUpdateConversation).not.toHaveBeenCalled();
    }
    expect(onCreateConversationForSelection).not.toHaveBeenCalled();
  });
});
