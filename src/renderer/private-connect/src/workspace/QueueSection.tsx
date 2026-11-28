import { useState } from "react";
import { z } from "zod";
import { PRIVATE_CONNECT_LIMITS } from "../../../../shared/private-connect/protocol";

export type PrivateConnectQueueHoldReason =
  | "stopped"
  | "failed"
  | "restart"
  | "usage-limit"
  | "workspace-setup"
  | "busy-session";

export interface PrivateConnectQueueItem {
  id: string;
  content: string;
  attachmentCount: number;
  state: "waiting" | "dispatching" | "blocked";
  queueHeld: boolean;
  editRevision: number;
  editable: boolean;
  sendLabel: "send-now" | "stop-and-send" | "queue" | "none";
  attribution: "user" | "watcher" | "delegated" | "device" | "agent";
  modelLabel: string | null;
  steerWaiting?: boolean;
  error: string | null;
}

export interface PrivateConnectQueueProjection {
  revision: number;
  held: boolean;
  holdReason: PrivateConnectQueueHoldReason | null;
  canResume: boolean;
  items: PrivateConnectQueueItem[];
}

export const privateConnectQueueItemSchema = z.object({
  id: z.string().min(1).max(200),
  content: z.string().max(64 * 1024),
  attachmentCount: z.number().int().min(0).max(100),
  state: z.enum(["waiting", "dispatching", "blocked"]),
  queueHeld: z.boolean(),
  editRevision: z.number().int().min(0),
  editable: z.boolean(),
  sendLabel: z.enum(["send-now", "stop-and-send", "queue", "none"]),
  attribution: z.enum(["user", "watcher", "delegated", "device", "agent"]),
  modelLabel: z.string().max(240).nullable(),
  steerWaiting: z.boolean().optional(),
  error: z.string().max(1000).nullable(),
}).strict();

export const privateConnectQueueProjectionSchema = z.object({
  revision: z.number().int().min(0),
  held: z.boolean(),
  holdReason: z.enum([
    "stopped",
    "failed",
    "restart",
    "usage-limit",
    "workspace-setup",
    "busy-session",
  ]).nullable(),
  canResume: z.boolean(),
  items: z.array(privateConnectQueueItemSchema).max(128),
}).strict();

function holdReasonText(reason: PrivateConnectQueueHoldReason | null): string {
  switch (reason) {
    case "stopped": return "Queue paused · Stopped";
    case "failed": return "Queue paused · Provider failed";
    case "restart": return "Queue paused · Restarted";
    case "usage-limit": return "Queue paused · Usage limit";
    case "workspace-setup": return "Queue paused · Workspace setup";
    case "busy-session": return "Queue paused · Busy session";
    default: return "Queue paused";
  }
}

function attributionLabel(attribution: PrivateConnectQueueItem["attribution"]): string | null {
  switch (attribution) {
    case "watcher": return "From watcher";
    case "delegated": return "Delegated results";
    case "device": return "From device";
    case "agent": return "From agent";
    default: return null;
  }
}

function itemStateLabel(item: PrivateConnectQueueItem): string {
  if (item.state === "dispatching") return "Sending…";
  if (item.state === "blocked") return "Needs attention";
  if (item.steerWaiting) return "Waiting for acceptance…";
  if (item.queueHeld) return "Paused";
  return "Queued";
}

function sendButtonText(sendLabel: PrivateConnectQueueItem["sendLabel"]): string | null {
  switch (sendLabel) {
    case "send-now": return "Send now";
    case "queue": return "Queue";
    default: return null;
  }
}

export interface QueueSectionProps {
  queue: PrivateConnectQueueProjection;
  canMutate: boolean;
  hasPendingQuestions: boolean;
  waitingForLocalAction: boolean;
  busy: boolean;
  offline: boolean;
  onSendItem?: (id: string) => Promise<void> | void;
  onEditItem?: (id: string, expectedRevision: number, content: string) => Promise<boolean | void> | void;
  onRemoveItem?: (id: string) => Promise<void> | void;
  onResume?: () => Promise<void> | void;
}

export function QueueSection({
  queue,
  canMutate,
  hasPendingQuestions,
  waitingForLocalAction,
  busy,
  offline,
  onSendItem,
  onEditItem,
  onRemoveItem,
  onResume,
}: QueueSectionProps): React.JSX.Element | null {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBaseRevision, setEditingBaseRevision] = useState<number | null>(null);
  const [editingBaseContent, setEditingBaseContent] = useState("");
  const [editDraft, setEditDraft] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  if (queue.items.length === 0) return null;

  const activeEditItem = editingId ? queue.items.find(({ id }) => id === editingId) ?? null : null;
  const showResume = canMutate
    && queue.held
    && queue.canResume
    && !hasPendingQuestions
    && !waitingForLocalAction;
  const liveSummary = queue.held
    ? `${holdReasonText(queue.holdReason)}, ${queue.items.length} queued`
    : `${queue.items.length} queued ${queue.items.length === 1 ? "message" : "messages"}`;

  const startEdit = (item: PrivateConnectQueueItem): void => {
    if (!canMutate || !item.editable || item.attachmentCount > 0) return;
    setEditingId(item.id);
    setEditingBaseRevision(item.editRevision);
    setEditingBaseContent(item.content);
    setEditDraft(item.content);
    setEditError(null);
  };

  const cancelEdit = (): void => {
    setEditingId(null);
    setEditingBaseRevision(null);
    setEditingBaseContent("");
    setEditDraft("");
    setEditError(null);
  };

  const saveEdit = async (item: PrivateConnectQueueItem): Promise<void> => {
    const trimmed = editDraft.trim();
    if (!trimmed || !onEditItem || savingEdit) return;
    const expectedRevision = editingBaseRevision ?? item.editRevision;
    setSavingEdit(true);
    setEditError(null);
    try {
      const ok = await onEditItem(item.id, expectedRevision, trimmed);
      if (ok === false) {
        setEditError(
          item.editRevision !== expectedRevision
            ? "This message changed on the desktop. Copy your draft or cancel to reload the latest version."
            : "Could not save your changes. Your draft is still here so you can retry or cancel.",
        );
        return;
      }
      setEditingId(null);
      setEditingBaseRevision(null);
      setEditingBaseContent("");
      setEditDraft("");
      setEditError(null);
    } catch (error) {
      setEditError(
        error instanceof Error && error.message
          ? error.message
          : "Could not save your changes. Your draft is still here so you can retry or cancel.",
      );
    } finally {
      setSavingEdit(false);
    }
  };

  return (
    <section className="queue-section" aria-label="Queued messages">
      <div className="queue-section-status" role="status" aria-live="polite">
        {liveSummary}
      </div>
      {queue.held && (
        <div className="queue-held-banner" role="group" aria-label="Queue paused">
          <span>{holdReasonText(queue.holdReason)}</span>
          {showResume && (
            <button
              type="button"
              className="queue-action-button"
              disabled={busy || offline}
              onClick={() => void onResume?.()}
            >
              Resume
            </button>
          )}
        </div>
      )}
      <div className="queue-list" role="list" aria-label="Queued messages">
        {queue.items.map((item, index) => {
          const isEditing = activeEditItem?.id === item.id;
          const attribution = attributionLabel(item.attribution);
          const sendText = item.attachmentCount === 0 ? sendButtonText(item.sendLabel) : null;
          const canEditThis = canMutate && item.editable && item.attachmentCount === 0 && item.state !== "dispatching";
          const updatedOnDesktop = isEditing
            && editingBaseRevision !== null
            && item.editRevision !== editingBaseRevision;
          const attachmentBadge = item.attachmentCount > 0
            ? `${item.attachmentCount} ${item.attachmentCount === 1 ? "attachment" : "attachments"}`
            : null;
          const itemLabel = `Queued message ${index + 1} of ${queue.items.length}${item.modelLabel ? `, ${item.modelLabel}` : ""}`;

          return (
            <div
              key={item.id}
              className="queue-item"
              role="listitem"
              aria-label={itemLabel}
              data-state={item.state}
            >
              <div className="queue-item-header">
                <div className="queue-chips">
                  <span className="queue-chip queue-state">{itemStateLabel(item)}</span>
                  {attribution && <span className="queue-chip">{attribution}</span>}
                  {item.modelLabel && <span className="queue-chip">{item.modelLabel}</span>}
                  {attachmentBadge && <span className="queue-chip">{attachmentBadge}</span>}
                </div>
                {canMutate && !isEditing && (
                  <div className="queue-item-actions">
                    {sendText && (
                      <button
                        type="button"
                        className="queue-action-button"
                        disabled={busy || offline || item.state === "dispatching" || item.sendLabel === "queue"}
                        onClick={() => void onSendItem?.(item.id)}
                      >
                        {sendText}
                      </button>
                    )}
                    {canEditThis && (
                      <button
                        type="button"
                        className="queue-action-button"
                        disabled={busy || offline}
                        onClick={() => startEdit(item)}
                      >
                        Edit
                      </button>
                    )}
                    <button
                      type="button"
                      className="queue-action-button"
                      disabled={busy || offline || item.state === "dispatching"}
                      onClick={() => void onRemoveItem?.(item.id)}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
              {isEditing ? (
                <form
                  className="queue-edit-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveEdit(item);
                  }}
                >
                  <textarea
                    aria-label="Edit queued message"
                    maxLength={PRIVATE_CONNECT_LIMITS.promptCharacters}
                    value={editDraft}
                    disabled={busy || offline || savingEdit}
                    onChange={(event) => {
                      setEditDraft(event.target.value);
                      setEditError(null);
                    }}
                  />
                  {editError ? (
                    <p className="queue-item-error" role="alert">{editError}</p>
                  ) : updatedOnDesktop ? (
                    <p className="queue-item-error" role="status">
                      Updated on desktop — saving will check for conflicts.
                    </p>
                  ) : null}
                  <div className="queue-edit-actions">
                    <button
                      type="submit"
                      className="queue-action-button"
                      disabled={
                        busy
                        || offline
                        || savingEdit
                        || !editDraft.trim()
                        || (editDraft.trim() === editingBaseContent.trim() && !updatedOnDesktop)
                      }
                    >
                      {savingEdit ? "Saving…" : "Save"}
                    </button>
                    <button
                      type="button"
                      className="queue-action-button"
                      disabled={savingEdit}
                      onClick={cancelEdit}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <p className="queue-item-content">{item.content}</p>
              )}
              {item.error && (
                <p className="queue-item-error" role="alert">{item.error}</p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
