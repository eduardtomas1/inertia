import type { ProjectTool, ProjectToolState } from "../../shared/project-tools";
import { projectToolServerName } from "../../shared/project-tools";

export interface ProjectToolObservation {
  id: string;
  state: Extract<ProjectToolState, "configured" | "available" | "needs-auth" | "unavailable">;
  reason: string;
  toolNames: string[];
}
/** Process-local capability for the exact run. Never persisted or serialized. */
export interface ProjectToolRun {
  connections: readonly ProjectTool[];
  report(observation: ProjectToolObservation): void;
  setRefresh?(refresh: () => Promise<void>): void;
  resolveToken?(variable: string, signal: AbortSignal): Promise<string | null>;
}

export function safeToolNames(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string"
    && /^[A-Za-z0-9_.:/-]{1,128}$/u.test(value)))].slice(0, 100).sort();
}

export function projectToolsUnverified(run: ProjectToolRun, reason: string): void {
  for (const connection of run.connections) run.report({ id: connection.id, state: "unavailable", reason, toolNames: [] });
}

/** Only allowlisted metadata leaves the transport; never errors, headers or config. */
export function observeClaudeProjectTools(run: ProjectToolRun, statuses: unknown): void {
  if (!Array.isArray(statuses)) return projectToolsUnverified(run, "Claude returned an unsupported tool status response. Update Claude Code and retry.");
  for (const connection of run.connections) {
    const status = statuses.find((entry) => entry && typeof entry === "object"
      && entry.name === projectToolServerName(connection.id));
    const names = safeToolNames(Array.isArray(status?.tools) ? status.tools.map((tool: { name?: unknown }) => tool?.name) : []);
    const state = status?.status === "needs-auth" ? "needs-auth"
      : status?.status === "connected" && names.length ? "available" : "unavailable";
    run.report({ id: connection.id, state, toolNames: state === "available" ? names : [], reason:
      state === "available" ? "Claude confirmed these tools on this chat's current connection."
        : state === "needs-auth" ? "The server requires authentication. Check the bearer-token environment variable; OAuth sign-in is not supported here yet."
          : "Claude has not exposed tools from this server. Check its URL, availability and authentication, then retry on the next message." });
  }
}

export function observeCodexProjectTool(run: ProjectToolRun, connection: ProjectTool, response: unknown): void {
  const result = response && typeof response === "object" ? response as Record<string, unknown> : {};
  const status = Array.isArray(result.data) ? result.data.find((entry) => entry && typeof entry === "object"
    && entry.name === projectToolServerName(connection.id)) : null;
  const names = status?.tools && typeof status.tools === "object" && !Array.isArray(status.tools)
    ? safeToolNames(Object.keys(status.tools)) : [];
  // A global discovery result is not proof of the thread's MCP connection.
  const ready = status?.runtimeStatus === "connected" && !status.toolsError && !result.nextCursor;
  const state = status?.authStatus === "notLoggedIn" || status?.runtimeStatus === "authenticationRequired" ? "needs-auth" : ready && names.length ? "available" : "unavailable";
  run.report({ id: connection.id, state, toolNames: state === "available" ? names : [], reason:
    state === "available" ? "Codex confirmed these tools on this chat's current connection."
      : state === "needs-auth" ? "The server requires authentication. Check the bearer-token environment variable; OAuth sign-in is not supported here yet."
        : "Codex could not confirm tools on this chat's connection. Check the server and token, or update Codex if thread tool status is unsupported." });
}
