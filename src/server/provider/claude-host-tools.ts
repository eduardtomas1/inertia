import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";

import type { ProviderHostToolRuntime } from "./host-tool-runtime";
import { INERTIA_HOST_MCP_NAME } from "./host-tool-mcp-config";

interface McpRequestExtra {
  requestId?: unknown;
  signal?: unknown;
}

export interface ClaudeHostTools {
  config: McpSdkServerConfigWithInstance;
  providerToolNames: ReadonlySet<string>;
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
  const config = createSdkMcpServer({
    name: INERTIA_HOST_MCP_NAME,
    version: "1.0.0",
    instructions: "Manage bounded top-level Inertia chats in the current project. Inertia itself asks for approval before mutations.",
    alwaysLoad: true,
  });
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
        inputSchema: definition.inputValidator,
        annotations: {
          readOnlyHint: definition.readOnly,
          destructiveHint: false,
          idempotentHint: definition.readOnly,
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
          content: [{ type: "text" as const, text: result.text }],
          ...(result.success ? {} : { isError: true }),
        };
      },
    );
  }
  let closePromise: Promise<void> | undefined;
  return {
    config,
    providerToolNames,
    close: () => {
      closePromise ??= (async () => {
        runtime.settle();
        await config.instance.close();
      })();
      return closePromise;
    },
  };
}
