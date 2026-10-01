import { z } from "zod";

export const CLI_IMPORT_MAX_MESSAGES = 200;
export const CLI_IMPORT_MAX_TEXT = 256 * 1024;
export const cliProviderSchema = z.enum(["codex", "claude"]);
export type CliProvider = z.infer<typeof cliProviderSchema>;
export const cliMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(32 * 1024),
  createdAt: z.string().datetime(),
}).strict();
export type CliMessage = z.infer<typeof cliMessageSchema>;
export const cliConversationCandidateSchema = z.object({
  id: z.string().uuid(),
  providerId: cliProviderSchema,
  title: z.string().max(160),
  updatedAt: z.string().datetime(),
  importedConversationId: z.string().uuid().nullable(),
}).strict();
export type CliConversationCandidate = z.infer<typeof cliConversationCandidateSchema>;
export const cliConversationScanSchema = z.object({
  candidates: z.array(cliConversationCandidateSchema).max(100),
  limited: z.boolean(),
  skipped: z.number().int().nonnegative(),
}).strict();
export type CliConversationScan = z.infer<typeof cliConversationScanSchema>;
export const cliConversationPreviewSchema = z.object({
  candidate: cliConversationCandidateSchema,
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
  messages: z.array(cliMessageSchema).max(CLI_IMPORT_MAX_MESSAGES),
  omittedMessages: z.number().int().nonnegative(),
}).strict();
export type CliConversationPreview = z.infer<typeof cliConversationPreviewSchema>;
