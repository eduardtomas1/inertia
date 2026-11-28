import "./RuntimeComposerQueuedActions.css";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CornerDownRight, Paperclip, PencilLine, Play, Trash2 } from "lucide-react";
import { chatAttachmentKind } from "@shared/attachments";
import type { ProviderInfo } from "@shared/contracts";
import type { QueueHoldReason } from "@shared/orchestration-queue";
import { QUEUED_ROUTE_CHANGED_ERROR, type MessageQueueResult, type QueuedMessage } from "@shared/queued-messages";
import { isAgentTurnTerminalStatus, type AgentTurnStatus } from "@shared/turn-lifecycle";
import {
  getPendingQueueIntents,
  resumeRuntimeQueue,
  RUNTIME_QUEUE_CHANGED,
  type PendingQueueIntent,
  type QueueCommand,
  type QueueCommandRunner,
  type QueuedMessageEdit,
} from "./runtimeQueueClient";
import {
  announceRuntimeQueueChanged,
  parseRuntimeQueueChangedDetail,
  RUNTIME_QUEUE_RECONNECTED,
  setRuntimeQueuedFollowUps,
  setRuntimeQueueSummary,
} from "./runtimeQueueEvents";
import { formatQueueModelLabel } from "./useQueuedMessageEdit";
import { IconButton } from "../ui";
import { runtimeCommandDelivery } from "../../utils/connectionMessages";

export const QUEUED_DOCUMENTS_SEND_LATER = "Documents send when the turn ends.";
export const QUEUE_VISIBLE_ROWS = 3;
const COLLAPSED_PREVIEW_ROWS = 2;

const pendingLoads = new WeakMap<QueueCommandRunner, Map<string, Promise<MessageQueueResult>>>();
function loadQueue(run: QueueCommandRunner, conversationId: string): Promise<MessageQueueResult> {
  let loads = pendingLoads.get(run);
  if (!loads) {
    loads = new Map();
    pendingLoads.set(run, loads);
  }
  const prior = loads.get(conversationId);
  if (prior) return prior;
  const operation = run({ type: "message.queue.get", payload: { conversationId } })
    .finally(() => {
      if (loads.get(conversationId) === operation) loads.delete(conversationId);
    });
  loads.set(conversationId, operation);
  return operation;
}

function mediaLabel(attachments: QueuedMessage["attachments"]): string {
  const images = attachments.every(({ mimeType }) => chatAttachmentKind(mimeType) === "image");
  const noun = images ? "image" : "file";
  return `${attachments.length} ${attachments.length === 1 ? noun : `${noun}s`}`;
}

const HOLD_REASONS: Record<QueueHoldReason, string> = {
  stopped: "Stopped",
  "provider-failed": "Provider failed",
  restart: "Restarted",
  "usage-limit": "Usage limit",
  "workspace-setup": "Workspace setup",
  "busy-session": "Busy session",
};

export function holdReasonLabel(reason: QueueHoldReason | null): string {
  const detail = reason ? HOLD_REASONS[reason] : undefined;
  return detail ? `Queue paused · ${detail}` : "Queue paused";
}

export type QueueEntrySendMode = "send-now" | "stop-and-send" | "queue" | "none";

export function resolveQueueEntrySendMode({
  entry,
  front,
  running,
  turnTerminal,
  canSteer,
  canInterrupt,
  providerSwitchWaitsForTurn,
}: {
  entry: QueuedMessage;
  front: boolean;
  running: boolean;
  turnTerminal: boolean;
  canSteer?: boolean;
  canInterrupt?: boolean;
  providerSwitchWaitsForTurn?: boolean;
}): QueueEntrySendMode {
  if (!front) return "none";
  const delegated = Boolean(entry.delegatedCompletion);
  const unread = entry.userMessageId !== null;
  if (delegated || unread) {
    return !running && turnTerminal ? "send-now" : "none";
  }
  if (!running) return "send-now";
  if (providerSwitchWaitsForTurn) return "queue";
  if (canSteer === false) {
    return canInterrupt === false ? "none" : "stop-and-send";
  }
  return "send-now";
}

function attributionChipLabel(entry: QueuedMessage): string | null {
  if (entry.watcherNote) return "From watcher";
  if (entry.delegatedCompletion) return "Delegated results";
  if (entry.creationSource === "mobile" || entry.deviceId) return "From device";
  if (entry.createdBy === "agent") return "From agent";
  if (entry.userMessageId !== null && entry.state !== "blocked") return "Not read, sends next";
  return null;
}

type FocusTarget = { index: number; action: "send" | "remove" | "toggle" } | null;

export interface RuntimeComposerQueuedActionsProps {
  conversationId: string;
  onCommand: QueueCommandRunner;
  canSend: boolean;
  running?: boolean;
  canSteer?: boolean;
  canInterrupt?: boolean;
  providerSwitchWaitsForTurn?: boolean;
  hasPendingQuestionOrApproval?: boolean;
  resuming?: boolean;
  onResume?: () => Promise<unknown>;
  providers?: readonly ProviderInfo[];
  latestTurnId: string | null;
  latestTurnStatus: string | null;
  queueHost: HTMLElement | null;
  editBannerHost?: HTMLElement | null;
  edit?: QueuedMessageEdit;
  onFocusInput?: () => void;
}

export function RuntimeComposerQueuedActions({
  conversationId,
  onCommand,
  canSend,
  running = false,
  canSteer,
  canInterrupt,
  providerSwitchWaitsForTurn = false,
  hasPendingQuestionOrApproval = false,
  resuming = false,
  onResume,
  providers,
  latestTurnId,
  latestTurnStatus,
  queueHost,
  editBannerHost = null,
  edit,
  onFocusInput,
}: RuntimeComposerQueuedActionsProps): React.JSX.Element | null {
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [pendingIntents, setPendingIntents] = useState<PendingQueueIntent[]>(() =>
    getPendingQueueIntents(conversationId));
  const [held, setHeld] = useState(false);
  const [holdReason, setHoldReason] = useState<QueueHoldReason | null>(null);
  const [canResume, setCanResume] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState("");
  const queueSignature = useRef("[]");
  const serverRevisionRef = useRef(-1);
  const latestError = useRef(error);
  latestError.current = error;
  const errorEntry = useRef<string | null>(null);
  const owner = useRef(conversationId);
  const revision = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const focusTarget = useRef<FocusTarget>(null);
  const editObserverRef = useRef(edit?.onEntriesObserved);
  editObserverRef.current = edit?.onEntriesObserved;
  const descriptionId = useId();
  const listId = useId();
  owner.current = conversationId;

  const applyQueueResult = useCallback((result: MessageQueueResult): void => {
    const received = result.entries;
    const entries = received.some(({ delegatedCompletion }) => delegatedCompletion)
      ? [...received].sort((left, right) => Number(!left.delegatedCompletion) - Number(!right.delegatedCompletion))
      : received;
    const nextRevision = typeof result.revision === "number"
      ? result.revision
      : Math.max(0, serverRevisionRef.current);
    if (typeof result.revision === "number" && result.revision > serverRevisionRef.current) {
      serverRevisionRef.current = result.revision;
    }
    const nextHeld = result.held ?? entries.some((entry) => entry.queueHeld === true);
    const nextHoldReason = nextHeld ? (result.holdReason ?? null) : null;
    const nextCanResume = result.canResume ?? (nextHeld && entries.length > 0);
    const signature = JSON.stringify([entries, nextHeld, nextHoldReason, nextCanResume, nextRevision]);
    setPendingIntents(getPendingQueueIntents(conversationId));
    editObserverRef.current?.(entries);
    if (queueSignature.current === signature) return;
    queueSignature.current = signature;
    setQueue(entries);
    setHeld(nextHeld);
    setHoldReason(nextHoldReason);
    setCanResume(nextCanResume);
    const userCount = entries.filter(({ watcherNote, delegatedCompletion, userMessageId }) =>
      !watcherNote && !delegatedCompletion && userMessageId === null).length;
    setRuntimeQueueSummary(conversationId, {
      userCount,
      totalCount: entries.length,
      held: nextHeld,
      holdReason: nextHoldReason,
      canResume: nextCanResume,
      latestRevision: nextRevision,
    });
    if (latestError.current !== null && entries[0]?.id !== errorEntry.current) {
      setError(null);
    }
  }, [conversationId]);

  useEffect(() => {
    let current = true;
    let refused = false;
    let deferredWhileHidden = false;
    const refresh = (force = false): void => {
      if (refused && !force) return;
      if (document.visibilityState === "hidden") {
        deferredWhileHidden = true;
        return;
      }
      deferredWhileHidden = false;
      const requestedRevision = revision.current;
      void loadQueue(onCommand, conversationId).then((result) => {
        if (!current || revision.current !== requestedRevision) return;
        if (document.visibilityState === "hidden") {
          deferredWhileHidden = true;
          return;
        }
        applyQueueResult(result);
      }, (failure: unknown) => {
        if (current && revision.current === requestedRevision && runtimeCommandDelivery(failure) === "rejected") {
          refused = true;
        }
      });
    };
    queueSignature.current = "[]";
    serverRevisionRef.current = -1;
    setQueue([]);
    setPendingIntents(getPendingQueueIntents(conversationId));
    setHeld(false);
    setHoldReason(null);
    setCanResume(false);
    setExpanded(false);
    setError(null);
    setBusy(false);
    setRuntimeQueueSummary(conversationId, {
      userCount: 0,
      totalCount: 0,
      held: false,
      holdReason: null,
      canResume: false,
      latestRevision: 0,
    });
    refresh();
    const onQueueChanged = (event: Event): void => {
      const detail = parseRuntimeQueueChangedDetail((event as CustomEvent<unknown>).detail);
      if (!detail || detail.conversationId !== conversationId) return;
      if (
        typeof detail.revision === "number"
        && serverRevisionRef.current >= 0
        && detail.revision <= serverRevisionRef.current
      ) {
        return;
      }
      revision.current += 1;
      refused = false;
      pendingLoads.get(onCommand)?.delete(conversationId);
      setPendingIntents(getPendingQueueIntents(conversationId));
      refresh(true);
    };
    const onReconnected = (event: Event): void => {
      if ((event as CustomEvent<unknown>).detail !== conversationId) return;
      revision.current += 1;
      refused = false;
      pendingLoads.get(onCommand)?.delete(conversationId);
      refresh(true);
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "visible" && deferredWhileHidden) {
        refresh();
      }
    };
    window.addEventListener(RUNTIME_QUEUE_CHANGED, onQueueChanged);
    window.addEventListener(RUNTIME_QUEUE_RECONNECTED, onReconnected);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      current = false;
      window.removeEventListener(RUNTIME_QUEUE_CHANGED, onQueueChanged);
      window.removeEventListener(RUNTIME_QUEUE_RECONNECTED, onReconnected);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [applyQueueResult, conversationId, latestTurnId, latestTurnStatus, onCommand]);

  const unreadFollowUpIds = queue
    .flatMap(({ userMessageId }) => (userMessageId === null ? [] : [userMessageId]))
    .join(" ");
  useEffect(() => {
    setRuntimeQueuedFollowUps(conversationId, unreadFollowUpIds ? unreadFollowUpIds.split(" ") : []);
    return () => setRuntimeQueuedFollowUps(conversationId, []);
  }, [conversationId, unreadFollowUpIds]);

  useLayoutEffect(() => {
    const target = focusTarget.current;
    if (!target || busy) return;
    const active = document.activeElement;
    const focusLost = active === null || active === document.body || Boolean(listRef.current?.contains(active));
    focusTarget.current = null;
    if (!focusLost) return;
    if (target.action === "toggle" && toggleRef.current?.isConnected) {
      toggleRef.current.focus();
      return;
    }
    const list = listRef.current;
    const preferred = target.action === "send"
      ? list?.querySelector<HTMLButtonElement>('[data-queue-action="send"]:not(:disabled)')
      : null;
    const removes = list?.querySelectorAll<HTMLButtonElement>('[data-queue-action="remove"]:not(:disabled)') ?? [];
    if (preferred) preferred.focus();
    else if (removes.length === 0) onFocusInput?.();
    else removes[Math.min(target.index, removes.length - 1)]?.focus();
  }, [busy, expanded, onFocusInput, queue]);

  const confirmedIds = new Set(queue.map(({ id }) => id));
  const visiblePendingIntents = pendingIntents.filter(({ id }) => !confirmedIds.has(id));
  const totalCount = queue.length + visiblePendingIntents.length;
  const collapsible = totalCount > QUEUE_VISIBLE_ROWS;
  const visibleEntries = collapsible && !expanded ? queue.slice(0, COLLAPSED_PREVIEW_ROWS) : queue;
  const remainingPreviewSlots = collapsible && !expanded
    ? Math.max(0, COLLAPSED_PREVIEW_ROWS - visibleEntries.length)
    : visiblePendingIntents.length;
  const visiblePending = visiblePendingIntents.slice(0, remainingPreviewSlots);

  const editSession = edit?.session ?? null;
  const editBannerElement = editSession ? (
    <div className="composer-edit-banner" role="region" aria-label="Editing queued message">
      <span className="composer-edit-banner-title">Editing queued message</span>
      {editSession.modelLabel && (
        <small className="composer-queue-chip composer-queue-model">{editSession.modelLabel}</small>
      )}
      <div className="composer-edit-banner-actions">
        {editSession.isCleared ? (
          <button
            type="button"
            className="composer-queue-send"
            disabled={editSession.saving}
            onClick={() => void editSession.onDiscard()}
          >
            Discard
          </button>
        ) : (
          <button
            type="button"
            className="composer-queue-send"
            disabled={!editSession.dirty || editSession.isCleared || editSession.saving}
            onClick={() => void editSession.onSave()}
          >
            {editSession.saving ? "Saving…" : "Save"}
          </button>
        )}
        <button
          type="button"
          className="composer-queue-send"
          disabled={editSession.saving}
          onClick={editSession.onCancel}
        >
          Cancel
        </button>
      </div>
      {editSession.error && (
        <span className="composer-edit-banner-error" role="alert">{editSession.error}</span>
      )}
    </div>
  ) : null;

  const editBannerPortal = editBannerElement
    ? (editBannerHost ? createPortal(editBannerElement, editBannerHost) : editBannerElement)
    : null;

  if (totalCount === 0 && !edit?.notice) {
    return editBannerPortal;
  }

  const mutate = async (
    command: QueueCommand,
    entry: QueuedMessage,
    index: number,
    announcement: string,
    after?: (result: MessageQueueResult) => Promise<void>,
  ): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    focusTarget.current = {
      index,
      action: command.type === "message.queue.send" || command.type === "message.queue.reconfirm"
        ? "send"
        : "remove",
    };
    try {
      const result = await onCommand(command);
      if (owner.current === conversationId) {
        revision.current += 1;
        applyQueueResult(result);
        setLiveStatus(announcement);
      }
      announceRuntimeQueueChanged(conversationId, result.revision);
      if (after) {
        focusTarget.current = null;
        await after(result);
      }
    } catch (failure) {
      if (owner.current === conversationId) {
        errorEntry.current = entry.id;
        setError(failure instanceof Error ? failure.message : "The queue could not be updated.");
      }
    } finally {
      if (owner.current === conversationId) setBusy(false);
    }
  };

  const handleResume = async (): Promise<void> => {
    if (busy || resuming || hasPendingQuestionOrApproval) return;
    setBusy(true);
    setError(null);
    try {
      if (onResume) {
        await onResume();
      } else {
        const result = await resumeRuntimeQueue(onCommand, conversationId);
        if (owner.current === conversationId) {
          revision.current += 1;
          applyQueueResult(result);
        }
      }
      if (owner.current === conversationId) setLiveStatus("Resumed queue");
    } catch (failure) {
      if (owner.current === conversationId) {
        setError(failure instanceof Error ? failure.message : "The queue could not be resumed.");
      }
    } finally {
      if (owner.current === conversationId) setBusy(false);
    }
  };

  const payload = (entry: QueuedMessage) => ({ conversationId, id: entry.id });
  const editBlocked = edit?.blockedReason ?? null;
  const statusEntry = queue.find(({ id, error: entryError }) =>
    (error !== null && id === errorEntry.current) || entryError !== null);
  const errorText = error ?? statusEntry?.error ?? null;
  const turnTerminal = latestTurnStatus !== null
    && isAgentTurnTerminalStatus(latestTurnStatus as AgentTurnStatus);
  const showHeldBanner = held && queue.length > 0;
  const showInlineResume = showHeldBanner && canResume && !hasPendingQuestionOrApproval;
  const politeAnnouncement = liveStatus
    || edit?.notice
    || (showHeldBanner
      ? `${holdReasonLabel(holdReason)}, ${totalCount} queued`
      : totalCount > 0
        ? `${totalCount} queued ${totalCount === 1 ? "message" : "messages"}`
        : "");

  const renderRows = () => (
    <>
      {visibleEntries.map((entry, index) => {
        const front = index === 0;
        const position = totalCount > 1 ? `${index + 1} of ${totalCount}` : null;
        const suffix = front ? "" : ` ${index + 1} of ${totalCount}`;
        const dispatching = entry.state === "dispatching";
        const delegated = Boolean(entry.delegatedCompletion);
        const unread = entry.userMessageId !== null;
        const editable = entry.editable ?? (!entry.watcherNote && !delegated && !unread);
        const routeBlocked = entry.state === "blocked" && entry.error === QUEUED_ROUTE_CHANGED_ERROR;
        const documents = entry.attachments.some(({ mimeType }) => chatAttachmentKind(mimeType) !== "image");
        const sendMode = resolveQueueEntrySendMode({
          entry,
          front,
          running,
          turnTerminal,
          canSteer,
          canInterrupt,
          providerSwitchWaitsForTurn,
        });
        const sendWaitsForTurn = running && documents && sendMode === "send-now";
        const editReason = editBlocked && editable ? editBlocked : null;
        const modelLabel = formatQueueModelLabel(entry.modelSelection, providers);
        const repeatsModel = index > 0 && modelLabel === formatQueueModelLabel(visibleEntries[index - 1]!.modelSelection, providers);
        const chipLabel = attributionChipLabel(entry);
        const steerWaiting = Boolean(entry.steerWhenReadyRunId) && entry.state !== "blocked";
        const isEditingRow = edit?.editingId === entry.id;
        const rowAriaLabel = `Queued message ${index + 1} of ${totalCount}${modelLabel ? `, ${modelLabel}` : ""}`;
        const statusLabel = dispatching
          ? "Sending…"
          : entry.state === "blocked"
            ? "Needs attention"
            : steerWaiting
              ? "Waiting for acceptance…"
              : position ?? "Queued";
        return (
          <div
            key={entry.id}
            className={`composer-queue-item${entry.attachments.length ? " has-media" : ""}${isEditingRow ? " is-editing" : ""}`}
            role="listitem"
            aria-label={rowAriaLabel}
            data-editing={isEditingRow ? "true" : undefined}
          >
            <CornerDownRight size={14} aria-hidden="true" />
            {chipLabel && <small className="composer-queue-chip">{chipLabel}</small>}
            <span className="composer-queue-copy" title={entry.content}>{entry.content}</span>
            {modelLabel && !repeatsModel && (
              <small className="composer-queue-chip composer-queue-model" title={modelLabel}>
                {modelLabel}
              </small>
            )}
            {entry.attachments.length > 0 && (
              <span className="composer-queue-media" title={entry.attachments.map(({ name }) => name).join(", ")}>
                <Paperclip size={14} aria-hidden="true" />{mediaLabel(entry.attachments)}
              </span>
            )}
            <small className="composer-queue-count">{statusLabel}</small>
            {front && routeBlocked && (
              <button
                type="button"
                className="composer-queue-send"
                aria-label="Send queued message with current settings"
                data-queue-action="send"
                disabled={busy || dispatching}
                onClick={() => void mutate(
                  { type: "message.queue.reconfirm", payload: payload(entry) },
                  entry,
                  index,
                  "Sent queued message",
                )}
              >
                Send with current settings
              </button>
            )}
            {!routeBlocked && sendMode !== "none" && (
              <button
                type="button"
                className="composer-queue-send"
                aria-label={
                  sendMode === "stop-and-send"
                    ? "Stop and send queued message"
                    : sendMode === "queue"
                      ? "Queue message for next turn"
                      : delegated
                        ? "Send delegated results now"
                        : unread
                          ? "Send unread follow-up now"
                          : "Send queued message now"
                }
                data-queue-action="send"
                aria-describedby={sendWaitsForTurn ? `${descriptionId}-send` : undefined}
                disabled={busy || dispatching || (!canSend && sendMode === "send-now") || sendWaitsForTurn || sendMode === "queue"}
                onClick={() => void mutate(
                  { type: "message.queue.send", payload: payload(entry) },
                  entry,
                  index,
                  "Sent queued message",
                )}
              >
                {sendMode === "stop-and-send" ? "Stop and send" : sendMode === "queue" ? "Queue" : "Send now"}
              </button>
            )}
            {front && sendWaitsForTurn && (
              <span id={`${descriptionId}-send`} className="visually-hidden">{QUEUED_DOCUMENTS_SEND_LATER}</span>
            )}
            {edit && editable && (
              <>
                <IconButton
                  label={editReason ?? "Edit"}
                  aria-label={`Edit queued message${suffix}`}
                  className="composer-queue-remove"
                  data-queue-action="edit"
                  aria-describedby={editReason ? `${descriptionId}-edit-${index}` : undefined}
                  disabled={busy || dispatching}
                  aria-disabled={editReason ? true : undefined}
                  onClick={(event) => {
                    if (editReason !== null) return;
                    if (edit.onStartEdit) {
                      edit.onStartEdit(entry, event.currentTarget);
                    } else if (edit.onEdit) {
                      void mutate(
                        { type: "message.queue.edit", payload: payload(entry) },
                        entry,
                        index,
                        "Editing queued message",
                        async (result) => {
                          if (result.edited) await edit.onEdit!(result.edited);
                        },
                      );
                    }
                  }}
                >
                  <PencilLine size={14} aria-hidden="true" />
                </IconButton>
                {editReason && (
                  <span id={`${descriptionId}-edit-${index}`} className="visually-hidden">{editReason}</span>
                )}
              </>
            )}
            <IconButton
              label="Remove"
              aria-label={
                delegated
                  ? "Remove delegated results"
                  : unread
                    ? "Remove unread follow-up"
                    : `Remove queued message${suffix}`
              }
              className="composer-queue-remove"
              data-queue-action="remove"
              disabled={busy || dispatching}
              onClick={() => void mutate(
                { type: "message.queue.remove", payload: payload(entry) },
                entry,
                index,
                "Removed queued message",
              )}
            >
              <Trash2 size={14} aria-hidden="true" />
            </IconButton>
          </div>
        );
      })}
      {visiblePending.map((pending, offset) => {
        const rowIndex = queue.length + offset;
        return (
          <div
            key={pending.id}
            className="composer-queue-item is-pending"
            role="listitem"
            aria-label={`Queued message ${rowIndex + 1} of ${totalCount}, saving`}
          >
            <CornerDownRight size={14} aria-hidden="true" />
            <span className="composer-queue-copy" title={pending.content}>{pending.content}</span>
            {pending.attachmentCount > 0 && (
              <span className="composer-queue-media">
                <Paperclip size={14} aria-hidden="true" />
                {pending.attachmentCount === 1 ? "1 file" : `${pending.attachmentCount} files`}
              </span>
            )}
            <small className="composer-queue-count">Saving…</small>
            <IconButton
              label="Remove"
              aria-label={`Remove pending queued message ${rowIndex + 1} of ${totalCount}`}
              className="composer-queue-remove"
              data-queue-action="remove"
              disabled
            >
              <Trash2 size={14} aria-hidden="true" />
            </IconButton>
          </div>
        );
      })}
    </>
  );

  const listElement = (
    <div ref={listRef} className="composer-queue">
      {showHeldBanner && (
        <div className="composer-queue-held" role="group" aria-label="Queue paused">
          <span className="composer-queue-held-label">{holdReasonLabel(holdReason)}</span>
          {showInlineResume && (
            <button
              type="button"
              className="composer-queue-send"
              aria-label="Resume queue"
              aria-busy={resuming || busy}
              disabled={busy || resuming}
              onClick={() => void handleResume()}
            >
              <Play size={14} aria-hidden="true" /> Resume
            </button>
          )}
        </div>
      )}
      {totalCount > 0 && (
        <div
          id={listId}
          className={collapsible && expanded ? "composer-queue-scroll" : undefined}
          role="list"
          aria-label="Queued messages"
        >
          {renderRows()}
        </div>
      )}
      {collapsible && (
        <button
          ref={toggleRef}
          type="button"
          className="composer-queue-toggle"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => {
            focusTarget.current = { index: 0, action: "toggle" };
            setExpanded((current) => !current);
          }}
        >
          {expanded ? "Show fewer" : `Show all ${totalCount} queued`}
        </button>
      )}
      {edit?.notice && <span className="composer-queue-notice">{edit.notice}</span>}
      {errorText && <span className="composer-queue-alert" role="alert">{errorText}</span>}
      <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {politeAnnouncement}
      </span>
    </div>
  );

  return (
    <>
      {queueHost ? createPortal(listElement, queueHost) : listElement}
      {editBannerPortal}
    </>
  );
}
