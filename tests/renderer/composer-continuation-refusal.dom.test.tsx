import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentWorkflowState, Conversation, ProviderInfo } from "../../src/shared/contracts";
import { MIXED_PROVIDER_HISTORY_MESSAGE } from "../../src/shared/continuation-policy";
import { Composer } from "../../src/renderer/src/components/Composer";
import type { ComposerProps } from "../../src/renderer/src/components/composer/types";
import { composerProps, conversation, provider } from "./composer-fixtures";

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
const providers: ProviderInfo[] = [{
  ...provider,
  models: [{
    id: "provider-default",
    label: "Codex Route",
    description: "Current route",
    isDefault: true,
    inputModalities: ["text"],
    reasoningOptions: [
      { value: "low", label: "Low", description: "" },
      { value: "high", label: "High", description: "" },
    ],
    defaultReasoningEffort: "low",
    fastMode: { providerValue: "priority", label: "Fast", description: "", isDefault: false },
  }],
  metadataState: { models: catalogState, rateLimits: catalogState },
}];

function chat(mixedProviderHistory: boolean): Conversation {
  return { ...conversation("33333333-3333-4333-8333-333333333333"), hasHistory: true, mixedProviderHistory };
}

function workflow(): AgentWorkflowState {
  return {
    conversationId: "33333333-3333-4333-8333-333333333333",
    goals: [],
    goalCapability: { kind: "codex-native", available: true, label: "Codex native goal" },
    skills: [],
    skillsCapability: { kind: "codex-native", available: true, label: "Codex skills" },
    goalRefreshWarning: null,
    skillDiscovery: { truncated: false, warningCount: 0, synchronizedAt: null },
    refreshedAt: "2026-08-01T00:00:00.000Z",
  };
}

function renderComposer(mixed: boolean, overrides: Partial<ComposerProps> = {}) {
  const handlers = {
    onSend: vi.fn<ComposerProps["onSend"]>(async () => undefined),
    onUpdateConversation: vi.fn<ComposerProps["onUpdateConversation"]>(async () => undefined),
    onCreateConversationForSelection: vi.fn<NonNullable<ComposerProps["onCreateConversationForSelection"]>>(async () => undefined),
    onCompact: vi.fn(async () => ({ message: "Compacted.", instructionForwarded: false })),
    onSetGoal: vi.fn(async () => undefined),
  };
  const current = chat(mixed);
  const view = render(<Composer {...composerProps(current, {
    providers,
    onSend: handlers.onSend,
    onUpdateConversation: handlers.onUpdateConversation,
    onCreateConversationForSelection: handlers.onCreateConversationForSelection,
    onCompact: handlers.onCompact,
    goal: {
      workflow: workflow(),
      loading: false,
      busy: false,
      error: null,
      onRetry: async () => undefined,
      onSetGoal: handlers.onSetGoal,
      onClearGoal: async () => undefined,
    },
    ...overrides,
  })} />);
  return { ...handlers, current, view };
}

function explanation(): HTMLElement {
  const notice = document.querySelector<HTMLElement>("[data-continuation-refusal]");
  if (!notice) throw new Error("Expected the composer continuation description.");
  return notice;
}

describe("composer for a chat that cannot continue", () => {
  it("describes the chat state without adding visible composer height and offers a new chat", async () => {
    const { onSend, onCreateConversationForSelection, current } = renderComposer(true);
    const notice = explanation();
    expect(notice).toHaveTextContent(MIXED_PROVIDER_HISTORY_MESSAGE);
    expect(notice).toHaveClass("visually-hidden");
    const input = screen.getByRole("textbox", { name: "Message" });
    expect(input.getAttribute("aria-describedby")).toBe(notice.id);
    expect(input).toHaveAttribute("placeholder", "This chat can't continue here. Start a new chat to keep working.");
    const start = screen.getByRole("button", { name: "Start a new chat" });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(MIXED_PROVIDER_HISTORY_MESSAGE);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onCreateConversationForSelection).toHaveBeenCalledOnce());
    expect(onCreateConversationForSelection.mock.calls[0]).toEqual([{
      selection: current.modelSelection,
      configuration: { accessMode: current.accessMode, interactionMode: current.interactionMode },
      sourceConversationId: current.id,
      onCreated: expect.any(Function),
    }]);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("replaces send with the new-chat action for Enter and keeps the draft", async () => {
    const { onSend, onCreateConversationForSelection } = renderComposer(true);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "Continue the legacy work." } });
    const start = screen.getByRole("button", { name: "Start a new chat" });
    expect(start).not.toHaveAttribute("aria-disabled");
    expect(start.getAttribute("aria-describedby")).toBe(explanation().id);
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(MIXED_PROVIDER_HISTORY_MESSAGE);
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("Continue the legacy work.");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onCreateConversationForSelection).toHaveBeenCalledOnce());
    expect(onCreateConversationForSelection.mock.calls[0]?.[0]).toMatchObject({ prefillText: "Continue the legacy work.", sourceConversationId: expect.any(String) });
  });

  it.each([
    ["reasoning", /Choose reasoning level/u],
    ["response speed", /Choose response speed/u],
  ] as const)("keeps the %s control focusable but unavailable with the explanation", (_control, name) => {
    const { onUpdateConversation } = renderComposer(true);
    const trigger = screen.getByRole("button", { name });
    trigger.focus();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    expect(trigger.getAttribute("aria-describedby")).toBe(explanation().id);
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onUpdateConversation).not.toHaveBeenCalled();
  });

  it("refuses /compact locally with the explanation", async () => {
    const { onCompact } = renderComposer(true);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "/compact keep the plan" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(MIXED_PROVIDER_HISTORY_MESSAGE));
    expect(onCompact).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "/com" } });
    expect(await screen.findByText(`Unavailable: ${MIXED_PROVIDER_HISTORY_MESSAGE}`)).toBeInTheDocument();
  });

  it("shows the goal command surface as unavailable with a new-chat action", async () => {
    const { onSetGoal, onCreateConversationForSelection } = renderComposer(true);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "/goal" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const region = await screen.findByRole("region", { name: /goal/iu });
    expect(region).toHaveTextContent(MIXED_PROVIDER_HISTORY_MESSAGE);
    expect(screen.queryByRole("form", { name: /Create Codex goal/u })).not.toBeInTheDocument();
    const newChat = region.querySelector<HTMLButtonElement>("button:not([aria-label])");
    expect(newChat).toHaveTextContent("New chat");
    await waitFor(() => expect(newChat).toHaveFocus());
    fireEvent.click(newChat!);
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(MIXED_PROVIDER_HISTORY_MESSAGE);
    expect(onSetGoal).not.toHaveBeenCalled();
    expect(onCreateConversationForSelection).not.toHaveBeenCalled();
  });

  it("leaves every control unchanged for a chat that can continue", async () => {
    const { onSend } = renderComposer(false);
    expect(document.querySelector("[data-continuation-refusal]")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Message" })).not.toHaveAttribute("aria-describedby");
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "Keep going." } });
    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("button", { name: /Choose reasoning level/u })).not.toHaveAttribute("aria-disabled");
    fireEvent.click(send);
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  });
});
