/**
 * Messages to the user: an agent shows a Markdown message in its own turn,
 * exactly as written, through the `inertia_send_to_user` host tool. Text a
 * provider writes before a tool call can reach Inertia only as a summary, while
 * tool input arrives intact, so this is how an agent shows a draft, a code
 * block or the subject of a question it is about to ask in full mid-turn.
 *
 * The message is stored as a turn-scoped system message flagged `sentToUser`.
 * It is the agent's words, never the turn's final reply.
 */

import type { ChatMessage } from "./contracts/agent";

export const SEND_TO_USER_TOOL_NAME = "inertia_send_to_user";

/** Upper bound on one message in Unicode code points, the unit JSON Schema's `maxLength` counts. */
export const SEND_TO_USER_MAX_LENGTH = 4_000;

/** Messages one agent turn may show; further calls are refused. */
export const SEND_TO_USER_MAX_PER_TURN = 20;

export type SentToUserMessage = ChatMessage & { role: "system"; turnId: string; sentToUser: true };

export function sendToUserCodePoints(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/** Non-blank Markdown without NUL characters, at most SEND_TO_USER_MAX_LENGTH code points. */
export function isSendToUserContent(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && !value.includes("\u0000")
    && sendToUserCodePoints(value) <= SEND_TO_USER_MAX_LENGTH;
}

export function isSentToUserMessage(message: ChatMessage): message is SentToUserMessage {
  return message.role === "system" && typeof message.turnId === "string" && message.sentToUser === true;
}
