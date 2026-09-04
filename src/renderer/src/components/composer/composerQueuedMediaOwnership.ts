const MEDIA_QUEUE_KEY_PREFIX = "inertia:queued-media:v2:";

export function composerMediaQueueKey(conversationId: string): string {
  return `${MEDIA_QUEUE_KEY_PREFIX}${conversationId}`;
}

export function composerMediaQueueConversationId(key: string): string | null {
  return key.startsWith(MEDIA_QUEUE_KEY_PREFIX)
    ? key.slice(MEDIA_QUEUE_KEY_PREFIX.length)
    : null;
}
