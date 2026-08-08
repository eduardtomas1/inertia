export class ConversationWorkAuthority {
  private readonly projectByConversation = new Map<string, string>();

  constructor(
    private readonly projectIdForConversation: (conversationId: string) => string,
  ) {}

  reserve(conversationId: string): boolean {
    if (this.projectByConversation.has(conversationId)) return false;
    this.projectByConversation.set(
      conversationId,
      this.projectIdForConversation(conversationId),
    );
    return true;
  }

  release(conversationId: string): void {
    this.projectByConversation.delete(conversationId);
  }

  hasConversation(conversationId: string): boolean {
    return this.projectByConversation.has(conversationId);
  }

  hasProject(projectId: string): boolean {
    return [...this.projectByConversation.values()].includes(projectId);
  }

  clear(): void {
    this.projectByConversation.clear();
  }
}
