import type WebSocket from "ws";

import type { ClientCommand, ServerEvent } from "../../../shared/contracts";
import { OrchestrationConflict, type CommandSource, type JsonValue } from "../../orchestration-v2/types";
import {
  MESSAGE_ADMISSION_UNAVAILABLE,
  publicRuntimeError,
  RuntimeRequestError,
} from "../../runtime-errors";
import type { TurnInteractionCommandDependencies } from "./turn-interaction-types";

export type MessageSendCommand = Extract<ClientCommand, { type: "message.send" }>;

export type MessageSendStage =
  | "conversation-state"
  | "active-route"
  | "follow-up-preparation"
  | "follow-up-publication"
  | "turn-admission"
  | "attachments"
  | "documents"
  | "backend-readiness"
  | "skills"
  | "provider-transition"
  | "retention"
  | "turn-persistence"
  | "turn-publication";

const MESSAGE_SEND_STAGE_LABELS: Record<MessageSendStage, string> = {
  "conversation-state": "conversation state preparation",
  "active-route": "active turn routing",
  "follow-up-preparation": "follow-up preparation",
  "follow-up-publication": "follow-up publication",
  "turn-admission": "turn admission",
  attachments: "attachment preparation",
  documents: "document preparation",
  "backend-readiness": "provider readiness",
  skills: "skill preparation",
  "provider-transition": "provider transition",
  retention: "attachment retention",
  "turn-persistence": "turn persistence",
  "turn-publication": "turn publication",
};

export const FOLLOW_UP_ROUTE_UNAVAILABLE = "This active agent route cannot accept a follow-up.";

export function classifiedMessageSendError(
  error: unknown,
  stage: MessageSendStage,
): RuntimeRequestError {
  if (error instanceof OrchestrationConflict && error.code === "cleanup-pending") {
    return new RuntimeRequestError(publicRuntimeError(error), MESSAGE_ADMISSION_UNAVAILABLE);
  }
  if (error instanceof RuntimeRequestError && error.delivery === "ambiguous") return error;
  const code = `message-send/${stage}/unexpected`;
  if (stage === "turn-publication") {
    return new RuntimeRequestError(`The turn was admitted but could not start cleanly. Refresh this chat before retrying. [${code}]`, code, "ambiguous");
  }
  if (stage === "follow-up-publication") {
    return new RuntimeRequestError(`The follow-up was accepted but its acknowledgement could not finish cleanly. Refresh this chat before retrying. [${code}]`, code, "ambiguous");
  }
  if (error instanceof RuntimeRequestError) return error;
  const publicMessage = publicRuntimeError(error);
  if (publicMessage !== "The request could not be completed.") {
    return new RuntimeRequestError(publicMessage);
  }
  return new RuntimeRequestError(
    stage === "follow-up-preparation"
      ? `The follow-up could not complete ${MESSAGE_SEND_STAGE_LABELS[stage]}. No follow-up was submitted; try again. [${code}]`
      : `The message could not complete ${MESSAGE_SEND_STAGE_LABELS[stage]}. No turn was started; try again. [${code}]`,
    code,
  );
}

export type CommandReply =
  | { type: "request.result"; result: Extract<ServerEvent, { type: "request.result" }>["result"] }
  | { type: "request.ok" };

export interface ReplyChannel {
  send(reply: CommandReply): void;
  readonly sent: CommandReply | null;
}

export function replyChannel(
  dependencies: Pick<TurnInteractionCommandDependencies, "send">,
  socket: WebSocket,
  requestId: string,
): ReplyChannel {
  let sent: CommandReply | null = null;
  return {
    send(reply) {
      sent = reply;
      dependencies.send(socket, { ...reply, requestId } as ServerEvent);
    },
    get sent() {
      return sent;
    },
  };
}

export function sendJoinedReply(
  dependencies: Pick<TurnInteractionCommandDependencies, "send">,
  socket: WebSocket,
  requestId: string,
  reply: JsonValue,
): void {
  if (reply === null) return;
  dependencies.send(socket, { ...(reply as unknown as CommandReply), requestId } as ServerEvent);
}

export function replyJson(reply: CommandReply | null): JsonValue {
  return reply === null ? null : JSON.parse(JSON.stringify(reply)) as JsonValue;
}

export function internalDispatchOrigin(dependencies: TurnInteractionCommandDependencies): string | null {
  if (dependencies.queuedMessage) return "queue";
  if (dependencies.limitResetDispatch) return "limit-reset";
  if (dependencies.restartContinuationDispatch) return "restart-continuation";
  if (dependencies.watcherDelivery) return "watcher";
  if (dependencies.delegatedDelivery) return "delegation";
  return null;
}

export function messageSendSource(command: MessageSendCommand, origin: string | null): CommandSource {
  const payload = JSON.parse(JSON.stringify(command)) as JsonValue;
  return origin === null
    ? { actorId: "human", commandId: command.requestId, command: payload }
    : { actorId: "runtime", commandId: `${origin}:${command.requestId}`, command: payload };
}
