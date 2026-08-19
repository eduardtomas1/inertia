import type { OpencodeClient, PermissionRuleset } from "@opencode-ai/sdk/v2";

import type { ProviderHostToolBridge } from "./contracts";
import type { AgentApprovalDecision, AgentApprovalRequest } from "./interactions";
import { INERTIA_HOST_MCP_NAME, openCodeHostMcpConfig } from "./host-tool-mcp-config";
import {
  createProviderHostToolMcpSession,
  type ProviderHostToolMcpConnection,
} from "./host-tool-mcp-http";
import { ProviderHostToolRuntime } from "./host-tool-runtime";
import { redactHostToolPayload } from "./host-tool-redaction";
import { withOpenCodeRequestDeadline } from "./opencode-owned-server";

const MCP_DISCONNECT_TIMEOUT_MS = 2_000;

type Initializer = <T>(
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
) => Promise<T>;

export interface OpenCodeHostTools {
  install(client: OpencodeClient, initialize: Initializer): Promise<void>;
  settle(): void;
  revoke(): Promise<void>;
  cleanup(client: OpencodeClient | undefined): Promise<void>;
  redact(value: string): string;
  redactPayload<T>(value: T): T;
  respondToApproval(requestId: string, decision: AgentApprovalDecision): boolean;
}

export function openCodePermissions(
  access: "full" | "supervised" | "auto-edit",
): PermissionRuleset {
  if (access === "full") return [{ permission: "*", pattern: "*", action: "allow" }];
  return [
    { permission: "*", pattern: "*", action: "ask" },
    ...(access === "auto-edit" ? [{ permission: "edit", pattern: "*", action: "allow" } as const] : []),
    { permission: "question", pattern: "*", action: "allow" },
    {
      // OpenCode 1.18.18's McpCatalog.toolName emits
      // `${sanitize(server)}_${sanitize(tool)}` and evaluates the last
      // matching rule. Keep this after the catch-all so the host manager,
      // rather than a second native prompt, owns the one exact approval.
      permission: `${INERTIA_HOST_MCP_NAME}_*`,
      pattern: "*",
      action: "allow",
    },
  ];
}

export function createOpenCodeHostTools(input: {
  bridge: ProviderHostToolBridge | undefined;
  conversationId: string;
  turnId: string | undefined;
  cwd: string;
  onApproval(request: AgentApprovalRequest): void;
  onApprovalResolved(
    requestId: string,
    decision: AgentApprovalDecision | "cancelled",
  ): void;
}): OpenCodeHostTools | undefined {
  if (!input.bridge || !input.turnId) return undefined;
  const runtime = new ProviderHostToolRuntime({
    bridge: input.bridge,
    conversationId: input.conversationId,
    turnId: input.turnId,
    cwd: input.cwd,
    onApproval: input.onApproval,
    onApprovalResolved: input.onApprovalResolved,
  });
  const session = createProviderHostToolMcpSession(runtime);
  let connection: ProviderHostToolMcpConnection | undefined;
  let installed = false;
  let cleanupPromise: Promise<void> | undefined;

  return {
    install: async (client, initialize) => {
      connection = await session.start();
      const response = await initialize(
        "Inertia chat-tool connection",
        async (signal) => await client.mcp.add({
          directory: input.cwd,
          name: INERTIA_HOST_MCP_NAME,
          config: openCodeHostMcpConfig(connection!),
        }, { signal, throwOnError: true }),
      );
      // A completed add mutates the owned server even when its returned status
      // is unexpected, so cleanup must still disconnect it.
      installed = true;
      if (response.data?.[INERTIA_HOST_MCP_NAME]?.status !== "connected") {
        throw new Error("OpenCode did not connect the scoped Inertia chat tools.");
      }
    },
    settle: () => runtime.settle(),
    revoke: () => session.close(),
    cleanup: (client) => {
      cleanupPromise ??= (async () => {
        runtime.settle();
        let failure: Error | undefined;
        if (client && installed) {
          try {
            await withOpenCodeRequestDeadline(
              MCP_DISCONNECT_TIMEOUT_MS,
              "Timed out disconnecting OpenCode Inertia chat tools.",
              async (signal) => await client.mcp.disconnect({
                directory: input.cwd,
                name: INERTIA_HOST_MCP_NAME,
              }, { signal, throwOnError: true }),
            );
          } catch {
            failure = new Error("OpenCode Inertia chat tools could not be disconnected.");
          }
          installed = false;
        }
        try {
          await session.close();
        } catch {
          failure ??= new Error("OpenCode Inertia chat tools could not be cleaned up.");
        }
        if (failure) throw failure;
      })();
      return cleanupPromise;
    },
    redact: (value) => connection
      ? value
          .replaceAll(connection.bearerToken, "[redacted]")
          .replaceAll(connection.url, "[redacted]")
      : value,
    redactPayload: (value) => connection
      ? redactHostToolPayload(value, [connection.bearerToken, connection.url])
      : value,
    respondToApproval: (requestId, decision) =>
      runtime.respondToApproval(requestId, decision),
  };
}
