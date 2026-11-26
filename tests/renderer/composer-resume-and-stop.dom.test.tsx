import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageQueueResult, QueuedMessage } from "../../src/shared/queued-messages";
import { Composer } from "../../src/renderer/src/components/Composer";
import { useComposerStopAction } from "../../src/renderer/src/components/composer/useComposerStopAction";
import {
  composerFollowUpState,
  composerPrimaryActionState,
  STOP_REPEAT_LATCH_MS,
} from "../../src/renderer/src/utils/composerPrimaryAction";
import type { QueueCommandRunner } from "../../src/renderer/src/components/composer/runtimeQueueClient";
import { composerProps, conversation, routedProvider } from "./composer-fixtures";

afterEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
});

describe("composer Resume primary action, shared Stop/Resume latch, and unlocked running controls", () => {
  it("computes resume-ready and resume-pending in the primary-action matrix and honors manifest capabilityContract", () => {
    expect(composerPrimaryActionState({
      sendEligible: false,
      submitting: false,
      sending: false,
      running: false,
      stopping: false,
      resuming: false,
      resumeEligible: true,
    })).toBe("resume-ready");

    expect(composerPrimaryActionState({
      sendEligible: false,
      submitting: false,
      sending: false,
      running: false,
      stopping: false,
      resuming: true,
      resumeEligible: true,
    })).toBe("resume-pending");

    // Draft send takes precedence over resume when sendEligible is true.
    expect(composerPrimaryActionState({
      sendEligible: true,
      submitting: false,
      sending: false,
      running: false,
      stopping: false,
      resuming: false,
      resumeEligible: true,
    })).toBe("send-ready");

    // Manifest capabilityContract overrides defaults for steer, attachments, compaction, and interrupt.
    const contract = {
      schemaVersion: 1 as const,
      harnessId: "codex-app-server" as const,
      manifestDigest: "a".repeat(64),
      installationVerified: true,
      installedVersion: "1.0.0",
      currentlyAvailableCount: 2,
      declaredCapabilityCount: 4,
      hostToolBridgeAvailable: true,
      capabilities: [
        { id: "follow-up-steer", state: "available" as const },
        { id: "cancellation", state: "available" as const },
        { id: "steer-accepts-attachments", state: "unsupported" as const },
        { id: "steer-during-compaction", state: "unsupported" as const },
      ],
    };
    expect(composerFollowUpState({
      running: true,
      stopping: false,
      harnessId: "codex-app-server",
      capabilityContract: contract,
      hasAttachments: true,
      hasDraft: true,
      textOnly: true,
      submitting: false,
      sending: false,
    })).toBe("stop-and-send");

    expect(composerFollowUpState({
      running: true,
      stopping: false,
      harnessId: "codex-app-server",
      capabilityContract: contract,
      compacting: true,
      hasDraft: true,
      textOnly: true,
      submitting: false,
      sending: false,
    })).toBe("stop-and-send");
  });

  it("shares the 1s repeat latch and pending claim between stop() and resume() and resets on held change", async () => {
    vi.useFakeTimers();
    const onStop = vi.fn(async () => undefined);
    const onResume = vi.fn(async () => undefined);
    const { result, rerender } = renderHook(
      (props: { running: boolean; held: boolean }) => useComposerStopAction({
        conversationId: "chat-1",
        running: props.running,
        cancelling: false,
        held: props.held,
        onStop,
        onResume,
      }),
      { initialProps: { running: false, held: true } },
    );

    let first = false;
    let second = false;
    await act(async () => {
      first = await result.current.resume();
      second = await result.current.resume();
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(result.current.resuming).toBe(true);
    expect(result.current.actionPending).toBe(true);

    // Changing held state resets the latch cleanly.
    rerender({ running: false, held: false });
    expect(result.current.resuming).toBe(false);
    expect(result.current.actionPending).toBe(false);

    rerender({ running: true, held: false });
    await act(async () => {
      expect(await result.current.stop()).toBe(true);
      expect(await result.current.stop()).toBe(false);
    });
    expect(onStop).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(STOP_REPEAT_LATCH_MS + 10); });
  });

  it("shows Resume queue on a held idle chat, triggers resume on Enter when empty, and hides it when a question/approval is pending", async () => {
    const current = conversation("90909090-9090-4090-8090-909090909091");
    const heldEntry: QueuedMessage = {
      id: "91919191-9191-4191-8191-919191919191",
      conversationId: current.id,
      content: "Resume me",
      attachments: [],
      state: "waiting",
      queueHeld: true,
      createdAt: "2026-11-26T00:00:00.000Z",
      error: null,
      turnId: null,
      userMessageId: null,
    };
    const run = vi.fn<QueueCommandRunner>(async (command): Promise<MessageQueueResult> => {
      if (command.type === "message.queue.resume") {
        return { kind: "message.queue", conversationId: current.id, entries: [], receipt: null, held: false, canResume: false, revision: 2 };
      }
      return { kind: "message.queue", conversationId: current.id, entries: [heldEntry], receipt: null, held: true, holdReason: "stopped", canResume: true, revision: 1 };
    });

    const view = render(
      <Composer
        {...composerProps(current, { running: false, onQueueCommand: run })}
        hasPendingQuestionOrApproval={false}
      />,
    );

    const composer = screen.getByRole("region", { name: "Message composer" });
    const primaryResume = await within(composer).findByRole("button", { name: "Resume queue" }, { timeout: 5_000 });
    expect(primaryResume).toHaveAttribute("data-composer-action-state", "resume-ready");

    // Pending question/approval hides both primary and inline Resume buttons.
    view.rerender(
      <Composer
        {...composerProps(current, { running: false, onQueueCommand: run })}
        hasPendingQuestionOrApproval
      />,
    );
    expect(screen.queryByRole("button", { name: "Resume queue" })).toBeNull();

    // Clearing pending request restores Resume; Enter on empty composer triggers message.queue.resume.
    view.rerender(
      <Composer
        {...composerProps(current, { running: false, onQueueCommand: run })}
        hasPendingQuestionOrApproval={false}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Message" });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    await waitFor(() => expect(run).toHaveBeenCalledWith({
      type: "message.queue.resume",
      payload: { conversationId: current.id },
    }));
  });

  it("allows Stop and send when another message is already queued and unlocks model/settings/mode controls while running", async () => {
    const current = conversation("90909090-9090-4090-8090-909090909092");
    const existing: QueuedMessage = {
      id: "92929292-9292-4292-8292-929292929292",
      conversationId: current.id,
      content: "Already queued",
      attachments: [],
      state: "waiting",
      createdAt: "2026-11-26T00:00:00.000Z",
      error: null,
      turnId: null,
      userMessageId: null,
    };
    const kimiTurn = {
      ...({} as NonNullable<React.ComponentProps<typeof Composer>["latestTurn"]>),
      id: "93939393-9393-4393-8393-939393939393",
      status: "running" as const,
      harnessId: "kimi-acp" as const,
    };
    const run = vi.fn<QueueCommandRunner>(async (command): Promise<MessageQueueResult> => {
      if (command.type === "message.queue.stop-and-send") {
        return {
          kind: "message.queue",
          conversationId: current.id,
          entries: [existing],
          receipt: {
            ...existing,
            id: command.payload.id,
            content: command.payload.content,
          },
        };
      }
      return { kind: "message.queue", conversationId: current.id, entries: [existing], receipt: null };
    });

    const providerWithReasoning = {
      ...routedProvider,
      models: [{
        ...routedProvider.models[0]!,
        reasoningOptions: [{ value: "high", label: "High", description: "Deep" }],
        defaultReasoningEffort: "high",
      }],
    };
    render(
      <Composer
        {...composerProps(current, {
          running: true,
          providers: [providerWithReasoning],
          latestTurn: kimiTurn,
          onQueueCommand: run,
        })}
      />,
    );

    await screen.findByText("Already queued", undefined, { timeout: 5_000 });
    // Queue slot renders in-flow above .composer inside .composer-shell.
    const shell = document.querySelector(".composer-shell")!;
    expect(shell.firstElementChild).toHaveClass("composer-queue-slot");

    // Controls are unlocked while running (Decision 4.8).
    expect(screen.getByRole("button", { name: /Choose project access/u })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Choose work mode/u })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Choose model/u })).toBeEnabled();

    // Stop and send works even though another message is already queued (no old refusal!).
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "Urgent override" } });
    expect(screen.getByRole("button", { name: "Stop and send" })).toBeEnabled();
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    await waitFor(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({
      type: "message.queue.stop-and-send",
      payload: expect.objectContaining({ content: "Urgent override", turnId: kimiTurn.id }),
    })));
    expect(screen.queryByText("Send or remove the queued message first.")).toBeNull();
  });
});
