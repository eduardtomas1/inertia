import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Composer } from "../../src/renderer/src/components/Composer";
import { DuoJudgeNoticeContext } from "../../src/renderer/src/components/DuoJudgeNoticeContext";
import type { ComposerProps } from "../../src/renderer/src/components/composer/types";
import type { DuoJudgeNotices } from "../../src/renderer/src/hooks/useDuoLaunchWatch";
import type {
  ConversationCompactAndSendResult,
  ConversationShell,
  ProviderInfo,
  ThreadUsageSnapshot,
} from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { composerProps, conversation, deferred, provider } from "./composer-fixtures";

const conversationId = "55555555-5555-4555-8555-555555555555";
const freshCatalog = {
  freshness: "fresh" as const,
  provenance: "provider" as const,
  updatedAt: "2026-10-25T09:00:00.000Z",
  lastAttemptedAt: "2026-10-25T09:00:00.000Z",
  refreshing: false,
};
const claude: ProviderInfo = {
  ...provider,
  id: "claude",
  label: "Claude",
  command: "claude",
  accountKind: "Console API key",
  models: [{
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    description: "",
    isDefault: true,
    inputModalities: ["text"],
    reasoningOptions: [],
    defaultReasoningEffort: "",
  }],
  metadataState: { models: freshCatalog, rateLimits: freshCatalog },
};

function chat(overrides: Partial<ConversationShell> = {}): ConversationShell {
  return {
    ...conversation(conversationId),
    providerId: "claude",
    modelSelection: providerNativeModelSelection({
      providerId: "claude",
      modelId: "provider-default",
      reasoningEffort: null,
    }),
    hasHistory: true,
    latestTurn: null,
    pendingApproval: false,
    pendingInput: false,
    ...overrides,
  };
}

function usage(minutesIdle: number, usedTokens = 252_000): ThreadUsageSnapshot {
  return {
    conversationId,
    turnId: null,
    usedTokens,
    totalProcessedTokens: null,
    totalProcessedScope: null,
    maxTokens: 1_000_000,
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    compactsAutomatically: null,
    promptCache: {
      lastRequestStartedAt: new Date(Date.now() - minutesIdle * 60_000).toISOString(),
      lifetimeMs: null,
      source: "assumed",
    },
    updatedAt: new Date().toISOString(),
  };
}

function sent(): ConversationCompactAndSendResult {
  return {
    kind: "conversation.compact-and-send",
    outcome: "sent",
    conversationId,
    turnId: "66666666-6666-4666-8666-666666666666",
    userMessageId: "77777777-7777-4777-8777-777777777777",
    disposition: "new-turn",
    compaction: {
      providerId: "claude",
      beforeTokens: 252_000,
      afterTokens: 18_300,
      instructionForwarded: false,
      trigger: "on-return",
    },
  };
}

function props(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return composerProps(chat(), {
    providers: [claude],
    usage: usage(20),
    compactOnReturnSetting: "offer",
    onCompactAndSend: vi.fn(async () => sent()),
    ...overrides,
  });
}

function textbox(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

function type(value: string): void {
  fireEvent.change(textbox(), { target: { value } });
}

async function primary(name: string): Promise<HTMLElement> {
  return await screen.findByRole("button", { name });
}

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("compact on return composer offer", () => {
  it("offers Compact and send for an eligible idle chat with a large history", async () => {
    render(<Composer {...props()} />);
    type("Pick up where we left off");

    expect(await screen.findByRole("button", { name: "History: Compact" })).toBeVisible();
    const button = await primary("Compact and send");
    expect(button).toHaveAccessibleDescription("Summarize 252K tokens of history, then send");
    expect(button).toHaveTextContent("Compact and send");
    expect(screen.getByRole("button", { name: "History: Compact" })).toBeVisible();
  });

  it.each([
    ["the setting is off", { compactOnReturnSetting: "never" as const }],
    ["the chat is under 200K tokens", { usage: usage(20, 199_999) }],
    ["the prompt cache is still warm", { usage: usage(2) }],
    ["the turn is still running", { running: true }],
    ["compact and send is unavailable for this chat", { onCompactAndSend: undefined }],
    ["the provider is signed in with a Claude account", { providers: [{ ...claude, accountKind: "Claude account" as const }] }],
  ])("stays a plain send when %s", async (_reason, overrides) => {
    render(<Composer {...props(overrides)} />);
    type("Pick up where we left off");

    expect(screen.queryByRole("button", { name: "Compact and send" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^History:/u })).toBeNull();
  });

  function lastTurn(overrides: Partial<NonNullable<ComposerProps["latestTurnSummary"]>>): NonNullable<ComposerProps["latestTurnSummary"]> {
    const current = chat();
    return {
      id: "88888888-8888-4888-8888-888888888888",
      runId: "run-before-return",
      status: "completed",
      providerId: "claude",
      harnessId: current.modelSelection.harnessId,
      backendProfileId: current.modelSelection.backendProfileId,
      modelSelection: current.modelSelection,
      continuationIdentity: null as unknown as NonNullable<ComposerProps["latestTurnSummary"]>["continuationIdentity"],
      model: "",
      reasoningEffort: "",
      requestedAt: "2026-10-25T09:00:00.000Z",
      startedAt: "2026-10-25T09:00:00.000Z",
      completedAt: "2026-10-25T09:01:00.000Z",
      terminalReason: null,
      updatedAt: "2026-10-25T09:01:00.000Z",
      ...overrides,
    };
  }

  it.each([
    ["hit a usage limit", { status: "completed" as const, usageLimited: true }],
    ["failed on billing", { status: "failed" as const, failureKind: "billing" as const }],
    ["failed on sign-in", { status: "failed" as const, failureKind: "authentication" as const }],
    ["was rate limited", { status: "failed" as const, failureKind: "rate-limited" as const }],
  ])("does not offer when the last turn %s, as the runtime would refuse it", async (_reason, overrides) => {
    const onSend = vi.fn(async () => undefined);
    const onCompactAndSend = vi.fn(async () => sent());
    render(<Composer {...props({ onSend, onCompactAndSend, latestTurnSummary: lastTurn(overrides) })} />);
    type("Try once more");
    await primary("Send message");
    expect(screen.queryByRole("button", { name: "Compact and send" })).toBeNull();

    fireEvent.keyDown(textbox(), { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Try once more", [], undefined));
    expect(onCompactAndSend).not.toHaveBeenCalled();
  });

  it("still offers after a last turn that failed for another reason", async () => {
    render(<Composer {...props({ latestTurnSummary: lastTurn({ status: "failed", failureKind: "model-not-found" }) })} />);
    type("Use the other model");
    expect(await screen.findByRole("button", { name: "History: Compact" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Compact and send" })).toBeInTheDocument();
  });

  it("sends a queued message as it is, without the offer", async () => {
    const current = chat();
    window.localStorage.setItem(
      `inertia:queued-prompts:v2:${current.id}`,
      JSON.stringify([{ id: "queued-1", content: "Queued before the break", createdAt: "2026-10-25T09:30:00.000Z", attachments: [] }]),
    );
    const onSend = vi.fn(async () => undefined);
    const onCompactAndSend = vi.fn(async () => sent());
    render(<Composer {...props({ conversation: current, onSend, onCompactAndSend })} />);
    const queue = await screen.findByRole("list", { name: "Queued messages" }, { timeout: 5_000 });
    expect(screen.queryByRole("button", { name: "Compact and send" })).toBeNull();
    expect(within(queue).queryByText(/compact/iu)).toBeNull();

    fireEvent.click(within(queue).getByRole("button", { name: "Send queued message now" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Queued before the break", [], undefined));
    expect(onCompactAndSend).not.toHaveBeenCalled();
  });

  it("does not offer while the draft cannot be sent or is a /compact command", async () => {
    render(<Composer {...props()} />);
    await primary("Send message");
    expect(screen.queryByRole("button", { name: "Compact and send" })).toBeNull();

    type("/compact");
    expect(screen.queryByRole("button", { name: "Compact and send" })).toBeNull();
  });

  it("does not offer in a Duo judge chat", async () => {
    const notices = {
      comparisonForConversation: () => ({
        launchId: "launch",
        role: "judge",
        sideStarted: false,
        othersFinished: true,
        comparison: { state: "running" },
      }),
    } as unknown as DuoJudgeNotices;
    render(
      <DuoJudgeNoticeContext.Provider value={notices}>
        <Composer {...props()} />
      </DuoJudgeNoticeContext.Provider>,
    );
    type("Judge again");
    await primary("Send message");
    expect(screen.queryByRole("button", { name: "Compact and send" })).toBeNull();
  });

  it("offers once the prompt cache expires while the chat is open", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      vi.setSystemTime(Date.parse("2026-10-25T10:04:00.000Z"));
      const warm: ThreadUsageSnapshot = {
        ...usage(0),
        promptCache: { lastRequestStartedAt: "2026-10-25T10:00:00.000Z", lifetimeMs: null, source: "assumed" },
      };
      render(<Composer {...props({ usage: warm })} />);
      type("Back again");
      expect(screen.queryByRole("button", { name: "Compact and send" })).toBeNull();

      await act(async () => { vi.advanceTimersByTime(61_000); });
      expect(screen.getByRole("button", { name: "Compact and send" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("toggles to full history for this message and Enter sends what the button says", async () => {
    const onSend = vi.fn(async () => undefined);
    const onCompactAndSend = vi.fn(async () => sent());
    render(<Composer {...props({ onSend, onCompactAndSend })} />);
    type("Send it whole");

    const chip = await screen.findByRole("button", { name: "History: Compact" });
    expect(chip).toHaveAccessibleDescription("Send with full history instead");
    chip.focus();
    fireEvent.click(chip);
    expect(screen.getByRole("button", { name: "History: Full" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "History: Full" }))
      .toHaveAccessibleDescription("Compact before sending instead");
    expect(screen.queryByRole("button", { name: "Compact and send" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();

    fireEvent.keyDown(textbox(), { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Send it whole", [], undefined));
    expect(onCompactAndSend).not.toHaveBeenCalled();
  });

  it("sends Compact and send with Enter and keeps the draft until the turn is accepted", async () => {
    const pending = deferred<ConversationCompactAndSendResult>();
    const onCompactAndSend = vi.fn(() => pending.promise);
    const onSend = vi.fn(async () => undefined);
    render(<Composer {...props({ onSend, onCompactAndSend })} />);
    type("Continue the migration");
    await primary("Compact and send");

    fireEvent.keyDown(textbox(), { key: "Enter" });
    await waitFor(() => expect(onCompactAndSend).toHaveBeenCalledWith("Continue the migration", [], undefined));
    expect(onSend).not.toHaveBeenCalled();
    expect(textbox()).toHaveValue("Continue the migration");
    expect(screen.getByRole("status")).toHaveTextContent("Compacting before sending…");
    expect(screen.getByRole("button", { name: "Compacting before sending" })).toHaveAttribute("aria-busy", "true");

    await act(async () => { pending.resolve(sent()); await pending.promise; });
    expect(textbox()).toHaveValue("");
    expect(screen.queryByText("Compacting before sending…")).toBeNull();
  });

  it("sends the draft's context with Compact and send exactly as a plain send would", async () => {
    const onCompactAndSend = vi.fn<NonNullable<ComposerProps["onCompactAndSend"]>>(async () => sent());
    render(<Composer {...props({
      onCompactAndSend,
      promptContext: "Local review note for src/app.ts:\nKeep the retry bounded.",
    })} />);
    type("Review this change");
    fireEvent.click(await primary("Compact and send"));

    await waitFor(() => expect(onCompactAndSend).toHaveBeenCalledTimes(1));
    const [content, attachments, context] = onCompactAndSend.mock.calls[0]!;
    expect(content).toBe("Review this change");
    expect(attachments).toEqual([]);
    expect(context).toEqual({ reviewNotes: [{ path: "src/app.ts", body: "Keep the retry bounded.", stale: false }] });
  });

  it("shows the compacting state from the chat in every window", () => {
    const shell = chat({ compaction: { state: "compacting", trigger: "on-return", startedAt: new Date().toISOString() } });
    render(<Composer {...props({ conversation: shell })} />);
    type("Queued thought");

    expect(screen.getByRole("status")).toHaveTextContent("Compacting before sending…");
    expect(screen.queryByRole("button", { name: "Compact and send" })).toBeNull();
    expect(screen.getByRole("button", { name: "Compacting before sending" })).toBeDisabled();
    expect(textbox()).not.toHaveAttribute("readonly");
  });

  it("keeps the draft after a failed compaction and offers both ways forward", async () => {
    const onCompactAndSend = vi.fn<NonNullable<ComposerProps["onCompactAndSend"]>>()
      .mockResolvedValueOnce({
        kind: "conversation.compact-and-send",
        conversationId,
        outcome: "compaction-failed",
        message: "Claude could not summarize this chat. Nothing was sent.",
      })
      .mockResolvedValueOnce(sent());
    const onSend = vi.fn(async () => undefined);
    render(<Composer {...props({ onSend, onCompactAndSend })} />);
    type("Keep this draft");
    fireEvent.click(await primary("Compact and send"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Claude could not summarize this chat. Nothing was sent.");
    expect(textbox()).toHaveValue("Keep this draft");
    expect(within(alert).getByRole("button", { name: "Send without compacting" })).toBeEnabled();
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeEnabled();

    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onCompactAndSend).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(textbox()).toHaveValue(""));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends without compacting from the failure notice", async () => {
    const onCompactAndSend = vi.fn<NonNullable<ComposerProps["onCompactAndSend"]>>().mockResolvedValue({
      kind: "conversation.compact-and-send",
      conversationId,
      outcome: "compaction-failed",
      message: "Compaction timed out. Nothing was sent.",
    });
    const onSend = vi.fn(async () => undefined);
    render(<Composer {...props({ onSend, onCompactAndSend })} />);
    type("Send it anyway");
    fireEvent.click(await primary("Compact and send"));

    fireEvent.click(await screen.findByRole("button", { name: "Send without compacting" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Send it anyway", [], undefined));
    expect(onCompactAndSend).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(textbox()).toHaveValue(""));
  });
});
