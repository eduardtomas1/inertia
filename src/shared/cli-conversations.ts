import { z } from "zod";

export const CLI_IMPORT_MAX_MESSAGES = 200;
export const CLI_IMPORT_MAX_TEXT = 256 * 1024;
export { CLI_TRANSCRIPT_READ_DEADLINE_MS } from "./runtime-command-timeouts";
export const cliProviderSchema = z.enum(["codex", "claude"]);
export type CliProvider = z.infer<typeof cliProviderSchema>;
export const cliProviderLabel = (provider: CliProvider): string => provider === "codex" ? "Codex" : "Claude Code";
export const cliMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(32 * 1024),
  createdAt: z.string().datetime(),
}).strict();
export type CliMessage = z.infer<typeof cliMessageSchema>;
export const CLI_OPENING_MAX_TEXT = 400;
export const cliConversationOpeningSchema = z.object({
  user: z.string().max(CLI_OPENING_MAX_TEXT),
  assistant: z.string().max(CLI_OPENING_MAX_TEXT).nullable(),
}).strict();
export type CliConversationOpening = z.infer<typeof cliConversationOpeningSchema>;
export const cliConversationOmissionSchema = z.object({
  omitted: z.number().int().positive(),
  total: z.number().int().positive(),
}).strict().refine(({ omitted, total }) => omitted < total);
export type CliConversationOmission = z.infer<typeof cliConversationOmissionSchema>;
export const cliOmissionText = ({ omitted, total }: CliConversationOmission, imported: boolean): string =>
  `Earlier messages ${imported ? "were" : "will"} not ${imported ? "" : "be "}imported: ${omitted.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`;
export const cliConversationCandidateSchema = z.object({
  id: z.string().uuid(),
  providerId: cliProviderSchema,
  title: z.string().max(160),
  updatedAt: z.string().datetime(),
  importedConversationId: z.string().uuid().nullable(),
  importedOmission: cliConversationOmissionSchema.nullable(),
  opening: cliConversationOpeningSchema,
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
