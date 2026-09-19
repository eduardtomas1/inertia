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
  const envelopeBytes = byteLength(buildContent(
    [],
    99,
    99,
    packet.droppedMessageCount + packet.excerpts.length,
  ));
  const blockCapacity = Math.max(
    1,
    Math.min(budgetBytes, MAX_CONVERSATION_CONTEXT_BLOCK_BYTES) - envelopeBytes,
  );
  const totalCapacity = Math.max(
    1,
    budgetBytes - MAX_CONVERSATION_CONTEXT_BLOCKS_PER_PACKET * envelopeBytes,
  );
  const retained: ConversationContextExcerpt[] = [];
  let used = 0;
  for (let index = packet.excerpts.length - 1; index >= 0; index -= 1) {
    const excerpt = packet.excerpts[index]!;
    const bytes = byteLength(JSON.stringify(excerpt)) + 1;
    if (retained.length > 0 && used + bytes > totalCapacity) break;
    used += bytes;
    retained.unshift(excerpt);
  }
  const dropped = packet.droppedMessageCount
    + (packet.excerpts.length - retained.length);
  const groups: ConversationContextExcerpt[][] = [];
  let current: ConversationContextExcerpt[] = [];
  let currentBytes = 0;
  for (const excerpt of retained) {
    const bytes = byteLength(JSON.stringify(excerpt)) + 1;
    if (current.length > 0 && currentBytes + bytes > blockCapacity) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(excerpt);
    currentBytes += bytes;
  }
  groups.push(current);
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
