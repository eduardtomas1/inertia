import { z } from "zod";

import { providerIdSchema, requestBase } from "./common";

export const updatesRunProviderIdsSchema = z.array(providerIdSchema)
  .max(providerIdSchema.options.length)
  .refine((providerIds) => new Set(providerIds).size === providerIds.length, "Duplicate provider.");

export const updatesCommandSchemas = [
  z.object({
    ...requestBase,
    type: z.literal("updates.run"),
    payload: z.object({
      providerIds: updatesRunProviderIdsSchema,
      includeApp: z.boolean(),
      continueChats: z.boolean(),
    }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("updates.finish"),
    payload: z.object({ installed: z.boolean() }).strict(),
  }).strict(),
] as const;

export const updatesRunResultSchema = z.strictObject({
  kind: z.literal("updates.run"),
  providers: z.array(z.strictObject({
    providerId: providerIdSchema,
    outcome: z.enum(["updated", "unchanged", "failed", "skipped"]),
    beforeVersion: z.string().nullable(),
    afterVersion: z.string().nullable(),
    error: z.string().nullable(),
  })).max(providerIdSchema.options.length),
  interruptedConversationIds: z.array(z.string()),
  readyForAppInstall: z.boolean(),
});

export type UpdatesRunResult = z.infer<typeof updatesRunResultSchema>;
