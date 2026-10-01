import { z } from "zod";
import { hasProjectToolEnvironmentTemplate } from "./project-tool-values";

export const MAX_PROJECT_TOOLS = 12;
export const projectToolProviderSchema = z.enum(["claude", "codex"]);
export type ProjectToolProvider = z.infer<typeof projectToolProviderSchema>;

export function isProjectToolUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return !hasProjectToolEnvironmentTemplate(value) && !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === "https:" || (url.protocol === "http:"
        && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  } catch { return false; }
}

export const projectToolDraftSchema = z.strictObject({
  name: z.string().trim().min(1).max(80).regex(/^[\p{L}\p{N} ._()-]+$/u),
  url: z.string().trim().max(2048).refine(isProjectToolUrl,
    "Use HTTPS or loopback HTTP, without credentials, queries, fragments or environment templates."),
  bearerTokenEnv: z.string().regex(/^INERTIA_MCP_[A-Z0-9_]{1,96}$/u).nullable(),
  providers: z.array(projectToolProviderSchema).min(1).max(2)
    .refine((items) => new Set(items).size === items.length),
});
export type ProjectToolDraft = z.infer<typeof projectToolDraftSchema>;
export const projectToolSchema = projectToolDraftSchema.extend({
  id: z.uuid(), projectId: z.uuid(), revision: z.number().int().positive(),
});
export type ProjectTool = z.infer<typeof projectToolSchema>;

export const projectToolStateSchema = z.enum([
  "configured", "available", "needs-auth", "needs-restart", "unavailable", "unsupported",
]);
export type ProjectToolState = z.infer<typeof projectToolStateSchema>;
export const PROJECT_TOOL_STATE_LABELS: Record<ProjectToolState, string> = {
  configured: "Configured", available: "Available in this chat",
  "needs-auth": "Needs authentication", "needs-restart": "Needs restart",
  unavailable: "Unavailable", unsupported: "Not enabled for this chat",
};
export const projectToolViewSchema = projectToolSchema.extend({
  state: projectToolStateSchema,
  reason: z.string().max(300),
  toolNames: z.array(z.string().regex(/^[A-Za-z0-9_.:/-]{1,128}$/u)).max(100),
  checkedAt: z.string().datetime().nullable(),
});
export const projectToolsViewSchema = z.strictObject({
  projectId: z.uuid(), conversationId: z.uuid().nullable(),
  connections: z.array(projectToolViewSchema).max(MAX_PROJECT_TOOLS),
});
export type ProjectToolsView = z.infer<typeof projectToolsViewSchema>;
export type ProjectToolView = z.infer<typeof projectToolViewSchema>;

export function projectToolServerName(id: string): string {
  return `inertia-project-${id}`;
}

export function projectToolTokenReference(variable: string): string {
  if (!/^INERTIA_MCP_[A-Z0-9_]{1,96}$/u.test(variable)) throw new Error("Invalid project tool environment variable.");
  return `secret:project-tool-env:${variable}`;
}
