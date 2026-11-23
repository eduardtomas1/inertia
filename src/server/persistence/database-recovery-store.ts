import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type Database from "better-sqlite3";

import type { ChatAttachment } from "../../shared/contracts";
import {
  conversationFromRow,
  messageFromRow,
  projectFromRow,
} from "./codecs";
import {
  DATABASE_RECOVERY_BUNDLE_VERSION,
  DATABASE_RECOVERY_EXPORT_FORMAT,
  DATABASE_RECOVERY_EXPORT_MAX_CONVERSATIONS,
  DATABASE_RECOVERY_EXPORT_MAX_MESSAGES,
  DATABASE_RECOVERY_EXPORT_MAX_PROJECTS,
  DATABASE_RECOVERY_EXPORT_VERSION,
  type DatabaseRecoveryBundleExport,
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

export interface RecoveryExportAttachmentReference {
  readonly projectIndex: number;
  readonly conversationIndex: number;
  readonly messageOrdinal: number;
  readonly messageId: string;
  readonly conversationId: string;
  readonly attachment: ChatAttachment;
}

export interface DatabaseRecoveryImportOptions {
  signal?: AbortSignal;
  operationId?: string;
  maxAttachments?: number;
  maxAttachmentBytes?: number;
  maxTotalAttachmentBytes?: number;
  operations?: PrepareRecoveryImportOptions["operations"] & {
    afterMessageCreate?: () => void;
    beforePublishAttachment?: (id: string) => void;
  };
}

export interface DatabaseRecoveryImportWriters {
  createProject(project: RecoveryProject, path: string): string;
  scratchProject(): string;
  createConversation(
    projectId: string,
    conversation: RecoveryConversation,
  ): string;
  createMessage(
    id: string,
    conversationId: string,
    message: RecoveryMessage,
    attachments?: ChatAttachment[],
  ): void;
}

const RECOVERY_MESSAGE_ORDINAL_HEX_DIGITS = 5;

function recoveryMessageId(prefix: string, ordinal: number): string {
  return `${prefix}${ordinal.toString(16).padStart(
    RECOVERY_MESSAGE_ORDINAL_HEX_DIGITS,
    "0",
  )}`;
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

export function snapshotRecoveryExportData(
  database: Database.Database,
  maxBytes: number,
  version: typeof DATABASE_RECOVERY_EXPORT_VERSION,
): {
  readonly exportData: DatabaseRecoveryExport;
  readonly attachmentReferences: readonly RecoveryExportAttachmentReference[];
};
export function snapshotRecoveryExportData(
  database: Database.Database,
  maxBytes: number,
  version: typeof DATABASE_RECOVERY_BUNDLE_VERSION,
): {
  readonly exportData: DatabaseRecoveryBundleExport;
  readonly attachmentReferences: readonly RecoveryExportAttachmentReference[];
};
export function snapshotRecoveryExportData(
  database: Database.Database,
  maxBytes: number,
  version: typeof DATABASE_RECOVERY_EXPORT_VERSION | typeof DATABASE_RECOVERY_BUNDLE_VERSION,
): {
  readonly exportData: DatabaseRecoveryExport | DatabaseRecoveryBundleExport;
  readonly attachmentReferences: readonly RecoveryExportAttachmentReference[];
} {
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
  const attachmentReferences: RecoveryExportAttachmentReference[] = [];
  const exportedProjects = projects.map((project, projectIndex) => {
    const scratch = project.workspaceKind === "scratch";
    account({ name: project.name, path: project.path });
    return {
      name: project.name,
      path: project.path,
      ...(scratch ? { workspaceKind: "scratch" as const } : {}),
      conversations: (conversationsByProject.get(project.id) ?? [])
        .map((conversation, conversationIndex) => {
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
              .map((message, ordinal) => {
                for (const attachment of message.attachments) {
                  attachmentReferences.push({
                    projectIndex,
                    conversationIndex,
                    messageOrdinal: ordinal,
                    messageId: message.id,
                    conversationId: conversation.id,
                    attachment,
                  });
                }
                const exportedMessage = {
                  role: message.role,
                  content: message.content,
                  createdAt: message.createdAt,
                  ordinal,
                };
                account(exportedMessage);
                return exportedMessage;
              }),
          };
        }),
    };
  });
  return {
    exportData: {
      format: DATABASE_RECOVERY_EXPORT_FORMAT,
      version,
      exportedAt: new Date().toISOString(),
      projects: exportedProjects,
    },
    attachmentReferences,
  };
}

export function exportDatabaseRecoveryData(
  database: Database.Database,
  maxBytes: number,
): string {
  const { exportData } = snapshotRecoveryExportData(
    database,
    maxBytes,
    DATABASE_RECOVERY_EXPORT_VERSION,
  );
  return serializeDatabaseRecoveryExport(exportData);
}

export interface CommittedDatabaseRecoveryImport {
  readonly summary: DatabaseRecoveryImportResult;
  readonly createdProjectIds: readonly string[];
  readonly createdConversationIds: readonly string[];
  readonly operationId: string;
  readonly placeholderProjectCount: number;
}

export async function importPreparedDatabaseRecovery(options: {
  readonly database: Database.Database;
  readonly recovery: DatabaseRecoveryExport;
  readonly digest: string;
  readonly resolvedRoot: string;
  readonly writers: DatabaseRecoveryImportWriters;
  readonly importOptions?: DatabaseRecoveryImportOptions;
  readonly attachmentsByMessageKey?: ReadonlyMap<string, ChatAttachment[]>;
}): Promise<CommittedDatabaseRecoveryImport> {
  const {
    database,
    recovery,
    digest,
    resolvedRoot,
    writers,
    importOptions = {},
    attachmentsByMessageKey,
  } = options;
  const existingReceipt = database.prepare(`
    SELECT projects, conversations, messages
    FROM recovery_import_receipts WHERE digest = ?
  `).get(digest) as {
    projects: number;
    conversations: number;
    messages: number;
  } | undefined;
  const operationId = importOptions.operationId ?? randomUUID();
  if (existingReceipt) {
    return {
      summary: { ...existingReceipt, alreadyImported: true },
      createdProjectIds: [],
      createdConversationIds: [],
      operationId,
      placeholderProjectCount: 0,
    };
  }
  const placeholderProjectCount = recovery.projects.filter(
    ({ workspaceKind }) => workspaceKind !== "scratch",
  ).length;
  const prepared = await prepareRecoveryImport({
    database,
    digest,
    authorizedRoot: resolvedRoot,
    projectCount: placeholderProjectCount,
    operationId,
    signal: importOptions.signal,
    operations: importOptions.operations,
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
      const createdProjectIds: string[] = [];
      const createdConversationIds: string[] = [];
      let conversationCount = 0;
      let messageCount = 0;
      let placeholderIndex = 0;
      for (const [projectIndex, importedProject] of recovery.projects.entries()) {
        const scratch = importedProject.workspaceKind === "scratch";
        const projectId = scratch
          ? writers.scratchProject()
          : writers.createProject(importedProject, verifyRecoveredProjectDirectory(
            prepared.projectPath(placeholderIndex++),
            resolvedRoot,
          ));
        if (!scratch) createdProjectIds.push(projectId);
        for (const [conversationIndex, importedConversation] of importedProject.conversations.entries()) {
          const conversationId = writers.createConversation(
            projectId,
            importedConversation,
          );
          createdConversationIds.push(conversationId);
          conversationCount += 1;
          const messageIdPrefix = randomUUID().slice(
            0,
            -RECOVERY_MESSAGE_ORDINAL_HEX_DIGITS,
          );
          for (const importedMessage of importedConversation.messages) {
            const messageAttachments = attachmentsByMessageKey?.get(
              `${projectIndex}:${conversationIndex}:${importedMessage.ordinal}`,
            );
            writers.createMessage(
              recoveryMessageId(messageIdPrefix, importedMessage.ordinal),
              conversationId,
              importedMessage,
              messageAttachments,
            );
            messageCount += 1;
            importOptions.operations?.afterMessageCreate?.();
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
      return {
        summary,
        createdProjectIds,
        createdConversationIds,
        operationId,
        placeholderProjectCount,
      };
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
  const committed = await importPreparedDatabaseRecovery({
    database,
    recovery,
    digest,
    resolvedRoot,
    writers,
    importOptions: options,
  });
  return committed.summary;
}
