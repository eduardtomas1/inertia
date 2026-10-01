import { z } from "zod";
import { MAX_PROJECT_MEMORY_CONTEXT_BYTES, projectMemoryStateSchema, projectMemorySourcePreviewSchema } from "../project-memory";

const contextResultSchema = z.strictObject({
  kind: z.literal("project.memory.context"),
  projectId: z.string().uuid(), conversationId: z.string().uuid(), turnId: z.string().uuid(),
  context: z.string().max(MAX_PROJECT_MEMORY_CONTEXT_BYTES).nullable(),
});
export const projectMemoryResultValidators = {
  "project.memory.source": (value: Record<string, unknown>): boolean => projectMemorySourcePreviewSchema.safeParse(value.preview).success,
  "project.memory": (value: Record<string, unknown>): boolean => projectMemoryStateSchema.safeParse(value.state).success,
  "project.memory.context": (value: Record<string, unknown>): boolean => contextResultSchema.safeParse(value).success,
};
