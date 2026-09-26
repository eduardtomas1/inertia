import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeComposerQueuedActions } from "../../src/renderer/src/components/composer/RuntimeComposerQueuedActions";
import { enqueueRuntimePrompt, finishQueueIntent, queueIntent, type QueueCommandRunner } from "../../src/renderer/src/components/composer/runtimeQueueClient";
import type { MessageQueueResult, QueuedMessage } from "../../src/shared/queued-messages";

const conversationId = "40404040-4040-4040-8040-404040404040";
const queued: QueuedMessage = { id: "50505050-5050-4050-8050-505050505050", conversationId, content: "Next task", attachments: [], state: "waiting", createdAt: "2026-09-26T00:00:00.000Z", error: null, turnId: null, userMessageId: null };
const response = (entries = [queued], receipt: QueuedMessage | null = null): MessageQueueResult => ({ kind: "message.queue", conversationId, entries, receipt });
beforeEach(() => window.localStorage.clear());

describe("runtime queue presentation and durable draft identity", () => {
  it("keeps a second pending draft's identity when the first acknowledgement arrives", () => {
    const first = queueIntent(conversationId, "First", []);
    const second = queueIntent(conversationId, "Second", []);
    finishQueueIntent(conversationId, first);
    expect(queueIntent(conversationId, "Second", [])).toBe(second);
    expect(queueIntent(conversationId, "First", [])).not.toBe(first);
  });

  it("reuses the exact identity after an unknown acknowledgement", async () => {
    const run = vi.fn<QueueCommandRunner>().mockRejectedValueOnce(new Error("Disconnected"))
      .mockImplementationOnce(async (command) => response([], { ...queued, id: command.payload.id!, state: "accepted" }));
    await expect(enqueueRuntimePrompt(run, conversationId, "Next task", [])).rejects.toThrow("Disconnected");
    await enqueueRuntimePrompt(run, conversationId, "Next task", []);
    expect(run.mock.calls[1]![0].payload.id).toBe(run.mock.calls[0]![0].payload.id);
  });

  it("only reads on mount or completion and sends exclusively after an explicit click", async () => {
    const run = vi.fn<QueueCommandRunner>().mockResolvedValue(response());
    const props = { conversationId, onCommand: run, running: false, canSend: true, latestTurnId: "first", latestTurnStatus: "completed", queueHost: null };
    const view = render(<RuntimeComposerQueuedActions {...props} />);
    await screen.findByText("Next task");
    view.rerender(<RuntimeComposerQueuedActions {...props} latestTurnId="second" />);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls.every(([command]) => command.type === "message.queue.get")).toBe(true);
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Send queued message now" })));
    expect(run.mock.calls.some(([command]) => command.type === "message.queue.send")).toBe(true);
  });
});
