import { z } from "zod";

import {
  PROVIDER_MAINTENANCE_PROVIDER_IDS,
  providerMaintenanceProviderIdSchema,
} from "../../provider-maintenance";
import { requestBase } from "./common";

export const updatesCommandSchemas = [
  z.object({
    ...requestBase,
    type: z.literal("updates.run"),
    payload: z.object({
      providerIds: z.array(providerMaintenanceProviderIdSchema)
        .max(PROVIDER_MAINTENANCE_PROVIDER_IDS.length)
        .refine((ids) => new Set(ids).size === ids.length),
      includeApp: z.boolean(),
      continueChats: z.boolean(),
    }).strict().refine(({ providerIds, includeApp }) => includeApp || providerIds.length > 0),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("updates.finish"),
    payload: z.object({ installed: z.boolean() }).strict(),
  }).strict(),
] as const;
