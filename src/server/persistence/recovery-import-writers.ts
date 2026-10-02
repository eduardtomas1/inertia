import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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
  projectPath(projectId: string): string;
  createRecoveredMessage(id: string, conversationId: string, content: string, role: "user" | "assistant" | "system", createdAt: string): void;
}

function isDirectory(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function isManagedRoot(root: string, dataDirectory: string): boolean {
  return isDirectory(root)
    && normalizeIdentityPath(realpathSync(root)) === normalizeIdentityPath(join(realpathSync(dataDirectory), "scratch"));
}

export function recoveryImportWriters(context: RecoveryImportWriterContext): DatabaseRecoveryImportWriters {
  const dataDirectory = dirname(resolve(context.database.name));
  const chatFolderIsAvailable = (projectId: string, folder: string): boolean => {
    let root: string;
    try {
      root = context.projectPath(projectId);
    } catch {
      return false;
    }
    return dirname(resolve(folder)) === resolve(root)
      && isDirectory(folder)
      && normalizeIdentityPath(realpathSync(folder)) === normalizeIdentityPath(join(realpathSync(root), basename(folder)))
      && context.database.prepare("SELECT 1 FROM conversations WHERE worktree_path = ?").get(folder) === undefined;
  };
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
    createConversation: (projectId, conversation, scratch) => {
      const folder = scratch ? conversation.worktreePath ?? context.database.prepare(
        "SELECT path FROM projects WHERE id = ?",
      ).pluck().get(projectId) as string : null;
      return context.createConversation(projectId, conversation.title, {
        ...recoveredConversationModel(conversation),
        interactionMode: conversation.interactionMode,
        // Exported authorization is never authoritative on this device.
        accessMode: "supervised",
        activate: false,
        ...(folder === null ? {} : {
          branch: null,
          worktreePath: folder,
          enrollWorktree: conversation.worktreePath !== undefined && chatFolderIsAvailable(projectId, folder),
        }),
      }).id;
    },
    createMessage: (id, conversationId, message) => {
      context.createRecoveredMessage(id, conversationId, message.content, message.role, message.createdAt);
    },
  };
}
