import type { AgentTurn, Conversation } from "../../shared/contracts";
import { importedResumeCwd } from "../cli-import/resume-cwd";
import { generateCodexThreadTitle } from "../codex/thread-title";
import type { RuntimeStore } from "../database";
import { readClaudeSessionTitle } from "../provider/claude-session-title";
import type { ProviderManager } from "../providers";
import type { BackendProfileController } from "./backends/backend-profile-controller";
import { ConversationProviderContact } from "./conversation-provider-contact";
import {
  isUntitledConversationTitle,
  normalizeGeneratedTitle,
  QUICK_TITLE_SCANNED_CHARS,
  quickConversationTitle,
} from "./conversation-title";
import type { TurnSettledEvidence } from "./turns/turn-controller-types";

export interface ConversationTitleSources {
  claude(input: { conversationId: string; sessionId: string }): Promise<string | undefined>;
  codex(input: {
    conversationId: string;
    model?: string;
    prompt: string;
    signal: AbortSignal;
  }): Promise<string | undefined>;
}

export interface ConversationTitleServiceDependencies {
  conversation(conversationId: string): Pick<Conversation, "title" | "archivedAt" | "providerSessionId">;
  firstUserMessage(conversationId: string, maxChars: number): { id: string; content: string } | null;
  keepsOwnTitle(conversationId: string): boolean;
  updateTitle(conversationId: string, title: string): void;
  sources: ConversationTitleSources;
  isExternalTurn(turn: AgentTurn): boolean;
  track(operation: () => Promise<void>): Promise<void>;
  signal: AbortSignal;
}

export interface ConversationTitleService {
  onTurnSettled(turn: AgentTurn, settlement: TurnSettledEvidence): void;
}

export function createConversationTitleService(
  dependencies: ConversationTitleServiceDependencies,
): ConversationTitleService {
  const applied = new Set<string>();
  const pending = new Set<string>();
  const generated = new Set<string>();

  const replaceableFirstMessage = (conversationId: string) => {
    if (applied.has(conversationId) || dependencies.signal.aborted) return null;
    if (dependencies.keepsOwnTitle(conversationId)) {
      applied.add(conversationId);
      return null;
    }
    const message = dependencies.firstUserMessage(conversationId, QUICK_TITLE_SCANNED_CHARS);
    if (!message) return null;
    const conversation = dependencies.conversation(conversationId);
    const replaceable = conversation.archivedAt === null && (
      isUntitledConversationTitle(conversation.title)
      || conversation.title === quickConversationTitle(message.content)
    );
    return replaceable ? { message, conversation } : null;
  };

  const titleSource = (
    turn: AgentTurn,
    settlement: TurnSettledEvidence,
  ): (() => Promise<string | undefined>) | null => {
    const current = replaceableFirstMessage(turn.conversationId);
    if (!current) return null;
    const { providerSessionTitle } = settlement;
    if (providerSessionTitle) return async () => providerSessionTitle;
    const sessionId = turn.providerSessionAfter ?? current.conversation.providerSessionId;
    if (turn.providerId === "claude" && sessionId) {
      return () => dependencies.sources.claude({ conversationId: turn.conversationId, sessionId });
    }
    if (
      turn.providerId !== "codex"
      || turn.status !== "completed"
      || turn.userMessageId !== current.message.id
      || generated.has(turn.conversationId)
      || dependencies.isExternalTurn(turn)
    ) return null;
    generated.add(turn.conversationId);
    return () => dependencies.sources.codex({
      conversationId: turn.conversationId,
      ...(turn.model === "provider-default" ? {} : { model: turn.model }),
      prompt: current.message.content,
      signal: dependencies.signal,
    });
  };

  return {
    onTurnSettled(turn, settlement) {
      const { conversationId } = turn;
      if (pending.has(conversationId)) return;
      let read: (() => Promise<string | undefined>) | null;
      try {
        read = titleSource(turn, settlement);
      } catch {
        return;
      }
      if (!read) return;
      const source = read;
      pending.add(conversationId);
      void Promise.resolve()
        .then(() => dependencies.track(async () => {
          const title = normalizeGeneratedTitle(await source() ?? "");
          const current = title ? replaceableFirstMessage(conversationId) : null;
          if (!title || !current) return;
          applied.add(conversationId);
          if (current.conversation.title !== title) dependencies.updateTitle(conversationId, title);
        }))
        .catch(() => undefined)
        .finally(() => pending.delete(conversationId));
    },
  };
}

export function conversationTitleSources(dependencies: {
  store: Pick<RuntimeStore, "assertConversationProvider" | "conversationPath" | "cliConversationImport">;
  providers: Pick<ProviderManager, "codexControlContext" | "claudeSkills">;
}): ConversationTitleSources {
  const contact = new ConversationProviderContact(dependencies.store, dependencies.providers);
  return {
    claude: ({ conversationId, sessionId }) => readClaudeSessionTitle(
      sessionId,
      importedResumeCwd(dependencies.store, conversationId, sessionId, dependencies.store.conversationPath(conversationId)),
    ),
    codex: async ({ conversationId, model, prompt, signal }) => {
      const context = await contact.codexControl(conversationId);
      return await generateCodexThreadTitle({ ...context, model, prompt, signal })
        .finally(() => { context.installationUse.abandonBeforeSpawn(); });
    },
  };
}

export function createConversationTitleRuntime(dependencies: {
  store: Pick<
    RuntimeStore,
    | "assertConversationProvider" | "conversation" | "firstUserMessage" | "updateConversation"
    | "conversationPath" | "cliConversationImport" | "todos" | "agentThreadManagement"
    | "conversationTitleLocks"
  >;
  providers: Pick<ProviderManager, "codexControlContext" | "claudeSkills">;
  backendProfileController: Pick<BackendProfileController, "isExternalSelection">;
  broadcastSnapshot(): void;
  track(operation: () => Promise<void>): Promise<void>;
  signal: AbortSignal;
}): ConversationTitleService {
  const { store, backendProfileController } = dependencies;
  return createConversationTitleService({
    conversation: (conversationId) => store.conversation(conversationId),
    firstUserMessage: (conversationId, maxChars) => store.firstUserMessage(conversationId, maxChars),
    keepsOwnTitle: (conversationId) => store.conversationTitleLocks.has(conversationId)
      || store.agentThreadManagement.managed(conversationId) !== null
      || store.todos.list().some((todo) => todo.conversationId === conversationId),
    updateTitle: (conversationId, title) => {
      store.updateConversation(conversationId, { title });
      dependencies.broadcastSnapshot();
    },
    sources: conversationTitleSources(dependencies),
    isExternalTurn: (turn) => backendProfileController.isExternalSelection(turn.modelSelection),
    track: dependencies.track,
    signal: dependencies.signal,
  });
}
