import type { McpServerConfig, Query } from "@anthropic-ai/claude-agent-sdk";
import { projectToolServerName } from "../../shared/project-tools";
import { isProjectToolBearerToken } from "../../shared/project-tool-values";
import { observeClaudeProjectTools, projectToolsUnverified, type ProjectToolRun } from "./project-tools";
import { CLAUDE_ISOLATED_SKILL_SETTINGS } from "./claude-skill-plugin";

export async function prepareProjectToolLaunch(run: ProjectToolRun | undefined, environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<{ environment: NodeJS.ProcessEnv; projectTools?: ProjectToolRun }> {
  const nextEnvironment = { ...environment };
  if (!run) return { environment: nextEnvironment };
  const connections = (await Promise.all(run.connections.map(async (connection) => {
    if (!connection.bearerTokenEnv) return [connection];
    let token: string | null = null;
    try { token = await run.resolveToken?.(connection.bearerTokenEnv, signal) ?? null; } catch { /* Broker failures never expose raw errors. */ }
    if (signal.aborted) return [];
    if (!isProjectToolBearerToken(token)) {
      run.report({ id: connection.id, state: "needs-auth", toolNames: [],
        reason: "The bearer-token environment variable is missing or invalid. Set it in Inertia's launch environment, restart Inertia, and send another message." });
      return [];
    }
    // A dedicated key makes exact-value credential redaction work regardless
    // of the user's variable name. Neither the value nor header leaves runtime.
    const key = `INERTIA_TOOL_${connection.id.replaceAll("-", "_")}_TOKEN`;
    nextEnvironment[key] = token;
    return [{ ...connection, bearerTokenEnv: key }];
  }))).flat();
  return { environment: nextEnvironment, projectTools: { ...run, connections } };
}

export function claudeProjectToolOptions(run: ProjectToolRun | undefined) {
  const servers: Record<string, McpServerConfig> = {};
  for (const connection of run?.connections ?? []) {
    servers[projectToolServerName(connection.id)] = {
      type: "http", url: connection.url, alwaysLoad: true, timeout: 60_000,
      // The SDK serializes MCP configuration into argv. Let Claude expand the
      // reference inside its process so token values never enter those arguments.
      ...(connection.bearerTokenEnv ? { headers: { Authorization: "Bearer ${" + connection.bearerTokenEnv + "}" } } : {}),
    };
  }
  return {
    servers,
    settings: { ...CLAUDE_ISOLATED_SKILL_SETTINGS,
      allowedMcpServers: Object.keys(servers).map((serverName) => ({ serverName })),
    },
  };
}

export async function checkClaudeProjectTools(query: Query, run: ProjectToolRun | undefined, signal: AbortSignal): Promise<void> {
  if (!run?.connections.length || signal.aborted) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => reject(new Error("timeout")), 5000);
      timer.unref();
    });
    const statuses = await Promise.race([query.mcpServerStatus(), deadline]);
    if (!signal.aborted) observeClaudeProjectTools(run, statuses);
  } catch {
    if (!signal.aborted) projectToolsUnverified(run, "Claude could not report this chat's tool status. Update Claude Code or retry on the next message.");
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

export function codexProjectToolConfig(run: ProjectToolRun | undefined): Record<string, unknown> {
  return Object.fromEntries((run?.connections ?? []).map((connection) => [
    `mcp_servers.${projectToolServerName(connection.id)}`, {
      url: connection.url, enabled: true, startup_timeout_sec: 10, tool_timeout_sec: 60,
      ...(connection.bearerTokenEnv ? { bearer_token_env_var: connection.bearerTokenEnv } : {}),
    },
  ]));
}

export async function startClaudeProjectToolStatus(query: Query, run: ProjectToolRun | undefined, signal: AbortSignal): Promise<void> {
  const refresh = () => checkClaudeProjectTools(query, run, signal);
  run?.setRefresh?.(refresh);
  await refresh();
}
