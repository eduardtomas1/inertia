import { z } from "zod";

const budgetSchema = z.number().int().min(0).max(1_000);

export const messageSearchIndexWorkerRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("batch"), id: z.number().int().positive(), budgetMs: budgetSchema, mergeMs: budgetSchema }),
  z.strictObject({ type: z.literal("close") }),
]);

export const messageSearchIndexWorkerResponseSchema = z.union([
  z.strictObject({
    id: z.number().int().positive(),
    progress: z.strictObject({ remaining: z.boolean(), backfillComplete: z.boolean() }),
  }),
  z.strictObject({ id: z.number().int().positive(), failed: z.literal(true) }),
]);

export type MessageSearchIndexWorkerRequest = z.infer<typeof messageSearchIndexWorkerRequestSchema>;
export type MessageSearchIndexWorkerResponse = z.infer<typeof messageSearchIndexWorkerResponseSchema>;
