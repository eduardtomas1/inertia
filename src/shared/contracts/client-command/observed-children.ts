import { z } from "zod";

import { requestBase } from "./common";

export const OBSERVED_CHILD_READ_COMMAND = "observed-child.read";

export const observedChildReadPayloadSchema = z.object({
  conversationId: z.string().uuid(),
  turnId: z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/u).optional(),
}).strict();

export const observedChildReadCommandSchema = z.object({
  ...requestBase,
  type: z.literal(OBSERVED_CHILD_READ_COMMAND),
  payload: observedChildReadPayloadSchema,
}).strict();

export const observedChildCommandSchemas = [
  observedChildReadCommandSchema,
] as const;

export type ObservedChildReadPayload = z.infer<typeof observedChildReadPayloadSchema>;
export type ObservedChildReadCommand = z.infer<typeof observedChildReadCommandSchema>;
