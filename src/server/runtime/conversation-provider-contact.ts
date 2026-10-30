import type { RuntimeStore } from "../database";
import type { ProviderManager } from "../providers";

export class ConversationProviderContact {
  constructor(
    private readonly store: Pick<RuntimeStore, "assertConversationProvider" | "conversationPath">,
    private readonly providers: Pick<ProviderManager, "codexControlContext" | "claudeSkills"> & Partial<Pick<ProviderManager, "piSkills">>,
  ) {}

  async codexControl(conversationId: string): ReturnType<ProviderManager["codexControlContext"]> {
    this.store.assertConversationProvider(conversationId, "codex");
    return await this.providers.codexControlContext(this.store.conversationPath(conversationId));
  }

  async claudeSkills(
    conversationId: string,
    forceReload: boolean,
  ): ReturnType<ProviderManager["claudeSkills"]> {
    this.store.assertConversationProvider(conversationId, "claude");
    return await this.providers.claudeSkills(this.store.conversationPath(conversationId), forceReload);
  }

  async piSkills(conversationId: string): ReturnType<ProviderManager["piSkills"]> {
    this.store.assertConversationProvider(conversationId, "pi");
    if (!this.providers.piSkills) throw new Error("Pi skill discovery is unavailable.");
    return await this.providers.piSkills(this.store.conversationPath(conversationId));
  }
}
