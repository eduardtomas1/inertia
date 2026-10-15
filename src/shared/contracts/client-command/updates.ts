import { z } from "zod";

import {
  PROVIDER_MAINTENANCE_PROVIDER_IDS,
  providerMaintenanceProviderIdSchema,
} from "../../provider-maintenance";
import { requestBase } from "./common";

const updatesRunProviderIdsSchema = z.array(providerMaintenanceProviderIdSchema)
  .max(PROVIDER_MAINTENANCE_PROVIDER_IDS.length)
  .refine((providerIds) => new Set(providerIds).size === providerIds.length, "Duplicate provider.");

export const updatesCommandSchemas = [
  z.object({
    ...requestBase,
    type: z.literal("updates.run"),
    payload: z.object({
      providerIds: updatesRunProviderIdsSchema,
      includeApp: z.boolean(),
      continueChats: z.boolean(),
    }).strict().refine(({ providerIds, includeApp }) => includeApp || providerIds.length > 0),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("updates.finish"),
    payload: z.object({ installed: z.literal(false) }).strict(),
  }).strict(),
] as const;
