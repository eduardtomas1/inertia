import { z } from "zod";

import {
  CHAT_ATTACHMENT_MIME_TYPES,
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_BYTES,
} from "../../attachments";
import { MAX_CONVERSATION_CONTEXT_PACKETS_PER_TURN } from "../../conversation-context";

export const requestBase = {
  requestId: z.string().uuid(),
};

function isPortableWorkspacePath(path: string, allowRoot: boolean): boolean {
  if (
    /[\0\r\n]/u.test(path)
    || path.startsWith("/")
    || path.split("/").some((segment) => segment === "..")
  ) return false;
  return allowRoot || (path !== "" && path !== ".");
}

export const workspaceDirectoryPathSchema = z.string()
  .min(1)
  .max(4_096)
  .refine((path) => isPortableWorkspacePath(path, true), "Invalid project-relative directory.");

export const workspaceFilePathSchema = z.string()
  .min(1)
  .max(4_096)
  .refine((path) => isPortableWorkspacePath(path, false), "Invalid project-relative file.");

export const providerIdSchema = z.enum(["codex", "claude", "cursor", "kimi", "opencode"]);
export const accessModeSchema = z.enum(["supervised", "auto-edit", "full"]);
export const interactionModeSchema = z.enum(["build", "plan"]);

export const attachmentSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(255),
    path: z.string().min(1).max(4096),
    mimeType: z.enum(CHAT_ATTACHMENT_MIME_TYPES),
    size: z.number().int().min(1).max(MAX_CHAT_ATTACHMENT_BYTES),
  })
  .strict();

export const attachmentsSchema = z.array(attachmentSchema)
  .max(MAX_CHAT_ATTACHMENTS)
  .default([]);

export const turnRequestContextSchema = z
  .object({
    fileReferences: z.array(z.object({
      path: z.string().trim().min(1).max(4096),
      lineStart: z.number().int().min(1).max(10_000_000).optional(),
      lineEnd: z.number().int().min(1).max(10_000_000).optional(),
    }).strict()).max(16).optional(),
    diffSelections: z.array(z.object({
      path: z.string().trim().min(1).max(4096),
      hunkHeader: z.string().trim().min(1).max(2_000),
      content: z.string().min(1).max(64 * 1024),
      selectedLineCount: z.number().int().min(1).max(500),
      truncated: z.boolean().optional(),
    }).strict()).max(8).optional(),
    terminalContexts: z.array(z.object({
      terminalId: z.string().trim().min(1).max(200),
      terminalLabel: z.string().trim().min(1).max(200),
      lineStart: z.number().int().min(1).max(10_000_000),
      lineEnd: z.number().int().min(1).max(10_000_000),
      content: z.string().min(1).max(64 * 1024),
    }).strict()).max(8).optional(),
    previewContexts: z.array(z.object({
      url: z.string().trim().min(1).max(8_192),
      title: z.string().trim().min(1).max(1_000).optional(),
      selector: z.string().trim().min(1).max(4_000).optional(),
      componentName: z.string().trim().min(1).max(500).optional(),
      sourcePath: z.string().trim().min(1).max(4_096).optional(),
      sourceLine: z.number().int().min(1).max(10_000_000).optional(),
      html: z.string().max(16 * 1024).optional(),
      styles: z.string().max(16 * 1024).optional(),
    }).strict()).max(8).optional(),
    reviewNotes: z.array(z.object({
      noteId: z.string().uuid().optional(),
      path: z.string().trim().min(1).max(4_096),
      hunkId: z.string().trim().min(1).max(128).optional(),
      lineIds: z.array(z.string().min(1).max(160)).max(500).optional(),
      body: z.string().trim().min(1).max(8_000),
      stale: z.boolean().optional(),
    }).strict()).max(16).optional(),
    conversationContextPacketIds: z.array(z.string().uuid())
      .max(MAX_CONVERSATION_CONTEXT_PACKETS_PER_TURN)
      .refine((ids) => new Set(ids).size === ids.length, "Context packets must be unique.")
      .optional(),
  })
  .strict();

export const diffReviewSelectionSchema = z.object({
  projectId: z.string().uuid(),
  conversationId: z.string().uuid(),
  repositoryPath: z.string().min(1).max(4096).optional(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  filePath: z.string().min(1).max(4096),
  hunkId: z.string().min(1).max(128),
  lineIds: z.array(z.string().min(1).max(160)).min(1).max(500),
  comment: z.string().trim().max(2_000).optional(),
  ignoreWhitespace: z.boolean().optional(),
}).strict();
