import { randomUUID } from "node:crypto";
import type WebSocket from "ws";

import type { AgentTurn, ChatAttachment, ClientCommand, Conversation, ModelSelection } from "../../shared/contracts";
import { modelSelectionSchema } from "../../shared/model-routing";
import {
  MAX_QUEUED_USER_AND_AGENT_ITEMS,
  queueContentCharCount,
  queueUnreadFollowUpCommandId,
  type QueueEvent,
} from "../../shared/orchestration-queue";
import { QUEUED_ROUTE_CHANGED_ERROR, type MessageQueueResult, type QueuedMessage } from "../../shared/queued-messages";
import type { WatcherNoteAttribution } from "../../shared/watcher";
import type { RuntimeStore } from "../database";
import { QueuedMessageLimitError, queuedIntentDigest, queuedRouteIdentity } from "../persistence/queued-message-repository";
import { MESSAGE_ADMISSION_UNAVAILABLE, publicRuntimeError, RuntimeRequestError } from "../runtime-errors";
import { hasIncompleteWorktreeSetup } from "../workspace-path-authority";
import type { CommandTicket } from "../orchestration-v2/command-authority";
import { OrchestrationConflict, type CommandSource } from "../orchestration-v2/types";
import { commandRejection } from "./commands/command-rejection";
import { requestAgentStop, SUPERSEDED_STOP_CODE } from "./commands/agent-stop-command";
import { QUEUE_CLAIM_SUPERSEDED_CODE } from "./commands/message-send-command";
import {
  awaitMessageSendPreparation,
  MessageSendPreparationTimeoutError,
  messageSendPreparationDeadline,
} from "./commands/message-send-preparation";
import type { TurnInteractionCommandDependencies } from "./commands/turn-interaction-types";
import { CHECKOUT_RESTORE_IN_PROGRESS } from "./conversation-work-authority";
import { isHeld, UPDATE_HOLD_MESSAGE } from "./update-hold";
import {
  CheckoutMoveBackgroundWorkError,
  ContextHandoffBackgroundWorkError,
  QueuedSelectionProviderUnavailableError,
} from "./turns/turn-request-preparation";
import {
  isResumeIntentFulfilled,
  isUserQueueFull,
  isWatcherQueueFull,
  listQueueEntries,
  nextQueuedSelectionForConversation,
  queueItemRouteMatches,
  resolveQueueTailSelection,
  resolveResumeContinuation,
  RESUME_USAGE_LIMIT_ERROR,
  RESUME_WORKTREE_SETUP_ERROR,
  routeIdentityForSelection,
  usageLimitHoldsQueue,
} from "./queued-message-runtime-helpers";

export interface InPlaceEditPayload {
  conversationId: string;
  id: string;
  expectedRevision: number;
  content: string;
  attachments?: ChatAttachment[];
  modelSelection?: ModelSelection | null;
}

export function isInPlaceEditPayload(payload: unknown): payload is InPlaceEditPayload {
  return payload !== null
    && typeof payload === "object"
    && typeof (payload as { content?: unknown }).content === "string"
    && typeof (payload as { expectedRevision?: unknown }).expectedRevision === "number";
}

export interface PreparedQueueAttachments {
  attachments: ChatAttachment[];
  sourceIds: string[];
  retentionId: string | null;
  accept: () => Promise<void>;
  release: () => Promise<void>;
}

export async function prepareAttachmentsForQueue(
  dependencies: Pick<TurnInteractionCommandDependencies, "store" | "attachmentResolver" | "conversationAttachments">,
  attachments: readonly ChatAttachment[],
  handoffId: string,
  existingRetained?: readonly ChatAttachment[],
): Promise<PreparedQueueAttachments> {
  if (attachments.length === 0) {
    return { attachments: [], sourceIds: [], retentionId: null, accept: async () => undefined, release: async () => undefined };
  }
  const existingById = new Map((existingRetained ?? []).map((item) => [item.id, item]));
  const kept: ChatAttachment[] = [];
  const incoming: ChatAttachment[] = [];
  for (const attachment of attachments) {
    const prior = existingById.get(attachment.id);
    if (prior) kept.push(prior);
    else incoming.push(attachment);
  }
  if (incoming.length === 0) {
    return { attachments: kept, sourceIds: [], retentionId: null, accept: async () => undefined, release: async () => undefined };
  }
  const retentionId = randomUUID();
  const abort = new AbortController();
  const deadline = messageSendPreparationDeadline();
  let sourceIds: string[] = [];
  let retained = false;
  try {
    const payloads = await awaitMessageSendPreparation(
      dependencies.attachmentResolver?.resolvePayloads(incoming, handoffId, abort.signal)
        ?? Promise.reject(new RuntimeRequestError("The selected attachment is no longer available.")),
      deadline,
      () => abort.abort(),
    );
    sourceIds = payloads.map(({ attachment }) => attachment.id);
    const retention = dependencies.conversationAttachments.retain(
      payloads, abort.signal, retentionId, () => dependencies.store.evictableAttachmentIds(),
    );
    let newlyRetained: ChatAttachment[];
    try {
      newlyRetained = await awaitMessageSendPreparation(retention, deadline, () => abort.abort());
      retained = true;
    } catch (error) {
      void retention.then(() => dependencies.conversationAttachments.releaseRetention(retentionId), () => undefined).catch(() => undefined);
      throw error;
    }
    const retainedById = new Map(newlyRetained.map((item) => [item.id, item]));
    const ordered = attachments.map((item) => existingById.get(item.id) ?? retainedById.get(item.id) ?? item);
    return {
      attachments: ordered,
      sourceIds,
      retentionId,
      accept: async () => {
        dependencies.conversationAttachments.acceptRetention(retentionId);
        await dependencies.attachmentResolver?.releaseAll(sourceIds);
      },
      release: async () => {
        if (retained) await dependencies.conversationAttachments.releaseRetention(retentionId);
        await dependencies.attachmentResolver?.relinquishAll(sourceIds);
      },
    };
  } catch (error) {
    if (retained) await dependencies.conversationAttachments.releaseRetention(retentionId).catch(() => undefined);
    await dependencies.attachmentResolver?.relinquishAll(sourceIds).catch(() => undefined);
    throw error;
  }
}

export interface QueueOperationsContext {
  dependencies: TurnInteractionCommandDependencies;
  running: Map<string, Promise<void>>;
  inFlightEditText: Map<string, string>;
  isCompacting(conversationId: string): boolean;
  requireConversation(conversationId: string): Conversation;
  hasPendingInteraction(conversationId: string): boolean;
  result(conversationId: string, id?: string): MessageQueueResult;
  changed(conversationId: string): void;
  schedule(conversationId: string): Promise<void>;
  retryAfterCleanup(conversationId: string): void;
  dispatch(conversationId: string, requestedId?: string): Promise<void>;
  directTurnInteraction(
    socket: WebSocket,
    command: Extract<ClientCommand, { type: "message.send" }>,
    authority: { kind: "main" },
  ): Promise<unknown>;
}

/** Decision 4.6 Stop-and-send: atomically stops (holding existing items H1) and enqueues position-1 unheld item. */
export async function stopAndSendOperation(
  ctx: QueueOperationsContext,
  input: { conversationId: string; id: string; turnId: string; content: string; attachments: ChatAttachment[] },
  handoffId: string,
  ticket: CommandTicket,
): Promise<void> {
  const { dependencies } = ctx;
  const { store } = dependencies;
  const db = store.orchestration.effects.connection;
  const queue = store.orchestration.queue;
  const { conversationId, id, turnId } = input;
  const conversation = ctx.requireConversation(conversationId);
  if (isUserQueueFull(store, conversationId)) {
    throw new RuntimeRequestError(`This chat already has ${MAX_QUEUED_USER_AND_AGENT_ITEMS} queued messages. Remove one and try again.`);
  }
  const prepared = await prepareAttachmentsForQueue(dependencies, input.attachments, handoffId);
  const trimmed = input.content.trim();
  const digest = queuedIntentDigest(trimmed, prepared.attachments);
  const selection = resolveQueueTailSelection(store, conversation);
  const routeIdentity = routeIdentityForSelection(conversation, selection);
  const requestedAt = new Date().toISOString();
  let persisted = false;

  const enqueueEvent: QueueEvent = {
    type: "queue.item-enqueued",
    payload: {
      itemId: id,
      kind: "message",
      userMessageId: null,
      createdBy: "user",
      creationSource: "web",
      contentRef: { chars: queueContentCharCount(trimmed), editRevision: 0 },
      attachmentIds: prepared.attachments.map(({ id: attachmentId }) => attachmentId),
      routeIdentity,
      modelSelection: modelSelectionSchema.parse(selection),
      placement: "front",
      queueHeld: false,
      skipHoldInheritance: true,
      requestedAt,
      origin: "command",
    },
  };
  const syncRow = (): void => {
    const projected = queue.getItem(id);
    if (!projected) return;
    db.prepare(`INSERT OR REPLACE INTO queued_messages (
      id, conversation_id, content, attachments_json, intent_digest, creation_digest, route_identity, state,
      created_at, user_message_id, watcher_note_json, delegated_completion_json,
      queue_position, queue_held, kind, created_by, creation_source, device_id, steer_follow_up_of_run_id,
      edit_revision, edited_at, dispatch_ordinal, run_id, delivery_mode, steer_when_ready_run_id,
      selection_json, follows_thread_selection
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?, NULL, NULL, NULL, ?, 0, 'message', 'user', 'web', NULL, NULL, 0, NULL, 0, NULL, 'after-stop', NULL, ?, 0)`).run(
      projected.id, conversation.id, trimmed, JSON.stringify(prepared.attachments), digest, digest, routeIdentity,
      requestedAt, projected.queuePosition, JSON.stringify(selection),
    );
    const state = queue.getState(conversation.id);
    if (state) {
      const update = db.prepare("UPDATE queued_messages SET queue_position = ?, queue_held = ? WHERE id = ? AND conversation_id = ?");
      for (const activeId of state.activeItemIds) {
        const activeItem = queue.getItem(activeId);
        if (activeItem) update.run(activeItem.queuePosition, activeItem.queueHeld ? 1 : 0, activeItem.id, conversation.id);
      }
    }
  };

  try {
    const stopId = `${handoffId}:stop`;
    const stopCommand = { type: "agent.stop", requestId: stopId, payload: { conversationId, expectedTurnId: turnId } };
    let stopDispatched = false;
    try {
      await requestAgentStop(dependencies, {
        conversationId,
        expectedTurnId: turnId,
        cause: "user",
        rejection: commandRejection,
        source: { actorId: "human", commandId: stopId, command: stopCommand },
        extraEvents: [enqueueEvent],
        extraAfterCommit: syncRow,
      });
      persisted = true;
      stopDispatched = true;
    } catch (error) {
      if (!(error instanceof RuntimeRequestError) || error.code !== SUPERSEDED_STOP_CODE) throw error;
    }

    if (!persisted) {
      await ticket.inLane(() => {
        ticket.commit({ events: [enqueueEvent], result: { stopAndSend: id } }, syncRow);
      });
      persisted = true;
    } else {
      await ticket.inLane(() => {
        ticket.commit({ events: [], result: { stopAndSend: id } });
      });
    }
    await prepared.accept();
    ctx.changed(conversationId);
    if (stopDispatched) ctx.retryAfterCleanup(conversationId);
    else void ctx.schedule(conversationId).catch(() => undefined);
  } finally {
    if (!persisted) await prepared.release();
  }
}

/** Phase 5 in-place edit: updates content/attachments/selection in place and commits `queue.item-edited`. */
export async function editInPlaceOperation(
  ctx: QueueOperationsContext,
  payload: InPlaceEditPayload,
  requestId: string,
  source: CommandSource,
): Promise<MessageQueueResult> {
  const { dependencies } = ctx;
  const { store, conversationAttachments } = dependencies;
  const queue = store.orchestration.queue;
  const conversation = ctx.requireConversation(payload.conversationId);
  const inFlightKey = `${conversation.id}:${requestId}`;

  const start = await store.orchestration.authority.begin<{
    existing: QueuedMessage;
    previousAttachmentIds: string[];
  }>({
    source,
    threadId: conversation.id,
    projectId: conversation.projectId,
    commandType: "message.queue.edit",
    rejection: commandRejection,
    verifyReplayContent: (receipt) => {
      if (receipt === null) {
        const activeText = ctx.inFlightEditText.get(inFlightKey);
        if (activeText !== undefined && activeText !== payload.content.trim()) {
          throw new OrchestrationConflict("command-conflict");
        }
        return;
      }
      queue.verifyEditReplay(conversation.id, payload.id, payload.expectedRevision + 1, payload.content, payload.attachments);
    },
  }, () => {
    const existing = listQueueEntries(store, conversation.id).find(({ id }) => id === payload.id);
    if (!existing) throw new RuntimeRequestError("This queued message is no longer in the queue.");
    if (existing.watcherNote || existing.kind === "watcher-note") {
      throw new RuntimeRequestError("A watcher note can't be edited. Remove it instead.");
    }
    if (existing.delegatedCompletion || existing.kind === "delegated-results") {
      throw new RuntimeRequestError("Delegated results can't be edited. Remove them instead.");
    }
    if (existing.userMessageId !== null) {
      throw new RuntimeRequestError("An unread follow-up can't be edited. Remove it instead.");
    }
    if (existing.state === "dispatching") {
      throw new RuntimeRequestError("This queued message is already being sent.");
    }
    const v2 = queue.getItem(payload.id);
    const currentRevision = v2?.contentRef.editRevision ?? existing.editRevision ?? 0;
    if (currentRevision !== payload.expectedRevision) {
      throw new RuntimeRequestError("This queued message changed before your edit could be saved.", "revision-conflict");
    }
    ctx.inFlightEditText.set(inFlightKey, payload.content.trim());
    return { existing, previousAttachmentIds: existing.attachments.map(({ id }) => id) };
  });

  if (start.kind === "rejected") throw new RuntimeRequestError(start.detail);
  if (start.kind === "joined") {
    await start.result;
    return ctx.result(conversation.id, payload.id);
  }
  if (start.kind === "replay") return ctx.result(conversation.id, payload.id);

  const { ticket, intake } = start;
  let prepared: PreparedQueueAttachments | null = null;
  let committed = false;
  try {
    prepared = payload.attachments !== undefined
      ? await prepareAttachmentsForQueue(dependencies, payload.attachments, requestId, intake.existing.attachments)
      : null;
    await ticket.inLane(() => {
      const current = ctx.requireConversation(conversation.id);
      const selection = payload.modelSelection !== undefined ? payload.modelSelection : undefined;
      const routeIdentity = selection ? routeIdentityForSelection(current, selection) : undefined;
      queue.edit({
        conversationId: current.id,
        itemId: payload.id,
        expectedRevision: payload.expectedRevision,
        content: payload.content,
        ...(prepared ? { attachments: prepared.attachments } : {}),
        ...(selection !== undefined ? { modelSelection: selection } : {}),
        ...(routeIdentity !== undefined ? { routeIdentity } : {}),
        source,
        commandType: "message.queue.edit",
      });
    });
    committed = true;
    await prepared?.accept();
    if (prepared) {
      const nextIds = new Set(prepared.attachments.map(({ id }) => id));
      const dropped = intake.previousAttachmentIds.filter((attachmentId) => !nextIds.has(attachmentId));
      if (dropped.length > 0) {
        const referenced = store.referencedAttachmentIds(dropped);
        await conversationAttachments.release(dropped.filter((attachmentId) => !referenced.has(attachmentId)));
      }
    }
    ctx.changed(conversation.id);
    ticket.finish(null);
    return ctx.result(conversation.id, payload.id);
  } catch (error) {
    if (!committed && prepared) {
      await prepared.release().catch(() => undefined);
    }
    ticket.fail(error);
    throw error;
  } finally {
    ctx.inFlightEditText.delete(inFlightKey);
  }
}

/** Decision 4.3: drops access-widening confirmation ceiling; reroutes and dispatches cleanly. */
export async function reconfirmOperation(
  ctx: QueueOperationsContext,
  conversationId: string,
  id: string,
): Promise<void> {
  const { store, turns } = ctx.dependencies;
  const queue = store.orchestration.queue;
  const conversation = ctx.requireConversation(conversationId);
  const entry = listQueueEntries(store, conversationId).find((item) => item.id === id);
  if (!entry || (entry.state !== "waiting" && entry.state !== "blocked")) {
    throw new RuntimeRequestError("This queued message has already been dispatched.");
  }
  const routeBlocked = entry.state === "blocked"
    ? entry.error === QUEUED_ROUTE_CHANGED_ERROR
    : !queueItemRouteMatches(store, entry, conversation);
  if (!routeBlocked) throw new RuntimeRequestError("This queued message is not waiting on a settings change.");

  const v2 = queue.getItem(id);
  if (v2) {
    queue.edit({
      conversationId,
      itemId: id,
      expectedRevision: v2.contentRef.editRevision,
      content: entry.content,
      modelSelection: conversation.modelSelection,
      routeIdentity: queuedRouteIdentity(conversation),
    });
  } else if (!store.queuedMessages.reroute(conversation, id)) {
    throw new RuntimeRequestError("This queued message has already been dispatched.");
  }
  ctx.changed(conversationId);
  if (turns.isActive(conversationId)) {
    void ctx.schedule(conversationId).catch(() => undefined);
    return;
  }
  await ctx.running.get(conversationId)?.catch(() => undefined);
  await ctx.dispatch(conversationId, id);
}

/** Executes the N7 continuation plan (native-first, prompted fallback, or next waiting queued item). */
export async function executeResumeContinuationOperation(
  ctx: QueueOperationsContext,
  conversationId: string,
  requestId: string,
  socket?: WebSocket,
): Promise<boolean> {
  const { store } = ctx.dependencies;
  const plan = resolveResumeContinuation(store, conversationId);
  if (plan.kind === "native" || plan.kind === "prompted") {
    if (!ctx.dependencies.enableProviders) return false;
    await ctx.directTurnInteraction(socket ?? (null as unknown as WebSocket), {
      type: "message.send",
      requestId: `${requestId}:continue`,
      payload: { conversationId, content: plan.content, attachments: [], activate: false },
    }, { kind: "main" });
    return true;
  }
  await ctx.running.get(conversationId)?.catch(() => undefined);
  const nextWaiting = listQueueEntries(store, conversationId).find((entry) => entry.state === "waiting" && !entry.queueHeld);
  if (!nextWaiting) return false;
  await ctx.dispatch(conversationId, nextWaiting.id);
  return true;
}

/** Phase 5 R3 + N7: releases held queue items and continues the interrupted/stopped thread natively first. */
export async function resumeQueueOperation(
  ctx: QueueOperationsContext,
  conversationId: string,
  requestId: string,
  socket?: WebSocket,
): Promise<MessageQueueResult> {
  const { store, turns } = ctx.dependencies;
  const db = store.orchestration.effects.connection;
  const queue = store.orchestration.queue;
  const conversation = ctx.requireConversation(conversationId);
  if (isHeld()) throw new RuntimeRequestError(UPDATE_HOLD_MESSAGE);
  if (store.conversationWork.restoreBlocksConversation(conversationId)) {
    throw new RuntimeRequestError(CHECKOUT_RESTORE_IN_PROGRESS);
  }
  if (hasIncompleteWorktreeSetup(db, conversationId)) {
    throw new RuntimeRequestError(RESUME_WORKTREE_SETUP_ERROR);
  }
  const targetSelection = nextQueuedSelectionForConversation(store, conversationId);
  if (usageLimitHoldsQueue(store, conversationId, targetSelection)) {
    throw new RuntimeRequestError(RESUME_USAGE_LIMIT_ERROR);
  }
  if (ctx.hasPendingInteraction(conversationId)) {
    throw new RuntimeRequestError("Answer the pending request before resuming this chat.");
  }
  if (turns.isActive(conversationId)) return ctx.result(conversationId);

  const source: CommandSource = {
    actorId: "human",
    commandId: requestId,
    command: { type: "message.queue.resume", requestId, payload: { conversationId } },
  };
  const start = await store.orchestration.authority.begin<void>({
    source,
    threadId: conversation.id,
    projectId: conversation.projectId,
    commandType: "message.queue.resume",
    rejection: commandRejection,
  }, (ticket) => {
    const heldIds = queue.listActive(conversationId).filter((item) => item.queueHeld).map(({ id }) => id);
    const events: QueueEvent[] = [
      { type: "queue.send-requested", payload: { itemId: null, kind: "resume", requestedAt: new Date().toISOString(), requestId } },
    ];
    if (heldIds.length > 0) {
      events.push({ type: "queue.items-released", payload: { itemIds: heldIds, cause: "R3-resume" } });
    }
    ticket.commit({ events, result: { resumed: true, releasedItemIds: heldIds } }, () => {
      if (heldIds.length > 0) {
        const update = db.prepare("UPDATE queued_messages SET queue_held = 0 WHERE id = ? AND conversation_id = ?");
        for (const heldId of heldIds) update.run(heldId, conversationId);
      }
    });
  });

  if (start.kind === "rejected") throw new RuntimeRequestError(start.detail);
  if (start.kind === "joined") {
    await start.result;
    return ctx.result(conversationId);
  }
  if (start.kind === "replay") {
    if (!turns.isActive(conversationId)) {
      const pending = queue.getState(conversationId)?.pendingSendIntent;
      if (pending?.kind === "resume" && pending.requestId === requestId && !isResumeIntentFulfilled(store, conversationId, pending)) {
        if (ctx.isCompacting(conversationId) || store.orchestration.hasPendingCleanup(conversationId)) {
          ctx.retryAfterCleanup(conversationId);
        } else {
          await ctx.schedule(conversationId);
        }
      }
    }
    return ctx.result(conversationId);
  }

  const { ticket } = start;
  try {
    ctx.changed(conversationId);
    if (ctx.isCompacting(conversationId) || store.orchestration.hasPendingCleanup(conversationId)) {
      ctx.retryAfterCleanup(conversationId);
      ticket.finish(null);
      return ctx.result(conversationId);
    }
    if (!await turns.waitForProviderCleanup([conversationId], Date.now() + 30_000)) {
      ctx.retryAfterCleanup(conversationId);
      ticket.finish(null);
      return ctx.result(conversationId);
    }
    if (ctx.isCompacting(conversationId) || store.orchestration.hasPendingCleanup(conversationId)) {
      ctx.retryAfterCleanup(conversationId);
      ticket.finish(null);
      return ctx.result(conversationId);
    }
    if (!turns.isActive(conversationId)) {
      await executeResumeContinuationOperation(ctx, conversationId, requestId, socket);
    }
    ticket.finish(null);
    return ctx.result(conversationId);
  } catch (error) {
    ticket.fail(error);
    throw error;
  }
}

/** Phase 5 N13: reorders an active queued item before `beforeId` (or to end when `null`). */
export async function reorderQueueOperation(
  ctx: QueueOperationsContext,
  conversationId: string,
  id: string,
  beforeId: string | null,
  requestId: string,
): Promise<MessageQueueResult> {
  const { store } = ctx.dependencies;
  const queue = store.orchestration.queue;
  const conversation = ctx.requireConversation(conversationId);
  const source: CommandSource = {
    actorId: "human",
    commandId: requestId,
    command: { type: "message.queue.reorder", requestId, payload: { conversationId, id, beforeId } },
  };
  const start = await store.orchestration.authority.begin<void>({
    source,
    threadId: conversation.id,
    projectId: conversation.projectId,
    commandType: "message.queue.reorder",
    rejection: commandRejection,
  }, () => {
    queue.reorder({ conversationId, itemId: id, beforeItemId: beforeId, source, commandType: "message.queue.reorder" });
  });
  if (start.kind === "rejected") throw new RuntimeRequestError(start.detail);
  if (start.kind === "joined") {
    await start.result;
    return ctx.result(conversationId, id);
  }
  if (start.kind === "replay") return ctx.result(conversationId, id);
  start.ticket.finish(null);
  ctx.changed(conversationId);
  return ctx.result(conversationId, id);
}

/** Synchronizes unread follow-ups inserted by `settleAgentTurn` into V2 queue events (after R2 runs). */
export function adoptSettledUnreadFollowUps(store: RuntimeStore, turn: AgentTurn): boolean {
  const db = store.orchestration.effects.connection;
  const queue = store.orchestration.queue;
  const conversationId = turn.conversationId;
  const rows = db.prepare(`
    SELECT id, content, attachments_json, route_identity, created_at, user_message_id,
           created_by, creation_source, device_id, steer_follow_up_of_run_id
    FROM queued_messages
    WHERE conversation_id = ? AND state = 'waiting' AND user_message_id IS NOT NULL
      AND id NOT IN (SELECT id FROM orchestration_v2_entities WHERE kind = 'queue-item' AND thread_id = ?)
    ORDER BY created_at ASC, sequence ASC
  `).all(conversationId, conversationId) as Array<{
    id: string; content: string; attachments_json: string; route_identity: string;
    created_at: string; user_message_id: string; created_by: "user" | "agent" | "system";
    creation_source: "web" | "mobile" | "mcp" | "server"; device_id: string | null;
    steer_follow_up_of_run_id: string | null;
  }>;
  if (rows.length === 0) return false;
  let adopted = false;
  for (const row of rows) {
    const afterItemIds = queue.listActive(conversationId)
      .filter((item) => item.requestedAt <= row.created_at)
      .map(({ id }) => id);
    let attachments: ChatAttachment[] = [];
    try { attachments = JSON.parse(row.attachments_json) as ChatAttachment[]; } catch { attachments = []; }
    db.prepare("DELETE FROM queued_messages WHERE id = ? AND conversation_id = ?").run(row.id, conversationId);
    queue.enqueue({
      conversationId,
      itemId: row.id,
      content: row.content,
      attachments,
      kind: "message",
      userMessageId: row.user_message_id,
      createdBy: row.created_by,
      creationSource: row.creation_source,
      ...(row.device_id ? { deviceId: row.device_id } : {}),
      ...(row.steer_follow_up_of_run_id ? { steerFollowUpOfRunId: row.steer_follow_up_of_run_id } : {}),
      routeIdentity: row.route_identity,
      modelSelection: turn.modelSelection,
      placement: { afterItemIds },
      requestedAt: row.created_at,
      origin: "requeue",
      source: {
        actorId: "runtime",
        commandId: queueUnreadFollowUpCommandId(turn.id, row.user_message_id),
        command: { type: "queue.requeue-unread-steer", conversationId, turnId: turn.id, messageId: row.user_message_id },
      },
      commandType: "queue.requeue-unread-steer",
    });
    adopted = true;
  }
  return adopted;
}

export function enqueueWatcherNoteOperation(
  ctx: QueueOperationsContext,
  input: { conversationId: string; id: string; content: string; watcherNote: WatcherNoteAttribution },
): MessageQueueResult {
  const { store } = ctx.dependencies;
  const db = store.orchestration.effects.connection;
  const conversation = ctx.requireConversation(input.conversationId);
  if (!ctx.dependencies.enableProviders) throw new RuntimeRequestError("Message queues require an available provider runtime.");
  const content = input.content.trim();
  if (!content) throw new RuntimeRequestError("The watcher note is empty.");
  if (isWatcherQueueFull(store, conversation.id, input.watcherNote.linkId)) {
    throw new RuntimeRequestError("The main chat's queue is full. Send or remove a queued message, then try again.");
  }
  const worktreeIncomplete = hasIncompleteWorktreeSetup(db, conversation.id);
  store.orchestration.queue.enqueue({
    conversationId: conversation.id,
    itemId: input.id,
    content,
    attachments: [],
    kind: "watcher-note",
    createdBy: "system",
    creationSource: "server",
    followsThreadSelection: true,
    ...(worktreeIncomplete ? { queueHeld: true } : {}),
    attribution: { watcherNote: input.watcherNote },
    origin: "automatic",
  });
  ctx.changed(conversation.id);
  void ctx.schedule(conversation.id).catch(() => undefined);
  return ctx.result(conversation.id, input.id);
}

export function enqueueManagedMessageOperation(
  ctx: QueueOperationsContext,
  input: { conversationId: string; id: string; content: string },
): MessageQueueResult {
  const { store } = ctx.dependencies;
  const db = store.orchestration.effects.connection;
  const conversation = ctx.requireConversation(input.conversationId);
  if (!ctx.dependencies.enableProviders) throw new RuntimeRequestError("Message queues require an available provider runtime.");
  const content = input.content.trim();
  if (!content) throw new RuntimeRequestError("The queued message is empty.");
  if (isUserQueueFull(store, conversation.id)) throw new QueuedMessageLimitError();
  const selection = resolveQueueTailSelection(store, conversation);
  const worktreeIncomplete = hasIncompleteWorktreeSetup(db, conversation.id);
  store.orchestration.queue.enqueue({
    conversationId: conversation.id,
    itemId: input.id,
    content,
    attachments: [],
    kind: "message",
    createdBy: "agent",
    creationSource: "mcp",
    routeIdentity: routeIdentityForSelection(conversation, selection),
    modelSelection: selection,
    ...(worktreeIncomplete ? { queueHeld: true } : {}),
    origin: "command",
  });
  ctx.changed(conversation.id);
  void ctx.schedule(conversation.id).catch(() => undefined);
  return ctx.result(conversation.id, input.id);
}

export function withdrawWatcherNoteOperation(ctx: QueueOperationsContext, conversationId: string, id: string): boolean {
  const { store } = ctx.dependencies;
  const queue = store.orchestration.queue;
  const v2 = queue.getItem(id);
  if (v2 && v2.kind === "watcher-note" && (v2.state === "waiting" || v2.state === "blocked")) {
    queue.cancel({ conversationId, itemId: id, reason: "withdrawn" });
    ctx.changed(conversationId);
    return true;
  }
  const entry = store.queuedMessages.get(conversationId, id);
  if (!entry?.watcherNote) return false;
  const removed = store.queuedMessages.cancel(conversationId, id);
  if (removed) ctx.changed(conversationId);
  return removed !== null;
}

export const isTransientDispatchFailure = (error: unknown): boolean =>
  error instanceof MessageSendPreparationTimeoutError
  || (error instanceof RuntimeRequestError && error.code === MESSAGE_ADMISSION_UNAVAILABLE);

export function handleQueuedDispatchErrorOperation(
  ctx: QueueOperationsContext,
  input: {
    conversationId: string;
    entry: QueuedMessage;
    claim: { dispatchOrdinal: number; editRevision: number };
    error: unknown;
    aborted: boolean;
    manualSendRetryKey: string | null;
    unreadRouteChangedError: string;
    retriedManualSend: Set<string>;
    releaseClaimItem(
      conversationId: string,
      id: string,
      reason: "transient" | "runtime-lost" | "steer-declined" | "turn-ended",
    ): boolean;
    blockItem(
      conversationId: string,
      entry: { id: string; watcherNote?: WatcherNoteAttribution },
      blockedReason: string,
      detail: string,
    ): void;
  },
): void {
  const { store, turns } = ctx.dependencies;
  const queue = store.orchestration.queue;
  const { conversationId, entry, claim, error } = input;
  const currentV2 = queue.getItem(entry.id);
  const claimSuperseded = (error instanceof RuntimeRequestError && error.code === QUEUE_CLAIM_SUPERSEDED_CODE)
    || (currentV2 !== null && (
      currentV2.queueHeld
      || currentV2.state !== "dispatching"
      || currentV2.dispatchOrdinal !== claim.dispatchOrdinal
      || currentV2.contentRef.editRevision !== claim.editRevision
    ));
  if (input.aborted || turns.isClosing()) {
    input.releaseClaimItem(conversationId, entry.id, "runtime-lost");
  } else if (claimSuperseded) {
    if (currentV2 && currentV2.state === "dispatching" && currentV2.dispatchOrdinal === claim.dispatchOrdinal) {
      input.releaseClaimItem(conversationId, entry.id, "transient");
    }
  } else if (error instanceof ContextHandoffBackgroundWorkError || error instanceof CheckoutMoveBackgroundWorkError) {
    input.releaseClaimItem(conversationId, entry.id, "transient");
    const unheld = queue.listActive(conversationId).filter((item) => !item.queueHeld);
    if (unheld.length > 0) queue.hold({ conversationId, cause: "H6-busy-session", itemIds: unheld.map(({ id }) => id) });
  } else if (error instanceof QueuedSelectionProviderUnavailableError) {
    input.blockItem(conversationId, entry, "provider-disabled", publicRuntimeError(error));
    const unheld = queue.listActive(conversationId).filter((item) => !item.queueHeld);
    if (unheld.length > 0) queue.hold({ conversationId, cause: "H4-start-failure", itemIds: unheld.map(({ id }) => id) });
  } else if (isTransientDispatchFailure(error) && input.releaseClaimItem(conversationId, entry.id, "transient")) {
    if (input.manualSendRetryKey !== null) input.retriedManualSend.add(input.manualSendRetryKey);
    else ctx.retryAfterCleanup(conversationId);
  } else {
    const routeBroken = !queueItemRouteMatches(store, entry, store.conversation(conversationId));
    input.blockItem(
      conversationId,
      entry,
      routeBroken ? "route-changed" : "dispatch-failed",
      routeBroken
        ? (entry.userMessageId === null ? QUEUED_ROUTE_CHANGED_ERROR : input.unreadRouteChangedError)
        : publicRuntimeError(error),
    );
    if (!routeBroken) {
      const remainingUnheld = queue.listActive(conversationId)
        .filter((item) => item.id !== entry.id && !item.queueHeld && item.kind === "message");
      if (remainingUnheld.length > 0) {
        queue.hold({ conversationId, cause: "H4-start-failure", itemIds: remainingUnheld.map(({ id }) => id) });
      }
    }
  }
}

export function onTurnSettledOperation(
  ctx: QueueOperationsContext,
  turn: AgentTurn,
  hasDispatchableItem: (conversationId: string) => boolean,
): void {
  const { store } = ctx.dependencies;
  const db = store.orchestration.effects.connection;
  const queue = store.orchestration.queue;
  const runControl = store.orchestration.runControl;
  const conversationId = turn.conversationId;
  db.prepare("UPDATE queued_messages SET steer_when_ready_run_id = NULL WHERE conversation_id = ? AND steer_when_ready_run_id = ?")
    .run(conversationId, turn.runId);
  let queueMutated = false;

  const target = runControl.target(turn.runId);
  const wasStopped = turn.status === "cancelled" || target?.interruptRequested === true;
  const nextSelection = nextQueuedSelectionForConversation(store, conversationId);
  if (turn.status === "completed" && !wasStopped
    && !hasIncompleteWorktreeSetup(db, conversationId)
    && !usageLimitHoldsQueue(store, conversationId, nextSelection)) {
    const released = queue.release({ conversationId, cause: "R2-run-completed" });
    if (released.events.length > 0) queueMutated = true;
  }

  if (adoptSettledUnreadFollowUps(store, turn)) queueMutated = true;

  if (turn.status === "failed" && !usageLimitHoldsQueue(store, conversationId, turn.modelSelection)) {
    const held = queue.hold({ conversationId, cause: "H4-start-failure" });
    if (held.events.length > 0) queueMutated = true;
  }

  if (turn.status === "cancelled") {
    const toHold = listQueueEntries(store, conversationId)
      .filter((entry) => !entry.queueHeld && entry.deliveryMode !== "after-stop" && queue.getItem(entry.id) !== null)
      .map(({ id }) => id);
    if (toHold.length > 0) {
      const held = queue.hold({ conversationId, cause: "H1-stop", itemIds: toHold });
      if (held.events.length > 0) queueMutated = true;
    }
  }

  if (turn.status === "interrupted" && turn.terminalReason !== "app-update") {
    const toHold = listQueueEntries(store, conversationId)
      .filter((entry) => !entry.queueHeld && entry.deliveryMode !== "after-stop" && queue.getItem(entry.id) !== null)
      .map(({ id }) => id);
    if (toHold.length > 0) {
      const held = queue.hold({ conversationId, cause: "H5-restart", itemIds: toHold });
      if (held.events.length > 0) queueMutated = true;
    }
  }

  if (queueMutated) ctx.changed(conversationId);
  if (hasDispatchableItem(conversationId)) {
    if (turn.status === "cancelled") ctx.retryAfterCleanup(conversationId);
    else void ctx.schedule(conversationId).catch(() => undefined);
  }
}
