import type Database from "better-sqlite3";
import type { CliMessage, CliProvider } from "../../shared/cli-conversations";
import type { Conversation, ContinuationIdentity, ModelSelection } from "../../shared/contracts";
import type { ConversationRepository } from "./conversation-repository";
import type { TranscriptRepository } from "./transcript-repository";

export interface CliConversationImportInput {
  projectId: string;
  sourceKey: string;
  providerId: CliProvider;
  sessionId: string;
  title: string;
  messages: readonly CliMessage[];
  selection: ModelSelection;
  continuationIdentity: ContinuationIdentity;
}

export function importedCliConversation(database: Database.Database, providerId: CliProvider, sessionId: string): string | null {
  const imported = database.prepare("SELECT conversation_id FROM cli_conversation_imports WHERE provider_id = ? AND session_id = ?")
    .get(providerId, sessionId) as { conversation_id: string } | undefined;
  if (imported) return imported.conversation_id;
  const resumed = database.prepare("SELECT id FROM conversations WHERE provider_id = ? AND provider_session_id = ? LIMIT 1")
    .get(providerId, sessionId) as { id: string } | undefined;
  return resumed?.id ?? null;
}

export function cliConversationImportProvider(database: Database.Database, conversationId: string): CliProvider | null {
  const imported = database.prepare("SELECT provider_id FROM cli_conversation_imports WHERE conversation_id = ?")
    .get(conversationId) as { provider_id: CliProvider } | undefined;
  return imported?.provider_id ?? null;
}

export function importCliConversation(
  database: Database.Database,
  conversations: ConversationRepository,
  transcripts: TranscriptRepository,
  input: CliConversationImportInput,
): string {
  return database.transaction(() => {
    const existing = importedCliConversation(database, input.providerId, input.sessionId);
    if (existing) return existing;
    const conversation: Conversation = conversations.create(input.projectId, input.title, {
      providerId: input.providerId, modelSelection: input.selection, activate: false,
      interactionMode: "build", accessMode: "supervised",
    });
    const importedAt = new Date().toISOString();
    let before = Date.parse(importedAt);
    const ordered = input.messages.map((message) => ({ ...message }));
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const message = ordered[index]!;
      before = Math.min(Date.parse(message.createdAt), before - 1);
      message.createdAt = new Date(before).toISOString();
    }
    for (const message of ordered) transcripts.createMessage(conversation.id, message.content, message.role, [], null, message.createdAt, { activateConversation: false });
    conversations.update(conversation.id, { providerSessionId: input.sessionId, continuationIdentity: input.continuationIdentity });
    database.prepare("INSERT INTO cli_conversation_imports (source_key, provider_id, session_id, conversation_id, imported_at) VALUES (?, ?, ?, ?, ?)")
      .run(input.sourceKey, input.providerId, input.sessionId, conversation.id, importedAt);
    return conversation.id;
  })();
}
