import { isAbsolute } from "node:path";

import { z } from "zod";

import {
  DATABASE_RECOVERY_EXPORT_MAX_CONVERSATIONS,
  DATABASE_RECOVERY_EXPORT_MAX_MESSAGES,
  DATABASE_RECOVERY_EXPORT_MAX_PROJECTS,
} from "./database-export";

const operationId = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
);
const path = z.string().min(1).max(4_096).refine(
  (value) => isAbsolute(value) && !value.includes("\0"),
);
const fault = z.object({
  phase: z.enum(["after-staging-publish", "during-message-import"]),
  markerPath: path,
  stallMs: z.number().int().min(0).max(300_000),
}).strict();

const request = z.object({
  type: z.literal("recovery-import.start"),
  version: z.literal(1),
  operationId,
  databasePath: path,
  defaultWorkspacePath: path,
  recoveryPath: path,
  targetDirectory: path,
  fault: fault.optional(),
}).strict();

const receipt = z.object({
  projects: z.number().int().min(0).max(DATABASE_RECOVERY_EXPORT_MAX_PROJECTS),
  conversations: z.number().int().min(0).max(DATABASE_RECOVERY_EXPORT_MAX_CONVERSATIONS),
  messages: z.number().int().min(0).max(DATABASE_RECOVERY_EXPORT_MAX_MESSAGES),
  alreadyImported: z.boolean(),
}).strict();
const result = z.discriminatedUnion("ok", [
  z.object({
    type: z.literal("recovery-import.result"),
    version: z.literal(1),
    operationId,
    ok: z.literal(true),
    result: receipt,
  }).strict(),
  z.object({
    type: z.literal("recovery-import.result"),
    version: z.literal(1),
    operationId,
    ok: z.literal(false),
    code: z.literal("import-failed"),
  }).strict(),
]);

export type RecoveryImportWorkerRequest = z.infer<typeof request>;
export type RecoveryImportWorkerFault = z.infer<typeof fault>;
export type RecoveryImportWorkerEvent = z.infer<typeof result>;

export function parseRecoveryImportWorkerRequest(value: unknown): RecoveryImportWorkerRequest | null {
  const parsed = request.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseRecoveryImportWorkerEvent(value: unknown): RecoveryImportWorkerEvent | null {
  const parsed = result.safeParse(value);
  return parsed.success ? parsed.data : null;
}
