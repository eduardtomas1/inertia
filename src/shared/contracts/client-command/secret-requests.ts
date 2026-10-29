import { z } from "zod";

import {
  SECRET_REQUEST_MAX_ACTIVE,
  SECRET_REQUEST_STORAGES,
  isSecretRequestTitle,
} from "../../agent-secrets";
import { requestBase } from "./common";

export const secretRequestCommandSchemas = [
  z.object({
    ...requestBase,
    type: z.literal("secret-request.decline"),
    payload: z.object({
      conversationId: z.string().uuid(),
      requestId: z.string().uuid(),
    }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("secret-request.revoke"),
    payload: z.object({
      requestId: z.string().uuid(),
    }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("secret-request.list"),
    payload: z.object({}).strict(),
  }).strict(),
] as const;

const timestampSchema = z.string().datetime({ offset: true });

export const secretRequestListEntrySchema = z.strictObject({
  requestId: z.string().uuid(),
  conversationId: z.string().uuid(),
  conversationTitle: z.string().max(1_000),
  title: z.string().refine(isSecretRequestTitle),
  answeredAt: timestampSchema,
  expiresAt: timestampSchema,
  storage: z.enum(SECRET_REQUEST_STORAGES),
});

export const secretRequestDeclineResultSchema = z.strictObject({
  kind: z.literal("secret-request.decline"),
  status: z.literal("declined"),
});

export const secretRequestRevokeResultSchema = z.strictObject({
  kind: z.literal("secret-request.revoke"),
  status: z.literal("revoked"),
});

export const secretRequestListResultSchema = z.strictObject({
  kind: z.literal("secret-request.list"),
  secrets: z.array(secretRequestListEntrySchema).max(SECRET_REQUEST_MAX_ACTIVE)
    .refine(
      (entries) => new Set(entries.map(({ requestId }) => requestId)).size === entries.length,
      "Secret requests cannot repeat.",
    ),
});

export type SecretRequestListEntry = z.infer<typeof secretRequestListEntrySchema>;
export type SecretRequestDeclineResult = z.infer<typeof secretRequestDeclineResultSchema>;
export type SecretRequestRevokeResult = z.infer<typeof secretRequestRevokeResultSchema>;
export type SecretRequestListResult = z.infer<typeof secretRequestListResultSchema>;
export type SecretRequestCommandResult =
  | SecretRequestDeclineResult
  | SecretRequestRevokeResult
  | SecretRequestListResult;

export const secretRequestResultValidators = {
  "secret-request.decline": (value: unknown) => secretRequestDeclineResultSchema.safeParse(value).success,
  "secret-request.revoke": (value: unknown) => secretRequestRevokeResultSchema.safeParse(value).success,
  "secret-request.list": (value: unknown) => secretRequestListResultSchema.safeParse(value).success,
} as const;
