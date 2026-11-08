import { z } from "zod";
import { isCursorSdkLoginUrl } from "../cursor-sdk-auth";
import { cursorSdkModelSchema, cursorSdkModelIdsUnique, MAX_CURSOR_SDK_MODELS } from "../cursor-sdk-models";

const loginEventBase = {
  type: z.literal("provider.cursor-sdk.login.updated"),
  loginRequestId: z.uuid(),
};

export const cursorSdkStatusResultSchema = z.strictObject({
  kind: z.literal("provider.cursor-sdk.status"),
  available: z.boolean(),
  hasCredential: z.boolean(),
  sdkVersion: z.literal("1.0.38"),
});

export const cursorSdkModelsResultSchema = z.strictObject({
  kind: z.literal("provider.cursor-sdk.models"),
  models: z.array(cursorSdkModelSchema.strict()).max(MAX_CURSOR_SDK_MODELS).refine(cursorSdkModelIdsUnique),
});

export const cursorSdkLoginEventSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...loginEventBase,
    status: z.enum(["starting", "cancelling", "cancelled", "expired", "failed"]),
  }),
  z.strictObject({
    ...loginEventBase,
    status: z.literal("waiting"),
    loginUrl: z.string().refine(isCursorSdkLoginUrl),
  }),
  z.strictObject({
    ...loginEventBase,
    status: z.literal("authenticated"),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
]);
