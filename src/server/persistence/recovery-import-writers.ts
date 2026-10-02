import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type Database from "better-sqlite3";

import type { Conversation, Project } from "../../shared/contracts";
import { normalizeIdentityPath } from "../project-identity";
import { recoveredConversationModel } from "./database-export";
import type { DatabaseRecoveryImportWriters } from "./database-recovery-store";
import type { NewProjectOptions } from "./project-repository";
import type { NewConversationOptions } from "./types";

export interface RecoveryImportWriterContext {
  database: Database.Database;
  createProject(name: string, path: string, options?: NewProjectOptions): Project;
  createConversation(projectId: string, title: string, options: NewConversationOptions): Conversation;
  createRecoveredMessage(
    id: string,
    conversationId: string,
    content: string,
    role: "user" | "assistant" | "system",
    createdAt: string,
  ): void;
}

function isManagedRoot(root: string, dataDirectory: string): boolean {
  try {
    const metadata = lstatSync(root);
    return metadata.isDirectory()
      && !metadata.isSymbolicLink()
      && normalizeIdentityPath(realpathSync(root)) === normalizeIdentityPath(join(realpathSync(dataDirectory), "scratch"));
  } catch {
    return false;
  }
}

export function recoveryImportWriters(context: RecoveryImportWriterContext): DatabaseRecoveryImportWriters {
  const dataDirectory = dirname(resolve(context.database.name));
  return {
    createProject: (project, path) =>
      context.createProject(project.name, path).id,
    scratchProject: () => {
      const existing = context.database.prepare(
        "SELECT id FROM projects WHERE workspace_kind = 'scratch'",
      ).get() as { id: string } | undefined;
      if (existing) return existing.id;
      const root = join(dataDirectory, "scratch");
      return context.createProject("No project", root, {
        workspaceKind: "scratch",
        activate: false,
        enroll: isManagedRoot(root, dataDirectory),
      }).id;
    },
    createConversation: (projectId, conversation) =>
      context.createConversation(projectId, conversation.title, {
        ...recoveredConversationModel(conversation),
        interactionMode: conversation.interactionMode,
        // Exported authorization is never authoritative on this device.
        accessMode: "supervised",
        activate: false,
      }).id,
    createMessage: (id, conversationId, message) => {
      context.createRecoveredMessage(id, conversationId, message.content, message.role, message.createdAt);
    },
  };
}
