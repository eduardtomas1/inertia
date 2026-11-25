import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CornerDownRight, Paperclip, PencilLine, Trash2 } from "lucide-react";
import { chatAttachmentKind } from "@shared/attachments";
import { ACCESS_MODE_LABELS, INTERACTION_MODE_LABELS } from "@shared/access-labels";
import { QUEUED_ROUTE_CHANGED_ERROR, type MessageQueueResult, type QueuedAccess, type QueuedMessage } from "@shared/queued-messages";
import { isAgentTurnTerminalStatus, type AgentTurnStatus } from "@shared/turn-lifecycle";
import { RUNTIME_QUEUE_CHANGED, type QueueCommand, type QueueCommandRunner, type QueuedMessageEdit } from "./runtimeQueueClient";
import { setRuntimeQueueLength } from "./runtimeQueueEvents";
import { IconButton } from "../ui";
import { runtimeCommandDelivery } from "../../utils/connectionMessages";

export const QUEUED_DOCUMENTS_SEND_LATER = "Documents send when the turn ends.";

const pendingLoads = new WeakMap<QueueCommandRunner, Map<string, Promise<MessageQueueResult>>>();
function loadQueue(run: QueueCommandRunner, conversationId: string): Promise<MessageQueueResult> {
  let loads = pendingLoads.get(run);
  if (!loads) { loads = new Map(); pendingLoads.set(run, loads); }
  const prior = loads.get(conversationId);
  if (prior) return prior;
  const operation = run({ type: "message.queue.get", payload: { conversationId } })
    .finally(() => { if (loads.get(conversationId) === operation) loads.delete(conversationId); });
  loads.set(conversationId, operation);
  return operation;
}

const accessLabel = (access: QueuedAccess): string =>
  `${INTERACTION_MODE_LABELS[access.interactionMode]} · ${ACCESS_MODE_LABELS[access.accessMode]}`;

function mediaLabel(attachments: QueuedMessage["attachments"]): string {
  const images = attachments.every(({ mimeType }) => chatAttachmentKind(mimeType) === "image");
  const noun = images ? "image" : "file";
  return `${attachments.length} ${attachments.length === 1 ? noun : `${noun}s`}`;
}

type FocusTarget = { index: number; action: "send" | "remove" } | null;

export function RuntimeComposerQueuedActions({ conversationId, onCommand, canSend, running = false, latestTurnId, latestTurnStatus, queueHost, edit, onFocusInput }: {
  conversationId: string; onCommand: QueueCommandRunner; canSend: boolean; running?: boolean;
  latestTurnId: string | null; latestTurnStatus: string | null; queueHost: HTMLElement | null;
  edit?: QueuedMessageEdit; onFocusInput?: () => void;
}): React.JSX.Element | null {
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const queueSignature = useRef("[]");
  const updateQueue = useCallback((entries: QueuedMessage[]): void => {
    const signature = JSON.stringify(entries);
    if (queueSignature.current === signature) return;
    queueSignature.current = signature;
    setQueue(entries);
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<NonNullable<MessageQueueResult["confirmation"]> | null>(null);
  const latestError = useRef(error);
  latestError.current = error;
  const errorEntry = useRef<string | null>(null);
  const owner = useRef(conversationId);
  const revision = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const focusTarget = useRef<FocusTarget>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  owner.current = conversationId;
  useEffect(() => {
    let current = true;
    let refused = false;
    let read = false;
    const turnActive = latestTurnStatus !== null && !isAgentTurnTerminalStatus(latestTurnStatus as AgentTurnStatus);
    const refresh = (): void => {
      if (refused || document.visibilityState === "hidden") return;
      const requestedRevision = revision.current;
      void loadQueue(onCommand, conversationId).then((result) => {
        if (current && revision.current === requestedRevision && document.visibilityState !== "hidden") {
          read = true;
          updateQueue(result.entries);
          if (latestError.current !== null && result.entries[0]?.id !== errorEntry.current) setError(null);
        }
      }, (failure: unknown) => {
        if (current && revision.current === requestedRevision && runtimeCommandDelivery(failure) === "rejected") refused = true;
      });
    };
    updateQueue([]); setError(null); setBusy(false); setConfirmation(null);
    refresh();
    const changed = (event: Event): void => {
      if ((event as CustomEvent<unknown>).detail === conversationId) {
        revision.current += 1;
        refused = false;
        pendingLoads.get(onCommand)?.delete(conversationId);
        refresh();
      }
    };
    window.addEventListener(RUNTIME_QUEUE_CHANGED, changed);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(() => {
      if (!read || turnActive || queueSignature.current !== "[]") refresh();
    }, 10_000);
    return () => { current = false; window.clearInterval(timer); window.removeEventListener(RUNTIME_QUEUE_CHANGED, changed); document.removeEventListener("visibilitychange", refresh); };
  }, [conversationId, onCommand, latestTurnId, latestTurnStatus, updateQueue]);
  const userQueued = queue.filter(({ watcherNote }) => !watcherNote).length;
  useEffect(() => setRuntimeQueueLength(conversationId, userQueued), [conversationId, userQueued]);
  useLayoutEffect(() => {
    const target = focusTarget.current;
    if (!target || busy) return;
    const active = document.activeElement;
    const focusLost = active === null || active === document.body || Boolean(listRef.current?.contains(active));
    focusTarget.current = null;
    if (!focusLost) return;
    const list = listRef.current;
    const preferred = target.action === "send" ? list?.querySelector<HTMLButtonElement>('[data-queue-action="send"]:not(:disabled)') : null;
    const removes = list?.querySelectorAll<HTMLButtonElement>('[data-queue-action="remove"]') ?? [];
    if (preferred) preferred.focus();
    else if (removes.length === 0) onFocusInput?.();
    else removes[Math.min(target.index, removes.length - 1)]?.focus();
  }, [busy, confirmation, onFocusInput, queue]);
  useLayoutEffect(() => {
    if (confirmation) confirmRef.current?.focus();
  }, [confirmation]);
  const first = queue[0];
  if (!first) return null;
  const mutate = async (
    command: QueueCommand,
    entry: QueuedMessage,
    index: number,
    after?: (result: MessageQueueResult) => Promise<void>,
  ): Promise<void> => {
    if (busy) return;
    setBusy(true); setError(null); setConfirmation(null);
    focusTarget.current = { index, action: "remove" };
    try {
      const result = await onCommand(command);
      if (owner.current === conversationId) { revision.current += 1; updateQueue(result.entries); }
      window.dispatchEvent(new CustomEvent(RUNTIME_QUEUE_CHANGED, { detail: conversationId }));
      if (owner.current === conversationId && result.confirmation) setConfirmation(result.confirmation);
      if (after) {
        focusTarget.current = null;
        await after(result);
      }
    } catch (failure) {
      if (owner.current === conversationId) {
        errorEntry.current = entry.id;
        setError(failure instanceof Error ? failure.message : "The queue could not be updated.");
      }
    } finally { if (owner.current === conversationId) setBusy(false); }
  };
  const payload = (entry: QueuedMessage) => ({ conversationId, id: entry.id });
  const reconfirm = (entry: QueuedMessage, index: number, confirmed?: QueuedAccess): Promise<void> =>
    mutate({ type: "message.queue.reconfirm", payload: { ...payload(entry), ...(confirmed ? { confirmed } : {}) } }, entry, index);
  const editBlocked = edit?.blockedReason ?? null;
  const statusEntry = queue.find(({ id, error: entryError }) => (error !== null && id === errorEntry.current) || entryError !== null);
  const statusText = error ?? statusEntry?.error ?? null;
  const confirming = confirmation ? queue.find(({ id }) => id === confirmation.id) ?? null : null;
  const element = <div ref={listRef} className="composer-queue" role="list" aria-label="Queued messages"
    data-rows={queue.length + (confirming ? 1 : 0)}>
    {queue.map((entry, index) => {
      const front = index === 0;
      const position = queue.length > 1 ? `${index + 1} of ${queue.length}` : null;
      const suffix = front ? "" : ` ${index + 1} of ${queue.length}`;
      const dispatching = entry.state === "dispatching";
      const routeBlocked = entry.state === "blocked" && entry.error === QUEUED_ROUTE_CHANGED_ERROR;
      const documents = entry.attachments.some(({ mimeType }) => chatAttachmentKind(mimeType) !== "image");
      const sendWaitsForTurn = running && documents;
      const editReason = editBlocked && !entry.watcherNote ? editBlocked : null;
      return <div key={entry.id} className={`composer-queue-item${entry.attachments.length ? " has-media" : ""}`} role="listitem">
        <CornerDownRight size={14} aria-hidden="true" />
        {entry.watcherNote && <small className="composer-queue-count">From watcher</small>}
        <span className="composer-queue-copy" title={entry.content}>{entry.content}</span>
        {entry.attachments.length > 0 && <span className="composer-queue-media" title={entry.attachments.map(({ name }) => name).join(", ")}>
          <Paperclip size={14} aria-hidden="true" />{mediaLabel(entry.attachments)}
        </span>}
        <small className="composer-queue-count">{dispatching ? "Sending…" : entry.state === "blocked" ? "Needs attention" : position ?? "Queued"}</small>
        {front && routeBlocked && <button type="button" className="composer-queue-send" aria-label="Send queued message with current settings"
          data-queue-action="send" disabled={busy} onClick={() => void reconfirm(entry, index)}>Send with current settings</button>}
        {front && !routeBlocked && <button type="button" className="composer-queue-send" aria-label="Send queued message now"
          data-queue-action="send" aria-describedby={sendWaitsForTurn ? `${descriptionId}-send` : undefined}
          disabled={busy || dispatching || !canSend || sendWaitsForTurn}
          onClick={() => void mutate({ type: "message.queue.send", payload: payload(entry) }, entry, index)}>Send now</button>}
        {front && sendWaitsForTurn && <span id={`${descriptionId}-send`} className="visually-hidden">{QUEUED_DOCUMENTS_SEND_LATER}</span>}
        {edit && !entry.watcherNote && <>
          <IconButton label={editReason ?? "Edit"} aria-label={`Edit queued message${suffix}`} className="composer-queue-remove"
            data-queue-action="edit" aria-describedby={editReason ? `${descriptionId}-edit-${index}` : undefined}
            disabled={busy || dispatching} aria-disabled={editReason ? true : undefined}
            onClick={() => {
              if (editReason !== null) return;
              void mutate({ type: "message.queue.edit", payload: payload(entry) }, entry, index, async (result) => {
                if (result.edited) await edit.onEdit(result.edited);
              });
            }}><PencilLine size={14} aria-hidden="true" /></IconButton>
          {editReason && <span id={`${descriptionId}-edit-${index}`} className="visually-hidden">{editReason}</span>}
        </>}
        <IconButton label="Remove" aria-label={`Remove queued message${suffix}`} className="composer-queue-remove" data-queue-action="remove"
          disabled={busy || dispatching} onClick={() => void mutate({ type: "message.queue.remove", payload: payload(entry) }, entry, index)}>
          <Trash2 size={14} aria-hidden="true" />
        </IconButton>
      </div>;
    })}
    {confirming && confirmation && <div className="composer-queue-item composer-queue-confirm" role="group" aria-label="Confirm wider access"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        setConfirmation(null);
        focusTarget.current = { index: 0, action: "send" };
      }}>
      <span className="composer-queue-copy">
        Queued with {accessLabel(confirmation.queued)}. Current settings: {accessLabel(confirmation.current)}.
      </span>
      <button ref={confirmRef} type="button" className="composer-queue-send" disabled={busy}
        onClick={() => void reconfirm(confirming, queue.indexOf(confirming), confirmation.current)}>
        Send with {ACCESS_MODE_LABELS[confirmation.current.accessMode]}
      </button>
      <button type="button" className="composer-queue-send" disabled={busy} onClick={() => {
        setConfirmation(null);
        focusTarget.current = { index: queue.indexOf(confirming), action: "send" };
      }}>Cancel</button>
    </div>}
    {statusText && <span role="status">{statusText}</span>}
  </div>;
  return queueHost ? createPortal(element, queueHost) : element;
}
