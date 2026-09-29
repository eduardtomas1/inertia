import { fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defaultSettings,
  type AppSnapshot,
  type Conversation,
  type ConversationLatestTurnSummary,
  type ConversationShell,
  type ProviderId,
  type ProviderInfo,
  type ServerEvent,
} from "../../src/shared/contracts";
import {
  CHAT_PROVIDER_CHANGE_MESSAGE,
  MIXED_PROVIDER_HISTORY_MESSAGE,
} from "../../src/shared/continuation-policy";
import { continuationIdentityForSelection, providerNativeModelSelection } from "../../src/shared/model-routing";
import { Composer } from "../../src/renderer/src/components/Composer";
import type { ComposerProps } from "../../src/renderer/src/components/composer/types";
import { visibleChatConversation } from "../../src/renderer/src/components/workspace-scene/createWorkspaceSceneModel";
import { useConversationProjection } from "../../src/renderer/src/hooks/useConversationProjection";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import { RuntimeCommandError } from "../../src/renderer/src/utils/connectionMessages";
import { composerProps, conversation, provider } from "./composer-fixtures";

const conversationId = "22222222-2222-4222-8222-222222222222";
const returnToMain = /Return this chat to the main window/u;

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
function route(id: string, label: string, isDefault = false) {
  return {
    id,
    label,
    description: label,
    isDefault,
    inputModalities: ["text" as const],
    reasoningOptions: [],
    defaultReasoningEffort: "",
  };
}
function providerInfo(id: ProviderId, label: string, models: ReturnType<typeof route>[]): ProviderInfo {
  return { ...provider, id, label, models, metadataState: { models: catalogState, rateLimits: catalogState } };
}
const providers = [
  providerInfo("codex", "Codex", [route("codex-route", "Codex Route", true), route("codex-next", "Codex Next")]),
  providerInfo("claude", "Claude", [route("claude-route", "Claude Route", true)]),
  providerInfo("opencode", "OpenCode", [route("opencode-route", "OpenCode Route", true)]),
];

function latestTurn(providerId: ProviderId): ConversationLatestTurnSummary {
  const modelSelection = providerNativeModelSelection({ providerId });
  return {
    id: "latest-turn",
    runId: "latest-run",
    status: "completed",
    providerId,
    harnessId: modelSelection.harnessId,
    backendProfileId: modelSelection.backendProfileId,
    modelSelection,
    continuationIdentity: continuationIdentityForSelection(modelSelection),
    model: modelSelection.modelId,
    reasoningEffort: "",
    requestedAt: "2026-07-29T08:00:00.000Z",
    startedAt: "2026-07-29T08:00:00.000Z",
    completedAt: "2026-07-29T08:01:00.000Z",
    terminalReason: null,
    updatedAt: "2026-07-29T08:01:00.000Z",
  };
}

async function chooseRoute(title: string, providerLabel: string): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /Choose model/u }));
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${providerLabel}, `, "u") }));
  const target = screen.getByTitle(title).closest("button");
  if (!target) throw new Error(`Expected the ${title} route action.`);
  fireEvent.click(target);
}

async function hydratedConversation(surface: "main window" | "detached window"): Promise<Conversation> {
  const shell: ConversationShell = {
    ...conversation(conversationId),
    hasHistory: true,
    latestTurn: null,
    pendingApproval: false,
    pendingInput: false,
  };
  const snapshot: AppSnapshot = {
    projects: [],
    conversations: [shell],
    providers,
    backendProfiles: [],
    backendDefaults: [],
    runs: [],
    activeProjectId: shell.projectId,
    activeConversationId: conversationId,
    settings: defaultSettings,
  };
  const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => (
    command.type === "conversation.detail.load"
      ? { type: "request.result", requestId: "detail", result: {
          kind: "conversation.detail",
          conversationId,
          state: "ready",
          detail: {
            conversation: { ...conversation(conversationId), hasHistory: true, mixedProviderHistory: true },
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
    ...(surface === "main window" ? {} : { targetConversationId: conversationId }),
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
  projection.unmount();
  return visible!;
}

describe("composer mixed-provider history", () => {
  it.each((["main window", "detached window"] as const).flatMap((surface) =>
    (["codex", "claude"] as const).flatMap((latestProvider) => [
      [surface, latestProvider, "the saved provider", "Codex Next", "Codex"],
      [surface, latestProvider, "the latest turn's provider", latestProvider === "codex" ? "Codex Next" : "Claude Route",
        latestProvider === "codex" ? "Codex" : "Claude"],
      [surface, latestProvider, "a third provider", "OpenCode Route", "OpenCode"],
    ] as const)))("offers a new chat in the %s when the latest turn used %s and the user picks %s", async (
    surface, latestProvider, _target, title, providerLabel,
  ) => {
    const visible = await hydratedConversation(surface);
    expect(visible.mixedProviderHistory).toBe(true);
    const onUpdateConversation = vi.fn<ComposerProps["onUpdateConversation"]>(async () => undefined);
    const onCreateConversationForSelection = vi.fn<NonNullable<ComposerProps["onCreateConversationForSelection"]>>(async () => undefined);
    render(<Composer {...composerProps(visible, {
      providers,
      hasVisibleHistory: true,
      latestTurnSummary: latestTurn(latestProvider),
      onUpdateConversation,
      onCreateConversationForSelection: surface === "detached window" ? undefined : onCreateConversationForSelection,
    })} />);
    await chooseRoute(title, providerLabel);

    if (surface === "detached window") {
      expect(await screen.findByText(returnToMain)).toBeInTheDocument();
    } else {
      expect(await screen.findByRole("alertdialog")).toHaveTextContent(MIXED_PROVIDER_HISTORY_MESSAGE);
    }
    expect(onUpdateConversation).not.toHaveBeenCalled();
    expect(onCreateConversationForSelection).not.toHaveBeenCalled();
  });

  it.each([
    ["another model of the same provider", "Codex Next", "Codex", false],
    ["another provider", "Claude Route", "Claude", true],
  ] as const)("keeps a single-provider history unchanged for %s", async (_case, title, providerLabel, newChat) => {
    const onUpdateConversation = vi.fn<ComposerProps["onUpdateConversation"]>(async () => undefined);
    render(<Composer {...composerProps({ ...conversation(conversationId), hasHistory: true, mixedProviderHistory: false }, {
      providers,
      latestTurnSummary: latestTurn("codex"),
      onUpdateConversation,
    })} />);
    await chooseRoute(title, providerLabel);
    if (newChat) {
      expect(await screen.findByRole("alertdialog")).toHaveTextContent(CHAT_PROVIDER_CHANGE_MESSAGE);
      expect(onUpdateConversation).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(onUpdateConversation).toHaveBeenCalledOnce());
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    }
  });

  it.each((["main window", "detached window"] as const).flatMap((surface) => [
    [surface, MIXED_PROVIDER_HISTORY_MESSAGE, "Codex Next", "Codex"],
    [surface, CHAT_PROVIDER_CHANGE_MESSAGE, "Claude Route", "Claude"],
  ] as const))("turns a server provider rejection into the new-chat path in the %s: %s", async (
    surface, message, title, providerLabel,
  ) => {
    const onUpdateConversation = vi.fn<ComposerProps["onUpdateConversation"]>(async () => {
      throw new RuntimeCommandError(message, "rejected");
    });
    const onCreateConversationForSelection = vi.fn<NonNullable<ComposerProps["onCreateConversationForSelection"]>>(async () => undefined);
    render(<Composer {...composerProps({ ...conversation(conversationId), hasHistory: false }, {
      providers,
      onUpdateConversation,
      onCreateConversationForSelection: surface === "detached window" ? undefined : onCreateConversationForSelection,
    })} />);
    await chooseRoute(title, providerLabel);
    await waitFor(() => expect(onUpdateConversation).toHaveBeenCalledOnce());
    if (surface === "detached window") {
      expect(await screen.findByText(returnToMain)).toBeInTheDocument();
    } else {
      expect(await screen.findByRole("alertdialog")).toHaveTextContent(message);
    }
    expect(screen.queryAllByRole("alert").filter((element) => element.textContent?.includes(message)))
      .toHaveLength(0);
    expect(onCreateConversationForSelection).not.toHaveBeenCalled();
  });

  it("offers a new chat when the server rejects a reasoning change for mixed history", async () => {
    const reasoningProviders = [{
      ...providers[0]!,
      models: [{
        ...route("codex-route", "Codex Route", true),
        reasoningOptions: [{ value: "low", label: "Low", description: "" }, { value: "high", label: "High", description: "" }],
        defaultReasoningEffort: "low",
      }],
    }];
    const onUpdateConversation = vi.fn<ComposerProps["onUpdateConversation"]>(async () => {
      throw new RuntimeCommandError(MIXED_PROVIDER_HISTORY_MESSAGE, "rejected");
    });
    const onCreateConversationForSelection = vi.fn<NonNullable<ComposerProps["onCreateConversationForSelection"]>>(async () => undefined);
    render(<Composer {...composerProps({ ...conversation(conversationId), hasHistory: true }, {
      providers: reasoningProviders,
      onUpdateConversation,
      onCreateConversationForSelection,
    })} />);
    fireEvent.click(screen.getByRole("button", { name: /Choose reasoning level/u }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /High/u }));
    await waitFor(() => expect(onUpdateConversation).toHaveBeenCalledOnce());
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(MIXED_PROVIDER_HISTORY_MESSAGE);
    expect(screen.queryAllByRole("alert").filter((element) =>
      element.textContent?.includes(MIXED_PROVIDER_HISTORY_MESSAGE))).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(onCreateConversationForSelection).toHaveBeenCalledOnce());
    expect(onCreateConversationForSelection.mock.calls[0]?.[0]).toMatchObject({ reasoningEffort: "high" });
  });

  it.each(["main window", "detached window"] as const)(
    "explains a compaction refused for mixed history in the %s",
    async (surface) => {
      const current = { ...conversation(conversationId), hasHistory: true };
      const onCompact = vi.fn(async () => {
        throw new RuntimeCommandError(MIXED_PROVIDER_HISTORY_MESSAGE, "rejected");
      });
      const onCreateConversationForSelection = vi.fn<NonNullable<ComposerProps["onCreateConversationForSelection"]>>(async () => undefined);
      render(<Composer {...composerProps(current, {
        providers,
        onCompact,
        onCreateConversationForSelection: surface === "detached window" ? undefined : onCreateConversationForSelection,
      })} />);
      const input = screen.getByRole("textbox", { name: "Message" });
      fireEvent.change(input, { target: { value: "/compact keep the plan" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(await screen.findByText(MIXED_PROVIDER_HISTORY_MESSAGE, { selector: "span" })).toBeVisible();
      expect(onCompact).toHaveBeenCalledOnce();
      await waitFor(() => expect(input).toHaveValue(""));
      if (surface === "detached window") {
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
        expect(screen.queryByText(returnToMain)).not.toBeInTheDocument();
        return;
      }
      expect(await screen.findByRole("alertdialog")).toHaveTextContent(MIXED_PROVIDER_HISTORY_MESSAGE);
      fireEvent.click(screen.getByRole("button", { name: "New chat" }));
      await waitFor(() => expect(onCreateConversationForSelection).toHaveBeenCalledOnce());
      expect(onCreateConversationForSelection.mock.calls[0]).toEqual([current.modelSelection, { onCreated: expect.any(Function) }]);
    },
  );

  it("offers a new chat with the unsent text when the server rejects a send for mixed history", async () => {
    const current = { ...conversation(conversationId), hasHistory: true };
    const onSend = vi.fn<ComposerProps["onSend"]>(async () => {
      throw new RuntimeCommandError(MIXED_PROVIDER_HISTORY_MESSAGE, "rejected");
    });
    const onCreateConversationForSelection = vi.fn<NonNullable<ComposerProps["onCreateConversationForSelection"]>>(async () => undefined);
    render(<Composer {...composerProps(current, {
      providers,
      onSend,
      onCreateConversationForSelection,
    })} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Continue this work." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(MIXED_PROVIDER_HISTORY_MESSAGE);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Continue this work.");
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(onCreateConversationForSelection).toHaveBeenCalledOnce());
    expect(onCreateConversationForSelection.mock.calls[0]).toEqual([
      current.modelSelection,
      { prefillText: "Continue this work.", onCreated: expect.any(Function) },
    ]);
  });
});
