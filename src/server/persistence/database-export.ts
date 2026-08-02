import { isAbsolute } from "node:path";

import { z } from "zod";

export const DATABASE_RECOVERY_EXPORT_FORMAT = "inertia-recovery-export";
export const DATABASE_RECOVERY_EXPORT_VERSION = 1;
export const DATABASE_RECOVERY_EXPORT_MAX_BYTES = 256 * 1024 * 1024;
export const DATABASE_RECOVERY_EXPORT_MAX_PROJECTS = 10_000;
export const DATABASE_RECOVERY_EXPORT_MAX_CONVERSATIONS = 100_000;
export const DATABASE_RECOVERY_EXPORT_MAX_MESSAGES = 250_000;

const timestampSchema = z.string().datetime({ offset: true });

const recoveryMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().max(64 * 1_024 * 1_024),
  createdAt: timestampSchema,
}).strict();

const recoveryConversationSchema = z.object({
  title: z.string().max(4_000),
  providerId: z.enum(["codex", "claude", "cursor", "opencode"]),
  model: z.string().max(300),
  reasoningEffort: z.string().max(80),
  interactionMode: z.enum(["build", "plan"]),
  accessMode: z.enum(["supervised", "auto-edit", "full"]),
  messages: z.array(recoveryMessageSchema).max(DATABASE_RECOVERY_EXPORT_MAX_MESSAGES),
}).strict();

const recoveryProjectSchema = z.object({
  name: z.string().max(1_000),
  path: z.string().min(1).max(4_096).refine(
    (value) => !value.includes("\0") && isAbsolute(value),
    "Expected a local absolute project path.",
  ),
  conversations: z.array(recoveryConversationSchema)
    .max(DATABASE_RECOVERY_EXPORT_MAX_CONVERSATIONS),
}).strict();

export const databaseRecoveryExportSchema = z.object({
  format: z.literal(DATABASE_RECOVERY_EXPORT_FORMAT),
  version: z.literal(DATABASE_RECOVERY_EXPORT_VERSION),
  exportedAt: timestampSchema,
  projects: z.array(recoveryProjectSchema)
    .max(DATABASE_RECOVERY_EXPORT_MAX_PROJECTS),
}).strict().superRefine((value, context) => {
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
});

export type DatabaseRecoveryExport = z.infer<
  typeof databaseRecoveryExportSchema
>;

export interface DatabaseRecoveryImportResult {
  readonly projects: number;
  readonly conversations: number;
  readonly messages: number;
  readonly alreadyImported: boolean;
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

export function parseDatabaseRecoveryExport(
  serialized: string,
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
  const result = databaseRecoveryExportSchema.safeParse(value);
  if (!result.success) {
    throw new Error("The recovery export does not match the supported format.");
  }
  return result.data;
}
