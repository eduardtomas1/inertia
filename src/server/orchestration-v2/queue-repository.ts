import type Database from "better-sqlite3";

import type { ChatAttachment, Conversation, ModelSelection } from "../../shared/contracts";
import { isCommandOnlyPrompt } from "../../shared/follow-up-steer";
import {
  normalizeScheduledTaskError,
  SCHEDULED_TASK_FAILURE_TRACKING_WINDOW_MS,
} from "../../shared/scheduled-tasks";
import { modelSelectionSchema } from "../../shared/model-routing";
import {
  QUEUE_ITEM_PROJECTION,
  QUEUE_STATE_PROJECTION,
  SUPERSEDED_TURN_PROJECTION,
  queueAdoptCommandId,
  queueContentCharCount,
  queueItemProjectionSchema,
  queueStateProjectionSchema,
  queuedItemsInDeliveryOrder,
  supersededTurnProjectionSchema,
  type QueueCancelReason,
  type QueueClaimReleaseReason,
  type QueueCreatedBy,
  type QueueCreationSource,
  type QueueDeliveryMode,
  type QueueEnqueuePlacement,
  type QueueEvent,
  type QueueHoldCause,
  type QueueItemAttribution,
  type QueueItemDelivery,
  type QueueItemKind,
  type QueueItemOrigin,
  type QueueItemProjection,
  type QueueReleaseCause,
  type QueueSendIntentKind,
  type QueueStateProjection,
  type SupersededTurnProjection,
} from "../../shared/orchestration-queue";
import { QUEUED_ROUTE_CHANGED_ERROR } from "../../shared/queued-messages";
import {
  delegatedCompletionFromJson,
  parseStoredAttachments,
  rendererSafeAttachments,
  watcherNoteFromJson,
} from "../persistence/codecs";
import {
  pruneTerminalQueuedMessages,
  queuedIntentDigest,
  queuedRouteIdentity,
} from "../persistence/queued-message-repository";
import type { OrchestrationEventStore } from "./event-store";
import { ensureOrchestrationThread } from "./thread-registration";
import {
  OrchestrationConflict,
  type CommandIdentity,
  type CommandSource,
  type JsonValue,
  type OrchestrationEvent,
} from "./types";

export interface QueueRepositoryAccess {
  conversation(id: string): Conversation;
  conversationPath(id: string): string;
}

export interface QueueMutationResult<T> {
  replayed: boolean;
  value: T;
  events: readonly OrchestrationEvent[];
  notifyCancelled?: () => void;
}

export interface QueueEnqueueInput {
  conversationId: string;
  itemId: string;
  content: string;
  attachments?: readonly ChatAttachment[];
  kind?: QueueItemKind;
  userMessageId?: string | null;
  createdBy?: QueueCreatedBy;
  creationSource?: QueueCreationSource;
  deviceId?: string;
  steerFollowUpOfRunId?: string;
  requeuedFromRunId?: string;
  requeuedFromTurnId?: string;
  routeIdentity?: string;
  modelSelection?: ModelSelection | null;
  followsThreadSelection?: true;
  placement?: QueueEnqueuePlacement;
  queueHeld?: boolean;
  skipHoldInheritance?: true;
  steerWhenReadyRunId?: string;
  freshContext?: true;
  bootAutoResend?: true;
  requestedAt?: string;
  attribution?: QueueItemAttribution;
  origin?: QueueItemOrigin;
  source?: CommandSource;
  commandType?: string;
  afterInsert?: () => void;
}

export interface QueueEditInput {
  conversationId: string;
  itemId: string;
  expectedRevision: number;
  content: string;
  attachments?: readonly ChatAttachment[];
  modelSelection?: ModelSelection | null;
  routeIdentity?: string;
  editedAt?: string;
  source?: CommandSource;
  commandType?: string;
}

export interface QueueReorderInput {
  conversationId: string;
  itemId: string;
  beforeItemId: string | null;
  source?: CommandSource;
  commandType?: string;
}

export interface QueueCancelInput {
  conversationId: string;
  itemId: string;
  reason: QueueCancelReason;
  detail?: string;
  deferCancelListeners?: boolean;
  source?: CommandSource;
  commandType?: string;
}

export interface QueueHoldInput {
  conversationId: string;
  cause: QueueHoldCause;
  itemIds?: readonly string[];
  source?: CommandSource;
  commandType?: string;
}

export interface QueueReleaseInput {
  conversationId: string;
  cause: QueueReleaseCause;
  itemIds?: readonly string[];
  bootAutoResend?: true;
  source?: CommandSource;
  commandType?: string;
}

export interface QueueSendRequestInput {
  conversationId: string;
  itemId: string | null;
  kind: QueueSendIntentKind;
  requestId: string;
  requestedAt?: string;
  source?: CommandSource;
  commandType?: string;
}

export interface QueueClaimInput {
  conversationId: string;
  itemId: string;
  mode: QueueDeliveryMode;
  source?: CommandSource;
  commandType?: string;
}

export interface QueueReleaseClaimInput {
  conversationId: string;
  itemId: string;
  reason: QueueClaimReleaseReason;
  detail?: string;
  source?: CommandSource;
  commandType?: string;
}

export interface QueueBlockInput {
  conversationId: string;
  itemId: string;
  blockedReason: string;
  detail: string;
  source?: CommandSource;
  commandType?: string;
}

export interface QueueDeliverInput {
  conversationId: string;
  itemId: string;
  delivery: QueueItemDelivery;
  source?: CommandSource;
  commandType?: string;
}

export interface QueueRequeueUndeliveredInput {
  conversationId: string;
  itemId: string;
  fromRunId: string;
  fromTurnId: string;
  userMessageId: string;
  content: string;
  attachments?: readonly ChatAttachment[];
  createdBy?: QueueCreatedBy;
  creationSource?: QueueCreationSource;
  deviceId?: string;
  routeIdentity?: string;
  modelSelection?: ModelSelection | null;
  followsThreadSelection?: true;
  freshContext?: true;
  attribution?: QueueItemAttribution;
  requestedAt?: string;
  queueHeld?: boolean;
  bootAutoResend?: true;
  placement?: QueueEnqueuePlacement;
  source?: CommandSource;
  commandType?: string;
}

export interface QueueAdoptionReport {
  adopted: string[];
  cancelled: string[];
  releasedDispatching: string[];
  skipped: string[];
}

export interface QueueItemContentRow {
  content: string;
  attachments: ChatAttachment[];
  editRevision: number;
  creationDigest: string | null;
  intentDigest: string;
}

interface LegacyQueueRow {
  sequence: number;
  id: string;
  conversation_id: string;
  content: string;
  attachments_json: string;
  intent_digest: string;
  creation_digest: string | null;
  route_identity: string;
  state: "waiting" | "dispatching" | "blocked" | "accepted" | "cancelled";
  created_at: string;
  error: string | null;
  turn_id: string | null;
  user_message_id: string | null;
  watcher_note_json: string | null;
  delegated_completion_json: string | null;
  queue_position: number | null;
  queue_held: number;
  kind: QueueItemKind;
  created_by: QueueCreatedBy;
  creation_source: QueueCreationSource;
  device_id: string | null;
  steer_follow_up_of_run_id: string | null;
  edit_revision: number;
  edited_at: string | null;
  dispatch_ordinal: number;
  run_id: string | null;
  delivery_mode: QueueDeliveryMode | null;
  steer_when_ready_run_id: string | null;
  selection_json: string | null;
  follows_thread_selection: number;
}

const toJsonValue = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

function parseSelectionJson(raw: string | null) {
  if (!raw) return undefined;
  try {
    const parsed = modelSelectionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function settleScheduledRunOnQueueCancel(
  database: Database.Database,
  item: Pick<QueueItemProjection, "attribution"> | null | undefined,
  reason: QueueCancelReason,
  detail: string | undefined,
  nowIso: string = new Date().toISOString(),
): void {
  if (!item?.attribution || !("scheduledTask" in item.attribution)) return;
  const runId = item.attribution.scheduledTask.runId;
  const runRow = database.prepare(`SELECT task_id, conversation_id, turn_id, claimed_at
    FROM scheduled_task_runs WHERE id = ? AND state IN ('claimed', 'queued')`).get(runId) as {
    task_id: string; conversation_id: string | null; turn_id: string | null; claimed_at: string;
  } | undefined;
  if (!runRow) return;
  const note = normalizeScheduledTaskError(detail ?? `The queued scheduled prompt was cancelled (${reason}).`);
  database.prepare(`UPDATE scheduled_task_runs
    SET state = 'skipped', error = COALESCE(error, ?), finished_at = COALESCE(finished_at, ?)
    WHERE id = ? AND state IN ('claimed', 'queued')`).run(note, nowIso, runId);
  const claimedMs = Date.parse(runRow.claimed_at);
  const nowMs = Date.parse(nowIso);
  if (Number.isFinite(claimedMs) && Number.isFinite(nowMs) && (nowMs - claimedMs) <= SCHEDULED_TASK_FAILURE_TRACKING_WINDOW_MS) {
    database.prepare(`UPDATE scheduled_tasks
      SET last_run_at = ?, last_run_status = 'skipped',
          last_conversation_id = ?,
          last_turn_id = ?,
          last_error = ?, updated_at = ?
      WHERE id = ?`).run(nowIso, runRow.conversation_id, runRow.turn_id, note, nowIso, runRow.task_id);
  }
}

export class OrchestrationQueueRepository {
  private readonly cancelListeners = new Set<(item: QueueItemProjection, reason: QueueCancelReason) => void>();

  constructor(
    private readonly database: Database.Database,
    private readonly events: OrchestrationEventStore,
    private readonly access: QueueRepositoryAccess,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  onCancel(listener: (item: QueueItemProjection, reason: QueueCancelReason) => void): () => void {
    this.cancelListeners.add(listener);
    return () => { this.cancelListeners.delete(listener); };
  }

  revision(threadId: string): number {
    return this.events.revision(threadId);
  }

  getState(threadId: string): QueueStateProjection | null {
    const row = this.events.projection(QUEUE_STATE_PROJECTION, threadId);
    return row ? queueStateProjectionSchema.parse(row.value) : null;
  }

  getItem(itemId: string): QueueItemProjection | null {
    const row = this.events.projection(QUEUE_ITEM_PROJECTION, itemId);
    return row ? queueItemProjectionSchema.parse(row.value) : null;
  }

  getSupersededTurn(turnId: string): SupersededTurnProjection | null {
    const row = this.events.projection(SUPERSEDED_TURN_PROJECTION, turnId);
    return row ? supersededTurnProjectionSchema.parse(row.value) : null;
  }

  getContent(conversationId: string, itemId: string): QueueItemContentRow | null {
    const row = this.database.prepare(`SELECT content, attachments_json, edit_revision, creation_digest, intent_digest
      FROM queued_messages WHERE id = ? AND conversation_id = ?`).get(itemId, conversationId) as {
      content: string; attachments_json: string; edit_revision: number; creation_digest: string | null; intent_digest: string;
    } | undefined;
    if (!row) return null;
    return {
      content: row.content,
      attachments: rendererSafeAttachments(parseStoredAttachments(row.attachments_json)),
      editRevision: row.edit_revision,
      creationDigest: row.creation_digest,
      intentDigest: row.intent_digest,
    };
  }

  listActive(threadId: string): QueueItemProjection[] {
    const state = this.getState(threadId);
    if (!state || state.activeItemIds.length === 0) return [];
    const items: QueueItemProjection[] = [];
    for (const itemId of state.activeItemIds) {
      const item = this.getItem(itemId);
      if (item && (item.state === "waiting" || item.state === "dispatching" || item.state === "blocked")) items.push(item);
    }
    return queuedItemsInDeliveryOrder(items);
  }

  listActiveByScheduledTask(taskId: string): Array<{ conversationId: string; itemId: string }> {
    const rows = this.database.prepare(`
      SELECT thread_id, id FROM orchestration_v2_entities
      WHERE kind = ?
        AND json_extract(payload_json, '$.state') IN ('waiting', 'blocked')
        AND json_extract(payload_json, '$.attribution.scheduledTask.taskId') = ?
    `).all(QUEUE_ITEM_PROJECTION, taskId) as Array<{ thread_id: string; id: string }>;
    return rows.map((row) => ({ conversationId: row.thread_id, itemId: row.id }));
  }

  pruneTerminal(conversationId: string): void {
    pruneTerminalQueuedMessages(this.database, conversationId);
  }

  /** N17: checks enqueue replay text against immutable `creation_digest` (survives later edits). */
  verifyEnqueueReplay(conversationId: string, itemId: string, content: string, attachments: readonly ChatAttachment[]): void {
    const row = this.database.prepare("SELECT creation_digest FROM queued_messages WHERE id = ? AND conversation_id = ?")
      .get(itemId, conversationId) as { creation_digest: string | null } | undefined;
    if (row && row.creation_digest !== null && row.creation_digest !== queuedIntentDigest(content, attachments)) {
      throw new OrchestrationConflict("command-conflict");
    }
  }

  /** N17: checks edit replay text against `intent_digest` while `edit_revision` still matches. */
  verifyEditReplay(
    conversationId: string,
    itemId: string,
    producedRevision: number,
    content: string,
    attachments?: readonly ChatAttachment[],
  ): void {
    const row = this.database.prepare("SELECT intent_digest, edit_revision, attachments_json FROM queued_messages WHERE id = ? AND conversation_id = ?")
      .get(itemId, conversationId) as { intent_digest: string; edit_revision: number; attachments_json: string } | undefined;
    if (!row || row.edit_revision !== producedRevision) return;
    const effective = attachments !== undefined
      ? rendererSafeAttachments(attachments)
      : rendererSafeAttachments(parseStoredAttachments(row.attachments_json));
    if (row.intent_digest !== queuedIntentDigest(content, effective)) throw new OrchestrationConflict("command-conflict");
  }

  enqueue(input: QueueEnqueueInput): QueueMutationResult<QueueItemProjection> {
    return this.database.transaction((): QueueMutationResult<QueueItemProjection> => {
      const conversation = this.access.conversation(input.conversationId);
      ensureOrchestrationThread(this.events, conversation, this.access.conversationPath(conversation.id));
      const content = input.content.trim();
      const attachments = rendererSafeAttachments(input.attachments ?? []);
      const kind: QueueItemKind = input.kind ?? (input.attribution && "delegatedCompletion" in input.attribution
        ? "delegated-results" : input.attribution && "watcherNote" in input.attribution ? "watcher-note" : "message");
      const createdBy: QueueCreatedBy = input.createdBy ?? (kind === "message" ? "user" : "system");
      const creationSource: QueueCreationSource = input.creationSource ?? (kind === "message" ? "web" : "server");
      const commandType = input.commandType ?? "message.queue.enqueue";
      const { identity, command } = this.commandContext(conversation, input.source, `queue-enqueue:${input.itemId}`,
        { type: commandType, conversationId: conversation.id, id: input.itemId, content, attachments, kind });
      if (this.events.receipt(identity, command, commandType)) {
        this.verifyEnqueueReplay(conversation.id, input.itemId, content, attachments);
        return { replayed: true, value: this.requireItem(input.itemId), events: [] };
      }
      const requestedAt = input.requestedAt ?? this.clock();
      const routeIdentity = input.routeIdentity ?? queuedRouteIdentity(conversation);
      const digest = queuedIntentDigest(content, attachments);
      const modelSelection = input.modelSelection !== undefined
        ? (input.modelSelection === null ? null : modelSelectionSchema.parse(input.modelSelection))
        : undefined;
      const events: QueueEvent[] = [];
      const supersededWatcherId = kind === "watcher-note" && input.attribution && "watcherNote" in input.attribution
        ? this.waitingWatcherNoteId(conversation.id, input.attribution.watcherNote.linkId)
        : null;
      if (supersededWatcherId !== null) {
        events.push({ type: "queue.item-cancelled", payload: { itemId: supersededWatcherId, reason: "superseded" } });
      }
      events.push({
        type: "queue.item-enqueued",
        payload: {
          itemId: input.itemId, kind, userMessageId: input.userMessageId ?? null, createdBy, creationSource,
          ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
          ...(input.steerFollowUpOfRunId !== undefined ? { steerFollowUpOfRunId: input.steerFollowUpOfRunId } : {}),
          ...(input.requeuedFromRunId !== undefined ? { requeuedFromRunId: input.requeuedFromRunId } : {}),
          ...(input.requeuedFromTurnId !== undefined ? { requeuedFromTurnId: input.requeuedFromTurnId } : {}),
          contentRef: { chars: queueContentCharCount(content), editRevision: 0 },
          attachmentIds: attachments.map(({ id }) => id), routeIdentity,
          ...(modelSelection !== undefined ? { modelSelection } : {}),
          ...(input.followsThreadSelection !== undefined ? { followsThreadSelection: input.followsThreadSelection } : {}),
          ...(input.placement !== undefined ? { placement: input.placement } : {}),
          ...(input.queueHeld !== undefined ? { queueHeld: input.queueHeld } : {}),
          ...(input.skipHoldInheritance !== undefined ? { skipHoldInheritance: input.skipHoldInheritance } : {}),
          ...(input.steerWhenReadyRunId !== undefined ? { steerWhenReadyRunId: input.steerWhenReadyRunId } : {}),
          ...(input.freshContext !== undefined ? { freshContext: input.freshContext } : {}),
          ...(input.bootAutoResend !== undefined ? { bootAutoResend: input.bootAutoResend } : {}),
          requestedAt,
          ...(input.attribution !== undefined ? { attribution: input.attribution } : {}),
          ...(input.origin !== undefined ? { origin: input.origin } : {}),
        },
      });
      const committed = this.events.commit({
        ...identity, command, commandType, expectedRevision: this.events.revision(conversation.id),
        events, result: { itemId: input.itemId },
      }, () => {
        if (supersededWatcherId !== null) this.cancelRowInTable(conversation.id, supersededWatcherId);
        const projected = this.requireItem(input.itemId);
        const watcherJson = input.attribution && "watcherNote" in input.attribution ? JSON.stringify(input.attribution.watcherNote) : null;
        const delegatedJson = input.attribution && "delegatedCompletion" in input.attribution ? JSON.stringify(input.attribution.delegatedCompletion) : null;
        this.database.prepare(`INSERT INTO queued_messages (
          id, conversation_id, content, attachments_json, intent_digest, creation_digest, route_identity, state,
          created_at, user_message_id, watcher_note_json, delegated_completion_json,
          queue_position, queue_held, kind, created_by, creation_source, device_id, steer_follow_up_of_run_id,
          edit_revision, edited_at, dispatch_ordinal, run_id, delivery_mode, steer_when_ready_run_id,
          selection_json, follows_thread_selection
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, NULL, NULL, ?, ?, ?)`).run(
          projected.id, conversation.id, content, JSON.stringify(attachments), digest, digest, routeIdentity,
          projected.state, requestedAt, projected.userMessageId, watcherJson, delegatedJson,
          projected.queuePosition, projected.queueHeld ? 1 : 0, projected.kind, projected.createdBy,
          projected.creationSource, projected.deviceId ?? null, projected.steerFollowUpOfRunId ?? null,
          projected.steerWhenReadyRunId ?? null, modelSelection ? JSON.stringify(modelSelection) : null,
          projected.followsThreadSelection ? 1 : 0,
        );
        input.afterInsert?.();
        this.syncActiveRowsToTable(conversation.id);
        if (supersededWatcherId !== null) this.pruneTerminal(conversation.id);
      });
      return { replayed: committed.replayed, value: this.requireItem(input.itemId), events: committed.events };
    }).immediate();
  }

  edit(input: QueueEditInput): QueueMutationResult<QueueItemProjection> {
    return this.database.transaction((): QueueMutationResult<QueueItemProjection> => {
      const conversation = this.access.conversation(input.conversationId);
      const content = input.content.trim();
      const sanitizedAttachments = input.attachments !== undefined ? rendererSafeAttachments(input.attachments) : undefined;
      const commandType = input.commandType ?? "message.queue.edit";
      const { identity, command } = this.commandContext(conversation, input.source, `queue-edit:${input.itemId}:${input.expectedRevision}`, {
        type: commandType, conversationId: conversation.id, id: input.itemId, expectedRevision: input.expectedRevision, content,
        ...(sanitizedAttachments !== undefined ? { attachments: sanitizedAttachments } : {}),
        ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      });
      if (this.events.receipt(identity, command, commandType)) {
        this.verifyEditReplay(conversation.id, input.itemId, input.expectedRevision + 1, content, sanitizedAttachments);
        return { replayed: true, value: this.requireItem(input.itemId), events: [] };
      }
      const editedAt = input.editedAt ?? this.clock();
      const modelSelection = input.modelSelection !== undefined
        ? (input.modelSelection === null ? null : modelSelectionSchema.parse(input.modelSelection))
        : undefined;
      const existingProjection = this.getItem(input.itemId);
      const nextAttachmentCount = sanitizedAttachments !== undefined
        ? sanitizedAttachments.length
        : (existingProjection?.attachmentIds.length ?? 0);
      const clearSteerWhenReady = existingProjection?.steerWhenReadyRunId !== undefined
        && isCommandOnlyPrompt(content, nextAttachmentCount);
      const committed = this.events.commit({
        ...identity, command, commandType, expectedRevision: this.events.revision(conversation.id),
        events: [{
          type: "queue.item-edited",
          payload: {
            itemId: input.itemId, expectedRevision: input.expectedRevision,
            contentRef: { chars: queueContentCharCount(content), editRevision: input.expectedRevision + 1 },
            ...(sanitizedAttachments !== undefined ? { attachmentIds: sanitizedAttachments.map(({ id }) => id) } : {}),
            ...(modelSelection !== undefined ? { modelSelection } : {}),
            ...(input.routeIdentity !== undefined ? { routeIdentity: input.routeIdentity } : {}),
            ...(clearSteerWhenReady ? { clearSteerWhenReady: true as const } : {}),
            editedAt,
          },
        }],
        result: { itemId: input.itemId, editRevision: input.expectedRevision + 1 },
      }, () => {
        const row = this.database.prepare("SELECT attachments_json, route_identity, selection_json FROM queued_messages WHERE id = ? AND conversation_id = ?")
          .get(input.itemId, conversation.id) as { attachments_json: string; route_identity: string; selection_json: string | null } | undefined;
        if (!row) throw new OrchestrationConflict("scope-conflict");
        const nextAttachments = sanitizedAttachments ?? rendererSafeAttachments(parseStoredAttachments(row.attachments_json));
        const nextSelection = modelSelection !== undefined ? (modelSelection === null ? null : JSON.stringify(modelSelection)) : row.selection_json;
        this.database.prepare(`UPDATE queued_messages
          SET content = ?, attachments_json = ?, intent_digest = ?, route_identity = ?,
              edit_revision = ?, edited_at = ?, state = 'waiting', error = NULL, selection_json = ?,
              steer_when_ready_run_id = CASE WHEN ? = 1 THEN NULL ELSE steer_when_ready_run_id END
          WHERE id = ? AND conversation_id = ?`).run(
          content, JSON.stringify(nextAttachments), queuedIntentDigest(content, nextAttachments),
          input.routeIdentity ?? row.route_identity, input.expectedRevision + 1, editedAt, nextSelection,
          clearSteerWhenReady ? 1 : 0, input.itemId, conversation.id,
        );
      });
      return { replayed: committed.replayed, value: this.requireItem(input.itemId), events: committed.events };
    }).immediate();
  }

  reorder(input: QueueReorderInput): QueueMutationResult<QueueItemProjection[]> {
    return this.database.transaction((): QueueMutationResult<QueueItemProjection[]> => {
      const conversation = this.access.conversation(input.conversationId);
      const commandType = input.commandType ?? "message.queue.reorder";
      const { identity, command } = this.commandContext(conversation, input.source,
        `queue-reorder:${input.itemId}:${input.beforeItemId ?? "end"}`,
        { type: commandType, conversationId: conversation.id, id: input.itemId, beforeId: input.beforeItemId });
      if (this.events.receipt(identity, command, commandType)) {
        return { replayed: true, value: this.listActive(conversation.id), events: [] };
      }
      const state = this.getState(conversation.id);
      if (!state || !state.activeItemIds.includes(input.itemId)) throw new OrchestrationConflict("revision-conflict");
      if (input.beforeItemId !== null) {
        if (input.beforeItemId === input.itemId || !state.activeItemIds.includes(input.beforeItemId)
          || this.getItem(input.beforeItemId)?.kind === "delegated-results") {
          throw new OrchestrationConflict("revision-conflict");
        }
      }
      const ordered = state.activeItemIds.filter((id) => id !== input.itemId);
      if (input.beforeItemId === null) ordered.push(input.itemId);
      else ordered.splice(ordered.indexOf(input.beforeItemId), 0, input.itemId);
      const committed = this.events.commit({
        ...identity, command, commandType, expectedRevision: this.events.revision(conversation.id),
        events: [{ type: "queue.reordered", payload: { movedItemId: input.itemId, orderedItemIds: ordered } }],
        result: { orderedItemIds: ordered },
      }, () => this.syncActiveRowsToTable(conversation.id));
      return { replayed: committed.replayed, value: this.listActive(conversation.id), events: committed.events };
    }).immediate();
  }

  cancel(input: QueueCancelInput): QueueMutationResult<QueueItemProjection> {
    let cancelledPrevious: QueueItemProjection | null = null;
    const outcome = this.database.transaction((): QueueMutationResult<QueueItemProjection> => {
      const conversation = this.access.conversation(input.conversationId);
      const commandType = input.commandType ?? "message.queue.remove";
      const { identity, command } = this.commandContext(conversation, input.source,
        `queue-cancel:${input.itemId}:${input.reason}`,
        { type: commandType, conversationId: conversation.id, id: input.itemId, reason: input.reason });
      if (this.events.receipt(identity, command, commandType)) {
        return { replayed: true, value: this.requireItem(input.itemId), events: [] };
      }
      const previous = this.getItem(input.itemId);
      const committed = this.events.commit({
        ...identity, command, commandType, expectedRevision: this.events.revision(conversation.id),
        events: [{
          type: "queue.item-cancelled",
          payload: { itemId: input.itemId, reason: input.reason, ...(input.detail !== undefined ? { detail: input.detail.slice(0, 1_000) } : {}) },
        }],
        result: { itemId: input.itemId, cancelled: true },
      }, () => {
        this.cancelRowInTable(conversation.id, input.itemId);
        this.syncActiveRowsToTable(conversation.id);
        this.pruneTerminal(conversation.id);
        settleScheduledRunOnQueueCancel(this.database, previous, input.reason, input.detail, this.clock());
      });
      if (!committed.replayed) cancelledPrevious = previous;
      return { replayed: committed.replayed, value: this.requireItem(input.itemId), events: committed.events };
    }).immediate();
    if (cancelledPrevious) {
      const notifyCancelled = (): void => {
        for (const listener of this.cancelListeners) {
          try { listener(cancelledPrevious!, input.reason); } catch { /* listener errors must not break cancel */ }
        }
      };
      if (input.deferCancelListeners) {
        return { ...outcome, notifyCancelled };
      }
      notifyCancelled();
    }
    return outcome;
  }

  hold(input: QueueHoldInput): QueueMutationResult<QueueItemProjection[]> {
    return this.database.transaction((): QueueMutationResult<QueueItemProjection[]> => {
      const conversation = this.access.conversation(input.conversationId);
      const commandType = input.commandType ?? "queue.hold";
      const { identity, command } = this.commandContext(conversation, input.source,
        `queue-hold:${conversation.id}:${input.cause}:${this.events.revision(conversation.id)}`,
        { type: commandType, conversationId: conversation.id, cause: input.cause, ...(input.itemIds ? { itemIds: [...input.itemIds] } : {}) });
      if (this.events.receipt(identity, command, commandType)) {
        return { replayed: true, value: this.listActive(conversation.id), events: [] };
      }
      const targetIds = input.itemIds !== undefined
        ? [...input.itemIds]
        : this.listActive(conversation.id).filter((item) => !item.queueHeld).map(({ id }) => id);
      if (input.itemIds === undefined && targetIds.length === 0) {
        return { replayed: false, value: this.listActive(conversation.id), events: [] };
      }
      const committed = this.events.commit({
        ...identity, command, commandType, expectedRevision: this.events.revision(conversation.id),
        events: [{ type: "queue.items-held", payload: { itemIds: targetIds, cause: input.cause } }],
        result: { heldItemIds: targetIds },
      }, () => this.syncActiveRowsToTable(conversation.id));
      return { replayed: committed.replayed, value: this.listActive(conversation.id), events: committed.events };
    }).immediate();
  }

  release(input: QueueReleaseInput): QueueMutationResult<QueueItemProjection[]> {
    return this.database.transaction((): QueueMutationResult<QueueItemProjection[]> => {
      const conversation = this.access.conversation(input.conversationId);
      const commandType = input.commandType ?? "queue.release";
      const { identity, command } = this.commandContext(conversation, input.source,
        `queue-release:${conversation.id}:${input.cause}:${this.events.revision(conversation.id)}`,
        { type: commandType, conversationId: conversation.id, cause: input.cause, ...(input.itemIds ? { itemIds: [...input.itemIds] } : {}) });
      if (this.events.receipt(identity, command, commandType)) {
        return { replayed: true, value: this.listActive(conversation.id), events: [] };
      }
      const targetIds = input.itemIds !== undefined
        ? [...input.itemIds]
        : this.listActive(conversation.id)
          .filter((item) => item.queueHeld && (input.cause !== "R2-run-completed" || item.createdBy !== "user"))
          .map(({ id }) => id);
      if (input.itemIds === undefined && targetIds.length === 0) {
        return { replayed: false, value: this.listActive(conversation.id), events: [] };
      }
      const committed = this.events.commit({
        ...identity, command, commandType, expectedRevision: this.events.revision(conversation.id),
        events: [{ type: "queue.items-released", payload: { itemIds: targetIds, cause: input.cause, ...(input.bootAutoResend ? { bootAutoResend: true } : {}) } }],
        result: { releasedItemIds: targetIds },
      }, () => this.syncActiveRowsToTable(conversation.id));
      return { replayed: committed.replayed, value: this.listActive(conversation.id), events: committed.events };
    }).immediate();
  }

  requestSend(input: QueueSendRequestInput): QueueMutationResult<QueueStateProjection> {
    return this.database.transaction((): QueueMutationResult<QueueStateProjection> => {
      const conversation = this.access.conversation(input.conversationId);
      ensureOrchestrationThread(this.events, conversation, this.access.conversationPath(conversation.id));
      const commandType = input.commandType ?? (input.kind === "resume" ? "message.queue.resume" : "message.queue.send");
      const { identity, command } = this.commandContext(conversation, input.source, `queue-send-intent:${input.requestId}`,
        { type: commandType, conversationId: conversation.id, itemId: input.itemId, kind: input.kind, requestId: input.requestId });
      if (this.events.receipt(identity, command, commandType)) {
        return { replayed: true, value: this.getState(conversation.id)!, events: [] };
      }
      const committed = this.events.commit({
        ...identity, command, commandType, expectedRevision: this.events.revision(conversation.id),
        events: [{
          type: "queue.send-requested",
          payload: { itemId: input.itemId, kind: input.kind, requestedAt: input.requestedAt ?? this.clock(), requestId: input.requestId },
        }],
        result: { requestId: input.requestId, kind: input.kind, itemId: input.itemId },
      });
      return { replayed: committed.replayed, value: this.getState(conversation.id)!, events: committed.events };
    }).immediate();
  }

  claim(input: QueueClaimInput): QueueMutationResult<QueueItemProjection> {
    return this.database.transaction((): QueueMutationResult<QueueItemProjection> => {
      const conversation = this.access.conversation(input.conversationId);
      const item = this.requireItem(input.itemId);
      if (input.mode === "steer" && item.attribution !== undefined && "scheduledTask" in item.attribution) {
        throw new OrchestrationConflict("revision-conflict");
      }
      const nextOrdinal = item.dispatchOrdinal + 1;
      const commandType = input.commandType ?? "queue.claim";
      const { identity, command } = this.commandContext(conversation, input.source, `queue-claim:${input.itemId}:${nextOrdinal}`,
        { type: commandType, conversationId: conversation.id, itemId: input.itemId, mode: input.mode, dispatchOrdinal: nextOrdinal });
      if (this.events.receipt(identity, command, commandType)) {
        return { replayed: true, value: this.requireItem(input.itemId), events: [] };
      }
      const committed = this.events.commit({
        ...identity, command, commandType, expectedRevision: this.events.revision(conversation.id),
        events: [{ type: "queue.item-claimed", payload: { itemId: input.itemId, mode: input.mode, dispatchOrdinal: nextOrdinal } }],
        result: { itemId: input.itemId, dispatchOrdinal: nextOrdinal },
      }, () => {
        this.database.prepare(`UPDATE queued_messages SET state = 'dispatching', error = NULL,
          dispatch_ordinal = ?, delivery_mode = ? WHERE id = ? AND conversation_id = ?`)
          .run(nextOrdinal, input.mode, input.itemId, conversation.id);
      });
      return { replayed: committed.replayed, value: this.requireItem(input.itemId), events: committed.events };
    }).immediate();
  }

  releaseClaim(input: QueueReleaseClaimInput): QueueMutationResult<QueueItemProjection> {
    return this.database.transaction((): QueueMutationResult<QueueItemProjection> => {
      const conversation = this.access.conversation(input.conversationId);
      const ordinal = this.requireItem(input.itemId).dispatchOrdinal;
      const commandType = input.commandType ?? "queue.release-claim";
      const { identity, command } = this.commandContext(conversation, input.source,
        `queue-release-claim:${input.itemId}:${ordinal}:${input.reason}`,
        { type: commandType, conversationId: conversation.id, itemId: input.itemId, reason: input.reason, dispatchOrdinal: ordinal });
      if (this.events.receipt(identity, command, commandType)) {
        return { replayed: true, value: this.requireItem(input.itemId), events: [] };
      }
      const committed = this.events.commit({
        ...identity, command, commandType, expectedRevision: this.events.revision(conversation.id),
        events: [{
          type: "queue.item-released",
          payload: { itemId: input.itemId, reason: input.reason, ...(input.detail !== undefined ? { detail: input.detail.slice(0, 1_000) } : {}) },
        }],
        result: { itemId: input.itemId },
      }, () => {
        this.database.prepare("UPDATE queued_messages SET state = 'waiting', error = NULL, delivery_mode = CASE WHEN delivery_mode = 'after-stop' THEN 'after-stop' ELSE NULL END WHERE id = ? AND conversation_id = ?")
          .run(input.itemId, conversation.id);
      });
      return { replayed: committed.replayed, value: this.requireItem(input.itemId), events: committed.events };
    }).immediate();
  }

  block(input: QueueBlockInput): QueueMutationResult<QueueItemProjection> {
    return this.database.transaction((): QueueMutationResult<QueueItemProjection> => {
      const conversation = this.access.conversation(input.conversationId);
      const detail = input.detail.slice(0, 1_000);
      const commandType = input.commandType ?? "queue.block";
      const { identity, command } = this.commandContext(conversation, input.source,
        `queue-block:${input.itemId}:${input.blockedReason}:${this.events.revision(conversation.id)}`,
        { type: commandType, conversationId: conversation.id, itemId: input.itemId, blockedReason: input.blockedReason, detail });
      if (this.events.receipt(identity, command, commandType)) {
        return { replayed: true, value: this.requireItem(input.itemId), events: [] };
      }
      const committed = this.events.commit({
        ...identity, command, commandType, expectedRevision: this.events.revision(conversation.id),
        events: [{ type: "queue.item-blocked", payload: { itemId: input.itemId, blockedReason: input.blockedReason, detail } }],
        result: { itemId: input.itemId, blockedReason: input.blockedReason },
      }, () => {
        this.database.prepare("UPDATE queued_messages SET state = 'blocked', error = ? WHERE id = ? AND conversation_id = ?")
          .run(detail, input.itemId, conversation.id);
      });
      return { replayed: committed.replayed, value: this.requireItem(input.itemId), events: committed.events };
    }).immediate();
  }

  deliver(input: QueueDeliverInput): QueueMutationResult<QueueItemProjection> {
    return this.database.transaction((): QueueMutationResult<QueueItemProjection> => {
      const conversation = this.access.conversation(input.conversationId);
      const commandType = input.commandType ?? "queue.deliver";
      const { identity, command } = this.commandContext(conversation, input.source,
        `queue-deliver:${input.itemId}:${input.delivery.runId}`,
        { type: commandType, conversationId: conversation.id, itemId: input.itemId, delivery: input.delivery });
      if (this.events.receipt(identity, command, commandType)) {
        return { replayed: true, value: this.requireItem(input.itemId), events: [] };
      }
      const committed = this.events.commit({
        ...identity, command, commandType, expectedRevision: this.events.revision(conversation.id),
        events: [{ type: "queue.item-delivered", payload: { itemId: input.itemId, delivery: input.delivery } }],
        result: { itemId: input.itemId, runId: input.delivery.runId, turnId: input.delivery.turnId },
      }, () => {
        this.database.prepare(`UPDATE queued_messages
          SET state = 'accepted', content = '', attachments_json = '[]', error = NULL,
              turn_id = (SELECT id FROM agent_turns WHERE id = ?),
              user_message_id = (SELECT id FROM messages WHERE id = ?),
              run_id = ?, delivery_mode = ?, queue_position = NULL, queue_held = 0
          WHERE id = ? AND conversation_id = ?`).run(
          input.delivery.turnId, input.delivery.messageId, input.delivery.runId,
          input.delivery.mode, input.itemId, conversation.id,
        );
        this.syncActiveRowsToTable(conversation.id);
        this.pruneTerminal(conversation.id);
      });
      return { replayed: committed.replayed, value: this.requireItem(input.itemId), events: committed.events };
    }).immediate();
  }

  requeueUndelivered(input: QueueRequeueUndeliveredInput): QueueMutationResult<QueueItemProjection> {
    return this.database.transaction((): QueueMutationResult<QueueItemProjection> => {
      const conversation = this.access.conversation(input.conversationId);
      ensureOrchestrationThread(this.events, conversation, this.access.conversationPath(conversation.id));
      const content = input.content.trim();
      const attachments = rendererSafeAttachments(input.attachments ?? []);
      const commandType = input.commandType ?? "queue.requeue";
      const { identity, command } = this.commandContext(conversation, input.source,
        `queue-requeue:${input.fromRunId}:${input.itemId}`,
        { type: commandType, conversationId: conversation.id, itemId: input.itemId, fromRunId: input.fromRunId, fromTurnId: input.fromTurnId, userMessageId: input.userMessageId });
      if (this.events.receipt(identity, command, commandType)) {
        return { replayed: true, value: this.requireItem(input.itemId), events: [] };
      }
      const editRevision = this.getItem(input.itemId)?.contentRef.editRevision ?? 0;
      const requestedAt = input.requestedAt ?? this.clock();
      const routeIdentity = input.routeIdentity ?? queuedRouteIdentity(conversation);
      const queueHeld = input.queueHeld ?? true;
      const createdBy = input.createdBy ?? "user";
      const creationSource = input.creationSource ?? "web";
      const modelSelection = input.modelSelection !== undefined
        ? (input.modelSelection === null ? null : modelSelectionSchema.parse(input.modelSelection))
        : undefined;
      const committed = this.events.commit({
        ...identity, command, commandType, expectedRevision: this.events.revision(conversation.id),
        events: [{
          type: "queue.item-requeued",
          payload: {
            itemId: input.itemId, fromRunId: input.fromRunId, fromTurnId: input.fromTurnId, userMessageId: input.userMessageId,
            contentRef: { chars: queueContentCharCount(content), editRevision },
            attachmentIds: attachments.map(({ id }) => id), routeIdentity,
            ...(modelSelection !== undefined ? { modelSelection } : {}),
            ...(input.followsThreadSelection !== undefined ? { followsThreadSelection: input.followsThreadSelection } : {}),
            ...(input.freshContext !== undefined ? { freshContext: input.freshContext } : {}),
            ...(input.attribution !== undefined ? { attribution: input.attribution } : {}),
            createdBy, creationSource, ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
            requestedAt, queueHeld, ...(input.bootAutoResend ? { bootAutoResend: true } : {}), placement: input.placement ?? "front",
          },
        }],
        result: { itemId: input.itemId },
      }, () => {
        const digest = queuedIntentDigest(content, attachments);
        const projected = this.requireItem(input.itemId);
        const selectionJson = modelSelection ? JSON.stringify(modelSelection) : null;
        const followsFlag = input.followsThreadSelection ? 1 : 0;
        const updated = this.database.prepare(`UPDATE queued_messages
          SET content = ?, attachments_json = ?, intent_digest = ?, route_identity = ?,
              state = 'waiting', error = NULL, turn_id = NULL, user_message_id = ?,
              queue_position = ?, queue_held = ?, edit_revision = ?, run_id = NULL, delivery_mode = NULL,
              selection_json = COALESCE(?, selection_json), follows_thread_selection = ?
          WHERE id = ? AND conversation_id = ?`).run(
          content, JSON.stringify(attachments), digest, routeIdentity, input.userMessageId,
          projected.queuePosition, projected.queueHeld ? 1 : 0, editRevision, selectionJson, followsFlag, input.itemId, conversation.id,
        );
        if (updated.changes === 0) {
          this.database.prepare(`INSERT INTO queued_messages (
            id, conversation_id, content, attachments_json, intent_digest, creation_digest, route_identity, state,
            created_at, user_message_id, queue_position, queue_held, kind, created_by, creation_source, device_id,
            edit_revision, dispatch_ordinal, selection_json, follows_thread_selection
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, 'message', ?, ?, ?, ?, ?, ?, ?)`).run(
            projected.id, conversation.id, content, JSON.stringify(attachments), digest, digest, routeIdentity,
            requestedAt, input.userMessageId, projected.queuePosition, projected.queueHeld ? 1 : 0,
            createdBy, creationSource, input.deviceId ?? null, editRevision, projected.dispatchOrdinal, selectionJson, followsFlag,
          );
        }
        this.syncActiveRowsToTable(conversation.id);
      });
      return { replayed: committed.replayed, value: this.requireItem(input.itemId), events: committed.events };
    }).immediate();
  }

  /**
   * Boot adoption of legacy `queued_messages` rows into V2 queue events:
   * one `.immediate()` tx per row under `queue-adopt:<id>`, cancelling rows pointing
   * to rolled-back turns as `stale` and treating legacy `dispatching` rows as `waiting`.
   */
  adoptLegacyRows(): QueueAdoptionReport {
    const report: QueueAdoptionReport = { adopted: [], cancelled: [], releasedDispatching: [], skipped: [] };
    const candidates = this.database.prepare(`SELECT q.id, q.conversation_id
      FROM queued_messages AS q
      JOIN conversations AS c ON c.id = q.conversation_id
      LEFT JOIN orchestration_v2_entities AS e ON e.kind = ? AND e.id = q.id
      WHERE q.state IN ('waiting', 'dispatching', 'blocked') AND e.id IS NULL
      ORDER BY q.conversation_id ASC, COALESCE(q.queue_position, 2147483647) ASC, q.created_at ASC, q.sequence ASC`)
      .all(QUEUE_ITEM_PROJECTION) as Array<{ id: string; conversation_id: string }>;
    for (const candidate of candidates) this.adoptSingleLegacyRow(candidate.conversation_id, candidate.id, report);
    return report;
  }

  private adoptSingleLegacyRow(conversationId: string, itemId: string, report: QueueAdoptionReport): void {
    this.database.transaction(() => {
      if (this.getItem(itemId)) { report.skipped.push(itemId); return; }
      const row = this.database.prepare("SELECT * FROM queued_messages WHERE id = ? AND conversation_id = ? AND state IN ('waiting', 'dispatching', 'blocked')")
        .get(itemId, conversationId) as LegacyQueueRow | undefined;
      if (!row) { report.skipped.push(itemId); return; }
      let conversation: Conversation;
      try { conversation = this.access.conversation(conversationId); } catch { report.skipped.push(itemId); return; }
      ensureOrchestrationThread(this.events, conversation, this.access.conversationPath(conversation.id));
      const { identity, command } = this.commandContext(conversation, undefined, queueAdoptCommandId(row.id),
        { type: "queue.adopt-legacy", conversationId: conversation.id, itemId: row.id });
      if (this.events.receipt(identity, command, "queue.adopt-legacy")) { report.skipped.push(itemId); return; }
      const rolledBack = this.isRolledBackFollowUpRow(row);
      const attachments = rendererSafeAttachments(parseStoredAttachments(row.attachments_json));
      const watcherNote = watcherNoteFromJson(row.watcher_note_json);
      const delegatedCompletion = delegatedCompletionFromJson(row.delegated_completion_json);
      const kind: QueueItemKind = delegatedCompletion ? "delegated-results" : watcherNote ? "watcher-note" : row.kind;
      const attribution: QueueItemAttribution | undefined = delegatedCompletion
        ? { delegatedCompletion } : watcherNote ? { watcherNote } : undefined;
      const selection = parseSelectionJson(row.selection_json);
      const wasDispatching = row.state === "dispatching";
      const initialState: "waiting" | "blocked" = !rolledBack && row.state === "blocked" ? "blocked" : "waiting";
      const blockedReason = initialState === "blocked"
        ? (row.error === QUEUED_ROUTE_CHANGED_ERROR ? "route-changed" : "dispatch-failed") : undefined;
      const detail = initialState === "blocked" ? (row.error ?? "This queued message is blocked.").slice(0, 1_000) : undefined;
      const events: QueueEvent[] = [];
      const supersededWatcherId = !rolledBack && kind === "watcher-note" && watcherNote && initialState === "waiting"
        ? this.waitingWatcherNoteId(conversation.id, watcherNote.linkId) : null;
      if (supersededWatcherId !== null) {
        events.push({ type: "queue.item-cancelled", payload: { itemId: supersededWatcherId, reason: "superseded" } });
      }
      events.push({
        type: "queue.item-enqueued",
        payload: {
          itemId: row.id, kind, userMessageId: row.user_message_id, createdBy: row.created_by, creationSource: row.creation_source,
          ...(row.device_id ? { deviceId: row.device_id } : {}),
          ...(row.steer_follow_up_of_run_id ? { steerFollowUpOfRunId: row.steer_follow_up_of_run_id } : {}),
          contentRef: { chars: queueContentCharCount(row.content), editRevision: row.edit_revision },
          attachmentIds: attachments.map(({ id }) => id), routeIdentity: row.route_identity,
          ...(selection !== undefined ? { modelSelection: selection } : {}),
          ...(row.follows_thread_selection === 1 ? { followsThreadSelection: true as const } : {}),
          placement: "end", queueHeld: row.queue_held === 1,
          ...(row.steer_when_ready_run_id ? { steerWhenReadyRunId: row.steer_when_ready_run_id } : {}),
          requestedAt: row.created_at, ...(attribution !== undefined ? { attribution } : {}),
          origin: "legacy", initialState,
          ...(blockedReason !== undefined ? { blockedReason } : {}),
          ...(detail !== undefined ? { detail } : {}),
        },
      });
      if (rolledBack) {
        events.push({ type: "queue.item-cancelled", payload: { itemId: row.id, reason: "stale", detail: "The source turn was rolled back." } });
      }
      this.events.commit({
        ...identity, command, commandType: "queue.adopt-legacy", expectedRevision: this.events.revision(conversation.id),
        events, result: { itemId: row.id, cancelled: rolledBack, releasedDispatching: wasDispatching },
      }, () => {
        if (supersededWatcherId !== null) this.cancelRowInTable(conversation.id, supersededWatcherId);
        if (rolledBack) {
          this.cancelRowInTable(conversation.id, row.id);
          this.syncActiveRowsToTable(conversation.id);
          this.pruneTerminal(conversation.id);
        } else {
          if (wasDispatching) {
            this.database.prepare("UPDATE queued_messages SET state = 'waiting', error = NULL WHERE id = ? AND conversation_id = ?")
              .run(row.id, conversation.id);
          }
          this.syncActiveRowsToTable(conversation.id);
          if (supersededWatcherId !== null) this.pruneTerminal(conversation.id);
        }
      });
      if (rolledBack) report.cancelled.push(row.id);
      else {
        report.adopted.push(row.id);
        if (wasDispatching) report.releasedDispatching.push(row.id);
      }
    }).immediate();
  }

  private commandContext(
    conversation: Conversation,
    source: CommandSource | undefined,
    defaultCommandId: string,
    defaultCommand: Record<string, unknown>,
  ): { identity: CommandIdentity; command: JsonValue } {
    return {
      identity: {
        actorId: source?.actorId ?? "runtime",
        commandId: source?.commandId ?? defaultCommandId,
        projectId: conversation.projectId,
        threadId: conversation.id,
      },
      command: source?.command ?? toJsonValue(defaultCommand),
    };
  }

  private waitingWatcherNoteId(conversationId: string, linkId: string): string | null {
    const match = this.listActive(conversationId).find(
      (item) => item.kind === "watcher-note" && item.state === "waiting"
        && item.attribution !== undefined && "watcherNote" in item.attribution
        && item.attribution.watcherNote.linkId === linkId,
    );
    return match?.id ?? null;
  }

  private cancelRowInTable(conversationId: string, itemId: string): void {
    this.database.prepare(`UPDATE queued_messages
      SET state = 'cancelled', content = '', attachments_json = '[]', error = NULL, queue_position = NULL, queue_held = 0
      WHERE id = ? AND conversation_id = ?`).run(itemId, conversationId);
  }

  private isRolledBackFollowUpRow(row: LegacyQueueRow): boolean {
    if (row.user_message_id === null) return false;
    const message = this.database.prepare("SELECT turn_id FROM messages WHERE id = ? AND conversation_id = ?")
      .get(row.user_message_id, row.conversation_id) as { turn_id: string | null } | undefined;
    if (!message || message.turn_id === null) return true;
    return this.events.projection("rolled-back-turn", message.turn_id) !== null;
  }

  private requireItem(itemId: string): QueueItemProjection {
    const item = this.getItem(itemId);
    if (!item) throw new OrchestrationConflict("scope-conflict");
    return item;
  }

  private syncActiveRowsToTable(conversationId: string): void {
    const state = this.getState(conversationId);
    if (!state) return;
    const update = this.database.prepare("UPDATE queued_messages SET queue_position = ?, queue_held = ? WHERE id = ? AND conversation_id = ?");
    for (const itemId of state.activeItemIds) {
      const item = this.getItem(itemId);
      if (item) update.run(item.queuePosition, item.queueHeld ? 1 : 0, item.id, conversationId);
    }
  }
}
