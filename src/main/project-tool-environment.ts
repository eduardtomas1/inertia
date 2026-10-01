/** Resolves only variables deliberately reserved for project MCP connections.
 * Values never enter the renderer, database, or the runtime's ambient environment. */
export function projectToolEnvironmentToken(reference: string, environment: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): string | null {
  if (signal?.aborted) return null;
  const variable = /^secret:project-tool-env:(INERTIA_MCP_[A-Z0-9_]{1,96})$/u.exec(reference)?.[1];
  if (!variable) return null;
  const value = environment[variable];
  return value && value.length >= 8 && value.length <= 8192 && !/[\r\n\x00]/u.test(value) ? value : null;
}
