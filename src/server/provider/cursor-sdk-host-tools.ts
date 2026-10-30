import { randomUUID } from "node:crypto";
import type { SDKCustomTool, SDKJsonValue } from "@cursor/sdk";
import { CURSOR_SDK_RUN_TIMEOUT_MS, type CursorSdkStart } from "../../node/cursor-sdk-protocol";

export const CURSOR_SDK_HOST_TOOL_TIMEOUT_MS = CURSOR_SDK_RUN_TIMEOUT_MS;

export function cursorSdkHostTools(input: CursorSdkStart, sessionId: () => string | undefined,
  signal: AbortSignal, request: (method: string, value: unknown, timeoutMs: number) => Promise<unknown>): Record<string, SDKCustomTool> {
  const seen = new Set<string>();
  return Object.fromEntries(input.tools.map((tool) => [tool.name, {
    description: tool.description, inputSchema: tool.inputSchema as Record<string, SDKJsonValue>,
    annotations: { readOnlyHint: tool.readOnly },
    execute: async (args, context) => {
      signal.throwIfAborted();
      if (!sessionId() || context.sessionId !== sessionId() || !context.toolCallId || context.toolCallId.length > 512
        || seen.has(context.toolCallId) || seen.size >= 128) throw new Error("Foreign or reused Cursor SDK host tool authority.");
      seen.add(context.toolCallId);
      const result = await request("host-tool", {
        authority: input.authority, callId: randomUUID(), tool: tool.name, arguments: args,
      }, CURSOR_SDK_HOST_TOOL_TIMEOUT_MS);
      signal.throwIfAborted();
      return result as SDKJsonValue;
    },
  } satisfies SDKCustomTool]));
}
