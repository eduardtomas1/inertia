export class ThreadNotificationActivationBuffer {
  private readonly listeners = new Set<(conversationId: string) => void>();
  private pendingConversationId: string | null = null;

  receive(conversationId: string): void {
    if (this.listeners.size === 0) {
      // Navigation is singular: while the renderer boots, the latest click is
      // the exact destination the user most recently requested.
      this.pendingConversationId = conversationId;
      return;
    }
    for (const listener of this.listeners) listener(conversationId);
  }

  subscribe(listener: (conversationId: string) => void): () => void {
    this.listeners.add(listener);
    const pending = this.pendingConversationId;
    this.pendingConversationId = null;
    if (pending) listener(pending);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
