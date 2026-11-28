import { z } from "zod";

import {
  attachmentSchema,
  attachmentsSchema,
  providerIdSchema,
  requestBase,
  turnRequestContextSchema,
} from "./common";
import { attachmentLimitError, MAX_ATTACHMENT_COUNT } from "../../attachments";
import { modelSelectionSchema } from "../../model-routing";
import { AGENT_GOAL_STATUSES } from "../agent-workflows";
import { queuedAccessSchema } from "../../queued-messages";

const optionalEditAttachmentsSchema = z.array(attachmentSchema)
  .max(MAX_ATTACHMENT_COUNT)
  .superRefine((attachments, context) => {
    const message = attachmentLimitError(attachments);
    if (message) context.addIssue({ code: "custom", message });
  })
  .optional();

/** Phase 5 in-place edit payload (also accepts legacy `{ conversationId, id }` until Wave 2 migrates the runtime). */
export const messageQueueEditInPlacePayloadSchema = z.strictObject({
  conversationId: z.uuid(),
  id: z.uuid(),
  expectedRevision: z.number().int().min(0),
  content: z.string().trim().min(1).max(20_000),
  attachments: optionalEditAttachmentsSchema,
  modelSelection: modelSelectionSchema.nullable().optional(),
});

export const messageQueueEditPayloadSchema = z.union([
  z.strictObject({ conversationId: z.uuid(), id: z.uuid() }),
  messageQueueEditInPlacePayloadSchema,
]);

/** Phase 5 queue commands ready for Wave 2 to wire into `agentCommandSchemas`, command-router, and runtimeCommandPolicy. */
export const messageQueueResumeCommandSchema = z.strictObject({
  ...requestBase,
  type: z.literal("message.queue.resume"),
  payload: z.strictObject({ conversationId: z.uuid() }),
});

export const messageQueueReorderCommandSchema = z.strictObject({
  ...requestBase,
  type: z.literal("message.queue.reorder"),
  payload: z.strictObject({
    conversationId: z.uuid(),
    id: z.uuid(),
    beforeId: z.uuid().nullable(),
  }),
});

export const phase5QueueCommandSchemas = [
  messageQueueResumeCommandSchema,
  messageQueueReorderCommandSchema,
] as const;

export const MAX_AGENT_INPUT_QUESTIONS = 4;

const agentApprovalRequestIdSchema = z.union([
  z.string().uuid(),
  z.string().regex(/^inertia-host-tool:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
]);

export const messageSendPayloadSchema = z
  .object({
    conversationId: z.string().uuid(),
    content: z.string().trim().min(1).max(20_000),
    attachments: attachmentsSchema,
    activate: z.boolean().optional(),
    context: turnRequestContextSchema.optional(),
  })
  .strict();

export const agentCommandSchemas = [
  z.strictObject({ ...requestBase, type: z.literal("conversation.limit-reset.get"), payload: z.strictObject({ conversationId: z.uuid() }) }),
  z.strictObject({ ...requestBase, type: z.literal("conversation.limit-reset.schedule"), payload: z.strictObject({ conversationId: z.uuid(), id: z.uuid(), failedTurnId: z.uuid(), resetsAt: z.iso.datetime() }) }),
  z.strictObject({ ...requestBase, type: z.literal("conversation.limit-reset.cancel"), payload: z.strictObject({ conversationId: z.uuid(), id: z.uuid() }) }),
  z.strictObject({ ...requestBase, type: z.literal("conversation.limit-reset.resume"), payload: z.strictObject({ conversationId: z.uuid(), id: z.uuid() }) }),
  z.strictObject({ ...requestBase, type: z.literal("conversation.limit-reset.snooze"), payload: z.strictObject({ conversationId: z.uuid(), failedTurnId: z.uuid(), resetsAt: z.iso.datetime() }) }),
  z.strictObject({ ...requestBase, type: z.literal("message.queue.get"), payload: z.strictObject({ conversationId: z.uuid(), id: z.uuid().optional() }) }),
  z.strictObject({ ...requestBase, type: z.literal("message.queue.enqueue"), payload: z.strictObject({
    conversationId: z.uuid(), id: z.uuid(), content: z.string().trim().min(1).max(20_000), attachments: attachmentsSchema,
  }) }),
  z.strictObject({ ...requestBase, type: z.literal("message.queue.remove"), payload: z.strictObject({ conversationId: z.uuid(), id: z.uuid() }) }),
  z.strictObject({ ...requestBase, type: z.literal("message.queue.send"), payload: z.strictObject({ conversationId: z.uuid(), id: z.uuid() }) }),
  z.strictObject({ ...requestBase, type: z.literal("message.queue.edit"), payload: messageQueueEditPayloadSchema }),
  z.strictObject({ ...requestBase, type: z.literal("message.queue.reconfirm"), payload: z.strictObject({
    conversationId: z.uuid(), id: z.uuid(), confirmed: queuedAccessSchema.optional(),
  }) }),
  z.strictObject({ ...requestBase, type: z.literal("message.queue.stop-and-send"), payload: z.strictObject({
    conversationId: z.uuid(), id: z.uuid(), turnId: z.uuid(), content: z.string().trim().min(1).max(20_000), attachments: attachmentsSchema,
  }) }),
  ...phase5QueueCommandSchemas,
  z
    .object({
      ...requestBase,
      type: z.literal("message.send"),
      payload: messageSendPayloadSchema,
    })
    .strict(),
  z.strictObject({
    ...requestBase,
    type: z.literal("conversation.compact-and-send"),
    payload: z.strictObject({
      ...messageSendPayloadSchema.shape,
      reason: z.literal("on-return"),
    }),
  }),
  z.strictObject({
    ...requestBase,
    type: z.literal("conversation.compact"),
    payload: z.strictObject({
      conversationId: z.uuid(),
      instruction: z.string().trim().min(1).max(4_000).optional(),
    }),
  }),
  z
    .object({
      ...requestBase,
      type: z.literal("agent.workflow.load"),
      payload: z.object({
        conversationId: z.string().uuid(),
        refresh: z.boolean().optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("agent.workflow.saved.load"),
      payload: z.object({
        conversationId: z.string().uuid(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("agent.goal.set"),
      payload: z.object({
        conversationId: z.string().uuid(),
        source: z.enum(["codex-native", "inertia-local"]),
        objective: z.string().trim().min(1).max(4_000).optional(),
        status: z.enum(AGENT_GOAL_STATUSES),
        tokenBudget: z.number().int().positive().max(1_000_000_000).nullable().optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("agent.goal.clear"),
      payload: z.object({
        conversationId: z.string().uuid(),
        source: z.enum(["codex-native", "inertia-local"]),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("agent.skills.list"),
      payload: z.object({
        conversationId: z.string().uuid(),
        forceReload: z.boolean().optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("agent.skills.preview"),
      payload: z.object({
        draftConversationId: z.string().uuid(),
        projectId: z.string().uuid(),
        harnessId: z.enum(["codex-app-server", "claude-agent-sdk"]),
        forceReload: z.boolean().optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("agent.commands.list"),
      payload: z.union([
        z.strictObject({ conversationId: z.uuid() }),
        z.strictObject({
          draftConversationId: z.uuid(),
          projectId: z.uuid(),
          providerId: providerIdSchema,
        }),
      ]),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("agent.stop"),
      payload: z.object({
        conversationId: z.string().uuid(),
        expectedTurnId: z.string().uuid().optional(),
      }).strict(),
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
      type: z.literal("agent.subagent.background"),
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
        requestId: agentApprovalRequestIdSchema,
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
        ).refine((answers) => Object.keys(answers).length <= MAX_AGENT_INPUT_QUESTIONS),
      }).strict(),
    })
    .strict(),
] as const;
