import type { RuntimeStore } from "../database";
import { providerCommandIntegrityFailure } from "../provider/provider-command-catalog";
import type { ProviderManager } from "../providers";

export class ConversationProviderContact {
  constructor(
    private readonly store: Pick<RuntimeStore, "assertConversationProvider" | "conversationPath">,
    private readonly providers: Pick<ProviderManager, "codexControlContext" | "claudeSkills">
      & Partial<Pick<ProviderManager, "providerCommands">>,
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

  async codexControlAt(cwd: string): ReturnType<ProviderManager["codexControlContext"]> {
    return await this.providers.codexControlContext(cwd);
  }

  async providerCommands(
    scope: Parameters<ProviderManager["providerCommands"]>[0],
  ): ReturnType<ProviderManager["providerCommands"]> {
    try {
      return await this.providers.providerCommands?.(scope) ?? [];
    } catch (error) {
      if (providerCommandIntegrityFailure(error)) throw error;
      return [];
    }
  }

  async claudeSkillsAt(
    cwd: string,
    forceReload: boolean,
  ): ReturnType<ProviderManager["claudeSkills"]> {
    return await this.providers.claudeSkills(cwd, forceReload);
  }
}
