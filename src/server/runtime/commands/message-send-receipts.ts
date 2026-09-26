import type { ServerEvent } from "../../../shared/contracts";
import type WebSocket from "ws";
import { MessageSendReceiptError, type MessageSendReceiptRepository } from "../../persistence/message-send-receipt-repository";
import { RuntimeRequestError } from "../../runtime-errors";
import { defineRuntimeCommandHandler, type RuntimeCommandHandler } from "./command-router";

export function withMessageSendReceipts(
  receipts: MessageSendReceiptRepository,
  createHandler: (send: (event: ServerEvent) => void) => RuntimeCommandHandler,
  send: (socket: WebSocket, event: ServerEvent) => void,
): RuntimeCommandHandler {
  const base = createHandler(() => undefined);
  return defineRuntimeCommandHandler(base.commandTypes ?? [], async (socket, command) => {
    if (command.type !== "message.send" || (command.payload.attachments?.length ?? 0) > 0) {
      return createHandler((event) => send(socket, event))(socket, command);
    }
    let replay: ServerEvent | null;
    try { replay = receipts.begin(command); }
    catch (error) {
      if (error instanceof MessageSendReceiptError) throw new RuntimeRequestError(error.message, undefined, "ambiguous");
      throw new RuntimeRequestError("Message delivery could not be reconciled. Check this chat before retrying.", undefined, "ambiguous");
    }
    if (replay) { send(socket, replay); return "handled"; }
    let acknowledged = false;
    try {
      return await createHandler((event) => {
        if (event.type === "request.ok" || (event.type === "request.result" && event.result.kind === "message.accepted")) {
          // Persist before publication: lost sockets replay this exact receipt.
          acknowledged = true;
          receipts.accept(command.requestId, event);
        }
        send(socket, event);
      })(socket, command);
    } catch (error) {
      const uncertain = acknowledged || !(error instanceof RuntimeRequestError) || error.delivery === "ambiguous";
      try { receipts.fail(command.requestId, uncertain); }
      catch {
        throw new RuntimeRequestError("Message delivery could not be reconciled. Check this chat before retrying.", undefined, "ambiguous");
      }
      if (uncertain && (!(error instanceof RuntimeRequestError) || error.delivery !== "ambiguous")) {
        throw new RuntimeRequestError("Message delivery could not be confirmed. Check this chat before retrying.", undefined, "ambiguous");
      }
      throw error;
    }
  });
}
