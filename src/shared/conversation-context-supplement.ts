import type {
  ConversationContextCheckpoint,
  ConversationContextHandoff,
  ConversationContextSupplement,
} from "./conversation-context";

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

export function conversationContextCheckpointLine(checkpoint: ConversationContextCheckpoint): string {
  return `Checkpoint: ${plural(checkpoint.fileCount, "file")}${checkpoint.truncated ? " (list incomplete)" : ""}`;
}

export function conversationContextHandoffLine(handoff: ConversationContextHandoff): string {
  return `Handoff: ${plural(handoff.itemCount, "earlier item")} to ${handoff.providerId} ${handoff.modelId} in ${
    handoff.session === "new" ? "a new" : "a resumed"} session`;
}

export function conversationContextSupplementLines(supplement: ConversationContextSupplement): string[] {
  const more = (count: number | undefined, noun: string) => count ? [plural(count, `more ${noun}`)] : [];
  return [
    ...supplement.files ?? [], ...more(supplement.omittedFiles, "file"),
    ...supplement.commands ?? [], ...more(supplement.omittedCommands, "command"),
    ...(supplement.checkpoints ?? []).map(conversationContextCheckpointLine), ...more(supplement.omittedCheckpoints, "checkpoint"),
    ...(supplement.handoffs ?? []).map(conversationContextHandoffLine), ...more(supplement.omittedHandoffs, "handoff"),
  ];
}
