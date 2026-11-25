import { basename } from "node:path";

import { z } from "zod";

import { MAX_RETAINED_ATTACHMENTS } from "../../shared/attachment-storage";
import {
  ACCEPTED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  chatAttachmentStorageExtension,
  storedAttachmentTypeMatchesName,
  type ChatAttachmentMimeType,
} from "../../shared/attachments";
import { providerNativeModelSelection } from "../../shared/model-routing";
import { previewAnnotationSchema } from "../../shared/preview-annotation";
import { snapshotSourceSchema } from "../../shared/snapshots";
import type { ProviderId } from "../../shared/contracts";
import type { NewConversationOptions } from "./types";

export const DATABASE_RECOVERY_EXPORT_FORMAT = "inertia-recovery-export";
export const DATABASE_RECOVERY_EXPORT_VERSION = 3;
export const DATABASE_RECOVERY_BUNDLE_FORMAT = "inertia-recovery-bundle";
export const DATABASE_RECOVERY_BUNDLE_VERSION = 4;
export const DATABASE_RECOVERY_EXPORT_MAX_BYTES = 256 * 1024 * 1024;
export const DATABASE_RECOVERY_BUNDLE_MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
export const DATABASE_RECOVERY_BUNDLE_MAX_ATTACHMENTS = MAX_RETAINED_ATTACHMENTS;
export const DATABASE_RECOVERY_BUNDLE_MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_BYTES;
export const DATABASE_RECOVERY_BUNDLE_MAX_TOTAL_ATTACHMENT_BYTES = 16 * 1024 * 1024 * 1024;
export const DATABASE_RECOVERY_EXPORT_MAX_PROJECTS = 10_000;
export const DATABASE_RECOVERY_EXPORT_MAX_CONVERSATIONS = 100_000;
export const DATABASE_RECOVERY_EXPORT_MAX_MESSAGES = 250_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const timestampSchema = z.string().datetime({ offset: true });

const legacyRecoveryMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().max(64 * 1_024 * 1_024),
  createdAt: timestampSchema,
}).strict();

const recoveryMessageSchema = legacyRecoveryMessageSchema.extend({
  ordinal: z.number().int().min(0)
    .max(DATABASE_RECOVERY_EXPORT_MAX_MESSAGES - 1),
}).strict();

const recoveryConversationFields = {
  title: z.string().max(4_000),
  providerId: z.enum([
    "codex",
    "claude",
    "cursor",
    "kimi",
    "opencode",
    "antigravity",
    "grok",
    "gemini",
  ]),
  model: z.string().max(300),
  reasoningEffort: z.string().max(80),
  interactionMode: z.enum(["build", "plan"]),
  accessMode: z.enum(["supervised", "auto-edit", "full"]),
};

function normalizeRecoveryConversation<T extends {
  providerId: z.infer<typeof recoveryConversationFields.providerId>;
  model: string;
  reasoningEffort: string;
}>(conversation: T) {
  const { providerId, ...rest } = conversation;
  return {
    ...rest,
    providerId: providerId === "gemini" ? "antigravity" as const : providerId,
    model: providerId === "gemini" ? "" : conversation.model,
    reasoningEffort: providerId === "gemini" ? "" : conversation.reasoningEffort,
  };
}

const legacyRecoveryConversationSchema = z.object({
  ...recoveryConversationFields,
  messages: z.array(legacyRecoveryMessageSchema)
    .max(DATABASE_RECOVERY_EXPORT_MAX_MESSAGES),
}).strict().transform(normalizeRecoveryConversation);

const recoveryConversationSchema = z.object({
  ...recoveryConversationFields,
  messages: z.array(recoveryMessageSchema).max(DATABASE_RECOVERY_EXPORT_MAX_MESSAGES),
}).strict().superRefine((value, context) => {
  for (const [index, message] of value.messages.entries()) {
    if (message.ordinal !== index) {
      context.addIssue({
        code: "custom",
        path: ["messages", index, "ordinal"],
        message: "Recovery message ordinals must match their array order.",
      });
    }
  }
}).transform(normalizeRecoveryConversation);

const recoveryProjectFields = {
  name: z.string().max(1_000),
  path: z.string().min(1).max(4_096).refine(
    (value) => !value.includes("\0"),
    "Expected a bounded project path identity without NUL bytes.",
  ),
};

const legacyRecoveryProjectSchema = z.object({
  ...recoveryProjectFields,
  conversations: z.array(legacyRecoveryConversationSchema)
    .max(DATABASE_RECOVERY_EXPORT_MAX_CONVERSATIONS),
}).strict();

const version2RecoveryProjectSchema = z.object({
  ...recoveryProjectFields,
  conversations: z.array(recoveryConversationSchema)
    .max(DATABASE_RECOVERY_EXPORT_MAX_CONVERSATIONS),
}).strict();

const recoveryProjectSchema = z.object({
  ...recoveryProjectFields,
  workspaceKind: z.literal("scratch").optional(),
  conversations: z.array(recoveryConversationSchema)
    .max(DATABASE_RECOVERY_EXPORT_MAX_CONVERSATIONS),
}).strict();

interface RecoveryExportCounts {
  projects: Array<{
    conversations: Array<{ messages: unknown[] }>;
  }>;
}

function validateRecoveryExportCounts(
  value: RecoveryExportCounts,
  context: z.RefinementCtx,
): void {
  let conversations = 0;
  let messages = 0;
  for (const project of value.projects) {
    conversations += project.conversations.length;
    for (const conversation of project.conversations) {
      messages += conversation.messages.length;
    }
  }
  if (conversations > DATABASE_RECOVERY_EXPORT_MAX_CONVERSATIONS) {
    context.addIssue({
      code: "custom",
      message: "The recovery export contains too many conversations.",
    });
  }
  if (messages > DATABASE_RECOVERY_EXPORT_MAX_MESSAGES) {
    context.addIssue({
      code: "custom",
      message: "The recovery export contains too many messages.",
    });
  }
}

const legacyDatabaseRecoveryExportSchema = z.object({
  format: z.literal(DATABASE_RECOVERY_EXPORT_FORMAT),
  version: z.literal(1),
  exportedAt: timestampSchema,
  projects: z.array(legacyRecoveryProjectSchema)
    .max(DATABASE_RECOVERY_EXPORT_MAX_PROJECTS),
}).strict().superRefine(validateRecoveryExportCounts);

const version2DatabaseRecoveryExportSchema = z.object({
  format: z.literal(DATABASE_RECOVERY_EXPORT_FORMAT),
  version: z.literal(2),
  exportedAt: timestampSchema,
  projects: z.array(version2RecoveryProjectSchema)
    .max(DATABASE_RECOVERY_EXPORT_MAX_PROJECTS),
}).strict().superRefine(validateRecoveryExportCounts);

export const databaseRecoveryExportSchema = z.object({
  format: z.literal(DATABASE_RECOVERY_EXPORT_FORMAT),
  version: z.literal(DATABASE_RECOVERY_EXPORT_VERSION),
  exportedAt: timestampSchema,
  projects: z.array(recoveryProjectSchema)
    .max(DATABASE_RECOVERY_EXPORT_MAX_PROJECTS),
}).strict().superRefine(validateRecoveryExportCounts);

export const databaseRecoveryBundleExportSchema = z.object({
  format: z.literal(DATABASE_RECOVERY_EXPORT_FORMAT),
  version: z.literal(DATABASE_RECOVERY_BUNDLE_VERSION),
  exportedAt: timestampSchema,
  projects: z.array(recoveryProjectSchema)
    .max(DATABASE_RECOVERY_EXPORT_MAX_PROJECTS),
}).strict().superRefine(validateRecoveryExportCounts);

const supportedDatabaseRecoveryExportSchema = z.union([
  databaseRecoveryExportSchema,
  version2DatabaseRecoveryExportSchema,
  legacyDatabaseRecoveryExportSchema,
]);

const supportedDatabaseRecoveryBundleOrLegacySchema = z.union([
  databaseRecoveryBundleExportSchema,
  databaseRecoveryExportSchema,
  version2DatabaseRecoveryExportSchema,
  legacyDatabaseRecoveryExportSchema,
]);

function isSafeAttachmentLeafName(name: string): boolean {
  return name.length >= 1
    && name.length <= 255
    && !/[\0-\x1f\x7f]/u.test(name)
    && !/[\\/]/u.test(name)
    && name !== "."
    && name !== ".."
    && basename(name) === name;
}

export const recoveryBundleMessageReferenceSchema = z.object({
  projectIndex: z.number().int().min(0).max(DATABASE_RECOVERY_EXPORT_MAX_PROJECTS - 1),
  conversationIndex: z.number().int().min(0).max(DATABASE_RECOVERY_EXPORT_MAX_CONVERSATIONS - 1),
  messageOrdinal: z.number().int().min(0).max(DATABASE_RECOVERY_EXPORT_MAX_MESSAGES - 1),
  messageId: z.string().min(1).max(200).refine((value) => !/[\0\r\n]/u.test(value)),
}).strict();

export const recoveryBundleAttachmentSchema = z.object({
  id: z.string().regex(UUID_PATTERN),
  conversationId: z.string().regex(UUID_PATTERN),
  messageReference: recoveryBundleMessageReferenceSchema,
  name: z.string().min(1).max(255).refine(
    isSafeAttachmentLeafName,
    "Expected a safe attachment file name.",
  ),
  mimeType: z.enum(ACCEPTED_ATTACHMENT_MIME_TYPES),
  size: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
  sha256: z.string().regex(SHA256_PATTERN).nullable(),
  status: z.enum(["included", "missing"]),
  entryPath: z.string().min(1).max(100).nullable(),
  previewAnnotation: previewAnnotationSchema.optional(),
  snapshot: snapshotSourceSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.previewAnnotation || value.snapshot) && value.mimeType !== "image/png") {
    context.addIssue({
      code: "custom",
      path: ["mimeType"],
      message: "Attachment annotation or snapshot metadata requires a PNG image.",
    });
  }
  if (!storedAttachmentTypeMatchesName(value.name, value.mimeType)) {
    context.addIssue({
      code: "custom",
      path: ["mimeType"],
      message: "Attachment MIME type does not match its file name.",
    });
  }
  if (value.status === "included") {
    if (value.sha256 === null) {
      context.addIssue({
        code: "custom",
        path: ["sha256"],
        message: "Included attachments must record a SHA-256 digest.",
      });
    }
    const expectedEntryPath = `attachments/${value.id}.${chatAttachmentStorageExtension(
      value.mimeType as ChatAttachmentMimeType,
    )}`;
    if (value.entryPath !== expectedEntryPath) {
      context.addIssue({
        code: "custom",
        path: ["entryPath"],
        message: "Included attachment entry path is invalid.",
      });
    }
  } else {
    if (value.sha256 !== null) {
      context.addIssue({
        code: "custom",
        path: ["sha256"],
        message: "Missing attachments must not record a SHA-256 digest.",
      });
    }
    if (value.entryPath !== null) {
      context.addIssue({
        code: "custom",
        path: ["entryPath"],
        message: "Missing attachments must not record an archive path.",
      });
    }
  }
});

export const recoveryBundleManifestSchema = z.object({
  format: z.literal(DATABASE_RECOVERY_BUNDLE_FORMAT),
  version: z.literal(DATABASE_RECOVERY_BUNDLE_VERSION),
  exportedAt: timestampSchema,
  exportEntry: z.literal("export.json"),
  exportSize: z.number().int().min(1).max(DATABASE_RECOVERY_EXPORT_MAX_BYTES),
  exportSha256: z.string().regex(SHA256_PATTERN),
  attachments: z.array(recoveryBundleAttachmentSchema)
    .max(DATABASE_RECOVERY_BUNDLE_MAX_ATTACHMENTS),
}).strict();

export type DatabaseRecoveryExport = z.infer<
  typeof databaseRecoveryExportSchema
>;
export type DatabaseRecoveryBundleExport = z.infer<
  typeof databaseRecoveryBundleExportSchema
>;
export type RecoveryBundleManifest = z.infer<
  typeof recoveryBundleManifestSchema
>;
export type RecoveryBundleAttachmentEntry = z.infer<
  typeof recoveryBundleAttachmentSchema
>;

export interface DatabaseRecoveryExportResultSummary {
  readonly includeAttachments: boolean;
  readonly attachments: number;
  readonly missingAttachments: number;
}

export interface DatabaseRecoveryImportResult {
  readonly projects: number;
  readonly conversations: number;
  readonly messages: number;
  readonly alreadyImported: boolean;
  readonly attachments?: number;
  readonly missingAttachments?: number;
}

export function serializeDatabaseRecoveryExport(
  value: DatabaseRecoveryExport,
): string {
  const validated = databaseRecoveryExportSchema.parse(value);
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > DATABASE_RECOVERY_EXPORT_MAX_BYTES) {
    throw new Error("The recovery export exceeds its safe size limit.");
  }
  return serialized;
}

export function serializeDatabaseRecoveryBundleExport(
  value: DatabaseRecoveryBundleExport,
): string {
  const validated = databaseRecoveryBundleExportSchema.parse(value);
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > DATABASE_RECOVERY_EXPORT_MAX_BYTES) {
    throw new Error("The recovery export exceeds its safe size limit.");
  }
  return serialized;
}

export function parseRecoveryBundleManifest(
  serialized: string,
): RecoveryBundleManifest {
  if (Buffer.byteLength(serialized, "utf8") > DATABASE_RECOVERY_BUNDLE_MAX_MANIFEST_BYTES) {
    throw new Error("The recovery bundle manifest exceeds its safe size limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("The recovery bundle manifest is not valid JSON.");
  }
  const result = recoveryBundleManifestSchema.safeParse(value);
  if (!result.success) {
    throw new Error("The recovery bundle manifest does not match the supported format.");
  }
  return result.data;
}

export function parseDatabaseRecoveryExport(
  serialized: string,
  options: { readonly allowBundleVersion?: boolean } = {},
): DatabaseRecoveryExport {
  if (Buffer.byteLength(serialized, "utf8") > DATABASE_RECOVERY_EXPORT_MAX_BYTES) {
    throw new Error("The recovery export exceeds its safe size limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("The recovery export is not valid JSON.");
  }
  const schema = options.allowBundleVersion
    ? supportedDatabaseRecoveryBundleOrLegacySchema
    : supportedDatabaseRecoveryExportSchema;
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error("The recovery export does not match the supported format.");
  }
  if (result.data.version === DATABASE_RECOVERY_EXPORT_VERSION) {
    return result.data;
  }
  if (
    result.data.version === DATABASE_RECOVERY_BUNDLE_VERSION
    || result.data.version === 2
  ) {
    return { ...result.data, version: DATABASE_RECOVERY_EXPORT_VERSION };
  }
  return {
    ...result.data,
    version: DATABASE_RECOVERY_EXPORT_VERSION,
    projects: result.data.projects.map((project) => ({
      ...project,
      conversations: project.conversations.map((conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message, ordinal) => ({
          ...message,
          ordinal,
        })),
      })),
    })),
  };
}

export function recoveredConversationModel(conversation: {
  providerId: ProviderId;
  model: string;
  reasoningEffort: string;
}): Pick<NewConversationOptions, "providerId" | "model" | "modelSelection" | "reasoningEffort"> {
  return conversation.model
    ? { providerId: conversation.providerId, model: conversation.model, reasoningEffort: conversation.reasoningEffort }
    : {
        providerId: conversation.providerId,
        modelSelection: providerNativeModelSelection({
          providerId: conversation.providerId,
          reasoningEffort: conversation.reasoningEffort,
        }),
      };
}
