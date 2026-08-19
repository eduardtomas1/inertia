import { randomUUID } from "node:crypto";

import { strictCodexProviderIdentifier } from "./app-server-subagents";
import { boundedText, type JsonObject, type RpcId } from "./protocol";
import type {
  ProviderHostToolApprovalRequest,
  ProviderHostToolResult,
} from "../provider/contracts";
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
} from "../provider/interactions";
import type { CodexAppServerOptions } from "./types";

interface PendingHostToolApproval {
  request: AgentApprovalRequest;
  toolCallId: string;
  resolve: (decision: AgentApprovalDecision) => void;
  timeout: NodeJS.Timeout;
}

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
const HOST_TOOL_APPROVAL_TIMEOUT_MS = 5 * 60_000;
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
  private readonly pendingApprovals = new Map<
    string,
    PendingHostToolApproval
  >();
  private readonly pendingCalls = new Map<string, PendingHostToolCall>();
  private readonly seenCallIds = new Set<string>();

  constructor(private readonly host: CodexHostToolRuntimeHost) {}

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
    void bridge.invoke({
      providerThreadId,
      providerTurnId,
      toolCallId,
      tool,
      arguments: params.arguments,
      signal: controller.signal,
      requestApproval: (request) => this.requestApproval(toolCallId, request),
    }).then(
      (result) => this.respond(toolCallId, pending, result),
      (error: unknown) => this.respond(toolCallId, pending, {
        success: false,
        text: boundedText(
          error instanceof Error ? error.message : String(error),
          1_000,
        ) ?? "The Inertia host tool failed.",
      }),
    ).finally(() => this.finishCall(toolCallId, pending));
  }

  respondToApproval(
    requestId: string,
    decision: AgentApprovalDecision,
  ): boolean {
    const pending = this.pendingApprovals.get(requestId);
    if (
      !pending
      || this.host.isSettled()
      || !pending.request.availableDecisions.includes(decision)
    ) return false;
    clearTimeout(pending.timeout);
    this.pendingApprovals.delete(requestId);
    pending.resolve(decision);
    this.host.options.onApprovalResolved?.(requestId, decision);
    if (decision === "cancel") {
      this.pendingCalls.get(pending.toolCallId)?.controller.abort();
      this.host.cancel();
    }
    return true;
  }

  settle(decision: AgentApprovalDecision): void {
    for (const [requestId, pending] of this.pendingApprovals) {
      clearTimeout(pending.timeout);
      pending.resolve(decision);
      this.host.options.onApprovalResolved?.(requestId, "cancelled");
    }
    this.pendingApprovals.clear();
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
    for (const [requestId, pending] of this.pendingApprovals) {
      if (pending.toolCallId !== toolCallId) continue;
      clearTimeout(pending.timeout);
      this.pendingApprovals.delete(requestId);
      pending.resolve("cancel");
      this.host.options.onApprovalResolved?.(requestId, "cancelled");
    }
  }

  private requestApproval(
    toolCallId: string,
    request: ProviderHostToolApprovalRequest,
  ): Promise<AgentApprovalDecision> {
    if (
      this.host.isSettled()
      || !this.pendingCalls.has(toolCallId)
      || [...this.pendingApprovals.values()].some(
        (pending) => pending.toolCallId === toolCallId,
      )
    ) return Promise.resolve("cancel");
    const requestId = `${HOST_TOOL_APPROVAL_ID_PREFIX}${randomUUID()}`;
    const approval: AgentApprovalRequest = {
      requestId,
      kind: "permissions",
      title: boundedText(request.title, 200) ?? "Allow Inertia chat action",
      detail: boundedText(request.detail, 2_000),
      reason: boundedText(request.reason, 1_000),
      cwd: this.host.options.cwd,
      permissionRoots: request.permissionRoots.slice(0, 8),
      availableDecisions: ["approve", "deny", "cancel"],
    };
    return new Promise<AgentApprovalDecision>((resolve) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingApprovals.get(requestId);
        if (!pending) return;
        this.pendingApprovals.delete(requestId);
        pending.resolve("deny");
        this.host.options.onApprovalResolved?.(requestId, "deny");
      }, Math.max(1, Math.min(
        HOST_TOOL_APPROVAL_TIMEOUT_MS,
        this.host.options.hostToolApprovalTimeoutMs
          ?? HOST_TOOL_APPROVAL_TIMEOUT_MS,
      )));
      timeout.unref();
      this.pendingApprovals.set(requestId, {
        request: approval,
        toolCallId,
        resolve,
        timeout,
      });
      this.host.options.onApproval?.(approval);
    });
  }

  private writeOrCancel(message: JsonObject): void {
    if (!this.host.writeMessage(message)) this.host.cancel();
  }
}
