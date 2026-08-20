import type { ClientCommand, ServerEvent } from "@shared/contracts";

export type CommandWithoutId = ClientCommand extends infer Command
  ? Command extends { requestId: string }
    ? Omit<Command, "requestId">
    : never
  : never;

export type ResultEvent = Extract<ServerEvent, { type: "request.result" }>;

export function withRequestId(command: CommandWithoutId): ClientCommand {
  return { ...command, requestId: crypto.randomUUID() } as ClientCommand;
}

export function resultEvent(event: ServerEvent): ResultEvent {
  if (event.type !== "request.result") {
    throw new Error("The local service returned an unexpected response.");
  }
  return event;
}

export function commandRefreshesConversationDetail(
  command: CommandWithoutId,
  event?: ServerEvent,
): boolean {
  if (command.type === "git.workspace.diff") {
    return event?.type === "request.result"
      && event.result.kind === "git.workspace.diff"
      && event.result.diff.reviewMetadataChanged === true;
  }
  return [
    "message.send",
    "conversation.context.create",
    "conversation.context.remove",
    "agent.subagent.stop",
    "agent.approval.respond",
    "agent.input.respond",
    "review.state.set",
    "review.note.create",
    "review.note.update",
    "review.note.delete",
    "review.summary.generate",
    "git.commit",
    "git.selection.revert",
    "git.selection.undo",
    "checkpoint.revert",
  ].includes(command.type);
}
