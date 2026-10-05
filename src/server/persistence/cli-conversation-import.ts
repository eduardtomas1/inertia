import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { cliOmissionText, type CliConversationContinuation, type CliConversationOmission, type CliMessage, type CliProvider } from "../../shared/cli-conversations";
import type { Conversation, ContinuationIdentity, ModelSelection } from "../../shared/contracts";
import type { ConversationRepository } from "./conversation-repository";
import type { TranscriptRepository } from "./transcript-repository";
import type { TurnLedgerRepository } from "./turn-ledger-repository";

export interface CliConversationImportInput {
  projectId: string;
  sourceKey: string;
  providerId: CliProvider;
  sessionId: string;
  cwd: string;
  title: string;
  messages: readonly CliMessage[];
  omittedMessages: number;
  omittedBytes: number;
  droppedRecords: number;
  continuation: CliConversationContinuation;
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

export interface CliSessionOwnership {
  importedConversationId: string | null;
  omission: CliConversationOmission | null;
  continuation?: CliConversationContinuation;
  owned: boolean;
}

export function cliSessionOwnership(database: Database.Database, providerId: CliProvider, sessionId: string): CliSessionOwnership {
  const imported = database.prepare("SELECT conversation_id, source_messages, omitted_messages, continuation FROM cli_conversation_imports WHERE provider_id = ? AND session_id = ?")
    .get(providerId, sessionId) as { conversation_id: string; source_messages: number; omitted_messages: number; continuation: CliConversationContinuation } | undefined;
  if (imported) {
    const omission = imported.omitted_messages > 0 ? { omitted: imported.omitted_messages, total: imported.source_messages } : null;
    return { importedConversationId: imported.conversation_id, omission, continuation: imported.continuation, owned: false };
  }
  const owned = database.prepare("SELECT 1 FROM conversations WHERE provider_id = ? AND provider_session_id = ? LIMIT 1").get(providerId, sessionId)
    ?? database.prepare(`SELECT 1 FROM agent_turns WHERE provider_id = @providerId AND origin IS NULL
      AND (provider_session_before = @sessionId OR provider_session_after = @sessionId) LIMIT 1`).get({ providerId, sessionId });
  return { importedConversationId: null, omission: null, owned: owned !== undefined };
}

export interface CliConversationImportRecord { providerId: CliProvider; cwd: string; sessionId: string; continuation: CliConversationContinuation }

export function cliConversationImport(database: Database.Database, conversationId: string): CliConversationImportRecord | null {
  const imported = database.prepare("SELECT provider_id, cwd, session_id, continuation FROM cli_conversation_imports WHERE conversation_id = ?")
    .get(conversationId) as { provider_id: CliProvider; cwd: string; session_id: string; continuation: CliConversationContinuation } | undefined;
  return imported ? { providerId: imported.provider_id, cwd: imported.cwd, sessionId: imported.session_id, continuation: imported.continuation } : null;
}

function importTurns(
  database: Database.Database,
  transcripts: TranscriptRepository,
  turns: Pick<TurnLedgerRepository, "create">,
  conversationId: string,
  input: CliConversationImportInput,
  messages: readonly CliMessage[],
): void {
  const groups: Array<{ user: CliMessage; replies: CliMessage[] }> = [];
  const leading: CliMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") groups.push({ user: message, replies: [] });
    else (groups.at(-1)?.replies ?? leading).push(message);
  }
  if (!groups.length) throw new Error("This CLI conversation has no user message to import.");
  groups[0]!.replies.unshift(...leading);
  let first: { turnId: string; createdAt: string } | null = null;
  const complete = database.prepare(`
    UPDATE agent_turns SET status = 'completed', run_state = 'completed', origin = 'cli-import',
      started_at = requested_at, completed_at = @completedAt, updated_at = @completedAt,
      terminal_assistant_message_id = @terminalAssistantMessageId, provider_session_after = @sessionId
    WHERE id = @id AND conversation_id = @conversationId AND status = 'queued'
  `);
  for (const group of groups) {
    const user = transcripts.createMessage(conversationId, group.user.content, "user", [], null, group.user.createdAt, { activateConversation: false });
    const turn = turns.create({
      conversationId, runId: randomUUID(), userMessageId: user.id, providerId: input.providerId,
      modelSelection: input.selection, continuationIdentity: input.continuationIdentity,
      reasoningEffort: input.selection.reasoningEffort ?? "", interactionMode: "build", accessMode: "supervised",
      requestedAt: user.createdAt, configurationRevision: input.selection.backendConfigurationRevision, association: "authoritative",
    });
    const replies = group.replies.map((reply) => transcripts.createMessage(conversationId, reply.content, "assistant", [], turn.id, reply.createdAt, { activateConversation: false }));
    const completedAt = [user.createdAt, ...replies.map(({ createdAt }) => createdAt)].sort().at(-1)!;
    const completed = complete.run({ id: turn.id, conversationId, completedAt, terminalAssistantMessageId: replies.at(-1)?.id ?? null, sessionId: input.sessionId });
    if (completed.changes !== 1) throw new Error("The imported turn could not be recorded.");
    first ??= { turnId: turn.id, createdAt: completedAt };
  }
  if (first && input.omittedMessages > 0) {
    const omission = { omitted: input.omittedMessages, total: input.omittedMessages + messages.length };
    transcripts.createMessage(conversationId, cliOmissionText(omission, true), "system", [], first.turnId, first.createdAt, { activateConversation: false });
  }
}

export function importCliConversation(
  database: Database.Database,
  conversations: ConversationRepository,
  transcripts: TranscriptRepository,
  turns: Pick<TurnLedgerRepository, "create">,
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
    importTurns(database, transcripts, turns, conversation.id, input, ordered);
    conversations.update(conversation.id, { providerSessionId: input.continuation === "native" ? input.sessionId : null, continuationIdentity: input.continuationIdentity });
    database.prepare(`INSERT INTO cli_conversation_imports
      (source_key, provider_id, session_id, cwd, conversation_id, imported_at, source_messages, omitted_messages, omitted_bytes, dropped_records, continuation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.sourceKey, input.providerId, input.sessionId, input.cwd, conversation.id, importedAt,
        input.messages.length + input.omittedMessages, input.omittedMessages, input.omittedBytes, input.droppedRecords, input.continuation);
    return conversation.id;
  })();
}
