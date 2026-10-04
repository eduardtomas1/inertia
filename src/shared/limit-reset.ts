import { z } from "zod";

export const limitResetPlanSchema = z.strictObject({
  id: z.uuid(), conversationId: z.uuid(), failedTurnId: z.uuid(),
  resetsAt: z.iso.datetime(),
  state: z.enum(["waiting", "dispatching", "blocked", "missed", "completed", "cancelled"]),
  error: z.string().max(1000).nullable(),
});
export const limitResetResultSchema = z.strictObject({
  kind: z.literal("conversation.limit-reset"), conversationId: z.uuid(),
  offer: z.strictObject({
    failedTurnId: z.uuid(), resetsAt: z.iso.datetime(), canResume: z.boolean(),
    unavailableReason: z.string().min(1).max(300).nullable(),
  }).nullable(),
  plan: limitResetPlanSchema.nullable(),
  usageLimited: z.boolean(),
});
export type LimitResetPlan = z.infer<typeof limitResetPlanSchema>;
export type LimitResetResult = z.infer<typeof limitResetResultSchema>;
