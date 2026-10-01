import type { UsageCommandDependencies } from "./usage-commands";
import { defineRuntimeCommandHandler } from "./command-router";

export function createConversationNotesCommandHandler({ store, send }: UsageCommandDependencies) {
  return defineRuntimeCommandHandler(["conversation.notes.get", "conversation.notes.update"], async (socket, command) => {
    if (command.type !== "conversation.notes.get" && command.type !== "conversation.notes.update") return "not-handled";
    const result = command.type === "conversation.notes.get"
      ? { kind: "conversation.notes" as const, outcome: "loaded" as const, note: store.conversationNotes.get(command.payload.conversationId) }
      : store.conversationNotes.update(command.payload.conversationId, command.payload.content, command.payload.expectedRevision);
    send(socket, { type: "request.result", requestId: command.requestId, result });
    return "handled";
  });
}
