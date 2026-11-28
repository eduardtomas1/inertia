import { act, render, renderHook, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RuntimeComposerQueuedActions } from "../../src/renderer/src/components/composer/RuntimeComposerQueuedActions";
import type { QueueCommandRunner } from "../../src/renderer/src/components/composer/runtimeQueueClient";
import { useRuntimeQueuedFollowUps, useRuntimeQueueSummary } from "../../src/renderer/src/components/composer/runtimeQueueEvents";
import type { MessageQueueResult, QueuedMessage } from "../../src/shared/queued-messages";

const conversationId = "73737373-7373-4373-8373-737373737373";
const followUp: QueuedMessage = {
  id: "74747474-7474-4474-8474-747474747474", conversationId, content: "Unread follow-up", attachments: [],
  state: "waiting", createdAt: "2026-11-23T00:00:00.000Z", error: null, turnId: null,
  userMessageId: "75757575-7575-4575-8575-757575757575", queueHeld: true,
};

describe("the composer queue across turn status changes", () => {
  it("keeps the queue, its held summary, and hidden unread follow-ups while it refetches for a new turn status", async () => {
    let release: ((value: MessageQueueResult) => void) | null = null;
    const loaded: MessageQueueResult = { kind: "message.queue", conversationId, entries: [followUp], receipt: null, held: true, canResume: true };
    const run = vi.fn<QueueCommandRunner>(async () => {
      if (run.mock.calls.length === 1) return loaded;
      return await new Promise<MessageQueueResult>((resolve) => { release = resolve; });
    });
    const props = { conversationId, onCommand: run, canSend: true, latestTurnId: "turn-1", queueHost: null };
    const view = render(<RuntimeComposerQueuedActions {...props} latestTurnStatus="running" />);
    const followUps = renderHook(() => useRuntimeQueuedFollowUps(conversationId));
    const summary = renderHook(() => useRuntimeQueueSummary(conversationId));
    const list = await screen.findByRole("list", { name: "Queued messages" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(followUps.result.current).toEqual([followUp.userMessageId]);
    expect(summary.result.current.held).toBe(true);

    view.rerender(<RuntimeComposerQueuedActions {...props} latestTurnStatus="completed" />);
    expect(run).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("list", { name: "Queued messages" })).toBeInTheDocument();
    expect(followUps.result.current).toEqual([followUp.userMessageId]);
    expect(summary.result.current.held).toBe(true);

    await act(async () => { release!(loaded); });
    expect(followUps.result.current).toEqual([followUp.userMessageId]);
    view.unmount();
  });
});
