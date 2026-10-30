import { z } from "zod";

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
