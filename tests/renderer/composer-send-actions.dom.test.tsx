import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ComposerSendActions } from "../../src/renderer/src/components/composer/ComposerSendActions";
import { ComposerSendActionsFallback } from "../../src/renderer/src/components/composer/ComposerSendActionsFallback";
import {
  composerMediaQueueKey,
  readComposerQueue,
} from "../../src/renderer/src/components/composer/composerQueuedPrompts";
import type { QueueCommandRunner } from "../../src/renderer/src/components/composer/runtimeQueueClient";
import type { ChatAttachment } from "../../src/shared/contracts";
import type { MessageQueueResult, QueuedMessage } from "../../src/shared/queued-messages";

const idle = {
  conversationId: "composer-actions",
  canSendQueuedNow: true,
  running: false,
  latestTurnId: null,
  latestTurnStatus: null,
  onSendQueued: vi.fn(async () => undefined),
  onReleaseAttachment: vi.fn(async () => undefined),
  onSubmit: vi.fn(async () => undefined),
  onStop: vi.fn(async () => undefined),
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("composer morphing send actions", () => {
  it.each([
    ["send-disabled", "Send message", { disabled: true, resting: false, busy: false, stop: false, icon: "send" }],
    ["send-ready", "Send message", { disabled: false, resting: false, busy: false, stop: false, icon: "send" }],
    ["submitting", "Sending message", { disabled: true, resting: false, busy: true, stop: false, icon: "sending" }],
    ["stop-ready", "Stop agent", { disabled: false, resting: false, busy: false, stop: true, icon: "stop" }],
    ["stop-pending", "Stopping agent", { disabled: false, resting: false, busy: true, stop: true, icon: "stop" }],
    ["stop-and-send", "Stop and send", { disabled: false, resting: false, busy: false, stop: true, icon: "stop" }],
  ] as const)("presents %s as %s in the deferred action and its fallback", (primaryAction, label, expected) => {
    const view = render(<ComposerSendActionsFallback {...idle} primaryAction={primaryAction} />);
    for (const deferred of [false, true]) {
      if (deferred) view.rerender(<ComposerSendActions {...idle} primaryAction={primaryAction} />);
      const primary = screen.getByRole("button", { name: label });
      expect(primary).toHaveClass("send-button");
      expect(primary).toHaveAttribute("data-composer-action-state", primaryAction);
      expect(primary.classList.contains("stop-button")).toBe(expected.stop);
      expect(primary.hasAttribute("disabled")).toBe(expected.disabled);
      expect(primary.getAttribute("aria-disabled")).toBe(expected.resting ? "true" : null);
      expect(primary).toHaveAttribute("aria-busy", String(expected.busy));
      if (deferred) {
        expect(primary).toHaveAttribute("data-motion-state", expected.icon);
        expect(primary.querySelector("svg")).toHaveAttribute("width", "16");
      }
    }
  });

  it("focuses the message input instead of sending when the draft is empty and the resting send is activated", () => {
    const onSubmit = vi.fn(async () => undefined);
    const onFocusInput = vi.fn();
    const view = render(<ComposerSendActionsFallback {...idle} awaitingInput onSubmit={onSubmit} onFocusInput={onFocusInput} primaryAction="send-disabled" />);
    for (const deferred of [false, true]) {
      if (deferred) view.rerender(<ComposerSendActions {...idle} awaitingInput onSubmit={onSubmit} onFocusInput={onFocusInput} primaryAction="send-disabled" />);
      const primary = screen.getByRole("button", { name: "Send message" });
      expect(primary).toBeEnabled();
      expect(primary).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(primary);
    }
    expect(onFocusInput).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();
    view.rerender(<ComposerSendActions {...idle} onSubmit={onSubmit} onFocusInput={onFocusInput} primaryAction="send-ready" />);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onFocusInput).toHaveBeenCalledTimes(2);
  });

  it("stops the agent from the stop disc and sends from the arrow", () => {
    const onStop = vi.fn(async () => undefined);
    const onSubmit = vi.fn(async () => undefined);
    const view = render(<ComposerSendActions {...idle} onStop={onStop} onSubmit={onSubmit} primaryAction="stop-ready" />);
    fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    view.rerender(<ComposerSendActions {...idle} onStop={onStop} onSubmit={onSubmit} primaryAction="stop-and-send" />);
    fireEvent.click(screen.getByRole("button", { name: "Stop and send" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    view.rerender(<ComposerSendActions {...idle} onStop={onStop} onSubmit={onSubmit} primaryAction="send-ready" />);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Send message", "send-ready"],
    ["Stop agent", "stop-ready"],
    ["Stop and send", "stop-and-send"],
  ] as const)(
    "preserves focus on %s when the deferred action replaces its fallback",
    (label, primaryAction) => {
      const props = { ...idle, primaryAction };
      const view = render(
        <div className="composer-actions">
          <ComposerSendActionsFallback {...props} />
        </div>,
      );
      screen.getByRole("button", { name: label }).focus();

      view.rerender(
        <div className="composer-actions">
          <ComposerSendActions {...props} />
        </div>,
      );

      expect(screen.getByRole("button", { name: label })).toHaveFocus();
    },
  );

  it("keeps one primary control mounted across send and Stop states", () => {
    const view = render(
      <ComposerSendActions {...idle} primaryAction="send-ready" />,
    );
    const primary = screen.getByRole("button", { name: "Send message" });
    expect(primary.querySelector("[data-icon-state]"))
      .toHaveAttribute("data-icon-state", "send");

    expect(primary).not.toHaveAttribute("title");
    fireEvent.pointerEnter(primary, { pointerType: "mouse" });
    expect(primary.querySelector("[data-icon-state]"))
      .toHaveAttribute("data-icon-state", "send");

    view.rerender(
      <ComposerSendActions {...idle} primaryAction="submitting" />,
    );
    expect(screen.getByRole("button", { name: "Sending message" }))
      .toBe(primary);
    expect(primary).toHaveAttribute("aria-busy", "true");
    expect(primary.querySelector("[data-icon-state]"))
      .toHaveAttribute("data-icon-state", "sending");

    view.rerender(
      <ComposerSendActions
        {...idle}
        primaryAction="stop-ready"
      />,
    );
    expect(screen.getByRole("button", { name: "Stop agent" })).toBe(primary);
    expect(primary.querySelector("[data-icon-state]"))
      .toHaveAttribute("data-icon-state", "stop");
  });

  it("shows the head of the queue with immediate-send and remove actions", async () => {
    const first: QueuedMessage = {
      id: "11111111-1111-4111-8111-111111111101",
      conversationId: idle.conversationId,
      content: "Run the release checks",
      createdAt: "2026-08-21T10:00:00.000Z",
      attachments: [],
      state: "waiting",
      error: null,
      turnId: null,
      userMessageId: null,
    };
    const second: QueuedMessage = {
      id: "11111111-1111-4111-8111-111111111102",
      conversationId: idle.conversationId,
      content: "Update the changelog",
      createdAt: "2026-08-21T10:01:00.000Z",
      attachments: [],
      state: "waiting",
      error: null,
      turnId: null,
      userMessageId: null,
    };
    let entries: QueuedMessage[] = [first, second];
    const onQueueCommand = vi.fn<QueueCommandRunner>(async (command): Promise<MessageQueueResult> => {
      if (command.type === "message.queue.send" || command.type === "message.queue.remove") {
        entries = entries.filter(({ id }) => id !== command.payload.id);
      }
      return { kind: "message.queue", conversationId: idle.conversationId, entries, receipt: null };
    });
    render(
      <ComposerSendActions
        {...idle}
        primaryAction="stop-ready"
        onQueueCommand={onQueueCommand}
      />,
    );

    expect(await screen.findByText(
      "Run the release checks",
      undefined,
      { timeout: 5_000 },
    )).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send queued message now" }));
    await waitFor(() => expect(onQueueCommand).toHaveBeenCalledWith({
      type: "message.queue.send",
      payload: { conversationId: idle.conversationId, id: first.id },
    }));
    expect(await screen.findByText("Update the changelog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove queued message" }));
    await waitFor(() => expect(screen.queryByRole("list", {
      name: "Queued messages",
    })).not.toBeInTheDocument());
    expect(onQueueCommand).toHaveBeenCalledWith({
      type: "message.queue.remove",
      payload: { conversationId: idle.conversationId, id: second.id },
    });
  });

  it("sends queued media without releasing the transferred capability", async () => {
    const attachment: ChatAttachment = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "release.png",
      path: "11111111-1111-4111-8111-111111111111",
      mimeType: "image/png",
      size: 128,
    };
    const entry: QueuedMessage = {
      id: "11111111-1111-4111-8111-111111111103",
      conversationId: idle.conversationId,
      content: "Review the screenshot",
      createdAt: "2026-08-21T10:00:00.000Z",
      attachments: [attachment],
      state: "waiting",
      error: null,
      turnId: null,
      userMessageId: null,
    };
    let entries: QueuedMessage[] = [entry];
    const onQueueCommand = vi.fn<QueueCommandRunner>(async (command): Promise<MessageQueueResult> => {
      if (command.type === "message.queue.send") entries = [];
      return { kind: "message.queue", conversationId: idle.conversationId, entries, receipt: null };
    });
    const onReleaseAttachment = vi.fn(async () => undefined);

    render(
      <ComposerSendActions
        {...idle}
        primaryAction="stop-ready"
        onQueueCommand={onQueueCommand}
        onReleaseAttachment={onReleaseAttachment}
      />,
    );

    expect(await screen.findByText("1 image")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {
      name: "Send queued message now",
    }));
    await waitFor(() => expect(onQueueCommand).toHaveBeenCalledWith({
      type: "message.queue.send",
      payload: { conversationId: idle.conversationId, id: entry.id },
    }));
    expect(onReleaseAttachment).not.toHaveBeenCalled();
  });

  it("releases legacy queued media once when the user discards the entry", async () => {
    const attachment: ChatAttachment = {
      id: "22222222-2222-4222-8222-222222222222",
      name: "discard.png",
      path: "22222222-2222-4222-8222-222222222222",
      mimeType: "image/png",
      size: 128,
    };
    const onReleaseAttachment = vi.fn(async () => undefined);
    window.sessionStorage.setItem(
      composerMediaQueueKey(idle.conversationId),
      JSON.stringify([{
        id: "legacy-discard",
        content: "Discard the screenshot",
        createdAt: "2026-08-21T10:00:00.000Z",
        attachments: [attachment],
      }]),
    );

    render(
      <ComposerSendActions
        {...idle}
        primaryAction="stop-ready"
        onReleaseAttachment={onReleaseAttachment}
      />,
    );
    fireEvent.click(await screen.findByRole("button", {
      name: "Discard saved draft",
    }));

    await waitFor(() => expect(onReleaseAttachment).toHaveBeenCalledTimes(1));
    expect(onReleaseAttachment).toHaveBeenCalledWith(attachment.id);
    expect(readComposerQueue(idle.conversationId)).toEqual([]);
  });

  it("keeps queued media owned by the queue when sending rejects", async () => {
    const attachment: ChatAttachment = {
      id: "33333333-3333-4333-8333-333333333333",
      name: "retry.png",
      path: "33333333-3333-4333-8333-333333333333",
      mimeType: "image/png",
      size: 128,
    };
    const entry: QueuedMessage = {
      id: "11111111-1111-4111-8111-111111111104",
      conversationId: idle.conversationId,
      content: "Retry the screenshot",
      createdAt: "2026-08-21T10:00:00.000Z",
      attachments: [attachment],
      state: "waiting",
      error: null,
      turnId: null,
      userMessageId: null,
    };
    const onQueueCommand = vi.fn<QueueCommandRunner>(async (command): Promise<MessageQueueResult> => {
      if (command.type === "message.queue.send") throw new Error("send rejected");
      return { kind: "message.queue", conversationId: idle.conversationId, entries: [entry], receipt: null };
    });
    const onReleaseAttachment = vi.fn(async () => undefined);

    render(
      <ComposerSendActions
        {...idle}
        primaryAction="stop-ready"
        onQueueCommand={onQueueCommand}
        onReleaseAttachment={onReleaseAttachment}
      />,
    );
    fireEvent.click(await screen.findByRole("button", {
      name: "Send queued message now",
    }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("send rejected"));
    expect(screen.getByText("Retry the screenshot")).toBeInTheDocument();
    expect(screen.getByText("1 image")).toBeInTheDocument();
    expect(onReleaseAttachment).not.toHaveBeenCalled();
  });

  it("jumps to the target path when the user prefers reduced motion", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    } satisfies MediaQueryList)));
    const view = render(
      <ComposerSendActions {...idle} primaryAction="send-ready" />,
    );
    const primary = screen.getByRole("button", { name: "Send message" });
    const path = primary.querySelector("path");
    const sendPath = path?.getAttribute("d");
    expect(path).not.toBeNull();

    view.rerender(
      <ComposerSendActions
        {...idle}
        primaryAction="submitting"
      />,
    );

    expect(screen.getByRole("button", { name: "Sending message" }))
      .toBe(primary);
    expect(primary.querySelector("path")).toBe(path);
    expect(path?.getAttribute("d")).not.toBe(sendPath);
  });
});
