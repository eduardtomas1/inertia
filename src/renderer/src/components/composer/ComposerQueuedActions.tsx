import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, CornerDownRight, Paperclip, Pause, Play, Trash2 } from "lucide-react";

import type { ChatAttachment, QueuedMessage } from "@shared/contracts";
import type { AgentTurnStatus } from "../../../../shared/turn-lifecycle";
import { runtimeCommandDelivery } from "../../utils/connectionMessages";
import { resultEvent } from "../../lib/runtimeCommands";
import type { MessageQueueCommand, MessageQueueCommandRunner } from "./types";
import { transferRuntimeComposerPrompt } from "./runtimeComposerQueue";
import {
  QUEUED_PROMPTS_CHANGED_EVENT,
  clearComposerQueuedPromptDispatched,
  composerQueueKey,
  composerQueueLockName,
  enqueueComposerPrompt,
  markComposerQueuedPromptDispatched,
  readComposerQueue,
  removeComposerQueuedPrompt,
  takeAllSessionQueuedMedia,
  takeComposerQueuedPrompts,
} from "./composerQueuedPrompts";

export { enqueueComposerPrompt };

const EMPTY_QUEUE: readonly QueuedMessage[] = [];

export async function releaseDeletedComposerQueue(
  conversationId: string,
  releaseAttachment: (attachmentId: string) => Promise<void>,
): Promise<void> {
  const drain = async (): Promise<void> => {
    const prompts = takeComposerQueuedPrompts(conversationId);
    await Promise.allSettled(prompts.flatMap(({ attachments }) =>
      attachments.map(({ id }) => releaseAttachment(id))));
  };
  if (!navigator.locks) {
    await drain();
    return;
  }
  await navigator.locks.request(composerQueueLockName(conversationId), drain);
}

export function ComposerQueuedActions({
  conversationId,
  canSendQueuedNow,
  running,
  latestTurnId,
  latestTurnStatus,
  latestTurnAuthoritative,
  queuedMessages = EMPTY_QUEUE,
  onMessageQueueCommand,
  queueHost,
  onSendQueued,
  onReleaseAttachment,
}: {
  conversationId: string;
  canSendQueuedNow: boolean;
  running: boolean;
  latestTurnId: string | null;
  latestTurnStatus: AgentTurnStatus | null;
  latestTurnAuthoritative: boolean;
  queuedMessages?: readonly QueuedMessage[];
  onMessageQueueCommand?: MessageQueueCommandRunner;
  queueHost: HTMLElement | null;
  onSendQueued: (
    content: string,
    attachments: ChatAttachment[],
  ) => Promise<unknown>;
  onReleaseAttachment: (attachmentId: string) => Promise<void>;
}): React.JSX.Element | null {
  const [queuedPrompts, setQueuedPrompts] = useState(() =>
    readComposerQueue(conversationId));
  const [queueSendingId, setQueueSendingId] = useState<string | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [queueResult, setQueueResult] = useState<{
    source: readonly QueuedMessage[]; conversationId: string; items: QueuedMessage[];
  } | null>(null);
  const migrationAttempts = useRef(new Set<string>());
  const queueElementRef = useRef<HTMLDivElement>(null);
  const durableMessages = (queueResult?.source === queuedMessages && queueResult.conversationId === conversationId
    ? queueResult.items : queuedMessages).filter((item) => item.conversationId === conversationId);
  const queueSendingRef = useRef<string | null>(null);
  const conversationIdRef = useRef(conversationId);
  const autoQueuedTurnRef = useRef<string | null>(null);
  conversationIdRef.current = conversationId;
  const syncQueue = useCallback((): void => {
    setQueuedPrompts(readComposerQueue(conversationId));
  }, [conversationId]);

  useEffect(() => {
    queueSendingRef.current = null;
    autoQueuedTurnRef.current = null;
    setQueueSendingId(null);
    setQueueError(null);
    migrationAttempts.current = new Set();
    syncQueue();
    const onStorage = (event: StorageEvent): void => {
      if (event.key === composerQueueKey(conversationId)) syncQueue();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(QUEUED_PROMPTS_CHANGED_EVENT, syncQueue);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(QUEUED_PROMPTS_CHANGED_EVENT, syncQueue);
    };
  }, [conversationId, syncQueue]);

  const transferQueued = useCallback(async (promptId: string): Promise<void> => {
    if (!onMessageQueueCommand) return;
    const prompt = readComposerQueue(conversationId).find(({ id }) => id === promptId);
    if (!prompt) return;
    try {
      await transferRuntimeComposerPrompt(conversationId, prompt, latestTurnId, onMessageQueueCommand);
      if (conversationIdRef.current === conversationId) {
        setQueueError(null);
      }
    } catch (error) {
      if (conversationIdRef.current === conversationId
        && readComposerQueue(conversationId).some(({ id }) => id === prompt.id)) {
        setQueueError(error instanceof Error ? error.message : "The queue could not be saved. Try again.");
      }
    }
  }, [conversationId, latestTurnId, onMessageQueueCommand]);

  useEffect(() => {
    if (!onMessageQueueCommand) return;
    for (const prompt of queuedPrompts) {
      if (prompt.attachments.length || prompt.dispatchedAt
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(prompt.id)
        || migrationAttempts.current.has(prompt.id)) continue;
      migrationAttempts.current.add(prompt.id);
      void transferQueued(prompt.id);
    }
  }, [onMessageQueueCommand, queuedPrompts, transferQueued]);

  const changeQueue = async (payload: MessageQueueCommand["payload"]): Promise<void> => {
    if (!onMessageQueueCommand || queueSendingRef.current) return;
    const id = "id" in payload ? payload.id : conversationId;
    queueSendingRef.current = id;
    setQueueSendingId(id);
    setQueueError(null);
    try {
      const result = resultEvent(await onMessageQueueCommand("message.queue", { type: "message.queue", payload })).result;
      if (result.kind !== "message.queue" || result.conversationId !== conversationId) throw new Error("The local service did not confirm this queue.");
      if (payload.action === "remove") removeComposerQueuedPrompt(conversationId, payload.id);
      if (conversationIdRef.current === conversationId) setQueueResult({ source: queuedMessages, conversationId, items: result.items });
    } catch (error) {
      if (conversationIdRef.current === conversationId) setQueueError(error instanceof Error ? error.message : "The queue could not be updated.");
    } finally {
      if (conversationIdRef.current === conversationId && queueSendingRef.current === id) {
        queueSendingRef.current = null;
        setQueueSendingId(null);
      }
    }
  };

  useEffect(() => {
    const releaseQueuedMedia = (): void => {
      for (const prompt of takeAllSessionQueuedMedia()) {
        for (const attachment of prompt.attachments) {
          void onReleaseAttachment(attachment.id);
        }
      }
    };
    window.addEventListener("beforeunload", releaseQueuedMedia);
    return () => window.removeEventListener("beforeunload", releaseQueuedMedia);
  }, [onReleaseAttachment]);

  const removeQueued = useCallback((
    promptId: string,
    releaseAttachments = true,
  ): void => {
    const removed = removeComposerQueuedPrompt(conversationId, promptId);
    if (!removed || !releaseAttachments) return;
    for (const attachment of removed.attachments) {
      void onReleaseAttachment(attachment.id);
    }
  }, [conversationId, onReleaseAttachment]);

  const sendQueued = useCallback(async (
    promptId: string,
    origin: "automatic" | "manual",
  ): Promise<void> => {
    const dispatch = async (): Promise<void> => {
      if (queueSendingRef.current) return;
      const queued = readComposerQueue(conversationId).find(
        ({ id }) => id === promptId,
      );
      if (!queued) return;
      if (queued.runtimeQueue || (onMessageQueueCommand && !queued.attachments.length && !queued.dispatchedAt)) {
        await transferQueued(promptId);
        return;
      }
      if (!canSendQueuedNow) return;
      // Re-read under the lock: an earlier attempt in this or another window
      // may have dispatched the prompt since the effect looked at it.
      if (origin === "automatic" && queued.dispatchedAt) return;
      // The intent is durable before the send crosses the boundary, so a
      // renderer that reloads or crashes before the reply cannot send the
      // same prompt again automatically. No record, no send.
      if (!markComposerQueuedPromptDispatched(conversationId, promptId)) return;
      queueSendingRef.current = promptId;
      setQueueSendingId(promptId);
      try {
        await onSendQueued(queued.content, queued.attachments);
        removeQueued(promptId, false);
      } catch (error) {
        // The workspace owns the error surface; keep the draft for retry.
        // Only a delivery the runtime is known not to have accepted restores
        // automatic sending; an unknown outcome stays manual-retry only.
        const delivery = runtimeCommandDelivery(error);
        if (delivery === "not-sent" || delivery === "rejected") {
          clearComposerQueuedPromptDispatched(conversationId, promptId);
        }
      } finally {
        if (
          conversationIdRef.current === conversationId
          && queueSendingRef.current === promptId
        ) {
          queueSendingRef.current = null;
          setQueueSendingId(null);
        }
      }
    };
    if (!navigator.locks) {
      await dispatch();
      return;
    }
    await navigator.locks.request(
      composerQueueLockName(conversationId),
      { ifAvailable: true },
      async (lock) => {
        if (lock) await dispatch();
      },
    );
  }, [canSendQueuedNow, conversationId, onMessageQueueCommand, onSendQueued, removeQueued, transferQueued]);

  useEffect(() => {
    const queued = queuedPrompts[0];
    if (
      running
      || queueSendingRef.current
      || !canSendQueuedNow
      || !queued
      || !latestTurnId
      || latestTurnStatus !== "completed"
      || !latestTurnAuthoritative
      || queued.dispatchedAt
      || queued.runtimeQueue
      || (onMessageQueueCommand && !queued.attachments.length)
      || durableMessages.length > 0
    ) return;
    const terminalKey = `${conversationId}:${latestTurnId}`;
    if (autoQueuedTurnRef.current === terminalKey) return;
    autoQueuedTurnRef.current = terminalKey;
    void sendQueued(queued.id, "automatic");
  }, [
    canSendQueuedNow,
    conversationId,
    latestTurnId,
    latestTurnAuthoritative,
    latestTurnStatus,
    queuedPrompts,
    running,
    sendQueued,
    onMessageQueueCommand,
    durableMessages.length,
  ]);

  const queued = queuedPrompts.find((prompt) => !durableMessages.some(({ id }) => id === prompt.id)) ?? null;
  const hasQueue = Boolean(queued || durableMessages.length || queueError);
  useLayoutEffect(() => {
    const element = queueElementRef.current;
    if (!element || !queueHost) return;
    const measure = (): void => queueHost.style.setProperty("--composer-queue-height", `${element.getBoundingClientRect().height}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { observer.disconnect(); queueHost.style.removeProperty("--composer-queue-height"); };
  }, [queueHost, hasQueue]);
  if (!hasQueue) return null;
  const sending = queueSendingId === queued?.id;
  const unconfirmed = Boolean(queued?.dispatchedAt) && !sending;
  const queueElement = (
    <div className="composer-queue" ref={queueElementRef}>
      {queueError && <p className="composer-queue-error" role="alert">{queueError}</p>}
      {durableMessages.length > 0 && <div role="list" aria-label="Saved queued messages">
        {durableMessages.map((item, index) => {
          const uncertain = item.status === "uncertain";
          const dispatching = item.status === "dispatching";
          const mutable = !uncertain && !dispatching;
          const status = uncertain ? "Send unconfirmed — check transcript"
            : dispatching ? "Sending…" : item.status === "paused" ? "Paused"
              : item.status === "rejected" ? "Send failed" : "Queued";
          return <div className="composer-queue-item composer-queue-durable" role="listitem" key={item.id}>
            <CornerDownRight size={15} aria-hidden="true" />
            <span className="composer-queue-copy" title={item.content}>{item.content}</span>
            <small className="composer-queue-status" title={item.lastError ?? undefined}>{status}</small>
            <div className="composer-queue-controls" role="group" aria-label={`Queued message ${index + 1}`}>
              <button type="button" className="composer-queue-remove" aria-label="Move queued message up" disabled={!mutable || index === 0 || queueSendingId !== null} onClick={() => void changeQueue({ action: "move", conversationId, id: item.id, direction: "up" })}><ArrowUp size={14} aria-hidden="true" /></button>
              <button type="button" className="composer-queue-remove" aria-label="Move queued message down" disabled={!mutable || index === durableMessages.length - 1 || queueSendingId !== null} onClick={() => void changeQueue({ action: "move", conversationId, id: item.id, direction: "down" })}><ArrowDown size={14} aria-hidden="true" /></button>
              <button type="button" className="composer-queue-remove" aria-label={item.status === "paused" ? "Resume queued message" : "Pause queued message"} disabled={!mutable || queueSendingId !== null} onClick={() => void changeQueue({ action: "pause", conversationId, id: item.id, paused: item.status !== "paused" })}>{item.status === "paused" ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}</button>
              <button type="button" className="composer-queue-send" disabled={!canSendQueuedNow || running || !mutable || queueSendingId !== null} onClick={() => void changeQueue({ action: "send", conversationId, id: item.id })}>Send now</button>
              <button type="button" className="composer-queue-remove" aria-label="Remove queued message" disabled={dispatching || queueSendingId !== null} onClick={() => void changeQueue({ action: "remove", conversationId, id: item.id })}><Trash2 size={14} aria-hidden="true" /></button>
            </div>
            {item.lastError && <span className="composer-queue-item-error">{item.lastError}</span>}
          </div>;
        })}
      </div>}
      {queued && <div role="list" aria-label="Queued messages">
      <div
        className={`composer-queue-item${
          queued.attachments.length > 0 ? " has-media" : ""
        }`}
        role="listitem"
      >
        <CornerDownRight size={15} aria-hidden="true" />
        <span className="composer-queue-copy" title={queued.content}>
          {queued.content}
        </span>
        {queued.attachments.length > 0 && (
          <span
            className="composer-queue-media"
            title={queued.attachments.map(({ name }) => name).join("\n")}
          >
            <Paperclip size={13} aria-hidden="true" />
            {queued.attachments.length === 1
              ? "1 image"
              : `${queued.attachments.length} images`}
          </span>
        )}
        <small
          className="composer-queue-count"
          title={unconfirmed
            ? "A previous send did not confirm. Check the transcript before sending again."
            : undefined}
        >
          {unconfirmed
            ? "Send unconfirmed"
            : queued.runtimeQueue ? "Waiting to save" : queuedPrompts.length === 1 ? "Queued" : `1 of ${queuedPrompts.length}`}
        </small>
        <button
          type="button"
          className="composer-queue-send"
          aria-label={queued.runtimeQueue ? "Retry saving queued message" : "Send queued message now"}
          disabled={(!queued.runtimeQueue && !canSendQueuedNow) || queueSendingId !== null}
          onClick={() => void sendQueued(queued.id, "manual")}
        >
          {sending ? "Sending…" : queued.runtimeQueue ? "Retry save" : "Send now"}
        </button>
        <button
          type="button"
          className="composer-queue-remove"
          aria-label="Remove queued message"
          disabled={queueSendingId === queued.id}
          onClick={() => {
            if (queued.runtimeQueue && onMessageQueueCommand) void changeQueue({ action: "remove", conversationId, id: queued.id });
            else removeQueued(queued.id);
          }}
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
      </div>}
    </div>
  );
  return queueHost ? createPortal(queueElement, queueHost) : queueElement;
}
