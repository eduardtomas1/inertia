import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  Conversation,
  ConversationLatestTurnSummary,
  ProviderId,
  ProviderInfo,
} from "../../src/shared/contracts";
import { continuationIdentityForSelection, providerNativeModelSelection } from "../../src/shared/model-routing";
import { Composer } from "../../src/renderer/src/components/Composer";
import type { ComposerProps } from "../../src/renderer/src/components/composer/types";
import { composerProps, conversation, provider } from "./composer-fixtures";

const conversationId = "22222222-2222-4222-8222-222222222222";
const claudeNotice = "Next message starts a new Claude session with this chat's earlier messages as context.";

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

/**
 * Renders an established Codex chat whose conversation follows each accepted
 * update, as the runtime snapshot does after `conversation.update`.
 */
function renderChat(overrides: Partial<ComposerProps> = {}) {
  let current: Conversation = { ...conversation(conversationId), hasHistory: true };
  const onUpdateConversation = vi.fn<ComposerProps["onUpdateConversation"]>(async (update) => {
    current = { ...current, ...update };
    view.rerender(<Composer {...composerProps(current, props)} />);
  });
  const props: Partial<ComposerProps> = {
    providers,
    latestTurnSummary: latestTurn("codex"),
    onUpdateConversation,
    ...overrides,
  };
  const view = render(<Composer {...composerProps(current, props)} />);
  return { onUpdateConversation, view, current: () => current, props };
}

describe("composer provider handoff", () => {
  it("switches an established chat to another provider in place and announces the handoff", async () => {
    const { onUpdateConversation } = renderChat();

    await chooseRoute("Claude Route", "Claude");

    await waitFor(() => expect(onUpdateConversation).toHaveBeenCalledOnce());
    expect(onUpdateConversation.mock.calls[0]![0]).toMatchObject({
      providerId: "claude",
      modelSelection: { harnessId: providerNativeModelSelection({ providerId: "claude" }).harnessId, modelId: "claude-route" },
    });
    const notice = await screen.findByText(claudeNotice);
    const status = notice.closest("[role='status']");
    expect(status).not.toBeNull();
    expect(status).not.toHaveAttribute("aria-live");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).not.toHaveAttribute("aria-describedby");
  });

  it("uses the configured provider identity label in the notice", async () => {
    renderChat({ providerIdentityLabels: { claude: "Team Claude" } });

    await chooseRoute("Claude Route", "Claude");

    expect(await screen.findByText(
      "Next message starts a new Team Claude session with this chat's earlier messages as context.",
    )).toBeInTheDocument();
  });

  it("clears the notice once a turn runs on the new provider", async () => {
    const { view, current, props } = renderChat();
    await chooseRoute("Claude Route", "Claude");
    await screen.findByText(claudeNotice);

    view.rerender(<Composer {...composerProps(current(), { ...props, latestTurnSummary: latestTurn("claude") })} />);

    expect(screen.queryByText(claudeNotice)).not.toBeInTheDocument();
  });

  it("derives the notice from the saved chat, so it survives a reload or another window", () => {
    const claudeChat: Conversation = {
      ...conversation(conversationId),
      hasHistory: true,
      providerId: "claude",
      modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "claude-route" }),
    };
    render(<Composer {...composerProps(claudeChat, { providers, latestTurnSummary: latestTurn("codex") })} />);

    expect(screen.getByText(claudeNotice).closest("[role='status']")).not.toBeNull();
  });

  it.each([
    ["the Kimi route on the Claude harness", "builtin:kimi-code", "Kimi", "Claude · Kimi"],
    ["a custom Claude-compatible backend", "custom-team-proxy", "Team Proxy", "Claude · Team Proxy"],
  ])("names the backend for %s in the notice", (_route, backendProfileId, backendProfileDisplayName, label) => {
    const claudeChat: Conversation = {
      ...conversation(conversationId),
      hasHistory: true,
      providerId: "claude",
      modelSelection: {
        ...providerNativeModelSelection({ providerId: "claude", modelId: "k3" }),
        backendProfileId,
        backendProfileDisplayName,
      },
    };
    render(<Composer {...composerProps(claudeChat, { providers, latestTurnSummary: latestTurn("codex") })} />);

    expect(screen.getByText(
      `Next message starts a new ${label} session with this chat's earlier messages as context.`,
    ).closest("[role='status']")).not.toBeNull();
  });

  it("clears the notice when the chat returns to its original provider", async () => {
    const { onUpdateConversation } = renderChat();
    await chooseRoute("Claude Route", "Claude");
    await screen.findByText(claudeNotice);

    await chooseRoute("Codex Next", "Codex");

    await waitFor(() => expect(onUpdateConversation).toHaveBeenCalledTimes(2));
    expect(onUpdateConversation.mock.calls[1]![0]).toMatchObject({ providerId: "codex" });
    await waitFor(() => expect(screen.queryByText(/Next message starts a new/u)).not.toBeInTheDocument());
  });

  it("does not announce a handoff for a model change on the same provider", async () => {
    const { onUpdateConversation } = renderChat();

    await chooseRoute("Codex Next", "Codex");

    await waitFor(() => expect(onUpdateConversation).toHaveBeenCalledOnce());
    expect(screen.queryByText(/Next message starts a new/u)).not.toBeInTheDocument();
  });

  it("keeps the chat and shows no notice when the provider change is rejected", async () => {
    const onUpdateConversation = vi.fn<ComposerProps["onUpdateConversation"]>(async () => {
      throw new Error("The provider is not ready.");
    });
    render(<Composer {...composerProps({ ...conversation(conversationId), hasHistory: true }, {
      providers,
      latestTurnSummary: latestTurn("codex"),
      onUpdateConversation,
    })} />);

    await chooseRoute("Claude Route", "Claude");

    expect(await screen.findByText("The provider is not ready.")).toBeInTheDocument();
    expect(screen.queryByText(claudeNotice)).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
