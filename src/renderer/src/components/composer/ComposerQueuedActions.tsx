import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CornerDownRight, Paperclip, Trash2 } from "lucide-react";

import type { ChatAttachment, ProviderInfo } from "@shared/contracts";
import type { AgentTurnStatus } from "../../../../shared/turn-lifecycle";
import {
  enqueueRuntimePrompt,
  type QueueCommandRunner,
  type QueuedMessageEdit,
} from "./runtimeQueueClient";
import { discardComposerDraftAttachments } from "../../utils/composerDraftAttachments";
import { IconButton } from "../ui";
import { TooltipText } from "../TooltipText";
import { RuntimeComposerQueuedActions } from "./RuntimeComposerQueuedActions";
import {
  QUEUED_PROMPTS_CHANGED_EVENT,
  composerQueueKey,
  composerQueueLockName,
  enqueueComposerPrompt,
  readComposerQueue,
  removeComposerQueuedPrompt,
  takeAllSessionQueuedMedia,
  takeComposerQueuedPrompts,
} from "./composerQueuedPrompts";

export { enqueueComposerPrompt };
export { queueComposerDraft } from "./queueComposerDraft";

export async function releaseDeletedComposerQueue(
  conversationId: string,
  releaseAttachment: (attachmentId: string) => Promise<void>,
): Promise<void> {
  discardComposerDraftAttachments(conversationId);
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

/**
 * Displays legacy browser-local queued prompts for explicit migration or
 * discard (Decision 4.5). Never sends automatically.
 */
function LegacySavedQueueSection({
  conversationId,
  queueHost,
  onQueueCommand,
  onReleaseAttachment,
}: {
  conversationId: string;
  queueHost: HTMLElement | null;
  onQueueCommand?: QueueCommandRunner;
  onReleaseAttachment: (attachmentId: string) => Promise<void>;
}): React.JSX.Element | null {
  const [queuedPrompts, setQueuedPrompts] = useState(() =>
    readComposerQueue(conversationId));
  const [movingId, setMovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const syncQueue = useCallback((): void => {
    setQueuedPrompts(readComposerQueue(conversationId));
  }, [conversationId]);

  useEffect(() => {
    setMovingId(null);
    setError(null);
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

  const discardLegacy = useCallback((promptId: string): void => {
    const removed = removeComposerQueuedPrompt(conversationId, promptId);
    if (!removed) return;
    setError(null);
    for (const attachment of removed.attachments) {
      void onReleaseAttachment(attachment.id);
    }
  }, [conversationId, onReleaseAttachment]);

  const moveToQueue = useCallback(async (promptId: string): Promise<void> => {
    if (!onQueueCommand || movingId !== null) return;
    const prompt = readComposerQueue(conversationId).find(({ id }) => id === promptId);
    if (!prompt) return;
    setMovingId(promptId);
    setError(null);
    try {
      await enqueueRuntimePrompt(onQueueCommand, conversationId, prompt.content, prompt.attachments);
      // Remove the local copy only after the durable queue confirmed receipt; keep attachments.
      removeComposerQueuedPrompt(conversationId, promptId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The saved draft could not be moved to the queue.");
    } finally {
      setMovingId((current) => (current === promptId ? null : current));
    }
  }, [conversationId, movingId, onQueueCommand]);

  if (queuedPrompts.length === 0) return null;

  const section = (
    <div className="composer-queue composer-legacy-queue" role="region" aria-label="Saved from an earlier version">
      <div className="composer-legacy-queue-header">Saved from an earlier version</div>
      <div role="list" aria-label="Saved drafts from an earlier version">
        {queuedPrompts.map((queued, index) => {
          const moving = movingId === queued.id;
          const suffix = queuedPrompts.length > 1 ? ` ${index + 1} of ${queuedPrompts.length}` : "";
          return (
            <div
              key={queued.id}
              className={`composer-queue-item${queued.attachments.length > 0 ? " has-media" : ""}`}
              role="listitem"
            >
              <CornerDownRight size={14} aria-hidden="true" />
              <span className="composer-queue-copy" title={queued.content}>
                {queued.content}
              </span>
              {queued.attachments.length > 0 && (
                <TooltipText
                  className="composer-queue-media"
                  tooltip={queued.attachments.map(({ name }) => name).join(", ")}
                >
                  <Paperclip size={14} aria-hidden="true" />
                  {queued.attachments.length === 1
                    ? "1 image"
                    : `${queued.attachments.length} images`}
                </TooltipText>
              )}
              <button
                type="button"
                className="composer-queue-send"
                aria-label={`Move saved draft${suffix} to queue`}
                disabled={!onQueueCommand || movingId !== null}
                onClick={() => void moveToQueue(queued.id)}
              >
                {moving ? "Moving…" : "Move to queue"}
              </button>
              <IconButton
                label="Discard"
                aria-label={`Discard saved draft${suffix}`}
                className="composer-queue-remove"
                disabled={moving}
                onClick={() => discardLegacy(queued.id)}
              >
                <Trash2 size={14} aria-hidden="true" />
              </IconButton>
            </div>
          );
        })}
      </div>
      {error && <span className="composer-queue-alert" role="alert">{error}</span>}
    </div>
  );

  return queueHost ? createPortal(section, queueHost) : section;
}

export interface ComposerQueuedActionsProps {
  conversationId: string;
  canSendQueuedNow: boolean;
  running: boolean;
  canSteer?: boolean;
  canInterrupt?: boolean;
  providerSwitchWaitsForTurn?: boolean;
  hasPendingQuestionOrApproval?: boolean;
  resuming?: boolean;
  onResume?: () => Promise<unknown>;
  providers?: readonly ProviderInfo[];
  latestTurnId: string | null;
  latestTurnStatus: AgentTurnStatus | null;
  latestTurnAuthoritative?: boolean;
  queueHost: HTMLElement | null;
  editBannerHost?: HTMLElement | null;
  onSendQueued?: (content: string, attachments: ChatAttachment[]) => Promise<unknown>;
  onQueueCommand?: QueueCommandRunner;
  queueEdit?: QueuedMessageEdit;
  onReleaseAttachment: (attachmentId: string) => Promise<void>;
  onFocusInput?: () => void;
}

export function ComposerQueuedActions({
  conversationId,
  canSendQueuedNow,
  running,
  canSteer,
  canInterrupt,
  providerSwitchWaitsForTurn,
  hasPendingQuestionOrApproval,
  resuming,
  onResume,
  providers,
  latestTurnId,
  latestTurnStatus,
  queueHost,
  editBannerHost,
  onQueueCommand,
  queueEdit,
  onReleaseAttachment,
  onFocusInput,
}: ComposerQueuedActionsProps): React.JSX.Element {
  useLayoutEffect(() => {
    const dock = queueHost?.classList.contains("composer-queue-slot") ? queueHost.parentElement : null;
    if (!dock || !queueHost) return;
    const sync = (): void => { dock.style.marginTop = queueHost.offsetHeight ? `${queueHost.offsetHeight + 4}px` : ""; };
    sync();
    const ro = typeof ResizeObserver < "u" ? new ResizeObserver(sync) : null;
    ro?.observe(queueHost);
    return () => { ro?.disconnect(); dock.style.marginTop = ""; };
  }, [queueHost]);
  return (
    <>
      {onQueueCommand && (
        <RuntimeComposerQueuedActions
          conversationId={conversationId}
          onCommand={onQueueCommand}
          canSend={canSendQueuedNow}
          running={running}
          canSteer={canSteer}
          canInterrupt={canInterrupt}
          providerSwitchWaitsForTurn={providerSwitchWaitsForTurn}
          hasPendingQuestionOrApproval={hasPendingQuestionOrApproval}
          resuming={resuming}
          onResume={onResume}
          providers={providers}
          latestTurnId={latestTurnId}
          latestTurnStatus={latestTurnStatus}
          queueHost={queueHost}
          editBannerHost={editBannerHost}
          edit={queueEdit}
          onFocusInput={onFocusInput}
        />
      )}
      <LegacySavedQueueSection
        conversationId={conversationId}
        queueHost={queueHost}
        onQueueCommand={onQueueCommand}
        onReleaseAttachment={onReleaseAttachment}
      />
    </>
  );
}
