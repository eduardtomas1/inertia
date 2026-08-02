import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type Database from "better-sqlite3";

import {
  conversationFromRow,
  messageFromRow,
  projectFromRow,
} from "./codecs";
import {
  DATABASE_RECOVERY_EXPORT_FORMAT,
  DATABASE_RECOVERY_EXPORT_MAX_CONVERSATIONS,
  DATABASE_RECOVERY_EXPORT_MAX_MESSAGES,
  DATABASE_RECOVERY_EXPORT_MAX_PROJECTS,
  DATABASE_RECOVERY_EXPORT_VERSION,
  type DatabaseRecoveryExport,
  type DatabaseRecoveryImportResult,
  parseDatabaseRecoveryExport,
  serializeDatabaseRecoveryExport,
} from "./database-export";
import {
  prepareRecoveryImport,
  type PrepareRecoveryImportOptions,
} from "./database-recovery-import";
import type { ConversationRow, MessageRow, ProjectRow } from "./rows";
import { MESSAGE_PROJECTION_COLUMNS } from "./stream-text-storage";

type RecoveryProject = DatabaseRecoveryExport["projects"][number];
type RecoveryConversation = RecoveryProject["conversations"][number];
type RecoveryMessage = RecoveryConversation["messages"][number];

export interface DatabaseRecoveryImportOptions {
  signal?: AbortSignal;
  operationId?: string;
  operations?: PrepareRecoveryImportOptions["operations"];
}

export interface DatabaseRecoveryImportWriters {
  createProject(project: RecoveryProject, path: string): string;
  createConversation(
    projectId: string,
    conversation: RecoveryConversation,
  ): string;
  createMessage(conversationId: string, message: RecoveryMessage): void;
}

function verifyRecoveredProjectDirectory(path: string, root: string): string {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("The recovered project destination is not a local directory.");
  }
  const canonical = resolve(realpathSync(path));
  const child = relative(root, canonical);
  if (
    !child
    || child === ".."
    || child.startsWith(`..${sep}`)
    || isAbsolute(child)
  ) {
    throw new Error("The recovered project destination escaped its authorized folder.");
  }
  return canonical;
}

export function exportDatabaseRecoveryData(
  database: Database.Database,
  maxBytes: number,
): string {
  if (database.prepare("PRAGMA foreign_key_check").get()) {
    throw new Error("The database has invalid relationships and cannot be exported safely.");
  }
  const counts = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM projects) AS projects,
      (SELECT COUNT(*) FROM conversations) AS conversations,
      (SELECT COUNT(*) FROM messages) AS messages
  `).get() as {
    projects: number;
    conversations: number;
    messages: number;
  };
  if (
    counts.projects > DATABASE_RECOVERY_EXPORT_MAX_PROJECTS
    || counts.conversations > DATABASE_RECOVERY_EXPORT_MAX_CONVERSATIONS
    || counts.messages > DATABASE_RECOVERY_EXPORT_MAX_MESSAGES
  ) {
    throw new Error("The recovery export contains too many records.");
  }
  // Any UTF-8 source byte expands to at most six JSON bytes (for example a
  // NUL becomes "\\u0000"). Include a conservative per-record allowance
  // for keys, punctuation, and pretty-print indentation before fetching any
  // reconstructed message projections into the JS heap.
  let sourceBytes = 1_024
    + counts.projects * 256
    + counts.conversations * 384
    + counts.messages * 160;
  const sourceByteTotal = database.prepare(`
    SELECT COALESCE(SUM(bytes), 0) AS bytes FROM (
      SELECT
        length(CAST(name AS BLOB))
          + length(CAST(path AS BLOB))
          + 64 AS bytes
      FROM projects
      UNION ALL
      SELECT
        length(CAST(title AS BLOB))
          + length(CAST(provider_id AS BLOB))
          + length(CAST(model AS BLOB))
          + length(CAST(reasoning_effort AS BLOB))
          + length(CAST(interaction_mode AS BLOB))
          + length(CAST(access_mode AS BLOB))
          + 64 AS bytes
      FROM conversations
      UNION ALL
      SELECT
        length(CAST(role AS BLOB))
          + length(CAST(content AS BLOB))
          + length(CAST(created_at AS BLOB))
          + 64 AS bytes
      FROM messages
      UNION ALL
      SELECT length(CAST(content AS BLOB)) AS bytes
      FROM message_content_chunks
    )
  `).get() as { bytes: unknown };
  if (
    typeof sourceByteTotal.bytes !== "number"
    || !Number.isSafeInteger(sourceByteTotal.bytes)
    || sourceByteTotal.bytes < 0
  ) {
    throw new Error("The recovery export size could not be bounded safely.");
  }
  sourceBytes += sourceByteTotal.bytes * 6;
  if (!Number.isSafeInteger(sourceBytes)) {
    throw new Error("The recovery export size could not be bounded safely.");
  }
  if (sourceBytes > maxBytes) {
    throw new Error("The recovery export exceeds its safe size limit.");
  }
  const rows = database.transaction(() => ({
    projects: database.prepare(
      "SELECT * FROM projects ORDER BY updated_at DESC, id ASC",
    ).all() as ProjectRow[],
    conversations: database.prepare(
      "SELECT * FROM conversations ORDER BY updated_at DESC, id ASC",
    ).all() as ConversationRow[],
    messages: database.prepare(`
      SELECT ${MESSAGE_PROJECTION_COLUMNS}
      FROM messages
      ORDER BY messages.created_at ASC, messages.id ASC
    `).all() as MessageRow[],
  }))();
  const projects = rows.projects.map(projectFromRow);
  const conversations = rows.conversations.map(conversationFromRow);
  const messages = rows.messages.map(messageFromRow);
  const conversationsByProject = new Map<string, typeof conversations>();
  for (const conversation of conversations) {
    const grouped = conversationsByProject.get(conversation.projectId);
    if (grouped) grouped.push(conversation);
    else conversationsByProject.set(conversation.projectId, [conversation]);
  }
  const messagesByConversation = new Map<string, typeof messages>();
  for (const message of messages) {
    const grouped = messagesByConversation.get(message.conversationId);
    if (grouped) grouped.push(message);
    else messagesByConversation.set(message.conversationId, [message]);
  }
  if (
    projects.length !== counts.projects
    || conversations.length !== counts.conversations
    || messages.length !== counts.messages
    || [...conversationsByProject.values()].reduce(
      (total, group) => total + group.length,
      0,
    ) !== counts.conversations
    || [...messagesByConversation.values()].reduce(
      (total, group) => total + group.length,
      0,
    ) !== counts.messages
  ) {
    throw new Error("The database recovery export could not account for every record.");
  }
  let estimatedBytes = 1_024;
  const account = (value: unknown): void => {
    estimatedBytes += Buffer.byteLength(JSON.stringify(value), "utf8") + 64;
    if (estimatedBytes > maxBytes) {
      throw new Error("The recovery export exceeds its safe size limit.");
    }
  };
  const value: DatabaseRecoveryExport = {
    format: DATABASE_RECOVERY_EXPORT_FORMAT,
    version: DATABASE_RECOVERY_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    projects: projects.map((project) => {
      account({ name: project.name, path: project.path });
      return {
        name: project.name,
        path: project.path,
        conversations: (conversationsByProject.get(project.id) ?? [])
          .map((conversation) => {
            account({
              title: conversation.title,
              providerId: conversation.providerId,
              model: conversation.model,
              reasoningEffort: conversation.reasoningEffort,
              interactionMode: conversation.interactionMode,
              accessMode: conversation.accessMode,
            });
            return {
              title: conversation.title,
              providerId: conversation.providerId,
              model: conversation.model,
              reasoningEffort: conversation.reasoningEffort,
              interactionMode: conversation.interactionMode,
              accessMode: conversation.accessMode,
              messages: (messagesByConversation.get(conversation.id) ?? [])
                .map((message) => {
                  const exportedMessage = {
                    role: message.role,
                    content: message.content,
                    createdAt: message.createdAt,
                  };
                  account(exportedMessage);
                  return exportedMessage;
                }),
            };
          }),
      };
    }),
  };
  return serializeDatabaseRecoveryExport(value);
}

export async function importDatabaseRecoveryData(
  database: Database.Database,
  serialized: string,
  authorizedRoot: string,
  writers: DatabaseRecoveryImportWriters,
  options: DatabaseRecoveryImportOptions = {},
): Promise<DatabaseRecoveryImportResult> {
  if (!isAbsolute(authorizedRoot) || authorizedRoot.includes("\0")) {
    throw new Error("The recovery import destination is invalid.");
  }
  const rootMetadata = lstatSync(authorizedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("The recovery import destination is not a local directory.");
  }
  const resolvedRoot = resolve(realpathSync(authorizedRoot));
  const recovery = parseDatabaseRecoveryExport(serialized);
  const digest = createHash("sha256")
    .update(serialized, "utf8")
    .update("\0", "utf8")
    .update(resolvedRoot, "utf8")
    .digest("hex");
  const existingReceipt = database.prepare(`
    SELECT projects, conversations, messages
    FROM recovery_import_receipts WHERE digest = ?
  `).get(digest) as {
    projects: number;
    conversations: number;
    messages: number;
  } | undefined;
  if (existingReceipt) return { ...existingReceipt, alreadyImported: true };
  const prepared = await prepareRecoveryImport({
    database,
    digest,
    authorizedRoot: resolvedRoot,
    projectCount: recovery.projects.length,
    operationId: options.operationId,
    signal: options.signal,
    operations: options.operations,
  });
  try {
    return database.transaction(() => {
      const receipt = database.prepare(`
        SELECT projects, conversations, messages
        FROM recovery_import_receipts WHERE digest = ?
      `).get(digest) as {
        projects: number;
        conversations: number;
        messages: number;
      } | undefined;
      if (receipt) {
        throw new Error("The recovery import completed concurrently.");
      }
      prepared.publish();
      const active = database.prepare(`
        SELECT active_project_id, active_conversation_id
        FROM app_state WHERE id = 1
      `).get() as {
        active_project_id: string | null;
        active_conversation_id: string | null;
      };
      let conversationCount = 0;
      let messageCount = 0;
      for (const [projectIndex, importedProject] of recovery.projects.entries()) {
        const remappedPath = verifyRecoveredProjectDirectory(
          prepared.projectPath(projectIndex),
          resolvedRoot,
        );
        const projectId = writers.createProject(importedProject, remappedPath);
        for (const importedConversation of importedProject.conversations) {
          const conversationId = writers.createConversation(
            projectId,
            importedConversation,
          );
          conversationCount += 1;
          for (const importedMessage of importedConversation.messages) {
            writers.createMessage(conversationId, importedMessage);
            messageCount += 1;
          }
        }
      }
      database.prepare(`
        UPDATE app_state
        SET active_project_id = ?, active_conversation_id = ?
        WHERE id = 1
      `).run(active.active_project_id, active.active_conversation_id);
      const summary = {
        projects: recovery.projects.length,
        conversations: conversationCount,
        messages: messageCount,
        alreadyImported: false,
      };
      if (database.prepare("PRAGMA foreign_key_check").get()) {
        throw new Error("The database has invalid relationships and cannot import recovery data safely.");
      }
      database.prepare(`
        INSERT INTO recovery_import_receipts (
          digest, projects, conversations, messages, imported_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        digest,
        summary.projects,
        summary.conversations,
        summary.messages,
        new Date().toISOString(),
      );
      prepared.complete();
      return summary;
    })();
  } catch (error) {
    try {
      prepared.abort();
    } catch (cleanupError) {
      const detail = error instanceof Error ? error.message : "Recovery import failed.";
      throw new AggregateError(
        [error, cleanupError],
        `${detail} The incomplete import still requires startup reconciliation.`,
        { cause: error },
      );
    }
    throw error;
  }
}
