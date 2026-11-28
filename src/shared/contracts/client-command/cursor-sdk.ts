import { z } from "zod";
import { requestBase } from "./common";

export const cursorSdkCommandSchemas = [
  z.strictObject({
    ...requestBase,
    type: z.literal("provider.cursor-sdk.models"),
  }),
  z.strictObject({
    ...requestBase,
    type: z.literal("provider.cursor-sdk.status"),
  }),
  z.strictObject({
    ...requestBase,
    type: z.literal("provider.cursor-sdk.login"),
  }),
  z.strictObject({
    ...requestBase,
    type: z.literal("provider.cursor-sdk.login.cancel"),
    payload: z.strictObject({ loginRequestId: z.uuid() }),
  }),
] as const;
