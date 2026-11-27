import { z } from "zod";

import type { Conversation } from "../../shared/contracts";
import { supportsActiveParentFollowUp } from "../../shared/follow-up-steer";
import {
  MAX_QUEUED_CONTENT_CHARS,
  queueAgentCommandId,
  queueContentCharCount,
  type QueueItemProjection,
} from "../../shared/orchestration-queue";
import type { RuntimeStore } from "../database";
import { OrchestrationConflict } from "../orchestration-v2/types";
import {
  ProviderSteerDeliveryUnknownError,
  type ProviderHostToolDefinition,
  type ProviderHostToolResult,
} from "../provider/contracts";
import { publicRuntimeError, RuntimeRequestError } from "../runtime-errors";
import { MULTILINE_PATTERN, idSchema, safeMultilineSchema } from "./managed-chat-schemas";
import { withAgentSenderNote, type ManagedMessageQueue } from "./managed-send-modes";
import { executeSteerViaEffectRuntime } from "./run-control-effect-handlers";
import type { TurnController } from "./turns/turn-controller";
import { bindSteerEffectId } from "./turns/turn-follow-up-coordinator";
import { neutralizeUntrustedAgentText } from "./untrusted-agent-text";

export const MANAGED_QUEUE_TOOL_NAME = "inertia_queue";
export const MAX_QUEUE_READ_CHARS = 16_000;
const MAX_QUEUE_PREVIEW_CHARS = 240;

export const MANAGED_QUEUE_ACTIONS = [
  "list",
  "read",
  "edit",
  "cancel",
  "reorder",
  "promote_to_steer",
] as const;

export type ManagedQueueAction = (typeof MANAGED_QUEUE_ACTIONS)[number];

export const managedQueueSchema = z.object({
  conversationId: idSchema,
  action: z.enum(MANAGED_QUEUE_ACTIONS),
  itemId: idSchema.optional(),
  content: safeMultilineSchema(MAX_QUEUED_CONTENT_CHARS).optional(),
  expectedRevision: z.number().int().min(0).optional(),
  beforeItemId: idSchema.nullable().optional(),
  targetTurnId: z.string().min(1).max(256).optional(),
}).strict().superRefine((input, context) => {
  if (input.action !== "list" && input.itemId === undefined) {
    context.addIssue({
      code: "custom",
      path: ["itemId"],
      message: `itemId is required for action ${input.action}`,
    });
  }
  if (input.action === "edit" && (input.content === undefined || input.content.trim().length === 0)) {
    context.addIssue({
      code: "custom",
      path: ["content"],
      message: "content is required for action edit",
    });
  }
  if (input.action === "reorder" && input.beforeItemId === undefined) {
    context.addIssue({
      code: "custom",
      path: ["beforeItemId"],
      message: "beforeItemId (uuid or null for end) is required for action reorder",
    });
  }
});

export type ManagedQueueInput = z.infer<typeof managedQueueSchema>;

export const MANAGED_QUEUE_TOOL_DEFINITION: ProviderHostToolDefinition = {
  name: MANAGED_QUEUE_TOOL_NAME,
  description: `Inspect or manage the durable queue of a chat this chat created. \`action\`: list (read-only), read (read-only, up to ${MAX_QUEUE_READ_CHARS.toLocaleString("en")} chars), edit (replace text; attachments stay), cancel, reorder (before \`beforeItemId\`, or null for end), promote_to_steer (steer a running turn now).`,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      conversationId: { type: "string", format: "uuid" },
      action: { enum: [...MANAGED_QUEUE_ACTIONS] },
      itemId: { type: "string", format: "uuid" },
      content: { type: "string", maxLength: MAX_QUEUED_CONTENT_CHARS, pattern: MULTILINE_PATTERN },
      expectedRevision: { type: "integer", minimum: 0 },
      beforeItemId: { type: ["string", "null"], format: "uuid" },
      targetTurnId: { type: "string", minLength: 1, maxLength: 256 },
    },
    required: ["conversationId", "action"],
  },
  inputValidator: managedQueueSchema,
  readOnly: false,
};

export interface ManagedQueueToolDependencies {
  store: RuntimeStore;
  turns: TurnController;
  messageQueue?(): ManagedMessageQueue | undefined;
  broadcastSnapshot(): void;
  broadcastConversationShell(conversationId: string): void;
  now(): string;
}

function json(value: unknown): ProviderHostToolResult {
  return { success: true, text: JSON.stringify(value) };
}

function boundedNeutralText(text: string, maxChars: number): { text: string; truncated: boolean; totalChars: number } {
  const neutralized = neutralizeUntrustedAgentText(text);
  const chars = Array.from(neutralized);
  if (chars.length <= maxChars) {
    return { text: neutralized, truncated: false, totalChars: chars.length };
  }
  return { text: chars.slice(0, maxChars).join(""), truncated: true, totalChars: chars.length };
}

function summarizeMutationItem(item: QueueItemProjection) {
  return {
    itemId: item.id,
    kind: item.kind,
    state: item.state,
    queuePosition: item.queuePosition,
    queueHeld: item.queueHeld,
    createdBy: item.createdBy,
    creationSource: item.creationSource,
    editRevision: item.contentRef.editRevision,
    chars: item.contentRef.chars,
    attachmentCount: item.attachmentIds.length,
    editable: item.kind === "message" && (item.state === "waiting" || item.state === "blocked"),
    requestedAt: item.requestedAt,
    editedAt: item.editedAt,
    ...(item.blockedReason ? { blockedReason: item.blockedReason } : {}),
  };
}

function summarizeItem(store: RuntimeStore, conversationId: string, item: QueueItemProjection) {
  const row = store.orchestration.queue.getContent(conversationId, item.id);
  const preview = boundedNeutralText(row?.content ?? "", MAX_QUEUE_PREVIEW_CHARS);
  return {
    itemId: item.id,
    kind: item.kind,
    state: item.state,
    position: item.queuePosition,
    queueHeld: item.queueHeld,
    createdBy: item.createdBy,
    creationSource: item.creationSource,
    editRevision: item.contentRef.editRevision,
    chars: item.contentRef.chars,
    attachmentCount: item.attachmentIds.length,
    editable: item.kind === "message" && (item.state === "waiting" || item.state === "blocked"),
    requestedAt: item.requestedAt,
    editedAt: item.editedAt,
    preview: preview.text,
    previewTruncated: preview.truncated,
    ...(item.blockedReason ? { blockedReason: item.blockedReason } : {}),
    ...(item.detail ? { detail: item.detail } : {}),
  };
}

export const FULL_ACCESS_AUTO_APPROVED_TOOLS: ReadonlySet<string> = new Set([
  "inertia_create_conversation",
  "inertia_send_message",
  "inertia_stop_conversation",
  "inertia_delegate_task",
  "inertia_cancel_task",
  MANAGED_QUEUE_TOOL_NAME,
]);

export function shouldAutoApproveManagedMutation(
  accessMode: Conversation["accessMode"],
  toolName: string,
): boolean {
  return accessMode === "full" && FULL_ACCESS_AUTO_APPROVED_TOOLS.has(toolName);
}

export function isManagedQueueReadAction(args: unknown): boolean {
  if (typeof args !== "object" || args === null) return false;
  const action = (args as { action?: unknown }).action;
  return action === "list" || action === "read";
}

export function managedQueueInputChars(args: unknown): number {
  const parsed = managedQueueSchema.safeParse(args);
  if (!parsed.success) return 0;
  return parsed.data.action === "edit" ? (parsed.data.content?.length ?? 0) : 0;
}

export function managedQueueApprovalDetail(
  store: RuntimeStore,
  target: Conversation,
  args: unknown,
): { title: string; detail: string; permissionRoots: Array<{ path: string; access: "write" }> } {
  const input = managedQueueSchema.parse(args);
  const titles: Record<Exclude<ManagedQueueAction, "list" | "read">, string> = {
    edit: "Edit a managed chat's queued message",
    cancel: "Cancel a managed chat's queued message",
    reorder: "Reorder a managed chat's queue",
    promote_to_steer: "Promote a managed chat's queued message to steer",
  };
  const title = input.action === "list" || input.action === "read"
    ? "Inspect a managed chat's queue"
    : titles[input.action];
  const suffix = input.action === "edit" && input.content
    ? ` · ${input.content.slice(0, 180)}`
    : input.action === "reorder"
      ? ` · before ${input.beforeItemId ?? "end"}`
      : "";
  return {
    title,
    detail: `Action ${input.action} · Target ${target.id}${input.itemId ? ` · Item ${input.itemId}` : ""}${suffix}`,
    permissionRoots: [{ path: store.conversationPath(target.id), access: "write" }],
  };
}

export function executeManagedQueueRead(
  dependencies: Pick<ManagedQueueToolDependencies, "store">,
  target: Conversation,
  args: unknown,
): ProviderHostToolResult {
  const input = managedQueueSchema.parse(args);
  if (input.action === "list") {
    const items = dependencies.store.orchestration.queue.listActive(target.id);
    return json({
      conversationId: target.id,
      action: "list",
      count: items.length,
      held: items.some((item) => item.queueHeld),
      items: items.map((item) => summarizeItem(dependencies.store, target.id, item)),
    });
  }
  const itemId = input.itemId!;
  const item = dependencies.store.orchestration.queue.getItem(itemId);
  if (!item || item.threadId !== target.id) {
    throw new Error("Queued item not found in this managed chat.");
  }
  const contentRow = dependencies.store.orchestration.queue.getContent(target.id, itemId);
  const content = boundedNeutralText(contentRow?.content ?? "", MAX_QUEUE_READ_CHARS);
  return json({
    conversationId: target.id,
    action: "read",
    item: {
      ...summarizeItem(dependencies.store, target.id, item),
      content: content.text,
      truncated: content.truncated,
      totalChars: content.totalChars,
    },
  });
}

function mapQueueConflictError(action: ManagedQueueAction, error: unknown): never {
  if (error instanceof OrchestrationConflict) {
    if (action === "edit") {
      throw new Error("That queued item cannot be edited (it may be automatic, already dispatching, or its revision changed).");
    }
    if (action === "reorder") {
      throw new Error("That queued item cannot be reordered (automatic items, dispatching items, and positions ahead of delegated results cannot be moved).");
    }
    if (action === "cancel") {
      throw new Error("That queued item is no longer waiting or blocked and cannot be cancelled.");
    }
    throw new Error(`Queue action ${action} conflicted with current queue state (${error.code}).`);
  }
  throw error;
}

export async function executeManagedQueueMutation(
  dependencies: ManagedQueueToolDependencies,
  source: Pick<Conversation, "id" | "title">,
  target: Conversation,
  args: unknown,
  operationId: string,
  signal: AbortSignal,
): Promise<ProviderHostToolResult> {
  const input = managedQueueSchema.parse(args);
  if (signal.aborted) throw new Error("The parent turn ended before the queue action ran.");
  const itemId = input.itemId!;
  const currentItem = dependencies.store.orchestration.queue.getItem(itemId);
  if (!currentItem || currentItem.threadId !== target.id) {
    throw new Error("Queued item not found in this managed chat.");
  }
  const commandId = queueAgentCommandId(operationId);
  const publish = (): void => {
    dependencies.broadcastConversationShell(target.id);
    dependencies.broadcastSnapshot();
  };

  if (input.action === "edit") {
    const content = input.content!.trim();
    const expectedRevision = input.expectedRevision ?? currentItem.contentRef.editRevision;
    try {
      const edited = dependencies.store.orchestration.queue.edit({
        conversationId: target.id,
        itemId,
        expectedRevision,
        content,
        editedAt: dependencies.now(),
        commandType: "message.queue.edit",
        source: {
          actorId: "runtime",
          commandId,
          command: {
            type: "message.queue.edit",
            conversationId: target.id,
            id: itemId,
            expectedRevision,
            content: { chars: queueContentCharCount(content) },
          },
        },
      });
      publish();
      return json({
        conversationId: target.id,
        action: "edit",
        item: summarizeMutationItem(edited.value),
      });
    } catch (error) {
      mapQueueConflictError("edit", error);
    }
  }

  if (input.action === "cancel") {
    try {
      const cancelled = dependencies.store.orchestration.queue.cancel({
        conversationId: target.id,
        itemId,
        reason: "user",
        commandType: "message.queue.remove",
        source: {
          actorId: "runtime",
          commandId,
          command: { type: "message.queue.remove", conversationId: target.id, id: itemId, reason: "user" },
        },
      });
      publish();
      return json({
        conversationId: target.id,
        action: "cancel",
        itemId: cancelled.value.id,
        state: cancelled.value.state,
        cancelled: true,
      });
    } catch (error) {
      mapQueueConflictError("cancel", error);
    }
  }

  if (input.action === "reorder") {
    const beforeItemId = input.beforeItemId ?? null;
    try {
      const reordered = dependencies.store.orchestration.queue.reorder({
        conversationId: target.id,
        itemId,
        beforeItemId,
        commandType: "message.queue.reorder",
        source: {
          actorId: "runtime",
          commandId,
          command: { type: "message.queue.reorder", conversationId: target.id, id: itemId, beforeId: beforeItemId },
        },
      });
      publish();
      return json({
        conversationId: target.id,
        action: "reorder",
        movedItemId: itemId,
        items: reordered.value.map((item) => summarizeMutationItem(item)),
      });
    } catch (error) {
      mapQueueConflictError("reorder", error);
    }
  }

  // promote_to_steer
  if (currentItem.kind !== "message" || (currentItem.state !== "waiting" && currentItem.state !== "blocked")) {
    throw new Error("Only a waiting or blocked message item can be promoted to steer.");
  }
  if (!dependencies.turns.isActive(target.id)) {
    throw new Error("The managed chat has no running turn to steer.");
  }
  if (dependencies.store.orchestration.runControl.interruptRequested(target.id)) {
    throw new Error("The managed chat's running turn is stopping and cannot be steered.");
  }
  const activeIdentity = dependencies.turns.activeIdentity(target.id);
  if (input.targetTurnId && activeIdentity && activeIdentity.turnId !== input.targetTurnId) {
    throw new Error("The specified targetTurnId is no longer the active turn.");
  }
  const latestTurn = dependencies.store.latestAgentTurnForConversation(target.id);
  const activeHarnessId = activeIdentity && latestTurn?.id === activeIdentity.turnId
    ? latestTurn.harnessId
    : target.modelSelection.harnessId;
  if (!supportsActiveParentFollowUp(activeHarnessId)) {
    throw new Error("The managed chat's active provider does not support steering.");
  }
  const contentRow = dependencies.store.orchestration.queue.getContent(target.id, itemId);
  const content = contentRow?.content.trim() ?? "";
  if (!content) {
    throw new Error("This queued message's text is no longer available.");
  }
  const lease = dependencies.turns.acquireFollowUpAdmission(target.id);
  if (!lease) {
    throw new Error("The managed chat cannot accept a steer right now.");
  }
  const runControl = dependencies.store.orchestration.runControl;
  const queue = dependencies.store.orchestration.queue;
  let claimed = false;
  let acknowledged = false;
  let steerEffectId: string | null = null;
  try {
    let dispatchOrdinal: number;
    try {
      const claimResult = queue.claim({
        conversationId: target.id,
        itemId,
        mode: "steer",
        commandType: "message.queue.promote-to-steer",
        source: {
          actorId: "runtime",
          commandId,
          command: { type: "message.queue.promote-to-steer", conversationId: target.id, id: itemId, turnId: lease.turnId },
        },
      });
      dispatchOrdinal = claimResult.value.dispatchOrdinal;
      claimed = true;
    } catch (error) {
      mapQueueConflictError("promote_to_steer", error);
    }
    const steerStart = await dependencies.store.orchestration.authority.begin<
      { kind: "requested"; effectId: string } | { kind: "closed" } | { kind: "untracked" }
    >({
      source: {
        actorId: "runtime",
        commandId: `queue-steer:${itemId}:${dispatchOrdinal}:${operationId}`,
        command: { type: "queue.steer", conversationId: target.id, itemId, dispatchOrdinal },
      },
      threadId: target.id,
      projectId: target.projectId,
      commandType: "queue.steer",
      rejection: null,
    }, (steerTicket) => runControl.requestSteer(steerTicket, lease.runId, lease.turnId, { queuedMessageId: itemId }));

    if (steerStart.kind === "lead") {
      if (steerStart.intake.kind === "requested") {
        steerEffectId = steerStart.intake.effectId;
        bindSteerEffectId(lease, steerEffectId);
      }
      steerStart.ticket.finish(null);
    } else if (steerStart.kind === "joined") {
      await steerStart.result;
    }
    const steerClosed = steerStart.kind === "lead" && steerStart.intake.kind === "closed";
    const steered = steerClosed
      ? { kind: "turn-ended" as const }
      : await executeSteerViaEffectRuntime(
        dependencies.store,
        steerEffectId,
        () => dependencies.turns.steer(
          lease,
          { content, imagePaths: [] },
          [],
          () => { acknowledged = true; },
          signal,
          { providerContent: withAgentSenderNote(content, source), queuedMessageId: itemId },
        ),
      );
    if (steered.kind === "accepted" && steered.message.turnId) {
      const settledEffectId = steerEffectId;
      if (settledEffectId) {
        steerEffectId = null;
        runControl.settleSteer(settledEffectId, "accepted", { messageId: steered.message.id, queuedMessageId: itemId });
      }
      const attemptId = dependencies.store.orchestration.currentAttemptId(lease.runId) ?? lease.runId;
      queue.deliver({
        conversationId: target.id,
        itemId,
        delivery: {
          mode: "steer",
          runId: lease.runId,
          attemptId,
          turnId: lease.turnId,
          messageId: steered.message.id,
          ...(settledEffectId ? { steerEffectId: settledEffectId } : {}),
          deliveredAt: dependencies.now(),
        },
      });
      claimed = false;
      publish();
      return json({
        conversationId: target.id,
        action: "promote_to_steer",
        itemId,
        turnId: steered.message.turnId,
        disposition: "follow-up",
        accepted: true,
      });
    }
    if (steered.kind === "refused" || steered.kind === "turn-ended") {
      if (steerEffectId) {
        const effectId = steerEffectId;
        steerEffectId = null;
        runControl.settleSteer(effectId, steered.kind === "turn-ended" ? "turn-ended" : "refused", { queuedMessageId: itemId });
      }
      queue.releaseClaim({
        conversationId: target.id,
        itemId,
        reason: steered.kind === "turn-ended" ? "turn-ended" : "steer-declined",
      });
      claimed = false;
      void Promise.resolve(dependencies.messageQueue?.()?.schedule?.(target.id)).catch(() => undefined);
      publish();
      throw new Error(
        steered.kind === "turn-ended"
          ? "The managed chat's turn ended before the promoted message could steer; it remains queued."
          : "The provider declined the promoted steer; it remains queued.",
      );
    }
    const outcome = steered.kind === "unconfirmed" ? "unconfirmed" : "unavailable";
    const reason = steered.kind === "unconfirmed" ? "steer-unconfirmed" : "steer-unavailable";
    const detail = steered.kind === "unconfirmed"
      ? steered.message
      : "The managed chat could not deliver the promoted steer.";
    if (steerEffectId) {
      const effectId = steerEffectId;
      steerEffectId = null;
      runControl.settleSteer(effectId, outcome, { queuedMessageId: itemId });
    }
    queue.block({
      conversationId: target.id,
      itemId,
      blockedReason: reason,
      detail,
    });
    claimed = false;
    publish();
    throw new Error(detail);
  } catch (error) {
    const ambiguous = acknowledged
      || (error instanceof RuntimeRequestError && error.delivery === "ambiguous")
      || error instanceof ProviderSteerDeliveryUnknownError;
    if (steerEffectId) {
      const effectId = steerEffectId;
      steerEffectId = null;
      try {
        runControl.settleSteer(effectId, ambiguous ? "unconfirmed" : "unavailable", { queuedMessageId: itemId });
      } catch {
        // Best-effort settle; never mask the original steer failure.
      }
    }
    if (claimed) {
      try {
        if (queue.getItem(itemId)?.state === "dispatching") {
          if (ambiguous) {
            const detail = acknowledged
              ? "The agent received this message, but Inertia could not record it. Check the chat before sending it again."
              : publicRuntimeError(error);
            queue.block({
              conversationId: target.id,
              itemId,
              blockedReason: "steer-unconfirmed",
              detail,
            });
          } else {
            queue.releaseClaim({
              conversationId: target.id,
              itemId,
              reason: "steer-declined",
            });
            void Promise.resolve(dependencies.messageQueue?.()?.schedule?.(target.id)).catch(() => undefined);
          }
          publish();
        }
      } catch {
        // Best-effort claim cleanup; never mask the original steer failure.
      }
    }
    throw error;
  } finally {
    lease.release();
  }
}
