import { createHash } from "node:crypto";

import { z } from "zod";

import type { AccessMode, AgentTurn, Conversation, RuntimeMutationEvent } from "../../shared/contracts";
import { COMMAND_ONLY_STEER_REFUSED, isCommandOnlyPrompt, supportsActiveParentFollowUp } from "../../shared/follow-up-steer";
import {
  MAX_QUEUED_USER_AND_AGENT_ITEMS,
  queueAgentCommandId,
  queueContentCharCount,
  type QueueEnqueuePlacement,
  type QueueEvent,
} from "../../shared/orchestration-queue";
import type { MessageQueueResult } from "../../shared/queued-messages";
import type { RuntimeStore } from "../database";
import { ensureOrchestrationThread } from "../orchestration-v2/thread-registration";
import { OrchestrationConflict } from "../orchestration-v2/types";
import {
  QueuedMessageLimitError,
  queuedIntentDigest,
  queuedRouteIdentity,
} from "../persistence/queued-message-repository";
import type { ProviderHostToolDefinition, ProviderHostToolResult } from "../provider/contracts";
import type { ProviderTerminalResumeRegistry } from "../provider/terminal-resume";
import type { ProviderManager } from "../providers";
import { RuntimeRequestError } from "../runtime-errors";
import {
  agentSenderNoteLine,
  hasAgentSenderNote,
  isLeadingCommandOrSkill,
  withAgentSenderNote as applyAgentSenderNote,
  type AgentSenderNoteSource,
} from "./agent-sender-note";
import { requestAgentStop, SUPERSEDED_STOP_CODE } from "./commands/agent-stop-command";
import { CHECKOUT_RESTORE_IN_PROGRESS } from "./conversation-work-authority";
import { assertInteractionWithinParent, ModeEscalationError } from "./delegation/task-tools";
import { prepareForkSession } from "./fork-session-service";
import { MAX_PROMPT_CHARS, MULTILINE_PATTERN, idSchema, safeMultilineSchema } from "./managed-chat-schemas";
import {
  MANAGED_TURN_GONE_MESSAGE,
  recordManagedTurn,
  recordQueuedManagedTurn,
} from "./managed-turn-ownership";
import type { HiddenProviderInstruction } from "./turns/request-context";
import { liveProviderRunOwnership } from "./turns/turn-checkout-activity";
import type { TurnController } from "./turns/turn-controller";
import { sameTurnOwner, type TurnOwnerIdentity } from "./turns/turn-ownership";

/** Maximum queued user + agent items per managed chat (Phase 5 Decision 4.1). */
export const MAX_QUEUED_USER_MESSAGES = MAX_QUEUED_USER_AND_AGENT_ITEMS;
/** The queued-message store keeps at most this many characters per message. */
const MAX_QUEUED_CONTENT_CHARS = 20_000;

export const STEER_IDLE = "The managed chat has no running turn to steer; send with mode auto or queue.";
export const RESTART_IDLE = "The managed chat has no running turn to restart; send with mode auto.";
const QUEUE_FULL = `The managed chat already has ${MAX_QUEUED_USER_MESSAGES} queued messages; wait for one to run, or send with another mode.`;
const QUEUE_UNAVAILABLE = "Queued sends are not available in this Inertia runtime.";
const TERMINAL_RESUMED = "End the resumed provider terminal for the target chat before sending another message.";
export const STEER_ENDED = "The managed chat's turn ended before the follow-up was sent; nothing was sent. Send with mode auto to start a new turn.";

const SEND_MODES = ["auto", "queue", "steer", "restart"] as const;
export type SendMode = (typeof SEND_MODES)[number];

/** The approval card's title and first detail line for each mode. */
export const SEND_APPROVALS: Readonly<Record<SendMode, { title: string; effect: string }>> = {
  auto: { title: "Send work to a managed chat", effect: "Mode auto: joins the running turn, or starts a new one" },
  queue: { title: "Queue work for a managed chat", effect: "Mode queue: runs after the current turn" },
  steer: { title: "Steer a managed chat's running turn", effect: "Mode steer: joins the running turn only" },
  restart: { title: "Stop and restart a managed chat", effect: "Mode restart: stops the running turn, then starts a new one" },
};

export const sendSchema = z.object({
  conversationId: idSchema,
  content: safeMultilineSchema(MAX_PROMPT_CHARS),
  mode: z.enum(SEND_MODES).optional(),
}).strict().superRefine((input, context) => {
  if (input.mode === "queue" && input.content.length > MAX_QUEUED_CONTENT_CHARS) {
    context.addIssue({
      code: "custom",
      path: ["content"],
      message: `at most ${MAX_QUEUED_CONTENT_CHARS.toLocaleString("en")} characters with mode queue`,
    });
  }
});

export const SEND_MESSAGE_TOOL_DEFINITION: ProviderHostToolDefinition = {
  name: "inertia_send_message",
  description: `Send \`content\` to a chat this chat created. \`mode\`: auto steers a running turn when steerable else queues or starts one; queue runs after the current turn (max ${MAX_QUEUED_USER_MESSAGES}, ${MAX_QUEUED_CONTENT_CHARS.toLocaleString("en")} chars) or starts immediately when idle; steer needs a running turn; restart stops it and queues at position 1. Supervised/auto-edit ask the user first.`,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      conversationId: { type: "string", format: "uuid" },
      content: { type: "string", maxLength: MAX_PROMPT_CHARS, pattern: MULTILINE_PATTERN },
      mode: { enum: [...SEND_MODES], default: "auto" },
    },
    required: ["conversationId", "content"],
  },
  inputValidator: sendSchema,
  readOnly: false,
};

/** The message queue a parent's queued sends coordinate with. */
export interface ManagedMessageQueue {
  enqueueManagedMessage?(input: { conversationId: string; id: string; content: string }): MessageQueueResult;
  schedule?(conversationId: string): void | Promise<void>;
}

/** Links a child turn a send dispatched to the parent's delegated task for that child, answering its task id. */
export type ManagedFollowUpLink = (childTurn: { id: string; runId: string }, via: "send" | "steer") => Promise<string | null>;

export interface ManagedDispatchDependencies {
  store: RuntimeStore;
  turns: TurnController;
  providers: Pick<ProviderManager, "resolveModelRoute" | "nativeConversation" | "isRunning">;
  providerTerminalResumes: Pick<ProviderTerminalResumeRegistry, "acquire" | "isActive" | "release">;
  /** Resolved per call: the queue runtime starts after the chat manager. */
  messageQueue?(): ManagedMessageQueue | undefined;
  isCompacting?(conversationId: string): boolean;
  broadcastSnapshot(): void;
  broadcast?(event: RuntimeMutationEvent): void;
  now(): string;
}

function accessRank(mode: AccessMode): number {
  return mode === "supervised" ? 0 : mode === "auto-edit" ? 1 : 2;
}

/**
 * Intersects a live conversation's modes with an active turn's effective modes
 * (e.g. a narrowed scheduled turn) so host-tool caller ceilings and auto-approval
 * can never escalate above the running turn's authority (S37).
 */
export function narrowConversationByTurn(
  conversation: Conversation,
  turn: Pick<AgentTurn, "accessMode" | "interactionMode"> | null | undefined,
): Conversation {
  if (!turn) return conversation;
  const accessMode: AccessMode = accessRank(turn.accessMode) < accessRank(conversation.accessMode)
    ? turn.accessMode : conversation.accessMode;
  const interactionMode = conversation.interactionMode === "plan" || turn.interactionMode === "plan"
    ? "plan" : "build";
  return accessMode === conversation.accessMode && interactionMode === conversation.interactionMode
    ? conversation
    : { ...conversation, accessMode, interactionMode };
}

export function assertAccessWithinParent(requested: AccessMode, parent: AccessMode): void {
  if (accessRank(requested) > accessRank(parent)) {
    throw new ModeEscalationError("access_mode_escalation_denied", "A managed chat cannot exceed its parent chat's access mode.");
  }
}

/**
 * N15 / DispatchModeLimit: a calling chat can never send into or mutate the queue
 * of a managed chat whose accessMode or interactionMode exceeds the caller's own.
 */
export function assertManagedDispatchCeiling(
  caller: Pick<Conversation, "accessMode" | "interactionMode">,
  target: Pick<Conversation, "accessMode" | "interactionMode">,
): void {
  assertAccessWithinParent(target.accessMode, caller.accessMode);
  assertInteractionWithinParent(target.interactionMode, caller.interactionMode);
}

/**
 * Re-reads both caller and target from the durable store immediately before
 * mutation/dispatch and enforces managed ownership, non-archived status, and
 * N15 accessMode/interactionMode ceilings across any intervening async wait.
 */
export function assertFreshManagedDispatchAuthority(
  store: RuntimeStore,
  sourceConversationId: string,
  targetConversationId: string,
  sourceNarrowing?: Partial<Pick<Conversation, "accessMode" | "interactionMode">>,
): { caller: Conversation; target: Conversation } {
  const storedCaller = store.conversation(sourceConversationId);
  const caller = sourceNarrowing?.accessMode && sourceNarrowing?.interactionMode
    ? narrowConversationByTurn(storedCaller, {
      accessMode: sourceNarrowing.accessMode,
      interactionMode: sourceNarrowing.interactionMode,
    })
    : storedCaller;
  const target = store.conversation(targetConversationId);
  if (target.projectId !== caller.projectId) {
    throw new Error("That chat is outside this turn's current-project authority.");
  }
  if (!store.agentThreadManagement.managedBy(caller.id, target.id)) {
    throw new Error("conversationId: not a chat this chat created; only chats created with inertia_create_conversation can be managed here.");
  }
  if (target.archivedAt !== null) {
    throw new Error("The managed chat is archived and cannot accept new messages.");
  }
  assertManagedDispatchCeiling(caller, target);
  return { caller, target };
}

function json(value: unknown): ProviderHostToolResult {
  return { success: true, text: JSON.stringify(value) };
}

/**
 * Deterministic UUID per operation so a G5 replay of `agent-queue:<operationId>`
 * targets the exact same queue item identity.
 */
export function deterministicAgentQueueItemId(operationId: string): string {
  const bytes = createHash("sha256").update(`agent-queue-item\u0000${operationId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function toAgentSenderSource(
  source: Pick<Conversation, "id" | "title"> | AgentSenderNoteSource,
): AgentSenderNoteSource {
  return "conversationId" in source
    ? source
    : { conversationId: source.id, title: source.title };
}

/**
 * T3 `b0b2c4f95` (`withMessageSenderNote`): attributes agent-sent messages in
 * provider-visible text while leaving leading `/command` and `$skill` mentions
 * untouched, never double-prefixing, and never altering the user-visible
 * persisted message text.
 */
export function withAgentSenderNote(
  content: string,
  source: Pick<Conversation, "id" | "title"> | AgentSenderNoteSource,
): string {
  return applyAgentSenderNote(content, toAgentSenderSource(source));
}

/**
 * Hidden provider instruction variant for new turns so the persisted user
 * message keeps its exact visible text while the provider clearly sees that
 * another agent chat sent it.
 */
export function agentSenderHiddenInstruction(
  content: string,
  source: Pick<Conversation, "id" | "title"> | AgentSenderNoteSource,
): HiddenProviderInstruction[] {
  if (hasAgentSenderNote(content) || isLeadingCommandOrSkill(content)) return [];
  return [{ label: "inertia-agent-sender", text: agentSenderNoteLine(toAgentSenderSource(source)) }];
}

function dispatching(dependencies: ManagedDispatchDependencies, operationId: string, target: Conversation): void {
  dependencies.store.agentThreadManagement.transition(
    operationId,
    ["approved"],
    "dispatching",
    { childConversationId: target.id },
    dependencies.now(),
  );
}

export function activeUserAndAgentQueueCount(store: RuntimeStore, conversationId: string): number {
  const v2Count = store.orchestration.queue.listActive(conversationId)
    .filter((item) => item.kind === "message"
      && item.userMessageId === null
      && item.steerFollowUpOfRunId === undefined
      && item.requeuedFromRunId === undefined)
    .length;
  return Math.max(v2Count, store.queuedMessages.cappedCount(conversationId));
}

export function hasUnheldWaitingAgentItem(store: RuntimeStore, conversationId: string): boolean {
  if (store.orchestration.queue.listActive(conversationId).some((item) =>
    item.kind === "message" && item.createdBy === "agent" && item.state === "waiting" && !item.queueHeld)) {
    return true;
  }
  return store.queuedMessages.list(conversationId).some((entry) =>
    entry.createdBy === "agent" && entry.state === "waiting" && entry.queueHeld !== true);
}

export function hasUnheldWaitingQueueItem(store: RuntimeStore, conversationId: string): boolean {
  if (store.orchestration.queue.listActive(conversationId).some((item) =>
    item.state === "waiting" && !item.queueHeld)) {
    return true;
  }
  return store.queuedMessages.list(conversationId).some((entry) =>
    entry.state === "waiting" && entry.queueHeld !== true && entry.userMessageId === null);
}

/**
 * N10 & T3 `0a159c9fb`: in `mode: "auto"`, queue instead of steering when the
 * target chat is stopping (`interruptRequested`), compacting, preparing/not yet
 * steerable, lacks steer capability (`!supportsActiveParentFollowUp`), or
 * already has an unheld waiting agent item in its queue.
 */
export function shouldAutoQueueInsteadOfSteer(
  dependencies: Pick<ManagedDispatchDependencies, "store" | "turns" | "isCompacting">,
  target: Conversation,
  content?: string,
): boolean {
  if (content !== undefined && isCommandOnlyPrompt(content, 0)) return true;
  if (dependencies.isCompacting?.(target.id) === true) return true;
  if (dependencies.store.orchestration.runControl.interruptRequested(target.id)) return true;
  const activeIdentity = dependencies.turns.activeIdentity(target.id);
  const latestTurn = dependencies.store.latestAgentTurnForConversation(target.id);
  const activeTurn = activeIdentity && latestTurn?.id === activeIdentity.turnId ? latestTurn : null;
  if (activeTurn?.runState?.state === "cancelling") return true;
  if (dependencies.turns.isPreparing?.(target.id) === true || activeTurn?.status === "starting") return true;
  const activeHarnessId = activeTurn?.harnessId ?? target.modelSelection.harnessId;
  if (!supportsActiveParentFollowUp(activeHarnessId)) return true;
  if (hasUnheldWaitingAgentItem(dependencies.store, target.id)) return true;
  return false;
}

/** Delivers `content` into the child's running turn as a follow-up. */
export async function steerManagedTurn(
  dependencies: ManagedDispatchDependencies,
  target: Conversation,
  content: string,
  operationId: string,
  signal: AbortSignal,
  link?: ManagedFollowUpLink,
  source?: Pick<Conversation, "id" | "title"> & Partial<Pick<Conversation, "accessMode" | "interactionMode">>,
): Promise<ProviderHostToolResult> {
  if (isCommandOnlyPrompt(content, 0)) throw new Error(COMMAND_ONLY_STEER_REFUSED);
  const lease = dependencies.turns.acquireFollowUpAdmission(target.id);
  if (!lease) throw new Error("The target chat cannot accept a follow-up right now.");
  try {
    await lease.ready;
    if (signal.aborted) throw new Error("The parent turn ended before dispatch.");
    const freshSource = source
      ? assertFreshManagedDispatchAuthority(dependencies.store, source.id, target.id, source).caller
      : undefined;
    dispatching(dependencies, operationId, target);
    const providerContent = freshSource ? withAgentSenderNote(content, freshSource) : content;
    const steered = await dependencies.turns.steer(lease, {
      content,
      imagePaths: [],
    }, [], () => recordManagedTurn(dependencies.store, operationId, {
      id: lease.turnId, runId: lease.runId,
    }, dependencies.now()), signal, { providerContent });
    if (steered.kind !== "accepted" || !steered.message.turnId) throw new Error("The target provider did not accept the follow-up.");
    const taskId = await link?.({ id: lease.turnId, runId: lease.runId }, "steer") ?? null;
    dependencies.broadcastSnapshot();
    return json({
      conversationId: target.id,
      turnId: steered.message.turnId,
      disposition: "follow-up",
      accepted: true,
      ...(taskId ? { taskId } : {}),
    });
  } finally {
    lease.release();
  }
}

/**
 * Starts a new child turn with `content`, recorded as this operation's dispatch.
 * Under P1, an agent send to an idle chat with a held queue starts immediately
 * past the held items while leaving those items held.
 */
export async function startManagedTurn(
  dependencies: ManagedDispatchDependencies,
  target: Conversation,
  content: string,
  operationId: string,
  signal: AbortSignal,
  options: {
    source?: Pick<Conversation, "id" | "title"> & Partial<Pick<Conversation, "accessMode" | "interactionMode">>;
    restarted?: { stoppedTurnId: string; queuedMessageId?: string };
    link?: ManagedFollowUpLink;
    alreadyDispatching?: boolean;
  } = {},
): Promise<{ result: ProviderHostToolResult; turnId: string; runId: string; messageId: string }> {
  const { restarted } = options;
  if (signal.aborted) throw new Error("The parent turn ended before dispatch.");
  if (dependencies.store.conversationWork.restoreBlocksConversation(target.id)) {
    throw new Error(CHECKOUT_RESTORE_IN_PROGRESS);
  }
  if (!dependencies.providerTerminalResumes.acquire(target.id)) throw new Error(TERMINAL_RESUMED);
  let admission: Awaited<ReturnType<TurnController["acquireTurnAdmission"]>> = null;
  try {
    if (signal.aborted) throw new Error("The parent turn ended before dispatch.");
    admission = await dependencies.turns.acquireTurnAdmission(target.id, 30_000);
    if (!admission) throw new Error("The target chat cannot accept a message right now.");
    await prepareForkSession(dependencies, target.id, signal);
    if (signal.aborted) throw new Error("The parent turn ended before dispatch.");
    let freshSource = options.source;
    if (options.source) {
      freshSource = assertFreshManagedDispatchAuthority(dependencies.store, options.source.id, target.id, options.source).caller;
    } else if (dependencies.store.conversation(target.id).archivedAt !== null) {
      throw new Error("The managed chat is archived and cannot accept new messages.");
    }
    if (!options.alreadyDispatching) dispatching(dependencies, operationId, target);
    const internalInstructions = freshSource ? agentSenderHiddenInstruction(content, freshSource) : [];
    const queued = dependencies.turns.queue({
      conversationId: target.id,
      content,
      activateConversation: false,
      ...(restarted?.queuedMessageId ? { queuedMessageId: restarted.queuedMessageId } : {}),
      ...(internalInstructions.length > 0 ? { internalInstructions } : {}),
    }, undefined, admission);
    recordQueuedManagedTurn(dependencies.store, dependencies.turns, operationId, queued.turn, dependencies.now());
    const taskId = await options.link?.(queued.turn, "send") ?? null;
    if (!dependencies.turns.start(queued.turn.id)) {
      dependencies.turns.failBeforeStart(target.id, "The managed follow-up could not start.");
      throw new Error("The target chat could not start the new turn.");
    }
    dependencies.broadcastSnapshot();
    const result = json({
      conversationId: target.id,
      turnId: queued.turn.id,
      disposition: restarted ? "restarted" : "new-turn",
      accepted: true,
      ...(restarted ? { stoppedTurnId: restarted.stoppedTurnId } : {}),
      ...(restarted?.queuedMessageId ? { queuedMessageId: restarted.queuedMessageId } : {}),
      ...(taskId ? { taskId } : {}),
    });
    return { result, turnId: queued.turn.id, runId: queued.turn.runId, messageId: queued.message.id };
  } finally {
    admission?.release();
    dependencies.providerTerminalResumes.release(target.id);
  }
}

/**
 * Refuses what would keep a new child turn from starting. A restart checks it
 * before its approval and again just before its stop, so it never stops a turn
 * and then sends nothing for these reasons.
 */
export function assertManagedTurnCanStart(
  dependencies: Pick<ManagedDispatchDependencies, "store"> & {
    providerTerminalResumes: Pick<ProviderTerminalResumeRegistry, "isActive">;
  },
  target: Conversation,
): void {
  if (dependencies.store.conversationWork.restoreBlocksConversation(target.id)) throw new Error(CHECKOUT_RESTORE_IN_PROGRESS);
  if (dependencies.providerTerminalResumes.isActive(target.id)) throw new Error(TERMINAL_RESUMED);
}

function messageQueue(dependencies: Pick<ManagedDispatchDependencies, "messageQueue">): ManagedMessageQueue {
  const queue = dependencies.messageQueue?.();
  if (!queue) throw new Error(QUEUE_UNAVAILABLE);
  return queue;
}

/** Refuses a queued send before its approval when the child's queue is full. */
export function assertManagedQueueRoom(
  dependencies: Pick<ManagedDispatchDependencies, "messageQueue" | "store">,
  target: Conversation,
): void {
  messageQueue(dependencies);
  if (activeUserAndAgentQueueCount(dependencies.store, target.id) >= MAX_QUEUED_USER_MESSAGES) {
    throw new Error(QUEUE_FULL);
  }
}

/**
 * Commits a managed queued message atomically via V2 `store.orchestration.queue`
 * under a G5 receipt `agent-queue:<operationId>`, inheriting hold state under
 * H2 unless `skipHoldInheritance` is set (for Stop-and-send restarts).
 */
export function queueManagedMessage(
  dependencies: ManagedDispatchDependencies,
  target: Conversation,
  content: string,
  operationId: string,
  options: {
    source?: Pick<Conversation, "id" | "title"> & Partial<Pick<Conversation, "accessMode" | "interactionMode">>;
    placement?: QueueEnqueuePlacement;
    queueHeld?: boolean;
    skipHoldInheritance?: true;
    skipDispatchTransition?: boolean;
  } = {},
): { result: ProviderHostToolResult; itemId: string; queueHeld: boolean; position: number } {
  if (options.source) {
    assertFreshManagedDispatchAuthority(dependencies.store, options.source.id, target.id, options.source);
  }
  const queue = messageQueue(dependencies);
  const itemId = deterministicAgentQueueItemId(operationId);
  const existingItem = dependencies.store.orchestration.queue.getItem(itemId);
  if (!existingItem && activeUserAndAgentQueueCount(dependencies.store, target.id) >= MAX_QUEUED_USER_MESSAGES) {
    throw new Error(QUEUE_FULL);
  }
  if (!options.skipDispatchTransition) dispatching(dependencies, operationId, target);
  let enqueued: ReturnType<RuntimeStore["orchestration"]["queue"]["enqueue"]>;
  try {
    enqueued = dependencies.store.orchestration.queue.enqueue({
      conversationId: target.id,
      itemId,
      content,
      kind: "message",
      createdBy: "agent",
      creationSource: "mcp",
      followsThreadSelection: true,
      ...(options.placement !== undefined ? { placement: options.placement } : {}),
      ...(options.queueHeld !== undefined ? { queueHeld: options.queueHeld } : {}),
      ...(options.skipHoldInheritance ? { skipHoldInheritance: true as const } : {}),
      requestedAt: dependencies.now(),
      commandType: "message.queue.enqueue",
      source: {
        actorId: "runtime",
        commandId: queueAgentCommandId(operationId),
        command: {
          type: "message.queue.enqueue",
          conversationId: target.id,
          id: itemId,
          content: { chars: queueContentCharCount(content.trim()) },
          createdBy: "agent",
          creationSource: "mcp",
        },
      },
    });
  } catch (error) {
    if (error instanceof QueuedMessageLimitError || (error instanceof OrchestrationConflict && error.code === "revision-conflict")) {
      throw new Error(QUEUE_FULL);
    }
    throw error;
  }
  const listed = dependencies.store.queuedMessages.list(target.id);
  const listedPos = listed.findIndex((entry) => entry.id === itemId) + 1;
  const position = listedPos > 0 ? listedPos : (enqueued.value.queuePosition ?? 1);
  void Promise.resolve(queue.schedule?.(target.id)).catch(() => undefined);
  dependencies.broadcastSnapshot();
  const result = json({
    conversationId: target.id,
    queuedMessageId: itemId,
    disposition: "queued",
    ...(position > 0 ? { position } : {}),
    ...(enqueued.value.queueHeld ? { held: true } : {}),
    accepted: true,
  });
  return { result, itemId, queueHeld: enqueued.value.queueHeld, position };
}

async function confirmRestartStop(
  store: RuntimeStore,
  turns: TurnController,
  conversationId: string,
  owner: TurnOwnerIdentity,
): Promise<void> {
  await turns.waitForProviderCleanup([conversationId]);
  const ownsProvider = liveProviderRunOwnership(store, store.providerRunOwnership.forConversation(conversationId))
    .some((run) => sameTurnOwner(run, owner));
  if (ownsProvider || sameTurnOwner(turns.activeIdentity(conversationId), owner)) {
    throw new Error("Stop was requested, but exact provider cleanup was not confirmed.");
  }
}

/**
 * N19 row `b` & `c`: `mode: "restart"` routes through Stop-and-send at position
 * 1 while keeping the turn identity captured before approval (recorded
 * deviation c). Atomically stops only the exact captured turn and enqueues the
 * replacement at position 1 unheld in the same V2 transaction, then starts it
 * once cleanup is confirmed (unless an earlier delegated delivery precedes it).
 */
export async function restartManagedTurn(
  dependencies: ManagedDispatchDependencies,
  source: Pick<Conversation, "id" | "title"> & Partial<Pick<Conversation, "accessMode" | "interactionMode">>,
  target: Conversation,
  content: string,
  operationId: string,
  signal: AbortSignal,
  restart: TurnOwnerIdentity | null,
  link?: ManagedFollowUpLink,
): Promise<ProviderHostToolResult> {
  if (!restart) throw new Error(RESTART_IDLE);
  assertFreshManagedDispatchAuthority(dependencies.store, source.id, target.id, source);
  assertManagedTurnCanStart(dependencies, target);
  if (!sameTurnOwner(dependencies.turns.activeIdentity(target.id), restart)) {
    throw new Error(MANAGED_TURN_GONE_MESSAGE);
  }
  const itemId = deterministicAgentQueueItemId(operationId);
  const trimmed = content.trim();
  const requestedAt = dependencies.now();
  const routeIdentity = queuedRouteIdentity(target);
  const digest = queuedIntentDigest(trimmed, []);
  const db = dependencies.store.orchestration.effects.connection;
  const queue = dependencies.store.orchestration.queue;
  const enqueueEvent: QueueEvent = {
    type: "queue.item-enqueued",
    payload: {
      itemId,
      kind: "message",
      userMessageId: null,
      createdBy: "agent",
      creationSource: "mcp",
      contentRef: { chars: queueContentCharCount(trimmed), editRevision: 0 },
      attachmentIds: [],
      routeIdentity,
      followsThreadSelection: true,
      placement: "front",
      queueHeld: true,
      skipHoldInheritance: true,
      requestedAt,
      origin: "command",
    },
  };
  const syncRow = (): void => {
    const projected = queue.getItem(itemId);
    if (!projected) return;
    db.prepare(`INSERT OR REPLACE INTO queued_messages (
      id, conversation_id, content, attachments_json, intent_digest, creation_digest, route_identity, state,
      created_at, user_message_id, watcher_note_json, delegated_completion_json,
      queue_position, queue_held, kind, created_by, creation_source, device_id, steer_follow_up_of_run_id,
      edit_revision, edited_at, dispatch_ordinal, run_id, delivery_mode, steer_when_ready_run_id,
      selection_json, follows_thread_selection
    ) VALUES (?, ?, ?, '[]', ?, ?, ?, 'waiting', ?, NULL, NULL, NULL, ?, 1, 'message', 'agent', 'mcp', NULL, NULL, 0, NULL, 0, NULL, NULL, NULL, NULL, 1)`).run(
      projected.id, target.id, trimmed, digest, digest, routeIdentity,
      requestedAt, projected.queuePosition,
    );
    const state = queue.getState(target.id);
    if (state) {
      const update = db.prepare("UPDATE queued_messages SET queue_position = ?, queue_held = ? WHERE id = ? AND conversation_id = ?");
      for (const activeId of state.activeItemIds) {
        const activeItem = queue.getItem(activeId);
        if (activeItem) update.run(activeItem.queuePosition, activeItem.queueHeld ? 1 : 0, activeItem.id, target.id);
      }
    }
  };
  dispatching(dependencies, operationId, target);
  ensureOrchestrationThread(
    dependencies.store.orchestration.events,
    target,
    dependencies.store.conversationPath(target.id),
  );
  const commandId = `agent-stop:${operationId}`;
  const command = {
    type: "agent.stop",
    requestId: commandId,
    payload: {
      conversationId: target.id,
      expectedTurnId: restart.turnId,
      expectedRunId: restart.runId,
      queuedMessageId: itemId,
    },
  };
  let disposition: Awaited<ReturnType<typeof requestAgentStop>>;
  try {
    disposition = await requestAgentStop(
      {
        store: dependencies.store,
        turns: dependencies.turns,
        ...(dependencies.broadcast ? { broadcast: dependencies.broadcast } : {}),
      },
      {
        conversationId: target.id,
        expectedTurnId: restart.turnId,
        expectedRunId: restart.runId,
        cause: "agent",
        rejection: null,
        source: { actorId: "agent", commandId, command },
        extraEvents: [enqueueEvent],
        extraAfterCommit: syncRow,
        commitExtraEventsOnNoOp: false,
        beforeCommit: () => assertFreshManagedDispatchAuthority(dependencies.store, source.id, target.id, source),
      },
    );
  } catch (error) {
    if (error instanceof RuntimeRequestError && error.code === SUPERSEDED_STOP_CODE) {
      throw new Error(MANAGED_TURN_GONE_MESSAGE);
    }
    if (error instanceof QueuedMessageLimitError || (error instanceof OrchestrationConflict && error.code === "revision-conflict")) {
      throw new Error(QUEUE_FULL);
    }
    throw error;
  }
  const withdrawQueuedRestartItem = (): void => {
    try {
      if (queue.getItem(itemId)?.state === "waiting") {
        queue.cancel({ conversationId: target.id, itemId, reason: "withdrawn" });
      }
    } catch {
      // Best-effort withdrawal if the restart did not stop the expected turn.
    }
  };
  if (disposition === "isolated") {
    withdrawQueuedRestartItem();
    throw new Error(MANAGED_TURN_GONE_MESSAGE);
  }
  await confirmRestartStop(dependencies.store, dependencies.turns, target.id, restart);
  if (disposition === "idle" || disposition === "releasing" || disposition === "ended") {
    withdrawQueuedRestartItem();
    throw new Error(MANAGED_TURN_GONE_MESSAGE);
  }
  if (signal.aborted) {
    withdrawQueuedRestartItem();
    throw new Error("The parent turn ended after the managed chat stopped; the new message was not sent.");
  }
  try {
    assertFreshManagedDispatchAuthority(dependencies.store, source.id, target.id, source);
  } catch (error) {
    withdrawQueuedRestartItem();
    throw error;
  }
  if (queue.getItem(itemId)?.queueHeld) {
    queue.release({ conversationId: target.id, cause: "R3-resume", itemIds: [itemId] });
  }
  db.prepare("UPDATE queued_messages SET queue_held = 0, delivery_mode = 'after-stop' WHERE id = ? AND conversation_id = ?").run(itemId, target.id);
  const ordered = queue.listActive(target.id);
  const firstUnheld = ordered.find((item) => item.state === "waiting" && !item.queueHeld);
  const canStartNow = !dependencies.turns.isActive(target.id)
    && firstUnheld?.id === itemId
    && dependencies.isCompacting?.(target.id) !== true;
  if (!canStartNow) {
    void Promise.resolve(dependencies.messageQueue?.()?.schedule?.(target.id)).catch(() => undefined);
    dependencies.broadcastSnapshot();
    return json({
      conversationId: target.id,
      queuedMessageId: itemId,
      position: 1,
      disposition: "restarted",
      accepted: true,
      stoppedTurnId: restart.turnId,
    });
  }
  queue.claim({
    conversationId: target.id,
    itemId,
    mode: "after-stop",
  });
  try {
    const started = await startManagedTurn(dependencies, target, content, operationId, signal, {
      source,
      restarted: { stoppedTurnId: restart.turnId, queuedMessageId: itemId },
      link,
      alreadyDispatching: true,
    });
    // Real V2 turn admission (`turn-repository.ts`) records `queue.item-delivered`
    // atomically inside `turns.queue(...)`. Only fall back when a non-V2 turn
    // admission path left the claimed item in `dispatching`.
    if (queue.getItem(itemId)?.state === "dispatching") {
      const attemptId = dependencies.store.orchestration.currentAttemptId(started.runId) ?? started.runId;
      queue.deliver({
        conversationId: target.id,
        itemId,
        delivery: {
          mode: "after-stop",
          outcome: "restarted",
          runId: started.runId,
          attemptId,
          turnId: started.turnId,
          messageId: started.messageId,
          deliveredAt: dependencies.now(),
        },
      });
    }
    return started.result;
  } catch (error) {
    try {
      const currentItem = queue.getItem(itemId);
      if (currentItem?.state === "dispatching") {
        queue.releaseClaim({
          conversationId: target.id,
          itemId,
          reason: "transient",
        });
        if (error instanceof ModeEscalationError) {
          withdrawQueuedRestartItem();
        }
      }
    } catch {
      // Best-effort release if start failed after claim.
    }
    throw error;
  }
}

/**
 * Preflight checks for `inertia_send_message` before approval / reservation.
 */
export function preflightManagedSend(
  dependencies: Pick<ManagedDispatchDependencies, "store" | "turns" | "messageQueue" | "isCompacting"> & {
    providerTerminalResumes: Pick<ProviderTerminalResumeRegistry, "isActive">;
  },
  target: Conversation,
  mode: SendMode,
  content?: string,
): void {
  const active = dependencies.turns.isActive(target.id);
  const compacting = dependencies.isCompacting?.(target.id) === true;
  if (mode === "steer" && !active) throw new Error(STEER_IDLE);
  if (mode === "steer" && content !== undefined && isCommandOnlyPrompt(content, 0)) {
    throw new Error(COMMAND_ONLY_STEER_REFUSED);
  }
  if (mode === "restart" && !active) throw new Error(RESTART_IDLE);
  if (mode === "restart") assertManagedTurnCanStart(dependencies, target);
  if (mode === "queue") {
    if (active || compacting || hasUnheldWaitingQueueItem(dependencies.store, target.id)) {
      assertManagedQueueRoom(dependencies, target);
    } else {
      assertManagedTurnCanStart(dependencies, target);
    }
  }
  if (mode === "auto" && (active || compacting) && shouldAutoQueueInsteadOfSteer(dependencies, target, content)) {
    assertManagedQueueRoom(dependencies, target);
  }
}

export function managedSendApprovalDetail(
  store: RuntimeStore,
  target: Conversation,
  input: z.infer<typeof sendSchema>,
  followUpSuffix: string,
): { title: string; detail: string; permissionRoots: Array<{ path: string; access: "write" }> } {
  const mode = input.mode ?? "auto";
  const approval = SEND_APPROVALS[mode];
  return {
    title: approval.title,
    detail: `${approval.effect} · Target ${input.conversationId} · ${input.content.slice(0, 180)}${followUpSuffix}`,
    permissionRoots: [{ path: store.conversationPath(target.id), access: "write" }],
  };
}

/**
 * Unified managed-send dispatcher implementing N19, P1, N10, `0a159c9fb`, and
 * `b0b2c4f95`.
 */
export async function dispatchManagedSend(
  dependencies: ManagedDispatchDependencies,
  source: Pick<Conversation, "id" | "title"> & Partial<Pick<Conversation, "accessMode" | "interactionMode">>,
  target: Conversation,
  content: string,
  mode: SendMode,
  operationId: string,
  signal: AbortSignal,
  restart: TurnOwnerIdentity | null,
  link?: ManagedFollowUpLink,
): Promise<ProviderHostToolResult> {
  if (mode === "restart") {
    return await restartManagedTurn(dependencies, source, target, content, operationId, signal, restart, link);
  }
  const active = dependencies.turns.isActive(target.id);
  const compacting = dependencies.isCompacting?.(target.id) === true;
  if (mode === "queue") {
    // P1: on an idle chat with no unheld waiting items (including a held or
    // failed chat), start immediately past any held items, which stay held.
    if (!active && !compacting && !hasUnheldWaitingQueueItem(dependencies.store, target.id)) {
      return (await startManagedTurn(dependencies, target, content, operationId, signal, { source, link })).result;
    }
    return queueManagedMessage(dependencies, target, content, operationId, { source }).result;
  }
  if (mode === "auto" && (active || compacting)) {
    if (shouldAutoQueueInsteadOfSteer(dependencies, target, content)) {
      return queueManagedMessage(dependencies, target, content, operationId, { source }).result;
    }
    return await steerManagedTurn(dependencies, target, content, operationId, signal, link, source);
  }
  if (active) {
    return await steerManagedTurn(dependencies, target, content, operationId, signal, link, source);
  }
  if (mode === "steer") throw new Error(STEER_ENDED);
  return (await startManagedTurn(dependencies, target, content, operationId, signal, { source, link })).result;
}
