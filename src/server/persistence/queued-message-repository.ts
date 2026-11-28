import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AgentTurn, ChatAttachment, Conversation } from "../../shared/contracts";
import { modelSelectionSchema } from "../../shared/model-routing";
import type {
  QueueCreatedBy,
  QueueCreationSource,
  QueueDeliveryMode,
  QueueItemKind,
} from "../../shared/orchestration-queue";
import { MAX_QUEUED_MESSAGES, MAX_UNREAD_FOLLOW_UP_ROWS, type QueuedMessage } from "../../shared/queued-messages";
import { watcherNoteAttributionSchema, type WatcherNoteAttribution } from "../../shared/watcher";
import { delegatedCompletionAttributionSchema, type DelegatedCompletionAttribution } from "../../shared/orchestration-delegation";
import { delegatedCompletionFromJson, parseStoredAttachments, rendererSafeAttachments, watcherNoteFromJson } from "./codecs";
import { MESSAGE_PROJECTION_COLUMNS } from "./stream-text-storage";

interface QueueRow {
  id: string; conversation_id: string; content: string; attachments_json: string;
  intent_digest: string; route_identity: string; state: QueuedMessage["state"];
  created_at: string; error: string | null; turn_id: string | null; user_message_id: string | null;
  watcher_note_json?: string | null;
  delegated_completion_json?: string | null;
  queue_position?: number | null;
  queue_held?: number | null;
  kind?: QueueItemKind | null;
  created_by?: QueueCreatedBy | null;
  creation_source?: QueueCreationSource | null;
  device_id?: string | null;
  steer_follow_up_of_run_id?: string | null;
  edit_revision?: number | null;
  edited_at?: string | null;
  creation_digest?: string | null;
  dispatch_ordinal?: number | null;
  run_id?: string | null;
  delivery_mode?: QueueDeliveryMode | null;
  steer_when_ready_run_id?: string | null;
  selection_json?: string | null;
  follows_thread_selection?: number | null;
}
const ACTIVE_STATES = "('waiting','dispatching','blocked')";
/** An active row that names a persisted message: a follow-up its provider accepted but never read. */
const NAMES_UNREAD_FOLLOW_UP = "user_message_id IS NOT NULL";
function parseSelection(raw: string | null | undefined) {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  try {
    const parsed = modelSelectionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
function project(row: QueueRow): QueuedMessage {
  const watcherNote = watcherNoteFromJson(row.watcher_note_json);
  const delegatedCompletion = delegatedCompletionFromJson(row.delegated_completion_json);
  const modelSelection = parseSelection(row.selection_json);
  return {
    id: row.id, conversationId: row.conversation_id, content: row.content,
    attachments: rendererSafeAttachments(parseStoredAttachments(row.attachments_json)),
    state: row.state, createdAt: row.created_at, error: row.error,
    turnId: row.turn_id, userMessageId: row.user_message_id,
    ...(watcherNote ? { watcherNote } : {}),
    ...(delegatedCompletion ? { delegatedCompletion } : {}),
    ...(row.kind ? { kind: row.kind } : {}),
    ...(row.queue_position !== undefined ? { queuePosition: row.queue_position } : {}),
    ...(row.queue_held !== undefined && row.queue_held !== null ? { queueHeld: row.queue_held === 1 } : {}),
    ...(row.edit_revision !== undefined && row.edit_revision !== null ? { editRevision: row.edit_revision } : {}),
    ...(row.edited_at !== undefined ? { editedAt: row.edited_at } : {}),
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    ...(row.creation_source ? { creationSource: row.creation_source } : {}),
    ...(row.device_id !== undefined ? { deviceId: row.device_id } : {}),
    ...(row.steer_when_ready_run_id !== undefined ? { steerWhenReadyRunId: row.steer_when_ready_run_id } : {}),
    ...(row.steer_follow_up_of_run_id !== undefined ? { steerFollowUpOfRunId: row.steer_follow_up_of_run_id } : {}),
    ...(modelSelection !== undefined ? { modelSelection } : {}),
    ...(row.follows_thread_selection !== undefined && row.follows_thread_selection !== null
      ? { followsThreadSelection: row.follows_thread_selection === 1 } : {}),
    ...(row.dispatch_ordinal !== undefined && row.dispatch_ordinal !== null ? { dispatchOrdinal: row.dispatch_ordinal } : {}),
    ...(row.run_id !== undefined ? { runId: row.run_id } : {}),
    ...(row.delivery_mode !== undefined ? { deliveryMode: row.delivery_mode } : {}),
  };
}
export function delegatedDeliveryId(parentConversationId: string, generation: number): string {
  const bytes = createHash("sha256").update(JSON.stringify(["delegated-completion", parentConversationId, generation])).digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function queuedRouteIdentity(conversation: Conversation): string {
  return JSON.stringify([conversation.projectId, conversation.worktreePath, conversation.providerId,
    conversation.modelSelection, conversation.model, conversation.reasoningEffort,
    conversation.interactionMode, conversation.accessMode]);
}
export function queuedIntentDigest(content: string, attachments: readonly ChatAttachment[]): string {
  return createHash("sha256").update(JSON.stringify([content.trim(), attachments.map(({ id }) => id)])).digest("hex");
}
/** Whether a chat's latest turn lets its queue send the next message by itself. */
export function releasesQueue(turn: Pick<AgentTurn, "status" | "terminalReason"> | null): boolean {
  return turn?.status === "completed" || (turn?.status === "interrupted" && turn.terminalReason === "app-update");
}
export class QueuedMessageLimitError extends Error {
  constructor() {
    super("This chat already has three queued messages.");
    this.name = "QueuedMessageLimitError";
  }
}
export const RETAINED_TERMINAL_QUEUED_MESSAGES = 50;
export function pruneTerminalQueuedMessages(database: Database.Database, conversationId: string): void {
  database.prepare(`DELETE FROM queued_messages WHERE conversation_id = ? AND state IN ('accepted','cancelled') AND sequence NOT IN (
    SELECT sequence FROM queued_messages WHERE conversation_id = ? AND state IN ('accepted','cancelled') ORDER BY sequence DESC LIMIT ?
  )`).run(conversationId, conversationId, RETAINED_TERMINAL_QUEUED_MESSAGES);
}
export class QueuedMessageRepository {
  constructor(private readonly database: Database.Database) {}

  get(conversationId: string, id: string): QueuedMessage | null {
    const row = this.database.prepare("SELECT * FROM queued_messages WHERE id = ? AND conversation_id = ?")
      .get(id, conversationId) as QueueRow | undefined;
    return row ? project(row) : null;
  }
  replay(conversationId: string, id: string, digest: string): QueuedMessage | null {
    const row = this.database.prepare("SELECT * FROM queued_messages WHERE id = ?").get(id) as QueueRow | undefined;
    if (!row) return null;
    if (row.conversation_id !== conversationId || row.intent_digest !== digest) {
      throw new Error("The queued message identity was reused for a different request.");
    }
    return project(row);
  }
  list(conversationId: string): QueuedMessage[] {
    // Submission time, so an unread follow-up keeps its place (Phase 5 N2): behind rows queued before it was
    // sent, ahead of rows queued after.
    return (this.database.prepare(`SELECT * FROM queued_messages WHERE conversation_id = ? AND state IN ${ACTIVE_STATES}
      ORDER BY (delegated_completion_json IS NULL), (watcher_note_json IS NOT NULL), created_at, sequence`)
      .all(conversationId) as QueueRow[]).map(project);
  }
  cappedCount(conversationId: string): number {
    return (this.database.prepare(`SELECT COUNT(*) AS count FROM queued_messages WHERE conversation_id = ?
      AND state IN ${ACTIVE_STATES} AND delegated_completion_json IS NULL AND NOT (${NAMES_UNREAD_FOLLOW_UP})`)
      .get(conversationId) as { count: number }).count;
  }
  /**
   * Queues, by reference, each follow-up its provider accepted but never read, in the settlement transaction of
   * the turn that dropped it (T3 `requeueUnreadSteers`, Phase 5 N2). The row names the message, which the
   * dispatched turn adopts; its time is the follow-up's submission, or its original row's for a queued message
   * sent during the turn. Outside the cap; never with a delegated attribution, which dispatch reads from the
   * message instead. The row keeps the route its turn ran on: the chat's route at settlement, since the chat's
   * configuration cannot change while a run is active. Returns the ids it queued; beyond the bound of 64 the
   * rest are logged and stay in their turn, credited as delivered, so none is ever hidden.
   *
   * Deviation until Phase 5: only a settled turn queues its unread follow-ups. A restart mid-turn ends that turn
   * through recovery, with no provider report of which follow-ups were read, so none is queued (T3 requeues them
   * in recovery from its per-steer pending state).
   */
  /** The unread follow-ups `requeueUnreadFollowUps` would queue now, in order; the rest stay in their turn. */
  queueableUnreadFollowUps(conversationId: string, turnId: string, messageIds: readonly string[]): string[] {
    return this.unreadFollowUpAdmission(conversationId, turnId, messageIds).queueable;
  }

  private unreadFollowUpAdmission(conversationId: string, turnId: string, messageIds: readonly string[]) {
    const message = this.database.prepare(`SELECT 1 FROM messages
      JOIN agent_turns AS turn ON turn.id = messages.turn_id
      WHERE messages.id = ? AND messages.conversation_id = ? AND messages.turn_id = ? AND messages.role = 'user'
        AND turn.user_message_id <> messages.id`);
    const named = this.database.prepare(`SELECT 1 FROM queued_messages WHERE conversation_id = ?
      AND state IN ${ACTIVE_STATES} AND user_message_id = ?`);
    const { count } = this.database.prepare(`SELECT COUNT(*) AS count FROM queued_messages WHERE conversation_id = ?
      AND state IN ${ACTIVE_STATES} AND ${NAMES_UNREAD_FOLLOW_UP}`).get(conversationId) as { count: number };
    const queueable: string[] = [];
    for (const messageId of new Set(messageIds)) {
      if (!message.get(messageId, conversationId, turnId) || named.get(conversationId, messageId)) continue;
      if (count + queueable.length >= MAX_UNREAD_FOLLOW_UP_ROWS) return { queueable, capped: true };
      queueable.push(messageId);
    }
    return { queueable, capped: false };
  }

  private nextQueuePosition(conversationId: string): number {
    const row = this.database.prepare(`SELECT COALESCE(MAX(queue_position), 0) AS max_pos FROM queued_messages
      WHERE conversation_id = ? AND state IN ${ACTIVE_STATES} AND delegated_completion_json IS NULL`)
      .get(conversationId) as { max_pos: number };
    return row.max_pos + 1;
  }

  requeueUnreadFollowUps(conversation: Conversation, turnId: string, messageIds: readonly string[]): string[] {
    const { queueable, capped } = this.unreadFollowUpAdmission(conversation.id, turnId, messageIds);
    if (capped) console.warn("Too many unread follow-ups wait in this chat; the rest stay in their turn.");
    const message = this.database.prepare(`SELECT ${MESSAGE_PROJECTION_COLUMNS}, private_connect_device_id,
      watcher_note_json, delegated_completion_json FROM messages WHERE id = ?`);
    const turnRow = this.database.prepare("SELECT run_id FROM agent_turns WHERE id = ?")
      .get(turnId) as { run_id: string } | undefined;
    const original = this.database.prepare(`SELECT created_at FROM queued_messages WHERE conversation_id = ?
      AND state = 'accepted' AND user_message_id = ? ORDER BY sequence LIMIT 1`);
    const insert = this.database.prepare(`INSERT INTO queued_messages (id, conversation_id, content, attachments_json,
      intent_digest, creation_digest, route_identity, state, created_at, user_message_id, queue_position, kind,
      created_by, creation_source, device_id, steer_follow_up_of_run_id, selection_json, follows_thread_selection)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, 'message', ?, ?, ?, ?, ?, 0)`);
    const selectionJson = JSON.stringify(conversation.modelSelection);
    const queued: string[] = [];
    for (const messageId of queueable) {
      const row = message.get(messageId) as {
        content: string; attachments_json: string; created_at: string;
        private_connect_device_id?: string | null; watcher_note_json?: string | null; delegated_completion_json?: string | null;
      };
      const attachments = rendererSafeAttachments(parseStoredAttachments(row.attachments_json));
      // The row shows the text; the adopted message carries all of it.
      const content = row.content.slice(0, 20_000);
      const createdAt = (original.get(conversation.id, messageId) as { created_at: string } | undefined)?.created_at ?? row.created_at;
      const digest = queuedIntentDigest(content, attachments);
      const isSystem = Boolean(row.watcher_note_json || row.delegated_completion_json);
      const createdBy: QueueCreatedBy = isSystem ? "system" : "user";
      const creationSource: QueueCreationSource = row.private_connect_device_id
        ? "mobile"
        : isSystem ? "server" : "web";
      insert.run(randomUUID(), conversation.id, content, JSON.stringify(attachments), digest, digest,
        queuedRouteIdentity(conversation), createdAt, messageId, this.nextQueuePosition(conversation.id),
        createdBy, creationSource, row.private_connect_device_id ?? null, turnRow?.run_id ?? null, selectionJson);
      queued.push(messageId);
    }
    return queued;
  }
  activeDelegatedDelivery(conversationId: string): QueuedMessage | null {
    const row = this.database.prepare(`SELECT * FROM queued_messages WHERE conversation_id = ? AND state IN ${ACTIVE_STATES}
      AND delegated_completion_json IS NOT NULL`).get(conversationId) as QueueRow | undefined;
    return row ? project(row) : null;
  }
  insertDelegatedDelivery(input: { id: string; conversation: Conversation; content: string;
    attribution: DelegatedCompletionAttribution }): QueuedMessage {
    const attribution = delegatedCompletionAttributionSchema.parse(input.attribution);
    if (attribution.parentConversationId !== input.conversation.id
      || input.id !== delegatedDeliveryId(input.conversation.id, attribution.generation)) {
      throw new Error("The delegated result delivery identity conflicts with its parent chat.");
    }
    const content = input.content.trim();
    const digest = queuedIntentDigest(content, []);
    this.database.prepare(`INSERT INTO queued_messages (id, conversation_id, content, attachments_json, intent_digest,
      creation_digest, route_identity, state, created_at, delegated_completion_json, kind, created_by, creation_source,
      follows_thread_selection) VALUES (?, ?, ?, '[]', ?, ?, ?, 'waiting', ?, ?, 'delegated-results', 'system', 'server', 1)`)
      .run(input.id, input.conversation.id, content, digest, digest, queuedRouteIdentity(input.conversation),
        new Date().toISOString(), JSON.stringify(attribution));
    return this.get(input.conversation.id, input.id)!;
  }
  updateDelegatedDelivery(conversationId: string, id: string, content: string, attribution: DelegatedCompletionAttribution): boolean {
    const parsed = delegatedCompletionAttributionSchema.parse(attribution);
    const trimmed = content.trim();
    return this.database.prepare(`UPDATE queued_messages SET content = ?, intent_digest = ?, delegated_completion_json = ?
      WHERE id = ? AND conversation_id = ? AND state IN ('waiting','blocked') AND delegated_completion_json IS NOT NULL
        AND json_extract(delegated_completion_json, '$.generation') = ?`)
      .run(trimmed, queuedIntentDigest(trimmed, []), JSON.stringify(parsed), id, conversationId, parsed.generation).changes === 1;
  }
  withdrawDelegatedDelivery(conversationId: string, id: string): boolean {
    const row = this.database.prepare(`SELECT 1 FROM queued_messages WHERE id = ? AND conversation_id = ?
      AND delegated_completion_json IS NOT NULL AND state IN ('waiting','blocked')`).get(id, conversationId);
    return row !== undefined && this.cancel(conversationId, id) !== null;
  }
  pendingConversationIds(): string[] {
    return (this.database.prepare("SELECT DISTINCT conversation_id FROM queued_messages WHERE state = 'waiting'").all() as { conversation_id: string }[])
      .map(({ conversation_id }) => conversation_id);
  }
  add(input: {
    id: string; conversation: Conversation; content: string; attachments: readonly ChatAttachment[]; digest: string;
    watcherNote?: WatcherNoteAttribution;
  }): QueuedMessage {
    return this.database.transaction(() => {
      const existing = this.replay(input.conversation.id, input.id, input.digest);
      if (existing) return existing;
      if (this.cappedCount(input.conversation.id) >= MAX_QUEUED_MESSAGES) throw new QueuedMessageLimitError();
      const watcherNote = input.watcherNote === undefined ? null : watcherNoteAttributionSchema.parse(input.watcherNote);
      const kind: QueueItemKind = watcherNote ? "watcher-note" : "message";
      const createdBy: QueueCreatedBy = watcherNote ? "system" : "user";
      const creationSource: QueueCreationSource = watcherNote ? "server" : "web";
      const selectionJson = watcherNote ? null : JSON.stringify(input.conversation.modelSelection);
      this.database.prepare(`INSERT INTO queued_messages (id, conversation_id, content, attachments_json, intent_digest,
        creation_digest, route_identity, state, created_at, watcher_note_json, queue_position, kind, created_by,
        creation_source, selection_json, follows_thread_selection)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.id, input.conversation.id, input.content.trim(),
        JSON.stringify(rendererSafeAttachments(input.attachments)), input.digest, input.digest,
        queuedRouteIdentity(input.conversation), new Date().toISOString(),
        watcherNote ? JSON.stringify(watcherNote) : null, this.nextQueuePosition(input.conversation.id),
        kind, createdBy, creationSource, selectionJson, watcherNote ? 1 : 0,
      );
      return this.get(input.conversation.id, input.id)!;
    })();
  }
  routeMatches(message: QueuedMessage, conversation: Conversation): boolean {
    // Delegated results run on the chat's current route. An unread follow-up keeps the route its turn ran on
    // (T3 `08804b217`), like any queued message.
    const row = this.database.prepare(`SELECT route_identity, delegated_completion_json IS NOT NULL AS delegated
      FROM queued_messages WHERE id = ? AND conversation_id = ?`)
      .get(message.id, conversation.id) as { route_identity: string; delegated: 0 | 1 } | undefined;
    return row?.delegated === 1 || row?.route_identity === queuedRouteIdentity(conversation);
  }
  queuedRoute(conversationId: string, id: string): { providerId: string; interactionMode: Conversation["interactionMode"]; accessMode: Conversation["accessMode"] } | null {
    const row = this.database.prepare("SELECT route_identity FROM queued_messages WHERE id = ? AND conversation_id = ?")
      .get(id, conversationId) as { route_identity: string } | undefined;
    if (!row) return null;
    try {
      const route: unknown = JSON.parse(row.route_identity);
      if (!Array.isArray(route) || route.length !== 8) return null;
      const [, , providerId, , , , interactionMode, accessMode] = route as unknown[];
      if (typeof providerId !== "string" || (interactionMode !== "build" && interactionMode !== "plan")
        || (accessMode !== "supervised" && accessMode !== "auto-edit" && accessMode !== "full")) return null;
      return { providerId, interactionMode, accessMode };
    } catch {
      return null;
    }
  }
  reroute(conversation: Conversation, id: string): boolean {
    return this.database.prepare("UPDATE queued_messages SET route_identity = ?, state = 'waiting', error = NULL WHERE id = ? AND conversation_id = ? AND state IN ('waiting','blocked')")
      .run(queuedRouteIdentity(conversation), id, conversation.id).changes === 1;
  }
  claim(conversationId: string, id: string): boolean {
    return this.database.prepare("UPDATE queued_messages SET state = 'dispatching', error = NULL WHERE id = ? AND conversation_id = ? AND state IN ('waiting','blocked')")
      .run(id, conversationId).changes === 1;
  }
  release(conversationId: string, id: string): boolean {
    return this.database.prepare("UPDATE queued_messages SET state = 'waiting', error = NULL WHERE id = ? AND conversation_id = ? AND state = 'dispatching' AND turn_id IS NULL")
      .run(id, conversationId).changes === 1;
  }
  block(conversationId: string, id: string, error: string): void {
    this.database.prepare("UPDATE queued_messages SET state = 'blocked', error = ? WHERE id = ? AND conversation_id = ? AND state IN ('waiting','dispatching','blocked')")
      .run(error.slice(0, 1000), id, conversationId);
  }
  cancel(conversationId: string, id: string): QueuedMessage | null {
    return this.database.transaction(() => {
      const item = this.get(conversationId, id);
      if (!item || !["waiting", "blocked"].includes(item.state)) return null;
      this.database.prepare("UPDATE queued_messages SET state = 'cancelled', content = '', attachments_json = '[]', error = NULL, queue_position = NULL, queue_held = 0 WHERE id = ? AND conversation_id = ?")
        .run(id, conversationId);
      pruneTerminalQueuedMessages(this.database, conversationId);
      return item;
    })();
  }
  reconcile(): void {
    this.database.prepare("UPDATE queued_messages SET state = 'waiting', error = NULL WHERE state = 'dispatching' AND turn_id IS NULL").run();
  }
  attachments(conversationId?: string): ChatAttachment[] {
    const rows = (conversationId === undefined
      ? this.database.prepare("SELECT attachments_json FROM queued_messages WHERE state IN ('waiting','dispatching','blocked')").all()
      : this.database.prepare("SELECT attachments_json FROM queued_messages WHERE conversation_id = ? AND state IN ('waiting','dispatching','blocked')").all(conversationId)) as { attachments_json: string }[];
    return rows.flatMap(({ attachments_json }) => rendererSafeAttachments(parseStoredAttachments(attachments_json)));
  }
  referencedAttachmentIds(candidateIds: readonly string[], transcriptIds: Set<string>): Set<string> {
    const candidates = new Set(candidateIds);
    if (candidates.size === 0) return transcriptIds;
    const rows = this.database.prepare(`
      SELECT attachments_json FROM queued_messages
      WHERE state IN ('waiting','dispatching','blocked') AND attachments_json <> '[]'
        AND (json_valid(attachments_json) = 0 OR EXISTS (
          SELECT 1 FROM json_tree(CASE WHEN json_valid(attachments_json) THEN attachments_json ELSE '[]' END) AS node
          WHERE node.atom IN (SELECT value FROM json_each(?))
        ))
    `).all(JSON.stringify([...candidates])) as { attachments_json: string }[];
    for (const row of rows) for (const attachment of parseStoredAttachments(row.attachments_json)) {
      if (candidates.has(attachment.id)) transcriptIds.add(attachment.id);
    }
    return transcriptIds;
  }
  excludeQueuedAttachments(candidateIds: readonly string[]): string[] {
    const queued = this.referencedAttachmentIds(candidateIds, new Set());
    return candidateIds.filter((id) => !queued.has(id));
  }
}
