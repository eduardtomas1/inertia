import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CornerDownRight, Paperclip, Trash2 } from "lucide-react";

import type { ChatAttachment } from "@shared/contracts";
import type { AgentTurnStatus } from "../../../../shared/turn-lifecycle";
import {
  QUEUED_PROMPTS_CHANGED_EVENT,
  composerQueueLockName,
  composerQueueKey,
  enqueueComposerPrompt,
  readComposerQueue,
  removeComposerQueuedPrompt,
  takeAllSessionQueuedMedia,
  takeComposerQueuedPrompts,
} from "./composerQueuedPrompts";

export { enqueueComposerPrompt };

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

  const sendQueued = useCallback(async (promptId: string): Promise<void> => {
    const dispatch = async (): Promise<void> => {
      if (queueSendingRef.current || !canSendQueuedNow) return;
      const queued = readComposerQueue(conversationId).find(
        ({ id }) => id === promptId,
      );
      if (!queued) return;
      queueSendingRef.current = promptId;
      setQueueSendingId(promptId);
      try {
        await onSendQueued(queued.content, queued.attachments);
        removeQueued(promptId, false);
      } catch {
        // The workspace owns the error surface; keep the draft for retry.
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
  }, [canSendQueuedNow, conversationId, onSendQueued, removeQueued]);

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
    ) return;
    const terminalKey = `${conversationId}:${latestTurnId}`;
    if (autoQueuedTurnRef.current === terminalKey) return;
    autoQueuedTurnRef.current = terminalKey;
    void sendQueued(queued.id);
  }, [
    canSendQueuedNow,
    conversationId,
    latestTurnId,
    latestTurnAuthoritative,
    latestTurnStatus,
    queuedPrompts,
    running,
    sendQueued,
  ]);

  const queued = queuedPrompts[0] ?? null;
  if (!queued) return null;
  const queueElement = (
    <div className="composer-queue" role="list" aria-label="Queued messages">
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
        <small className="composer-queue-count">
          {queuedPrompts.length === 1 ? "Queued" : `1 of ${queuedPrompts.length}`}
        </small>
        <button
          type="button"
          className="composer-queue-send"
          aria-label="Send queued message now"
          disabled={!canSendQueuedNow || queueSendingId !== null}
          onClick={() => void sendQueued(queued.id)}
        >
          {queueSendingId === queued.id ? "Sending…" : "Send now"}
        </button>
        <button
          type="button"
          className="composer-queue-remove"
          aria-label="Remove queued message"
          disabled={queueSendingId === queued.id}
          onClick={() => removeQueued(queued.id)}
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
  return queueHost ? createPortal(queueElement, queueHost) : queueElement;
}
