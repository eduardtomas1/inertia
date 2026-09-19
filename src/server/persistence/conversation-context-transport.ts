import {
  MAX_CONVERSATION_CONTEXT_BLOCK_BYTES,
  MAX_CONVERSATION_CONTEXT_BLOCKS_PER_PACKET,
  type ConversationContextExcerpt,
  type ConversationContextPacket,
  type MaterializedConversationContext,
} from "../../shared/conversation-context";

export function conversationContextTransportBudget(packetCount: number): number {
  return Math.floor(MAX_CONVERSATION_CONTEXT_BLOCK_BYTES
    * MAX_CONVERSATION_CONTEXT_BLOCKS_PER_PACKET / packetCount);
}

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

/** The same selection owns draft previews, transmitted blocks, and receipts. */
export function prepareConversationContextPacket(
  packet: ConversationContextPacket,
  budgetBytes = conversationContextTransportBudget(1),
  transport: "prompt" | "tool-result" = "prompt",
): { packet: ConversationContextPacket; blocks: MaterializedConversationContext[] } {
  const buildContent = (
    excerpts: readonly ConversationContextExcerpt[],
    blockIndex: number,
    blockCount: number,
    droppedMessageCount: number,
  ): string => JSON.stringify({
    version: 1,
    kind: "inertia-conversation-context",
    packetId: packet.id,
    blockIndex,
    blockCount,
    source: {
      conversationId: packet.sourceConversationId,
      conversationTitle: packet.sourceConversationTitle,
      projectId: packet.sourceProjectId,
      projectName: packet.sourceProjectName,
      workspaceLabel: packet.sourceWorkspaceLabel,
      capturedAt: packet.createdAt,
    },
    relationToTarget: packet.workspaceRelation,
    note: packet.note,
    droppedMessageCount,
    excerpts,
  });
  const envelope = buildContent(
    [],
    MAX_CONVERSATION_CONTEXT_BLOCKS_PER_PACKET - 1,
    MAX_CONVERSATION_CONTEXT_BLOCKS_PER_PACKET,
    packet.droppedMessageCount + packet.excerpts.length,
  );
  // Prompt context embeds block JSON inside a JSON string. Tool results embed
  // parsed blocks directly. Count the actual escaping for each transport;
  // raw block sizes alone can pass here and exceed the final prompt limit.
  const transportBytes = (serialized: string): number => transport === "prompt"
    ? byteLength(JSON.stringify(serialized)) - 2
    : byteLength(serialized);
  const envelopeBytes = transportBytes(envelope) + (transport === "prompt" ? 2 : 0);
  const blockCapacity = Math.min(budgetBytes, MAX_CONVERSATION_CONTEXT_BLOCK_BYTES)
    - byteLength(envelope);
  const groups: ConversationContextExcerpt[][] = [[]];
  let current = groups[0]!;
  let currentBytes = 0;
  let used = envelopeBytes;
  // Pack newest first so either bound drops only the oldest whole excerpts.
  for (let index = packet.excerpts.length - 1; index >= 0; index -= 1) {
    const excerpt = packet.excerpts[index]!;
    const serialized = JSON.stringify(excerpt);
    const bytes = byteLength(serialized) + 1;
    const newBlock = current.length > 0 && currentBytes + bytes > blockCapacity;
    const nextUsed = used + transportBytes(serialized) + 1 + (newBlock ? envelopeBytes : 0);
    if (bytes > blockCapacity || nextUsed > budgetBytes
      || (newBlock && groups.length === MAX_CONVERSATION_CONTEXT_BLOCKS_PER_PACKET)) break;
    if (newBlock) {
      current = [];
      groups.push(current);
      currentBytes = 0;
    }
    current.push(excerpt);
    currentBytes += bytes;
    used = nextUsed;
  }
  groups.reverse().forEach((group) => group.reverse());
  const retained = groups.flat();
  if (retained.length === 0 && packet.excerpts.length > 0) {
    throw new Error("The shared chat context excerpt exceeds its transport bound.");
  }
  const dropped = packet.droppedMessageCount
    + (packet.excerpts.length - retained.length);
  const blockCount = groups.length;
  const blocks = groups.map((excerpts, blockIndex) => {
    const content = buildContent(excerpts, blockIndex, blockCount, dropped);
    if (byteLength(content) > MAX_CONVERSATION_CONTEXT_BLOCK_BYTES) {
      throw new Error("The shared chat context block exceeds its transport bound.");
    }
    return {
      packetId: packet.id,
      label: `Chat context · ${packet.sourceConversationTitle} · ${retained.length} ${retained.length === 1 ? "message" : "messages"}${dropped > 0 ? ` · ${dropped} oldest omitted` : ""}${blockCount > 1 ? ` · part ${blockIndex + 1} of ${blockCount}` : ""}`,
      content,
      blockIndex,
      blockCount,
    };
  });
  return {
    packet: { ...packet, excerpts: retained, messageCount: retained.length,
      characterCount: retained.reduce((total, excerpt) => total + excerpt.content.length, 0),
      droppedMessageCount: dropped },
    blocks,
  };
}
