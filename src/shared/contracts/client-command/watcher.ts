import { z } from "zod";

import { modelSelectionSchema } from "../../model-routing";
import {
  watcherBudgetsSchema,
  watcherDeliveryModeSchema,
  watcherDeliveryPolicySchema,
  watcherInstructionsSchema,
  watcherPresetSchema,
  watcherPrivateConnectSchema,
  watcherSharingSchema,
} from "../../watcher";
import { requestBase } from "./common";

const linkId = z.uuid();

export const watcherAttachPayloadSchema = z.strictObject({
  linkId,
  watchedConversationId: z.uuid(),
  modelSelection: modelSelectionSchema,
  preset: watcherPresetSchema,
  instructions: watcherInstructionsSchema,
  sharing: watcherSharingSchema,
  budgets: watcherBudgetsSchema,
  privateConnect: watcherPrivateConnectSchema,
  delivery: watcherDeliveryPolicySchema.optional(),
  initialReview: z.boolean(),
});

export const watcherUpdatePayloadSchema = z.strictObject({
  linkId,
  preset: watcherPresetSchema.optional(),
  instructions: watcherInstructionsSchema.optional(),
  sharing: watcherSharingSchema.optional(),
  budgets: watcherBudgetsSchema.optional(),
  privateConnect: watcherPrivateConnectSchema.optional(),
  delivery: watcherDeliveryPolicySchema.optional(),
}).refine(
  ({ linkId: _linkId, ...patch }) => Object.values(patch).some((value) => value !== undefined),
  "A watcher update must change at least one setting.",
);

export const watcherCommandSchemas = [
  z.strictObject({
    ...requestBase,
    type: z.literal("watcher.attach"),
    payload: watcherAttachPayloadSchema,
  }),
  z.strictObject({
    ...requestBase,
    type: z.literal("watcher.update"),
    payload: watcherUpdatePayloadSchema,
  }),
  z.strictObject({
    ...requestBase,
    type: z.enum(["watcher.pause", "watcher.resume", "watcher.wake", "watcher.detach"]),
    payload: z.strictObject({ linkId }),
  }),
  z.strictObject({
    ...requestBase,
    type: z.literal("watcher.feed.get"),
    payload: z.strictObject({
      linkId,
      beforeSequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    }),
  }),
  z.strictObject({
    ...requestBase,
    type: z.literal("watcher.note.deliver"),
    payload: z.strictObject({
      linkId,
      wakeId: z.uuid(),
      mode: watcherDeliveryModeSchema,
      deliveryId: z.uuid(),
    }),
  }),
  z.strictObject({
    ...requestBase,
    type: z.literal("watcher.note.dismiss"),
    payload: z.strictObject({ linkId, wakeId: z.uuid() }),
  }),
] as const;

export type WatcherAttachPayload = z.infer<typeof watcherAttachPayloadSchema>;
export type WatcherUpdatePayload = z.infer<typeof watcherUpdatePayloadSchema>;
