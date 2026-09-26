import { z } from "zod";

export const queuedMessageSchema = z.strictObject({
  id: z.uuid(), conversationId: z.uuid(), content: z.string().min(1).max(20_000),
  createdAt: z.string().datetime(),
  status: z.enum(["queued", "paused", "dispatching", "uncertain", "rejected"]),
  afterTurnId: z.string().nullable(), lastError: z.string().nullable(),
});
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;
export interface MessageQueueResult {
  kind: "message.queue";
  conversationId: string;
  items: QueuedMessage[];
}

const owner = { conversationId: z.uuid() };
const entry = { ...owner, id: z.uuid() };
export const messageQueuePayloadSchema = z.discriminatedUnion("action", [
  z.strictObject({ ...owner, action: z.literal("list") }),
  z.strictObject({ ...entry, action: z.literal("enqueue"), content: z.string().trim().min(1).max(20_000), afterTurnId: z.string().min(1).max(256).nullable() }),
  z.strictObject({ ...entry, action: z.literal("remove") }),
  z.strictObject({ ...entry, action: z.literal("send") }),
  z.strictObject({ ...entry, action: z.literal("pause"), paused: z.boolean() }),
  z.strictObject({ ...entry, action: z.literal("move"), direction: z.enum(["up", "down"]) }),
]);
