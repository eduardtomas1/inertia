import { z } from "zod";

const nativeSkillSource = z.enum(["codex-native", "claude-native", "pi-native"]);
const agentSkillSchema = z.object({
  id: z.string(), conversationId: z.string(), name: z.string(), description: z.string(),
  shortDescription: z.string().nullable(), enabled: z.boolean(),
  scope: z.enum(["user", "repo", "system", "admin", "provider"]), source: nativeSkillSource,
});
const workflowSkillsCapabilitySchema = z.union([
  z.object({ kind: nativeSkillSource, label: z.string(), available: z.literal(true) }),
  z.object({ kind: z.literal("unavailable"), label: z.string(), available: z.literal(false), reason: z.string() }),
]);

export function agentSkill(value: unknown): boolean {
  return agentSkillSchema.safeParse(value).success;
}

export function workflowSkillsCapability(value: unknown): boolean {
  return workflowSkillsCapabilitySchema.safeParse(value).success;
}
