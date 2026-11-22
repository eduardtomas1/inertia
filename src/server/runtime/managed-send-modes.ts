import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { Conversation } from "../../shared/contracts";
import { MAX_QUEUED_MESSAGES, type MessageQueueResult } from "../../shared/queued-messages";
import type { RuntimeStore } from "../database";
import { QueuedMessageLimitError, releasesQueue } from "../persistence/queued-message-repository";
import type { ProviderHostToolDefinition, ProviderHostToolResult } from "../provider/contracts";
import type { ProviderTerminalResumeRegistry } from "../provider/terminal-resume";
import { MAX_PROMPT_CHARS, MULTILINE_PATTERN, idSchema, safeMultilineSchema } from "./managed-chat-schemas";
import { recordManagedTurn, recordQueuedManagedTurn } from "./managed-turn-ownership";
import type { TurnController } from "./turns/turn-controller";

/** The queued-message store keeps at most this many characters per message. */
const MAX_QUEUED_CONTENT_CHARS = 20_000;
export const STEER_IDLE = "The managed chat has no running turn to steer; send with mode auto or queue.";
export const RESTART_IDLE = "The managed chat has no running turn to restart; send with mode auto.";
const QUEUE_FULL = `The managed chat already has ${MAX_QUEUED_MESSAGES} queued messages; wait for one to run, or send with another mode.`;
const QUEUE_UNAVAILABLE = "Queued sends are not available in this Inertia runtime.";
const QUEUE_HELD_NEXT = "Its last turn did not complete, so its queue waits for the user to send this; to start a turn now, send with mode auto.";
export const STEER_ENDED = "The managed chat's turn ended before the follow-up was sent; nothing was sent. Send with mode auto to start a new turn.";

const SEND_MODES = ["auto", "queue", "steer", "restart"] as const;
type SendMode = (typeof SEND_MODES)[number];

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
  description: `Send \`content\` to a chat this chat created. \`mode\`: auto steers a running turn, else starts one; queue runs after the current turn (max ${MAX_QUEUED_MESSAGES}, ${MAX_QUEUED_CONTENT_CHARS.toLocaleString("en")} chars); steer needs a running turn; restart stops it and starts anew. Inertia asks the user first.`,
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

/** The message queue a parent's `mode: "queue"` sends go through. */
export interface ManagedMessageQueue {
  enqueueManagedMessage(input: { conversationId: string; id: string; content: string }): MessageQueueResult;
}

export interface ManagedDispatchDependencies {
  store: RuntimeStore;
  turns: TurnController;
  providerTerminalResumes: Pick<ProviderTerminalResumeRegistry, "acquire" | "release">;
  /** Resolved per call: the queue runtime starts after the chat manager. */
  messageQueue?(): ManagedMessageQueue | undefined;
  broadcastSnapshot(): void;
  now(): string;
}

function json(value: unknown): ProviderHostToolResult {
  return { success: true, text: JSON.stringify(value) };
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

/** Delivers `content` into the child's running turn as a follow-up. */
export async function steerManagedTurn(
  dependencies: ManagedDispatchDependencies,
  target: Conversation,
  content: string,
  operationId: string,
  signal: AbortSignal,
): Promise<ProviderHostToolResult> {
  const lease = dependencies.turns.acquireFollowUpAdmission(target.id);
  if (!lease) throw new Error("The target chat cannot accept a follow-up right now.");
  try {
    dispatching(dependencies, operationId, target);
    const steered = await dependencies.turns.steer(lease, {
      content,
      imagePaths: [],
    }, [], () => recordManagedTurn(dependencies.store, operationId, {
      id: lease.turnId, runId: lease.runId,
    }, dependencies.now()), signal);
    if (steered.kind !== "accepted" || !steered.message.turnId) throw new Error("The target provider did not accept the follow-up.");
    dependencies.broadcastSnapshot();
    return json({
      conversationId: target.id,
      turnId: steered.message.turnId,
      disposition: "follow-up",
      accepted: true,
    });
  } finally {
    lease.release();
  }
}

/** Starts a new child turn with `content`, recorded as this operation's dispatch. */
export async function startManagedTurn(
  dependencies: ManagedDispatchDependencies,
  target: Conversation,
  content: string,
  operationId: string,
  signal: AbortSignal,
  restarted?: { stoppedTurnId: string },
): Promise<ProviderHostToolResult> {
  if (!dependencies.providerTerminalResumes.acquire(target.id)) {
    throw new Error(
      "End the resumed provider terminal for the target chat before sending another message.",
    );
  }
  try {
    if (signal.aborted) throw new Error("The parent turn ended before dispatch.");
    dispatching(dependencies, operationId, target);
    const queued = dependencies.turns.queue({
      conversationId: target.id,
      content,
      activateConversation: false,
    });
    recordQueuedManagedTurn(dependencies.store, dependencies.turns, operationId, queued.turn, dependencies.now());
    if (!dependencies.turns.start(queued.turn.id)) {
      dependencies.turns.failBeforeStart(target.id, "The managed follow-up could not start.");
      throw new Error("The target chat could not start the new turn.");
    }
    dependencies.broadcastSnapshot();
    return json({
      conversationId: target.id,
      turnId: queued.turn.id,
      disposition: "new-turn",
      accepted: true,
      ...(restarted ? { stoppedTurnId: restarted.stoppedTurnId } : {}),
    });
  } finally {
    dependencies.providerTerminalResumes.release(target.id);
  }
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
  if (dependencies.store.queuedMessages.list(target.id).length >= MAX_QUEUED_MESSAGES) {
    throw new Error(QUEUE_FULL);
  }
}

/**
 * Adds the message to the child's ordinary message queue, which sends it
 * after the current turn completes. The turn it starts is the user's queue
 * at work, not this operation's dispatch, so a parent turn that later fails
 * does not cancel it; the user can still remove it from the queue.
 */
export function queueManagedMessage(
  dependencies: ManagedDispatchDependencies,
  target: Conversation,
  content: string,
  operationId: string,
): ProviderHostToolResult {
  const queue = messageQueue(dependencies);
  dispatching(dependencies, operationId, target);
  const id = randomUUID();
  let queued: MessageQueueResult;
  try {
    queued = queue.enqueueManagedMessage({ conversationId: target.id, id, content });
  } catch (error) {
    if (error instanceof QueuedMessageLimitError) throw new Error(QUEUE_FULL);
    throw error;
  }
  const position = queued.entries.findIndex((entry) => entry.id === id) + 1;
  const held = !dependencies.turns.isActive(target.id)
    && !releasesQueue(dependencies.store.latestAgentTurnForConversation(target.id));
  return json({
    conversationId: target.id,
    queuedMessageId: id,
    disposition: "queued",
    ...(position > 0 ? { position } : {}),
    accepted: true,
    ...(held ? { next: QUEUE_HELD_NEXT } : {}),
  });
}
