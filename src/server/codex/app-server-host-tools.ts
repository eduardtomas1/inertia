import { strictCodexProviderIdentifier } from "./app-server-subagents";
import { type JsonObject, type RpcId } from "./protocol";
import type { ProviderHostToolResult } from "../provider/contracts";
import type { AgentApprovalDecision } from "../provider/interactions";
import { ProviderHostToolRuntime } from "../provider/host-tool-runtime";
import type { CodexAppServerOptions } from "./types";

interface PendingHostToolCall {
  rpcId: RpcId;
  controller: AbortController;
}

export interface CodexHostToolRuntimeHost {
  options: CodexAppServerOptions;
  isSettled(): boolean;
  providerThreadId(): string | undefined;
  activeTurnId(): string | undefined;
  reserveServerRequest(id: RpcId): boolean;
  releaseServerRequest(id: RpcId): void;
  writeMessage(message: JsonObject): boolean;
  cancel(): void;
}

const HOST_TOOL_APPROVAL_ID_PREFIX = "inertia-host-tool:";
const MAX_HOST_TOOL_RESULT_BYTES = 32 * 1024;

function boundedHostToolResult(value: string): string {
  const bytes = Buffer.from(value.replaceAll("\0", ""), "utf8");
  if (bytes.length <= MAX_HOST_TOOL_RESULT_BYTES) return bytes.toString("utf8");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = MAX_HOST_TOOL_RESULT_BYTES;
  while (end > 0) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

export function isHostToolApprovalId(requestId: string): boolean {
  return requestId.startsWith(HOST_TOOL_APPROVAL_ID_PREFIX);
}

/** Exact-run owner for Codex dynamic-tool calls and their local approvals. */
export class CodexHostToolRuntime {
  private readonly pendingCalls = new Map<string, PendingHostToolCall>();
  private readonly seenCallIds = new Set<string>();
  private readonly runtime: ProviderHostToolRuntime | undefined;

  constructor(private readonly host: CodexHostToolRuntimeHost) {
    const bridge = host.options.hostTools;
    this.runtime = bridge
      ? new ProviderHostToolRuntime({
          bridge,
          conversationId: () => host.providerThreadId(),
          turnId: () => host.activeTurnId(),
          cwd: host.options.cwd,
          onApproval: (request) => host.options.onApproval?.(request),
          onApprovalResolved: (requestId, decision) => {
            host.options.onApprovalResolved?.(requestId, decision);
          },
          onCancel: (callId) => {
            this.pendingCalls.get(callId)?.controller.abort();
            host.cancel();
          },
          approvalTimeoutMs: host.options.hostToolApprovalTimeoutMs,
        })
      : undefined;
  }

  handle(id: RpcId, params: JsonObject): void {
    const bridge = this.host.options.hostTools;
    const providerThreadId = strictCodexProviderIdentifier(
      params.threadId,
      512,
    );
    const providerTurnId = strictCodexProviderIdentifier(params.turnId, 512);
    const toolCallId = strictCodexProviderIdentifier(params.callId, 512);
    const tool = strictCodexProviderIdentifier(params.tool, 128);
    if (!bridge) {
      this.writeOrCancel({
        id,
        error: {
          code: -32601,
          message: "Inertia host tools are unavailable for this session.",
        },
      });
      return;
    }
    if (
      !providerThreadId
      || providerThreadId !== this.host.providerThreadId()
      || !providerTurnId
      || providerTurnId !== this.host.activeTurnId()
      || !toolCallId
      || !tool
      || !bridge.definitions.some((definition) => definition.name === tool)
    ) {
      this.writeOrCancel({
        id,
        error: {
          code: -32602,
          message: "Codex sent an invalid or unauthorised Inertia tool call.",
        },
      });
      return;
    }
    if (this.seenCallIds.has(toolCallId)) {
      this.writeOrCancel({
        id,
        error: {
          code: -32602,
          message: "Codex reused an Inertia tool-call identity.",
        },
      });
      return;
    }
    this.seenCallIds.add(toolCallId);
    if (!this.host.reserveServerRequest(id)) return;
    const controller = new AbortController();
    const pending = { rpcId: id, controller };
    this.pendingCalls.set(toolCallId, pending);
    void this.runtime!.invoke({
      callId: toolCallId,
      tool,
      arguments: params.arguments,
      signal: controller.signal,
    }).then(
      (result) => this.respond(toolCallId, pending, result),
    ).finally(() => this.finishCall(toolCallId, pending));
  }

  respondToApproval(
    requestId: string,
    decision: AgentApprovalDecision,
  ): boolean {
    if (this.host.isSettled()) return false;
    return this.runtime?.respondToApproval(requestId, decision) ?? false;
  }

  settle(_decision: AgentApprovalDecision): void {
    this.runtime?.settle();
    for (const pending of this.pendingCalls.values()) {
      pending.controller.abort();
      this.host.releaseServerRequest(pending.rpcId);
    }
    this.pendingCalls.clear();
  }

  private respond(
    toolCallId: string,
    pending: PendingHostToolCall,
    result: ProviderHostToolResult,
  ): void {
    if (
      pending.controller.signal.aborted
      || this.host.isSettled()
      || this.pendingCalls.get(toolCallId) !== pending
    ) return;
    const written = this.host.writeMessage({
      id: pending.rpcId,
      result: {
        contentItems: [{
          type: "inputText",
          text: boundedHostToolResult(result.text),
        }],
        success: result.success,
      },
    });
    this.host.releaseServerRequest(pending.rpcId);
    if (!written) this.host.cancel();
  }

  private finishCall(
    toolCallId: string,
    pendingCall: PendingHostToolCall,
  ): void {
    if (this.pendingCalls.get(toolCallId) === pendingCall) {
      this.pendingCalls.delete(toolCallId);
    }
  }

  private writeOrCancel(message: JsonObject): void {
    if (!this.host.writeMessage(message)) this.host.cancel();
  }
}
