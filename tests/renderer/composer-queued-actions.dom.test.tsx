import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ComposerQueuedActions } from "../../src/renderer/src/components/composer/ComposerQueuedActions";
import {
  composerQueueKey,
  enqueueComposerPrompt,
  markComposerQueuedPromptDispatched,
  readComposerQueue,
} from "../../src/renderer/src/components/composer/composerQueuedPrompts";
import { RuntimeCommandError } from "../../src/renderer/src/utils/connectionMessages";

const conversationId = "40404040-4040-4040-8040-404040404040";

type SendQueued = (content: string, attachments: unknown[]) => Promise<unknown>;

function deferred(): { promise: Promise<unknown>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((settle, fail) => {
    resolve = () => settle(undefined);
    reject = fail;
  });
  return { promise, resolve, reject };
}

function view(onSendQueued: SendQueued, overrides: Partial<Parameters<typeof ComposerQueuedActions>[0]> = {}) {
  return (
    <ComposerQueuedActions
      conversationId={conversationId}
      canSendQueuedNow
      running={false}
      latestTurnId="turn-1"
      latestTurnStatus="completed"
      latestTurnAuthoritative
      queueHost={null}
      onSendQueued={onSendQueued}
      onReleaseAttachment={vi.fn(async () => undefined)}
      {...overrides}
    />
  );
}

describe("ComposerQueuedActions dispatch bookkeeping", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    expect(enqueueComposerPrompt(conversationId, "Continue with the plan")).toBe(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records the dispatch durably before the send crosses the boundary and removes it on success", async () => {
    const pending = deferred();
    const onSendQueued = vi.fn<SendQueued>(() => pending.promise);
    render(view(onSendQueued));
    await waitFor(() => expect(onSendQueued).toHaveBeenCalledOnce());
    // The reply is still pending: the persisted entry already carries the marker.
    expect(readComposerQueue(conversationId)[0]?.dispatchedAt).toEqual(expect.any(String));
    expect(screen.getByRole("button", { name: "Send queued message now" })).toHaveTextContent("Sending…");
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    await waitFor(() => expect(readComposerQueue(conversationId)).toEqual([]));
    expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull();
  });

  it("restores automatic eligibility only when the runtime is known not to have accepted the send", async () => {
    const onSendQueued = vi.fn<SendQueued>()
      .mockRejectedValueOnce(new RuntimeCommandError("Rejected.", "rejected"))
      .mockRejectedValueOnce(new RuntimeCommandError("Lost.", "ambiguous"));
    const { rerender } = render(view(onSendQueued));
    await waitFor(() => expect(onSendQueued).toHaveBeenCalledOnce());
    await waitFor(() => expect(readComposerQueue(conversationId)[0]?.dispatchedAt).toBeUndefined());
    expect(screen.getByText("Queued")).toBeInTheDocument();

    // The next completed turn may send it again, and this time delivery is unknown.
    rerender(view(onSendQueued, { latestTurnId: "turn-2" }));
    await waitFor(() => expect(onSendQueued).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("Send unconfirmed")).toBeInTheDocument());
    expect(readComposerQueue(conversationId)[0]?.dispatchedAt).toEqual(expect.any(String));

    // Later completed turns never send an unconfirmed prompt automatically.
    rerender(view(onSendQueued, { latestTurnId: "turn-3" }));
    await act(async () => { await Promise.resolve(); });
    expect(onSendQueued).toHaveBeenCalledTimes(2);
  });

  it("does not automatically resend a prompt whose dispatch was interrupted before the reply", async () => {
    // The previous renderer marked the prompt and was destroyed before the
    // runtime replied; this renderer starts from storage alone.
    const prompt = readComposerQueue(conversationId)[0]!;
    expect(markComposerQueuedPromptDispatched(conversationId, prompt.id)).toBe(true);
    const onSendQueued = vi.fn<SendQueued>(async () => undefined);
    render(view(onSendQueued));
    await act(async () => { await Promise.resolve(); });
    expect(onSendQueued).not.toHaveBeenCalled();
    expect(screen.getByText("Send unconfirmed")).toBeInTheDocument();

    // An explicit send is the reconciliation the label asks for.
    fireEvent.click(screen.getByRole("button", { name: "Send queued message now" }));
    await waitFor(() => expect(onSendQueued).toHaveBeenCalledOnce());
    await waitFor(() => expect(readComposerQueue(conversationId)).toEqual([]));
  });

  it("does not send at all when the dispatch record cannot be persisted", async () => {
    // A full or blocked storage: reads still see the queued prompt, writes fail.
    const original = window.localStorage;
    const key = composerQueueKey(conversationId);
    const stored = original.getItem(key);
    const quotaExceeded = (): never => { throw new Error("QuotaExceededError"); };
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        length: 0,
        key: () => null,
        getItem: (name: string) => (name === key ? stored : null),
        setItem: quotaExceeded,
        removeItem: quotaExceeded,
        clear: () => undefined,
      },
    });
    try {
      const onSendQueued = vi.fn<SendQueued>(async () => undefined);
      render(view(onSendQueued));
      await act(async () => { await Promise.resolve(); });
      expect(onSendQueued).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Send queued message now" })).toHaveTextContent("Send now");
    } finally {
      Object.defineProperty(window, "localStorage", { configurable: true, value: original });
    }
  });
});
