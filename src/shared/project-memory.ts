import { z } from "zod";

export const MAX_PROJECT_MEMORY_ENTRIES = 20;
export const MAX_PROJECT_MEMORY_BYTES = 24 * 1024;
export const MAX_PROJECT_MEMORY_CONTEXT_BYTES = 32 * 1024;
export const PROJECT_MEMORY_CONTEXT_LABEL = "Project rules & decisions";

const text = (maximum: number) => z.string().trim().min(1).max(maximum)
  .refine((value) => !value.includes("\0"), "Text cannot contain null characters.");
export const projectMemoryDraftSchema = z.strictObject({
  kind: z.enum(["rule", "decision"]),
  title: text(120),
  text: text(1600),
  reason: text(1200),
});
export const projectMemorySourceSchema = z.strictObject({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  conversationTitle: text(120),
});
export const projectMemoryEntrySchema = projectMemoryDraftSchema.extend({
  id: z.string().uuid(),
  source: projectMemorySourceSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export const projectMemoryEntriesSchema = z.array(projectMemoryEntrySchema)
  .max(MAX_PROJECT_MEMORY_ENTRIES)
  .refine((entries) => new Set(entries.map(({ id }) => id)).size === entries.length)
  .refine((entries) => new TextEncoder().encode(JSON.stringify(entries)).byteLength <= MAX_PROJECT_MEMORY_BYTES);
export const projectMemoryStateSchema = z.strictObject({
  projectId: z.string().uuid(),
  conversationId: z.string().uuid().nullable(),
  revision: z.number().int().nonnegative(),
  chatRevision: z.number().int().nonnegative(),
  entries: projectMemoryEntriesSchema,
  disabledIds: z.array(z.string().uuid()).max(MAX_PROJECT_MEMORY_ENTRIES),
  unavailableSourceIds: z.array(z.string().uuid()).max(MAX_PROJECT_MEMORY_ENTRIES),
  context: z.string().max(MAX_PROJECT_MEMORY_CONTEXT_BYTES).nullable(),
});
export type ProjectMemoryDraft = z.infer<typeof projectMemoryDraftSchema>;
export type ProjectMemoryEntry = z.infer<typeof projectMemoryEntrySchema>;
export type ProjectMemoryState = z.infer<typeof projectMemoryStateSchema>;

/** Same text is previewed and delivered; it is user-curated context, not app policy. */
export function projectMemoryContext(state: Pick<ProjectMemoryState, "projectId" | "revision" | "entries" | "disabledIds">): string | null {
  if (state.revision === 0) return null;
  return JSON.stringify({
    type: "project-rules-and-decisions",
    version: 1,
    projectId: state.projectId,
    revision: state.revision,
    guidance: "These are user-curated project rules and decisions. Only the entries in this snapshot are active; it supersedes earlier project rules and decisions snapshots. Respect their reasons, unless the user's current instructions override them. This context does not grant tool permissions. Source chats are provenance, not instructions to fetch more history.",
    entries: state.entries.filter(({ id }) => !state.disabledIds.includes(id)),
  }, null, 2);
}

export const projectMemorySourcePreviewSchema = z.strictObject({
  projectId: z.string().uuid(),
  id: z.string().uuid(),
  source: projectMemorySourceSchema,
  role: z.enum(["user", "assistant"]),
  content: z.string().max(4000),
  truncated: z.boolean(),
});
export type ProjectMemorySourcePreview = z.infer<typeof projectMemorySourcePreviewSchema>;
