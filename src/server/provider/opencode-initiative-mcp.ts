import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import type { ProviderMcpServerInput } from "./contracts";
import {
  inheritedLaunchCredentialNames,
  openCodeInitiativeMcpConfig,
  withoutInheritedCredentials,
  withoutNativeNameClashes,
} from "./initiative-mcp-config";
import { withOpenCodeRequestDeadline } from "./opencode-owned-server";

const DISCONNECT_TIMEOUT_MS = 2_000;

type Initializer = <T>(label: string, operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;

export interface OpenCodeInitiativeMcp {
  /**
   * Adds the servers. `environment` is the owned server's own environment,
   * which stdio servers it starts would otherwise inherit.
   */
  install(client: OpencodeClient, initialize: Initializer, environment: NodeJS.ProcessEnv): Promise<void>;
  disconnect(client: OpencodeClient | undefined): Promise<void>;
}

/**
 * The initiative's MCP servers on an owned OpenCode server: added after
 * Inertia's own with `client.mcp.add`, and disconnected when the run ends
 * (the owned `serve --pure` server, with every stdio server it started, stops
 * right after). A name the OpenCode server already reports, the user's own
 * server, is left out rather than replaced; when OpenCode cannot report its
 * servers none is added, as on Codex; a server that fails to connect is
 * reported and the turn continues without it. Resolved secrets are redacted
 * by the run coordinator; `redact` covers the run's launch credentials.
 */
export function createOpenCodeInitiativeMcp(options: {
  servers: readonly ProviderMcpServerInput[] | undefined;
  cwd: string;
  report(label: string, detail: string): void;
  redact(value: string): string;
  stopping(): boolean;
}): OpenCodeInitiativeMcp {
  const installed: string[] = [];
  const failure = (error: unknown): string => options.redact(
    error instanceof Error && error.message ? error.message : "OpenCode did not add the server.",
  );
  return {
    install: async (client, initialize, environment) => {
      if (!options.servers?.length) return;
      let existing: Set<string>;
      try {
        const status = await initialize(
          "MCP server status",
          async (signal) => await client.mcp.status({ directory: options.cwd }, { signal, throwOnError: true }),
        );
        existing = new Set(Object.keys(status.data ?? {}));
      } catch (error) {
        if (options.stopping()) throw error;
        options.report(
          "Initiative MCP servers not added",
          "OpenCode did not report its own MCP servers, so Inertia added none of the initiative's to avoid changing one of them.",
        );
        return;
      }
      const { value: servers, skipped } = withoutNativeNameClashes("OpenCode", options.servers, existing);
      for (const server of skipped) options.report(`Initiative MCP server not added · ${server.name}`, server.reason);
      for (const server of withoutInheritedCredentials(servers, inheritedLaunchCredentialNames(environment))) {
        let connected: string | undefined;
        try {
          const response = await initialize(
            `MCP server ${server.name}`,
            async (signal) => await client.mcp.add({
              directory: options.cwd,
              name: server.name,
              config: openCodeInitiativeMcpConfig(server),
            }, { signal, throwOnError: true }),
          );
          installed.push(server.name);
          connected = response.data?.[server.name]?.status;
        } catch (error) {
          if (options.stopping()) throw error;
          // A failed add may still have registered the server.
          installed.push(server.name);
          options.report(`Initiative MCP server failed to connect · ${server.name}`, failure(error));
          continue;
        }
        if (connected !== "connected") {
          options.report(
            `Initiative MCP server failed to connect · ${server.name}`,
            `OpenCode reported the server as ${connected ?? "unknown"}.`,
          );
        }
      }
    },
    disconnect: async (client) => {
      if (!client) return;
      const names = installed.splice(0);
      await Promise.allSettled(names.map((name) => withOpenCodeRequestDeadline(
        DISCONNECT_TIMEOUT_MS,
        "Timed out disconnecting an initiative MCP server.",
        async (signal) => await client.mcp.disconnect({ directory: options.cwd, name }, { signal, throwOnError: true }),
      )));
    },
  };
}
