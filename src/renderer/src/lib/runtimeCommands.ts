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
): boolean {
  return [
    "message.send",
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
