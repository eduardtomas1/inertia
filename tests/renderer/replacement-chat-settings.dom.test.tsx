import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentWorkflowState, Conversation, ProviderInfo } from "../../src/shared/contracts";
import { MIXED_PROVIDER_HISTORY_MESSAGE } from "../../src/shared/continuation-policy";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { Composer } from "../../src/renderer/src/components/Composer";
import type { ComposerProps } from "../../src/renderer/src/components/composer/types";
import { RuntimeCommandError } from "../../src/renderer/src/utils/connectionMessages";
import { composerProps, conversation, provider } from "./composer-fixtures";

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const conversationId = "44444444-4444-4444-8444-444444444444";
const catalogState = {
  freshness: "fresh" as const,
  provenance: "provider" as const,
  updatedAt: "2026-08-01T00:00:00.000Z",
  lastAttemptedAt: "2026-08-01T00:00:00.000Z",
  refreshing: false,
};
function model(id: string, label: string) {
  return {
    id,
    label,
    description: label,
    isDefault: true,
    inputModalities: ["text" as const],
    reasoningOptions: [
      { value: "low", label: "Low", description: "" },
      { value: "high", label: "High", description: "" },
    ],
    defaultReasoningEffort: "low",
  };
}
const providers: ProviderInfo[] = [
  { ...provider, models: [model("provider-default", "Codex Route")], metadataState: { models: catalogState, rateLimits: catalogState } },
  { ...provider, id: "claude", label: "Claude", models: [model("claude-route", "Claude Route")],
    metadataState: { models: catalogState, rateLimits: catalogState } },
];
const planSupervised = { accessMode: "supervised", interactionMode: "plan" } as const;

function chat(overrides: Partial<Conversation> = {}): Conversation {
  return { ...conversation(conversationId), hasHistory: true, ...planSupervised, ...overrides };
}

function workflow(): AgentWorkflowState {
  return {
    conversationId,
    goals: [],
    goalCapability: { kind: "codex-native", available: true, label: "Codex native goal" },
    skills: [],
    skillsCapability: { kind: "codex-native", available: true, label: "Codex skills" },
    goalRefreshWarning: null,
    skillDiscovery: { truncated: false, warningCount: 0, synchronizedAt: null },
    refreshedAt: "2026-08-01T00:00:00.000Z",
  };
}

function renderComposer(current: Conversation, overrides: Partial<ComposerProps> = {}) {
  const onCreateConversationForSelection = vi.fn<NonNullable<ComposerProps["onCreateConversationForSelection"]>>(async () => undefined);
  const props = composerProps(current, {
    providers,
    onCreateConversationForSelection,
    goal: {
      workflow: workflow(),
      loading: false,
      busy: false,
      error: null,
      onRetry: async () => undefined,
      onSetGoal: async () => undefined,
      onClearGoal: async () => undefined,
    },
    ...overrides,
  });
  const view = render(<Composer {...props} />);
  return { onCreateConversationForSelection, view, props };
}

async function confirmNewChat(): Promise<HTMLElement> {
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
  return dialog;
}

describe("replacement chat settings", () => {
  it.each(["click", "Enter"] as const)("carries Plan and supervised access when a mixed chat starts a new chat by %s", async (trigger) => {
    const current = chat({ mixedProviderHistory: true });
    const { onCreateConversationForSelection } = renderComposer(current);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "Keep planning." } });
    if (trigger === "click") fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));
    else fireEvent.keyDown(input, { key: "Enter" });
    await confirmNewChat();
    await waitFor(() => expect(onCreateConversationForSelection).toHaveBeenCalledOnce());
    expect(onCreateConversationForSelection.mock.calls[0]).toEqual([{
      selection: current.modelSelection,
      configuration: planSupervised,
      prefillText: "Keep planning.",
      sourceConversationId: conversationId,
      onCreated: expect.any(Function),
    }]);
  });

  it("carries the chat's settings from the reasoning menu of a mixed chat", async () => {
    const current = chat({ mixedProviderHistory: true });
    const { onCreateConversationForSelection } = renderComposer(current);
    fireEvent.click(await screen.findByRole("button", { name: "More composer options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Reasoning/u }));
    await waitFor(() => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: /High/u }));
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });
    await confirmNewChat();
    await waitFor(() => expect(onCreateConversationForSelection).toHaveBeenCalledOnce());
    expect(onCreateConversationForSelection.mock.calls[0]).toEqual([{
      selection: current.modelSelection,
      configuration: planSupervised,
      sourceConversationId: conversationId,
      onCreated: expect.any(Function),
    }]);
  });

  it("carries the chat's settings from the /goal new-chat action of a mixed chat", async () => {
    const current = chat({ mixedProviderHistory: true });
    const { onCreateConversationForSelection } = renderComposer(current);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "/goal" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const region = await screen.findByRole("region", { name: /goal/iu });
    fireEvent.click(region.querySelector<HTMLButtonElement>("button:not([aria-label])")!);
    await confirmNewChat();
    await waitFor(() => expect(onCreateConversationForSelection).toHaveBeenCalledOnce());
    expect(onCreateConversationForSelection.mock.calls[0]).toEqual([{
      selection: current.modelSelection,
      configuration: planSupervised,
      sourceConversationId: conversationId,
      onCreated: expect.any(Function),
    }]);
  });

  it("carries the chat's settings when the server rejects a send", async () => {
    const current = chat();
    const { onCreateConversationForSelection } = renderComposer(current, {
      onSend: vi.fn<ComposerProps["onSend"]>(async () => {
        throw new RuntimeCommandError(MIXED_PROVIDER_HISTORY_MESSAGE, "rejected");
      }),
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Continue." } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await confirmNewChat();
    await waitFor(() => expect(onCreateConversationForSelection).toHaveBeenCalledOnce());
    expect(onCreateConversationForSelection.mock.calls[0]).toEqual([{
      selection: current.modelSelection,
      configuration: planSupervised,
      prefillText: "Continue.",
      sourceConversationId: conversationId,
      onCreated: expect.any(Function),
    }]);
  });

  it("carries the chat's settings when the server rejects /compact", async () => {
    const current = chat();
    const { onCreateConversationForSelection } = renderComposer(current, {
      onCompact: vi.fn(async () => {
        throw new RuntimeCommandError(MIXED_PROVIDER_HISTORY_MESSAGE, "rejected");
      }),
    });
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "/compact keep the plan" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await confirmNewChat();
    await waitFor(() => expect(onCreateConversationForSelection).toHaveBeenCalledOnce());
    expect(onCreateConversationForSelection.mock.calls[0]).toEqual([{
      selection: current.modelSelection,
      configuration: planSupervised,
      sourceConversationId: conversationId,
      onCreated: expect.any(Function),
    }]);
  });

  it("carries the chat's settings when the server rejects a reasoning change", async () => {
    const current = chat();
    const { onCreateConversationForSelection } = renderComposer(current, {
      onUpdateConversation: vi.fn<ComposerProps["onUpdateConversation"]>(async () => {
        throw new RuntimeCommandError(MIXED_PROVIDER_HISTORY_MESSAGE, "rejected");
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: /Choose reasoning level/u }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /High/u }));
    await confirmNewChat();
    await waitFor(() => expect(onCreateConversationForSelection).toHaveBeenCalledOnce());
    expect(onCreateConversationForSelection.mock.calls[0]).toEqual([{
      selection: { ...current.modelSelection, reasoningEffort: "high" },
      configuration: planSupervised,
      sourceConversationId: conversationId,
      onCreated: expect.any(Function),
    }]);
  });

  it("carries the chat's settings when the model chooser needs a new chat for another provider", async () => {
    const current = chat({ mixedProviderHistory: false });
    const { onCreateConversationForSelection } = renderComposer(current, { hasVisibleHistory: true });
    fireEvent.click(screen.getByRole("button", { name: /Choose model/u }));
    fireEvent.click(await screen.findByRole("button", { name: /^Claude, /u }));
    fireEvent.click(screen.getByTitle("Claude Route").closest("button")!);
    const dialog = await confirmNewChat();
    expect(dialog).toHaveTextContent("Supervised · Plan");
    await waitFor(() => expect(onCreateConversationForSelection).toHaveBeenCalledOnce());
    expect(onCreateConversationForSelection.mock.calls[0]?.[0]).toMatchObject({
      selection: { harnessId: providerNativeModelSelection({ providerId: "claude" }).harnessId },
      configuration: planSupervised,
      sourceConversationId: conversationId,
    });
  });

  it("keeps a chat at the project defaults on its default settings", async () => {
    const current = chat({ mixedProviderHistory: true, accessMode: "supervised", interactionMode: "build" });
    const { onCreateConversationForSelection } = renderComposer(current);
    fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));
    expect(await confirmNewChat()).toHaveTextContent("Supervised · Build");
    await waitFor(() => expect(onCreateConversationForSelection).toHaveBeenCalledOnce());
    expect(onCreateConversationForSelection.mock.calls[0]).toEqual([{
      selection: current.modelSelection,
      configuration: { accessMode: "supervised", interactionMode: "build" },
      sourceConversationId: conversationId,
      onCreated: expect.any(Function),
    }]);
  });

  it("withdraws the offer when the chat's access mode changes while it is open", async () => {
    const current = chat({ mixedProviderHistory: true, accessMode: "full" });
    const { onCreateConversationForSelection, view, props } = renderComposer(current);
    fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Full access · Plan");
    view.rerender(<Composer {...props} conversation={{ ...current, accessMode: "supervised" }} />);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(onCreateConversationForSelection).not.toHaveBeenCalled();
  });
});
