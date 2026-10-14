import { z } from "zod";

import { providerMaintenanceProviderIdSchema } from "./provider-maintenance";

export const UPDATE_PROVIDER_OUTCOMES = ["updated", "unchanged", "failed", "skipped"] as const;

export const updatesRunResultSchema = z.strictObject({
  kind: z.literal("updates.run"),
  providers: z.array(z.strictObject({
    providerId: providerMaintenanceProviderIdSchema,
    outcome: z.enum(UPDATE_PROVIDER_OUTCOMES),
    beforeVersion: z.string().nullable(),
    afterVersion: z.string().nullable(),
    error: z.string().nullable(),
  })),
  interruptedConversationIds: z.array(z.string().min(1)),
  readyForAppInstall: z.boolean(),
  appInstallBlocker: z.string().min(1).nullable(),
});

export type UpdatesRunResult = z.infer<typeof updatesRunResultSchema>;
export type UpdateProviderResult = UpdatesRunResult["providers"][number];
