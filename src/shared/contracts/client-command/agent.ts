import { z } from "zod";

import {
  attachmentsSchema,
  requestBase,
  turnRequestContextSchema,
} from "./common";

export const agentCommandSchemas = [
  z
    .object({
      ...requestBase,
      type: z.literal("message.send"),
      payload: z
        .object({
          conversationId: z.string().uuid(),
          content: z.string().trim().min(1).max(20_000),
          attachments: attachmentsSchema,
          activate: z.boolean().optional(),
          context: turnRequestContextSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("agent.stop"),
      payload: z.object({ conversationId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("agent.subagent.stop"),
      payload: z.object({
        conversationId: z.string().uuid(),
        traceId: z.string().uuid(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("activity.stop"),
      payload: z.object({ runId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("activity.dismiss"),
      payload: z.object({ runId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.enum(["activity.mark-seen", "activity.acknowledge"]),
      payload: z.object({ runId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("agent.approval.respond"),
      payload: z.object({
        conversationId: z.string().uuid(),
        requestId: z.string().uuid(),
        decision: z.enum(["approve", "deny", "cancel"]),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("agent.input.respond"),
      payload: z.object({
        conversationId: z.string().uuid(),
        requestId: z.string().uuid(),
        answers: z.record(
          z.string().trim().min(1).max(120),
          z.array(z.string().min(1).max(4_000)).min(1).max(20),
        ).refine((answers) => Object.keys(answers).length <= 3),
      }).strict(),
    })
    .strict(),
] as const;
