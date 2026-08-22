import { randomUUID } from "node:crypto";

import { MAX_AGENT_BROWSER_SCREENSHOT_BYTES } from "../../shared/agent-browser";
import type {
  ProviderHostToolApprovalRequest,
  ProviderHostToolBridge,
  ProviderHostToolResult,
} from "./contracts";
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
} from "./interactions";

const HOST_TOOL_APPROVAL_ID_PREFIX = "inertia-host-tool:";
const HOST_TOOL_APPROVAL_TIMEOUT_MS = 5 * 60_000;
const MAX_HOST_TOOL_CALLS = 128;
const MAX_PENDING_HOST_TOOL_CALLS = 8;
const MAX_HOST_TOOL_RESULT_BYTES = 32 * 1024;

interface PendingApproval {
  callId: string;
  resolve(decision: AgentApprovalDecision): void;
  timeout: NodeJS.Timeout;
}

interface PendingCall {
  controller: AbortController;
  detachSignal(): void;
}

export interface ProviderHostToolRuntimeOptions {
  bridge: ProviderHostToolBridge;
  conversationId: string | (() => string | undefined);
  turnId: string | (() => string | undefined);
  cwd: string;
  onApproval(request: AgentApprovalRequest): void;
  onApprovalResolved(
    requestId: string,
    decision: AgentApprovalDecision | "cancelled",
  ): void;
  onCancel?(callId: string): void;
  /** Test-only shortening seam; production callers must omit it. */
  approvalTimeoutMs?: number;
}

export interface ProviderHostToolInvocation {
  callId: string;
  tool: string;
  arguments: unknown;
  signal?: AbortSignal;
}

function boundedUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value.replaceAll("\0", ""), "utf8");
  if (bytes.length <= maximumBytes) return bytes.toString("utf8");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = maximumBytes;
  while (end > 0) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

function failure(message: string): ProviderHostToolResult {
  return {
    success: false,
    text: boundedUtf8(JSON.stringify({ error: { code: "host_tool_rejected", message } }), MAX_HOST_TOOL_RESULT_BYTES),
  };
}

function validIdentity(value: string, maximum: number): boolean {
  return value.length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function boundedHostImage(
  image: ProviderHostToolResult["image"],
): ProviderHostToolResult["image"] | null | undefined {
  if (!image) return undefined;
  const maximumBase64 = Math.ceil(MAX_AGENT_BROWSER_SCREENSHOT_BYTES / 3) * 4;
  if (
    image.mimeType !== "image/png"
    || image.data.length === 0
    || image.data.length > maximumBase64
    || image.data.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(image.data)
  ) return null;
  const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
  return image.data.length / 4 * 3 - padding <= MAX_AGENT_BROWSER_SCREENSHOT_BYTES
    ? image
    : null;
}

/**
 * Process-local authority for one exact Inertia turn's provider tool calls.
 * Provider transports may present calls, but cannot mint approvals or retain
 * mutation authority after this owner settles.
 */
export class ProviderHostToolRuntime {
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingCalls = new Map<string, PendingCall>();
  private readonly seenCallIds = new Set<string>();
  private settled = false;

  constructor(private readonly options: ProviderHostToolRuntimeOptions) {}

  definitions() {
    return this.options.bridge.definitions;
  }

  invoke(input: ProviderHostToolInvocation): Promise<ProviderHostToolResult> {
    if (this.settled) {
      return Promise.resolve(failure("This Inertia turn no longer owns chat-tool authority."));
    }
    if (
      !validIdentity(input.callId, 512)
      || !validIdentity(input.tool, 128)
      || !this.options.bridge.definitions.some(({ name }) => name === input.tool)
    ) {
      return Promise.resolve(failure("The provider sent an invalid or unauthorised Inertia tool call."));
    }
    if (this.seenCallIds.has(input.callId)) {
      // MCP/JSON-RPC only promises correlation, not run-global uniqueness.
      // Inertia deliberately chooses the stricter fail-closed policy so a
      // reconnect or replay cannot repeat a previously admitted mutation.
      return Promise.resolve(failure("The provider reused an Inertia tool-call identity."));
    }
    if (
      this.seenCallIds.size >= MAX_HOST_TOOL_CALLS
      || this.pendingCalls.size >= MAX_PENDING_HOST_TOOL_CALLS
    ) {
      return Promise.resolve(failure("The bounded Inertia chat-tool call budget was exhausted."));
    }
    this.seenCallIds.add(input.callId);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener("abort", abort, { once: true });
    const pending: PendingCall = {
      controller,
      detachSignal: () => input.signal?.removeEventListener("abort", abort),
    };
    this.pendingCalls.set(input.callId, pending);
    const providerThreadId = typeof this.options.conversationId === "function"
      ? this.options.conversationId()
      : this.options.conversationId;
    const providerTurnId = typeof this.options.turnId === "function"
      ? this.options.turnId()
      : this.options.turnId;
    if (!providerThreadId || !providerTurnId) {
      this.finishCall(input.callId, pending);
      return Promise.resolve(failure("The provider tool call has no active Inertia turn authority."));
    }
    return this.options.bridge.invoke({
      providerThreadId,
      providerTurnId,
      toolCallId: input.callId,
      tool: input.tool,
      arguments: input.arguments,
      signal: controller.signal,
      requestApproval: (request) => this.requestApproval(input.callId, request),
    }).then(
      (result) => {
        if (this.settled || controller.signal.aborted) {
          return failure("The Inertia chat-tool call was cancelled.");
        }
        const image = boundedHostImage(result.image);
        return image === null
          ? failure("The Inertia chat-tool returned invalid visual evidence.")
          : {
              success: result.success,
              text: boundedUtf8(result.text, MAX_HOST_TOOL_RESULT_BYTES),
              ...(image ? { image } : {}),
            };
      },
      (error: unknown) => failure(
        error instanceof Error && error.message
          ? error.message.slice(0, 1_000)
          : "The Inertia chat-tool call failed.",
      ),
    ).finally(() => this.finishCall(input.callId, pending));
  }

  cancelCall(callId: string): boolean {
    const pending = this.pendingCalls.get(callId);
    if (!pending) return false;
    pending.controller.abort();
    this.cancelApprovalsForCall(callId);
    return true;
  }

  respondToApproval(
    requestId: string,
    decision: AgentApprovalDecision,
  ): boolean {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending || this.settled) return false;
    clearTimeout(pending.timeout);
    this.pendingApprovals.delete(requestId);
    pending.resolve(decision);
    this.options.onApprovalResolved(requestId, decision);
    if (decision === "cancel") {
      this.pendingCalls.get(pending.callId)?.controller.abort();
      this.options.onCancel?.(pending.callId);
    }
    return true;
  }

  settle(): void {
    if (this.settled) return;
    this.settled = true;
    for (const [requestId, pending] of this.pendingApprovals) {
      clearTimeout(pending.timeout);
      pending.resolve("cancel");
      this.options.onApprovalResolved(requestId, "cancelled");
    }
    this.pendingApprovals.clear();
    for (const pending of this.pendingCalls.values()) {
      pending.controller.abort();
      pending.detachSignal();
    }
    this.pendingCalls.clear();
  }

  isSettled(): boolean {
    return this.settled;
  }

  private requestApproval(
    callId: string,
    request: ProviderHostToolApprovalRequest,
  ): Promise<AgentApprovalDecision> {
    if (
      this.settled
      || !this.pendingCalls.has(callId)
      || [...this.pendingApprovals.values()].some((pending) => pending.callId === callId)
    ) return Promise.resolve("cancel");
    const requestId = `${HOST_TOOL_APPROVAL_ID_PREFIX}${randomUUID()}`;
    const approval: AgentApprovalRequest = {
      requestId,
      kind: "permissions",
      title: boundedUtf8(request.title, 200) || "Allow Inertia chat action",
      detail: boundedUtf8(request.detail, 2_000),
      reason: boundedUtf8(request.reason, 1_000),
      cwd: this.options.cwd,
      permissionRoots: request.permissionRoots.slice(0, 8),
      availableDecisions: ["approve", "deny", "cancel"],
    };
    return new Promise<AgentApprovalDecision>((resolve) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingApprovals.get(requestId);
        if (!pending) return;
        this.pendingApprovals.delete(requestId);
        pending.resolve("deny");
        this.options.onApprovalResolved(requestId, "deny");
      }, Math.max(1, Math.min(
        HOST_TOOL_APPROVAL_TIMEOUT_MS,
        this.options.approvalTimeoutMs ?? HOST_TOOL_APPROVAL_TIMEOUT_MS,
      )));
      timeout.unref();
      this.pendingApprovals.set(requestId, { callId, resolve, timeout });
      this.options.onApproval(approval);
    });
  }

  private finishCall(callId: string, pending: PendingCall): void {
    if (this.pendingCalls.get(callId) === pending) {
      this.pendingCalls.delete(callId);
      pending.detachSignal();
    }
    this.cancelApprovalsForCall(callId);
  }

  private cancelApprovalsForCall(callId: string): void {
    for (const [requestId, pending] of this.pendingApprovals) {
      if (pending.callId !== callId) continue;
      clearTimeout(pending.timeout);
      this.pendingApprovals.delete(requestId);
      pending.resolve("cancel");
      this.options.onApprovalResolved(requestId, "cancelled");
    }
  }
}
