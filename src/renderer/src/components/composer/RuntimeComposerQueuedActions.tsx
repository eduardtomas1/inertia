import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CornerDownRight, Paperclip, Trash2 } from "lucide-react";
import type { MessageQueueResult, QueuedMessage } from "@shared/queued-messages";
import { RUNTIME_QUEUE_CHANGED, type QueueCommandRunner } from "./runtimeQueueClient";

const pendingLoads = new WeakMap<QueueCommandRunner, Map<string, Promise<MessageQueueResult>>>();
function loadQueue(run: QueueCommandRunner, conversationId: string): Promise<MessageQueueResult> {
  let loads = pendingLoads.get(run);
  if (!loads) { loads = new Map(); pendingLoads.set(run, loads); }
  const prior = loads.get(conversationId);
  if (prior) return prior;
  const operation = run({ type: "message.queue.get", payload: { conversationId } })
    .finally(() => loads.delete(conversationId));
  loads.set(conversationId, operation);
  return operation;
}

export function RuntimeComposerQueuedActions({ conversationId, onCommand, running, canSend, latestTurnId, latestTurnStatus, queueHost }: {
  conversationId: string; onCommand: QueueCommandRunner; running: boolean; canSend: boolean;
  latestTurnId: string | null; latestTurnStatus: string | null; queueHost: HTMLElement | null;
}): React.JSX.Element | null {
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = useRef(conversationId);
  owner.current = conversationId;
  useEffect(() => {
    let current = true;
    const refresh = (): void => {
      if (document.visibilityState === "hidden") return;
      void loadQueue(onCommand, conversationId).then((result) => {
        if (current) { setQueue(result.entries); setError(null); }
      }, () => { /* A disconnected runtime keeps the last known queue visible. */ });
    };
    setQueue([]); setError(null); setBusy(false);
    refresh();
    const changed = (event: Event): void => {
      if ((event as CustomEvent<unknown>).detail === conversationId) refresh();
    };
    window.addEventListener(RUNTIME_QUEUE_CHANGED, changed);
    document.addEventListener("visibilitychange", refresh);
    // Small bounded reads reconcile edits from another window. Dispatch itself
    // is exclusively runtime-owned and continues while this component is gone.
    const timer = window.setInterval(refresh, 10_000);
    return () => { current = false; window.clearInterval(timer); window.removeEventListener(RUNTIME_QUEUE_CHANGED, changed); document.removeEventListener("visibilitychange", refresh); };
  }, [conversationId, onCommand, latestTurnId, latestTurnStatus]);
  const first = queue[0];
  if (!first) return null;
  const dispatching = first.state === "dispatching";
  const mutate = async (type: "message.queue.send" | "message.queue.remove"): Promise<void> => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await onCommand({ type, payload: { conversationId, id: first.id } });
      if (owner.current === conversationId) setQueue(result.entries);
      window.dispatchEvent(new CustomEvent(RUNTIME_QUEUE_CHANGED, { detail: conversationId }));
    } catch (failure) {
      if (owner.current === conversationId) setError(failure instanceof Error ? failure.message : "The queue could not be updated.");
    } finally { if (owner.current === conversationId) setBusy(false); }
  };
  const element = <div className="composer-queue" role="list" aria-label="Queued messages">
    <div className={`composer-queue-item${first.attachments.length ? " has-media" : ""}`} role="listitem">
      <CornerDownRight size={15} aria-hidden="true" />
      <span className="composer-queue-copy" title={first.content}>{first.content}</span>
      {first.attachments.length > 0 && <span className="composer-queue-media"><Paperclip size={13} aria-hidden="true" />{first.attachments.length} {first.attachments.length === 1 ? "image" : "images"}</span>}
      <small className="composer-queue-count" title={first.error ?? undefined}>{dispatching ? "Sending…" : first.state === "blocked" ? "Needs attention" : queue.length > 1 ? `1 of ${queue.length}` : "Queued"}</small>
      <button type="button" className="composer-queue-send" aria-label="Send queued message now" disabled={busy || dispatching || running || !canSend} onClick={() => void mutate("message.queue.send")}>Send now</button>
      <button type="button" className="composer-queue-remove" aria-label="Remove queued message" disabled={busy || dispatching} onClick={() => void mutate("message.queue.remove")}><Trash2 size={14} aria-hidden="true" /></button>
    </div>
    {(error ?? first.error) && <span role="status">{error ?? first.error}</span>}
  </div>;
  return queueHost ? createPortal(element, queueHost) : element;
}
