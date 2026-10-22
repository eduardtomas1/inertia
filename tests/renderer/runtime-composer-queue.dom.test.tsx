import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeComposerQueuedActions } from "../../src/renderer/src/components/composer/RuntimeComposerQueuedActions";
import { enqueueRuntimePrompt, finishQueueIntent, queueIntent, RUNTIME_QUEUE_CHANGED, type QueueCommandRunner } from "../../src/renderer/src/components/composer/runtimeQueueClient";
import type { MessageQueueResult, QueuedMessage } from "../../src/shared/queued-messages";
import { RuntimeCommandError } from "../../src/renderer/src/utils/connectionMessages";
import { readSourceText } from "../helpers/source-text";

const conversationId = "40404040-4040-4040-8040-404040404040";
const queued: QueuedMessage = { id: "50505050-5050-4050-8050-505050505050", conversationId, content: "Next task", attachments: [], state: "waiting", createdAt: "2026-09-26T00:00:00.000Z", error: null, turnId: null, userMessageId: null };
const response = (entries = [queued], receipt: QueuedMessage | null = null): MessageQueueResult => ({ kind: "message.queue", conversationId, entries, receipt });
beforeEach(() => window.localStorage.clear());

describe("runtime queue presentation and durable draft identity", () => {
  it("defers a pending queue result until the window becomes visible again", async () => {
    let resolveRead!: (value: MessageQueueResult) => void;
    const pending = new Promise<MessageQueueResult>((resolve) => { resolveRead = resolve; });
    const run = vi.fn<QueueCommandRunner>().mockReturnValueOnce(pending).mockResolvedValue(response());
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const view = render(<RuntimeComposerQueuedActions conversationId={conversationId} onCommand={run} canSend
      latestTurnId="first" latestTurnStatus="completed" queueHost={null} />);
    try {
      visibility.mockReturnValue("hidden");
      await act(async () => { resolveRead(response()); await pending; });
      expect(screen.queryByText("Next task")).toBeNull();
      visibility.mockReturnValue("visible");
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      expect(screen.getByText("Next task")).toBeTruthy();
      expect(run).toHaveBeenCalledTimes(2);
    } finally { view.unmount(); visibility.mockRestore(); }
  });

  it.each([false, true])("does not commit identical polling results with queued entries=%s", async (hasEntry) => {
    vi.useFakeTimers();
    try {
      const run = vi.fn<QueueCommandRunner>().mockImplementation(async () => structuredClone(response(hasEntry ? [queued] : [])));
      let commits = 0;
      const view = render(<Profiler id="queue" onRender={() => { commits += 1; }}>
        <RuntimeComposerQueuedActions conversationId={conversationId} onCommand={run} canSend
          latestTurnId="first" latestTurnStatus="completed" queueHost={null} />
      </Profiler>);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const initialCommits = commits;
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(run).toHaveBeenCalledTimes(3);
      expect(commits).toBe(initialCommits);
      run.mockResolvedValue(response([{ ...queued, content: "Updated queue" }]));
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(screen.getByText("Updated queue")).toBeTruthy();
      expect(commits).toBe(initialCommits + 1);
      view.unmount();
    } finally { vi.useRealTimers(); }
  });

  it("stops polling a queue the service refuses until the chat's queue or turn changes", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn<QueueCommandRunner>().mockRejectedValue(new RuntimeCommandError("Conversation not found.", "rejected"));
      const props = { conversationId, onCommand: run, canSend: true, latestTurnStatus: null, queueHost: null };
      const view = render(<RuntimeComposerQueuedActions {...props} latestTurnId={null} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(run).toHaveBeenCalledTimes(1);
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      expect(run).toHaveBeenCalledTimes(1);
      run.mockResolvedValue(response());
      await act(async () => { window.dispatchEvent(new CustomEvent(RUNTIME_QUEUE_CHANGED, { detail: conversationId })); await vi.advanceTimersByTimeAsync(0); });
      expect(run).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Next task")).toBeTruthy();
      run.mockRejectedValue(new RuntimeCommandError("Conversation not found.", "rejected"));
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(run).toHaveBeenCalledTimes(3);
      run.mockResolvedValue(response());
      view.rerender(<RuntimeComposerQueuedActions {...props} latestTurnId="first" />);
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(run).toHaveBeenCalledTimes(5);
      view.unmount();
    } finally { vi.useRealTimers(); }
  });

  it("keeps polling after a read whose delivery is unknown", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn<QueueCommandRunner>().mockRejectedValue(new RuntimeCommandError("Timed out.", "ambiguous"));
      const view = render(<RuntimeComposerQueuedActions conversationId={conversationId} onCommand={run} canSend
        latestTurnId="first" latestTurnStatus="completed" queueHost={null} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(run).toHaveBeenCalledTimes(4);
      view.unmount();
    } finally { vi.useRealTimers(); }
  });

  it("keeps a second pending draft's identity when the first acknowledgement arrives", () => {
    const first = queueIntent(conversationId, "First", []);
    const second = queueIntent(conversationId, "Second", []);
    finishQueueIntent(conversationId, first);
    expect(queueIntent(conversationId, "Second", [])).toBe(second);
    expect(queueIntent(conversationId, "First", [])).not.toBe(first);
  });

  it("reuses the exact identity after an unknown acknowledgement", async () => {
    const run = vi.fn<QueueCommandRunner>().mockRejectedValueOnce(new Error("Disconnected"))
      .mockRejectedValueOnce(new Error("Still disconnected"))
      .mockImplementationOnce(async (command) => response([], { ...queued, id: command.payload.id!, state: "accepted" }));
    await expect(enqueueRuntimePrompt(run, conversationId, "Next task", [])).rejects.toThrow("Disconnected");
    await enqueueRuntimePrompt(run, conversationId, "Next task", []);
    expect(run.mock.calls[2]![0].payload.id).toBe(run.mock.calls[0]![0].payload.id);
  });

  it.each(["getItem", "setItem"] as const)("queues a draft when intent storage is unavailable (%s)", async (method) => {
    const storage = vi.spyOn(window.localStorage, method).mockImplementation(() => {
      throw new DOMException("Storage unavailable", method === "getItem" ? "SecurityError" : "QuotaExceededError");
    });
    try {
      const run = vi.fn<QueueCommandRunner>().mockImplementation(async (command) => response([], { ...queued, id: command.payload.id! }));
      await expect(enqueueRuntimePrompt(run, conversationId, "Next task", [])).resolves.toBeUndefined();
      expect(run.mock.calls.map(([command]) => command.type)).toEqual(["message.queue.enqueue"]);
    } finally { storage.mockRestore(); }
  });

  it("frees a definitively rejected intent only after confirming there is no receipt", async () => {
    const rejectedId = queueIntent(conversationId, "Next task", []);
    const run = vi.fn<QueueCommandRunner>().mockRejectedValueOnce(new RuntimeCommandError("Full queue", "rejected"))
      .mockResolvedValueOnce(response([], null));
    await expect(enqueueRuntimePrompt(run, conversationId, "Next task", [])).rejects.toThrow("Full queue");
    expect(queueIntent(conversationId, "Next task", [])).not.toBe(rejectedId);
    expect(run.mock.calls.map(([command]) => command.type)).toEqual(["message.queue.enqueue", "message.queue.get"]);
  });

  it("treats an existing durable receipt as acceptance after a postcommit error", async () => {
    const id = queueIntent(conversationId, "Next task", []);
    const run = vi.fn<QueueCommandRunner>().mockRejectedValueOnce(new RuntimeCommandError("Publication failed", "rejected"))
      .mockResolvedValueOnce(response([], { ...queued, id, state: "accepted", turnId: "turn" }));
    await expect(enqueueRuntimePrompt(run, conversationId, "Next task", [])).resolves.toBeUndefined();
    expect(run.mock.calls.filter(([command]) => command.type === "message.queue.enqueue")).toHaveLength(1);
    expect(window.localStorage.getItem(`inertia:queue-intent:${conversationId}`)).toBeNull();
  });

  it("only reads on mount or completion and sends exclusively after an explicit click", async () => {
    const run = vi.fn<QueueCommandRunner>().mockResolvedValue(response());
    const props = { conversationId, onCommand: run, canSend: true, latestTurnId: "first", latestTurnStatus: "completed", queueHost: null };
    const view = render(<RuntimeComposerQueuedActions {...props} />);
    await screen.findByText("Next task");
    view.rerender(<RuntimeComposerQueuedActions {...props} latestTurnId="second" />);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls.every(([command]) => command.type === "message.queue.get")).toBe(true);
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Send queued message now" })));
    expect(run.mock.calls.some(([command]) => command.type === "message.queue.send")).toBe(true);
  });

  it("lets Send now hand a queued message to a working agent that takes follow-ups, and shows when it cannot", async () => {
    const run = vi.fn<QueueCommandRunner>().mockResolvedValue(response());
    const props = { conversationId, onCommand: run, canSend: true, latestTurnId: "first", latestTurnStatus: "running", queueHost: null };
    const view = render(<RuntimeComposerQueuedActions {...props} />);
    const send = await screen.findByRole("button", { name: "Send queued message now" });
    expect(send).toBeEnabled();
    await act(async () => fireEvent.click(send));
    expect(run.mock.calls.some(([command]) => command.type === "message.queue.send")).toBe(true);
    view.rerender(<RuntimeComposerQueuedActions {...props} canSend={false} />);
    expect(screen.getByRole("button", { name: "Send queued message now" })).toBeDisabled();
    const css = readSourceText("src/renderer/src/components/composer/ComposerSendActions.css");
    expect(css).toContain(".composer-queue-send:disabled {\n  color: var(--text-muted);\n  opacity: var(--disabled-opacity);\n}");
  });

  it("keeps a Send now error through queue refreshes until that message leaves the head of the queue", async () => {
    const next: QueuedMessage = { ...queued, id: "60606060-6060-4060-8060-606060606060", content: "Another task" };
    let entries = [queued];
    const run = vi.fn<QueueCommandRunner>(async (command) => {
      if (command.type === "message.queue.send") throw new Error("The active model cannot inspect follow-up images. It will send when the turn ends.");
      return response(entries);
    });
    render(<RuntimeComposerQueuedActions conversationId={conversationId} onCommand={run} canSend latestTurnId="first" latestTurnStatus="running" queueHost={null} />);
    const send = await screen.findByRole("button", { name: "Send queued message now" });
    await act(async () => fireEvent.click(send));
    expect(screen.getByRole("status")).toHaveTextContent("cannot inspect follow-up images");

    await act(async () => window.dispatchEvent(new CustomEvent(RUNTIME_QUEUE_CHANGED, { detail: conversationId })));
    await waitFor(() => expect(run.mock.calls.filter(([command]) => command.type === "message.queue.get").length).toBeGreaterThanOrEqual(2));
    expect(screen.getByRole("status")).toHaveTextContent("cannot inspect follow-up images");

    entries = [next];
    await act(async () => window.dispatchEvent(new CustomEvent(RUNTIME_QUEUE_CHANGED, { detail: conversationId })));
    await screen.findByText("Another task");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not resurrect a removed entry when an earlier queue read finishes late", async () => {
    let resolveRead!: (value: MessageQueueResult) => void;
    const pending = new Promise<MessageQueueResult>((resolve) => { resolveRead = resolve; });
    const run = vi.fn<QueueCommandRunner>().mockResolvedValueOnce(response())
      .mockReturnValueOnce(pending).mockResolvedValue(response([]));
    render(<RuntimeComposerQueuedActions conversationId={conversationId} onCommand={run} canSend latestTurnId="first" latestTurnStatus="completed" queueHost={null} />);
    await screen.findByText("Next task");
    await act(async () => window.dispatchEvent(new CustomEvent(RUNTIME_QUEUE_CHANGED, { detail: conversationId })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove queued message" })));
    expect(screen.queryByText("Next task")).toBeNull();
    await act(async () => { resolveRead(response()); await pending; });
    expect(screen.queryByText("Next task")).toBeNull();
  });

  it("states a blocked entry's error once, in the status line, without repeating it in a tooltip", async () => {
    const blocked: QueuedMessage = { ...queued, state: "blocked", error: "The route is no longer available." };
    const run = vi.fn<QueueCommandRunner>().mockResolvedValue(response([blocked]));
    render(<RuntimeComposerQueuedActions conversationId={conversationId} onCommand={run} canSend latestTurnId="first" latestTurnStatus="completed" queueHost={null} />);
    const label = await screen.findByText("Needs attention");
    expect(label.tagName.toLowerCase()).toBe("small");
    expect(screen.getByRole("status")).toHaveTextContent("The route is no longer available.");
    vi.useFakeTimers();
    fireEvent.pointerEnter(label, { pointerType: "mouse" });
    act(() => { vi.advanceTimersByTime(500); });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    vi.useRealTimers();
  });
});
