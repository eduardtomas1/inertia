const ownedRecords = new WeakMap<readonly object[], { conversationId: string; records: object[] }>();

export function recordsOwnedByConversation<T extends { conversationId: string }>(
  records: T[],
  conversationId: string | null,
): T[] {
  if (!conversationId) return [];
  const cached = ownedRecords.get(records);
  if (cached?.conversationId === conversationId) return cached.records as T[];
  const owned = records.every((record) => record.conversationId === conversationId)
    ? records
    : records.filter((record) => record.conversationId === conversationId);
  ownedRecords.set(records, { conversationId, records: owned });
  return owned;
}
