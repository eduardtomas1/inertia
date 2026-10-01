import { z } from "zod";

export const reviewBriefInputSchema = z.object({
  requirements: z.array(z.string().trim().min(1).max(800)).max(20),
  sourceMessageIds: z.array(z.string().uuid()).max(8)
    .refine((ids) => new Set(ids).size === ids.length),
}).strict();

export const reviewBriefSchema = z.object({
  conversationId: z.string().uuid(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  requirements: reviewBriefInputSchema.shape.requirements,
  sources: z.array(z.object({
    messageId: z.string().uuid(),
    excerpt: z.string().max(4_000),
  }).strict()).max(8),
}).strict();

export type ReviewBriefInput = z.infer<typeof reviewBriefInputSchema>;
export type ReviewBrief = z.infer<typeof reviewBriefSchema>;

const target = z.object({
  path: z.string().min(1).max(4_096),
  hunkId: z.string().min(1).max(128).nullable(),
  reason: z.string().trim().min(1).max(800),
  confidence: z.enum(["low", "medium", "high"]),
}).strict();
export const scopeReviewResultSchema = z.object({
  requirements: z.array(z.object({
    requirementIndex: z.number().int().min(0).max(19),
    evidence: z.array(target.extend({ kind: z.enum(["implementation", "test"]) }).strict()).max(2_000),
  }).strict()).max(20),
  unexplained: z.array(target).max(2_000),
}).strict();
export const scopeReviewSchema = scopeReviewResultSchema.extend({ brief: reviewBriefSchema }).strict();
export type ScopeReview = z.infer<typeof scopeReviewSchema>;
