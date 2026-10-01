import { z } from "zod";

export const MAX_CONVERSATION_NOTE_CHARS = 20_000;
export const conversationNoteContentSchema = z.string().max(MAX_CONVERSATION_NOTE_CHARS)
  .refine((value) => !value.includes("\0"), "Notes cannot contain NUL characters.");
export const conversationNoteSchema = z.strictObject({
  conversationId: z.string().uuid(),
  content: conversationNoteContentSchema,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.string().datetime({ offset: true }).nullable(),
});
export const conversationNotesResultSchema = z.strictObject({
  kind: z.literal("conversation.notes"),
  outcome: z.enum(["loaded", "saved", "conflict"]),
  note: conversationNoteSchema,
});
export type ConversationNote = z.infer<typeof conversationNoteSchema>;
export type ConversationNotesResult = z.infer<typeof conversationNotesResultSchema>;

export const conversationNotesCommandSchemas = [
  z.strictObject({
    type: z.literal("conversation.notes.get"), requestId: z.string().uuid(),
    payload: z.strictObject({ conversationId: z.string().uuid() }),
  }),
  z.strictObject({
    type: z.literal("conversation.notes.update"), requestId: z.string().uuid(),
    payload: z.strictObject({
      conversationId: z.string().uuid(), content: conversationNoteContentSchema,
      expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
    }),
  }),
] as const;
