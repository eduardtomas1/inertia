import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  SECRET_REQUEST_TOOL_NAME,
  SECRET_REQUEST_WAIT_MS_BY_PROVIDER,
} from "../../node/agent-secrets";
import type { ProviderHostToolRuntime } from "./host-tool-runtime";
import { INERTIA_HOST_MCP_NAME } from "./host-tool-mcp-config";
import { providerMcpTools } from "./host-tool-mcp-protocol";

const UNCHECKED_ARGUMENTS = z.looseObject({});
export const CLAUDE_SECRET_MCP_TIMEOUT_MS = SECRET_REQUEST_WAIT_MS_BY_PROVIDER.claude + 60_000;

interface McpRequestExtra {
  requestId?: unknown;
  signal?: unknown;
}

export interface ClaudeHostTools {
  config: McpSdkServerConfigWithInstance;
  providerToolNames: ReadonlySet<string>;
  servesSecrets: boolean;
  close(): Promise<void>;
}

function requestIdentity(extra: unknown): string {
  const value = extra !== null && typeof extra === "object"
    ? extra as McpRequestExtra
    : {};
  const id = typeof value.requestId === "string" || typeof value.requestId === "number"
    ? `${typeof value.requestId}:${String(value.requestId)}`
    : "missing";
  return `claude-mcp:${id}`;
}

function requestSignal(extra: unknown): AbortSignal | undefined {
  const signal = extra !== null && typeof extra === "object"
    ? (extra as McpRequestExtra).signal
    : undefined;
  return signal instanceof AbortSignal ? signal : undefined;
}

/** Creates one in-process Claude MCP server owned by one exact Inertia turn. */
export function createClaudeHostTools(
  runtime: ProviderHostToolRuntime,
): ClaudeHostTools {
  const server = createSdkMcpServer({
    name: INERTIA_HOST_MCP_NAME,
    version: "1.0.0",
  });
  const servesSecrets = runtime.definitions().some(({ name }) => name === SECRET_REQUEST_TOOL_NAME);
  const config: McpSdkServerConfigWithInstance = servesSecrets
    ? { ...server, timeout: CLAUDE_SECRET_MCP_TIMEOUT_MS }
    : server;
  const providerToolNames = new Set<string>();
  for (const definition of runtime.definitions()) {
    if (!definition.inputValidator) {
      throw new Error(`Inertia host tool '${definition.name}' has no runtime validator.`);
    }
    providerToolNames.add(`mcp__${INERTIA_HOST_MCP_NAME}__${definition.name}`);
    config.instance.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: UNCHECKED_ARGUMENTS,
        annotations: {
          readOnlyHint: definition.readOnly,
          destructiveHint: definition.destructive === true,
          idempotentHint: definition.idempotent ?? definition.readOnly,
          openWorldHint: false,
        },
      },
      async (args, extra) => {
        const result = await runtime.invoke({
          callId: requestIdentity(extra),
          tool: definition.name,
          arguments: args,
          signal: requestSignal(extra),
        });
        return {
          content: [
            { type: "text" as const, text: result.text },
            ...(result.images ?? []).map((image) => ({
              type: "image" as const,
              data: image.data,
              mimeType: image.mimeType,
            })),
          ],
          ...(result.success ? {} : { isError: true }),
        };
      },
    );
  }
  config.instance.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: providerMcpTools(runtime.definitions(), { destructiveHints: true, alwaysLoadMeta: true }),
  }));
  let closePromise: Promise<void> | undefined;
  return {
    config,
    providerToolNames,
    servesSecrets,
    close: () => {
      closePromise ??= (async () => {
        runtime.settle();
        await config.instance.close();
      })();
      return closePromise;
    },
  };
}
