import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Conversation, ConversationLatestTurnSummary, ProviderInfo } from "../../src/shared/contracts";
import { continuationIdentityForSelection, providerNativeModelSelection } from "../../src/shared/model-routing";
import type { RoutingDecisionSummary } from "../../src/shared/routing/routing-policy";
import { Composer } from "../../src/renderer/src/components/Composer";
import type { ComposerProps } from "../../src/renderer/src/components/composer/types";
import { autoRouteChipOverride, routingDecisionText } from "../../src/renderer/src/components/routing/useAutoRouting";
import { composerProps, conversation, provider } from "./composer-fixtures";

const conversationId = "22222222-2222-4222-8222-222222222222";
const fresh = {
  freshness: "fresh" as const,
  provenance: "provider" as const,
  updatedAt: "2026-08-01T00:00:00.000Z",
  lastAttemptedAt: "2026-08-01T00:00:00.000Z",
  refreshing: false,
};
const codex: ProviderInfo = {
  ...provider,
  metadataState: { models: fresh, rateLimits: fresh },
  models: [
    {
      id: "gpt-5.6", label: "GPT-5.6", description: "", isDefault: true, inputModalities: ["text"],
      reasoningOptions: [{ value: "high", label: "High", description: "" }], defaultReasoningEffort: "high",
    },
    {
      id: "gpt-6.1-sol", label: "GPT-6.1 Sol", description: "", isDefault: false, inputModalities: ["text"],
      reasoningOptions: [{ value: "high", label: "High", description: "" }], defaultReasoningEffort: "high",
    },
  ],
};
const decision: RoutingDecisionSummary = {
  picker: "rules",
  tier: "heavy",
  taskKind: "debugging",
  confidence: 0.6,
  outcome: "applied",
  reason: "Debugging, 60% confidence → Heavy tier: GPT-6.1 Sol · high.",
  previousRoute: { providerId: "codex", modelId: "gpt-5.6", reasoningEffort: "high" },
};

function autoChat(routingMode: Conversation["routingMode"] = "auto"): Conversation {
  return {
    ...conversation(conversationId),
    hasHistory: true,
    routingMode,
    modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "gpt-6.1-sol", reasoningEffort: "high" }),
    model: "gpt-6.1-sol",
    reasoningEffort: "high",
  };
}

function latestTurn(routing?: RoutingDecisionSummary): ConversationLatestTurnSummary {
  const modelSelection = autoChat().modelSelection;
  return {
    id: "latest-turn", runId: "latest-run", status: "completed", providerId: "codex",
    harnessId: modelSelection.harnessId, backendProfileId: modelSelection.backendProfileId, modelSelection,
    continuationIdentity: continuationIdentityForSelection(modelSelection), model: modelSelection.modelId,
    reasoningEffort: "high", requestedAt: "2026-07-29T08:00:00.000Z", startedAt: "2026-07-29T08:00:00.000Z",
    completedAt: "2026-07-29T08:01:00.000Z", terminalReason: null, updatedAt: "2026-07-29T08:01:00.000Z",
    ...(routing ? { routing } : {}),
  };
}

function renderComposer(current: Conversation, overrides: Partial<ComposerProps> = {}) {
  const onUpdateConversation = vi.fn<ComposerProps["onUpdateConversation"]>(async () => undefined);
  render(<Composer {...composerProps(current, { providers: [codex], onUpdateConversation, ...overrides })} />);
  return { onUpdateConversation };
}

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("Auto routing in the composer", () => {
  it("hides Auto when routing is disabled", async () => {
    renderComposer(autoChat(), { latestTurnSummary: latestTurn(decision) });
    const chip = screen.getByRole("button", { name: /Choose model/u });
    expect(chip).not.toHaveAttribute("data-routing-mode");
    expect(chip).not.toHaveTextContent(/Auto/u);
    fireEvent.click(chip);
    await screen.findByRole("dialog", { name: "Choose model" });
    expect(screen.queryByRole("button", { name: /^Auto:/u })).not.toBeInTheDocument();
  });

  it("shows the Auto badge with the routed model and explains the latest decision", () => {
    renderComposer(autoChat(), { routingEnabled: true, latestTurnSummary: latestTurn(decision) });
    const chip = screen.getByRole("button", { name: /Choose model\. Auto routing is on/u });
    expect(chip).toHaveAttribute("data-routing-mode", "auto");
    // The effort control beside the chip already shows the effort.
    expect(chip).toHaveTextContent(/^Auto · GPT-6\.1 Sol$/u);
    expect(chip).toHaveAccessibleName(
      "Choose model. Auto routing is on; currently GPT-6.1 Sol · High. "
      + "Rules picker · Debugging · Heavy tier · 60% confidence · Switched model. "
      + "Choosing a model or effort turns Auto off for this chat.",
    );
    expect(chip.getAttribute("aria-label")).not.toContain(decision.reason);
  });

  it("shows the decision as a route line, a decision line and the override hint", async () => {
    renderComposer(autoChat(), { routingEnabled: true, latestTurnSummary: latestTurn(decision) });
    const chip = screen.getByRole("button", { name: /Choose model\. Auto routing is on/u });
    fireEvent.pointerEnter(chip, { pointerType: "mouse" });
    const tooltip = await screen.findByRole("tooltip", { hidden: true }, { timeout: 2_000 });
    expect(tooltip).toHaveClass("tooltip", "is-multiline");
    expect(tooltip.textContent?.split("\n")).toEqual([
      "Auto routing → GPT-6.1 Sol · High",
      "Rules picker · Debugging · Heavy tier · 60% confidence · Switched model",
      "Choosing a model or effort turns Auto off for this chat.",
    ]);
    fireEvent.pointerLeave(chip, { pointerType: "mouse" });
  });

  it("marks Auto selected in the chooser and offers it to manual chats", async () => {
    const { onUpdateConversation } = renderComposer(autoChat("manual"), { routingEnabled: true });
    expect(screen.getByRole("button", { name: /Choose model/u })).not.toHaveTextContent(/Auto ·/u);
    fireEvent.click(screen.getByRole("button", { name: /Choose model/u }));
    const auto = await screen.findByRole("button", { name: /^Auto:.*Currently GPT-6\.1 Sol · High/u });
    expect(auto).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(auto);
    await waitFor(() => expect(onUpdateConversation).toHaveBeenCalledWith({ routingMode: "auto" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose model" })).not.toBeInTheDocument());
  });

  it("turns Auto off when a concrete model is picked", async () => {
    const { onUpdateConversation } = renderComposer(autoChat(), { routingEnabled: true, latestTurnSummary: latestTurn(decision) });
    fireEvent.click(screen.getByRole("button", { name: /Choose model/u }));
    const auto = await screen.findByRole("button", { name: /^Auto:/u });
    expect(auto).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(await screen.findByRole("button", { name: /^Codex, /u }));
    const target = screen.getByTitle("GPT-5.6").closest("button");
    if (!target) throw new Error("Expected the GPT-5.6 route.");
    fireEvent.click(target);
    await waitFor(() => expect(onUpdateConversation).toHaveBeenCalledOnce());
    expect(onUpdateConversation.mock.calls[0]![0]).toMatchObject({
      routingMode: "manual",
      modelSelection: expect.objectContaining({ modelId: "gpt-5.6" }),
    });
  });
});

describe("Auto routing text", () => {
  it("describes a decision and the pending state", () => {
    expect(routingDecisionText({ ...decision, outcome: "low-confidence", reason: "" }))
      .toBe("Rules picker · Debugging · Heavy tier · 60% confidence · Low confidence");
    expect(autoRouteChipOverride("GPT-5.6", "High", null)).toEqual({
      label: "Auto · GPT-5.6",
      tooltip: "Auto routing → GPT-5.6 · High\nAuto chooses a model when you send the next message.\nChoosing a model or effort turns Auto off for this chat.",
      accessibleName: "Choose model. Auto routing is on; currently GPT-5.6 · High. Auto chooses a model when you send the next message. Choosing a model or effort turns Auto off for this chat.",
    });
    expect(autoRouteChipOverride("GPT-5.6", null, decision).tooltip).toBe(
      "Auto routing → GPT-5.6\nRules picker · Debugging · Heavy tier · 60% confidence · Switched model\nChoosing a model or effort turns Auto off for this chat.",
    );
  });
});
