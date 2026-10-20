import type { McpServer } from "@agentclientprotocol/sdk";
import type { McpHttpServerConfig, McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { McpLocalConfig, McpRemoteConfig } from "@opencode-ai/sdk/v2";

import { INITIATIVE_MCP_INERTIA_CREDENTIAL_ENV_NAMES } from "../../shared/initiative-mcp";
import { launchCredentialNames } from "./activity-detail";
import type { ProviderMcpNameValue, ProviderMcpServerInput } from "./contracts";

/*
 * Pure translations of resolved initiative MCP servers into each provider's
 * native configuration. Inertia only adds the initiative's servers: it never
 * replaces, disables or edits a server the user configured in the provider.
 * Where a provider can report its own servers, a same-named initiative server
 * is left out instead of being merged over the user's.
 */

const OPENCODE_MCP_TIMEOUT_MS = 30_000;

function record(entries: readonly ProviderMcpNameValue[]): Record<string, string> {
  return Object.fromEntries(entries.map(({ name, value }) => [name, value]));
}

export interface InitiativeMcpTranslation<T> {
  value: T;
  /** Initiative servers left out, with a reason that never contains a value. */
  skipped: { name: string; reason: string }[];
}

/**
 * Leaves out initiative servers whose names the provider already reports for
 * the user's own servers (Codex `config/read`, OpenCode `mcp.status`), so a
 * user's server is never merged with or replaced by an initiative's.
 */
export function withoutNativeNameClashes(
  provider: string,
  servers: readonly ProviderMcpServerInput[],
  nativeServerNames: ReadonlySet<string>,
): InitiativeMcpTranslation<ProviderMcpServerInput[]> {
  const value: ProviderMcpServerInput[] = [];
  const skipped: InitiativeMcpTranslation<unknown>["skipped"] = [];
  for (const server of servers) {
    if (nativeServerNames.has(server.name)) {
      skipped.push({
        name: server.name,
        reason: `${provider} already has an MCP server named “${server.name}”, which Inertia leaves as it is. Rename the initiative's server to use both.`,
      });
    } else {
      value.push(server);
    }
  }
  return { value, skipped };
}

/**
 * The variables a provider's stdio server would inherit from the provider's
 * own environment that carry Inertia's launch credentials: the provider
 * sign-in and backend key names Inertia sets, and every credential-shaped
 * variable the launch environment holds (the names exact launch-credential
 * redaction uses).
 */
export function inheritedLaunchCredentialNames(environment: NodeJS.ProcessEnv): string[] {
  return [...new Set([...INITIATIVE_MCP_INERTIA_CREDENTIAL_ENV_NAMES, ...launchCredentialNames(environment)])].sort();
}

/**
 * Gives each stdio server an empty value for every inherited launch
 * credential, so a server the provider starts never receives Inertia's
 * credentials. A variable the server sets itself keeps its value (names are
 * compared without case, as Windows does).
 */
export function withoutInheritedCredentials(
  servers: readonly ProviderMcpServerInput[],
  credentialNames: readonly string[],
): ProviderMcpServerInput[] {
  return servers.map((server) => {
    if (server.transport !== "stdio") return server;
    const own = new Set(server.env.map(({ name }) => name.toUpperCase()));
    const blanks = credentialNames
      .filter((name) => !own.has(name.toUpperCase()))
      .map((name) => ({ name, value: "" }));
    return blanks.length > 0 ? { ...server, env: [...blanks, ...server.env] } : server;
  });
}

/**
 * Codex `thread/start` and `thread/resume` config overrides: one dotted
 * `mcp_servers.<name>` key per server, so Codex merges exactly that entry into
 * its session-flags layer and leaves every other key (and the user's own
 * servers) untouched. Field names follow Codex's `RawMcpServerConfig`:
 * `url` and `http_headers` for streamable HTTP, `command`, `args` and `env`
 * for stdio. A name the user's Codex configuration already uses is skipped,
 * because Codex would deep-merge the two entries.
 */
export function codexInitiativeMcpConfig(
  servers: readonly ProviderMcpServerInput[],
  nativeServerNames: ReadonlySet<string>,
): InitiativeMcpTranslation<Record<string, Record<string, unknown>>> {
  const value: Record<string, Record<string, unknown>> = {};
  const { value: kept, skipped } = withoutNativeNameClashes("Codex", servers, nativeServerNames);
  for (const server of kept) {
    value[`mcp_servers.${server.name}`] = server.transport === "http"
      ? {
          url: server.url,
          ...(server.headers.length > 0 ? { http_headers: record(server.headers) } : {}),
        }
      : {
          command: server.command,
          args: [...server.args],
          ...(server.env.length > 0 ? { env: record(server.env) } : {}),
        };
  }
  return { value, skipped };
}

/** The server names in a Codex `config/read` result; null when it has none readable. */
export function codexConfiguredMcpServerNames(config: unknown): Set<string> | null {
  if (typeof config !== "object" || config === null) return null;
  const effective = (config as { config?: unknown }).config;
  if (typeof effective !== "object" || effective === null) return null;
  const servers = (effective as { mcp_servers?: unknown }).mcp_servers;
  if (servers === undefined || servers === null) return new Set();
  if (typeof servers !== "object" || Array.isArray(servers)) return null;
  return new Set(Object.keys(servers));
}

/**
 * Claude Agent SDK servers. They are attached with `setMcpServers`, which
 * travels over the SDK's control channel, rather than the `mcpServers` query
 * option, which the SDK writes to the Claude Code command line where any
 * local process could read header and environment values.
 */
export function claudeInitiativeMcpServers(
  servers: readonly ProviderMcpServerInput[],
): Record<string, McpHttpServerConfig | McpStdioServerConfig> {
  return Object.fromEntries(servers.map((server) => [
    server.name,
    server.transport === "http"
      ? { type: "http" as const, url: server.url, headers: record(server.headers) }
      : { type: "stdio" as const, command: server.command, args: [...server.args], env: record(server.env) },
  ]));
}

/** Claude Code's managed allowlist entries for exactly these server names. */
export function claudeAllowedInitiativeMcpServers(
  servers: readonly ProviderMcpServerInput[],
): { serverName: string }[] {
  return servers.map(({ name }) => ({ serverName: name }));
}

/**
 * ACP `McpServer` entries for `session/new`, `session/load` and
 * `session/resume`, appended after Inertia's host server. HTTP servers need
 * the agent's `mcpCapabilities.http`; stdio servers are part of every ACP
 * agent's baseline.
 */
export function acpInitiativeMcpServers(
  provider: string,
  servers: readonly ProviderMcpServerInput[],
  supportsHttp: boolean,
): InitiativeMcpTranslation<McpServer[]> {
  const value: McpServer[] = [];
  const skipped: InitiativeMcpTranslation<unknown>["skipped"] = [];
  for (const server of servers) {
    if (server.transport === "http") {
      if (!supportsHttp) {
        skipped.push({
          name: server.name,
          reason: `${provider} did not report support for HTTP MCP servers.`,
        });
        continue;
      }
      value.push({
        type: "http",
        name: server.name,
        url: server.url,
        headers: server.headers.map(({ name, value: header }) => ({ name, value: header })),
      });
      continue;
    }
    value.push({
      name: server.name,
      command: server.command,
      args: [...server.args],
      env: server.env.map(({ name, value: variable }) => ({ name, value: variable })),
    });
  }
  return { value, skipped };
}

/** OpenCode `client.mcp.add` configuration for one server, OAuth discovery off. */
export function openCodeInitiativeMcpConfig(server: ProviderMcpServerInput): McpRemoteConfig | McpLocalConfig {
  return server.transport === "http"
    ? {
        type: "remote",
        url: server.url,
        enabled: true,
        headers: record(server.headers),
        oauth: false,
        timeout: OPENCODE_MCP_TIMEOUT_MS,
      }
    : {
        type: "local",
        command: [server.command, ...server.args],
        environment: record(server.env),
        enabled: true,
        timeout: OPENCODE_MCP_TIMEOUT_MS,
      };
}
