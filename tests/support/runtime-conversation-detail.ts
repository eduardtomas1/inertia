import { randomUUID } from "node:crypto";

import type WebSocket from "ws";

import type { ConversationDetail, ServerEvent } from "../../src/shared/contracts";
import type { RuntimeEventQueue } from "./runtime-event-queue";

type ConversationDetailResult = Extract<
  Extract<ServerEvent, { type: "request.result" }>["result"],
  { kind: "conversation.detail" }
>;

export async function loadConversationDetailResult(
  socket: WebSocket,
  events: RuntimeEventQueue,
  conversationId: string,
  deadlineAt?: number,
): Promise<ConversationDetailResult> {
  const requestId = randomUUID();
  socket.send(JSON.stringify({
    type: "conversation.detail.load",
    requestId,
    payload: { conversationId },
  }));
  const isConversationDetail = (
    candidate: ServerEvent,
  ): candidate is Extract<ServerEvent, { type: "request.result" }> =>
    candidate.type === "request.result"
    && candidate.requestId === requestId
    && candidate.result.kind === "conversation.detail";
  const event = deadlineAt === undefined
    ? await events.next(isConversationDetail)
    : await events.nextForRequest(requestId, isConversationDetail, deadlineAt);
  if (event.result.kind !== "conversation.detail") {
    throw new Error(`Expected a conversation detail result for ${conversationId}.`);
  }
  return event.result;
}

export async function loadConversationDetail(
  socket: WebSocket,
  events: RuntimeEventQueue,
  conversationId: string,
  deadlineAt?: number,
): Promise<ConversationDetail> {
  const result = await loadConversationDetailResult(
    socket,
    events,
    conversationId,
    deadlineAt,
  );
  if (result.state !== "ready") {
    throw new Error(`Expected ready conversation detail for ${conversationId}.`);
  }
  return result.detail;
}
