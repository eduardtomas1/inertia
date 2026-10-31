import { randomUUID } from "node:crypto";

import {
  MAX_PROVIDER_HOST_TOOL_IMAGE_BYTES,
  MAX_PROVIDER_HOST_TOOL_IMAGES,
  MAX_PROVIDER_HOST_TOOL_RESULT_BYTES,
} from "../../shared/provider-host-tools";
import {
  providerHostToolAccepted,
  type ProviderHostToolApprovalDecision,
  type ProviderHostToolApprovalRequest,
  type ProviderHostToolBridge,
  type ProviderHostToolImage,
  type ProviderHostToolResult,
  UNSAFE_HOST_TOOL_NAME_CHARACTERS,
  unknownProviderHostToolMessage,
} from "./contracts";
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
} from "./interactions";

const HOST_TOOL_APPROVAL_ID_PREFIX = "inertia-host-tool:";
const HOST_TOOL_APPROVAL_TIMEOUT_MS = 5 * 60_000;
export const MAX_HOST_TOOL_CALLS = 1_024;
/**
 * Calls that end without using the allowance (a wait that timed out) still
 * reserve their identity; this bounds that set for one turn.
 */
export const MAX_HOST_TOOL_CALL_IDENTITIES = 8_192;
const MAX_PENDING_HOST_TOOL_CALLS = 8;

const unchargedResults = new WeakSet<ProviderHostToolResult>();
const allowanceReportingResults = new WeakSet<ProviderHostToolResult>();

/**
 * Marks a host-owned result for the turn's call allowance. An `uncharged`
 * result gives back the allowance its call reserved; either way, a JSON
 * object result gains `remainingToolCalls` so the model can see what is left.
 * Only Inertia code can mark a result; provider input never can.
 */
export function withHostToolAllowance(
  result: ProviderHostToolResult,
  charge: "charged" | "uncharged",
): ProviderHostToolResult {
  allowanceReportingResults.add(result);
  if (charge === "uncharged") unchargedResults.add(result);
  return result;
}

function withRemainingAllowance(text: string, remaining: number): string {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return text;
    return JSON.stringify({ ...value, remainingToolCalls: remaining });
  } catch {
    return text;
  }
}

interface PendingApproval {
  callId: string;
  resolve(decision: ProviderHostToolApprovalDecision): void;
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

function failure(
  message: string,
  code: "host_tool_rejected" | "host_tool_budget_exhausted" = "host_tool_rejected",
): ProviderHostToolResult {
  return {
    success: false,
    text: boundedUtf8(JSON.stringify({ error: { code, message } }), MAX_PROVIDER_HOST_TOOL_RESULT_BYTES),
  };
}

function validIdentity(value: string, maximum: number): boolean {
  return value.length > 0
    && value.length <= maximum
    && !UNSAFE_HOST_TOOL_NAME_CHARACTERS.test(value);
}

const HOST_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function boundedHostImages(
  images: ProviderHostToolResult["images"],
): readonly ProviderHostToolImage[] | null | undefined {
  if (!images || images.length === 0) return undefined;
  if (images.length > MAX_PROVIDER_HOST_TOOL_IMAGES) return null;
  const maximumBase64 = Math.ceil(MAX_PROVIDER_HOST_TOOL_IMAGE_BYTES / 3) * 4;
  let decodedBytes = 0;
  for (const image of images) {
    if (
      !HOST_IMAGE_MIME_TYPES.has(image.mimeType)
      || image.data.length === 0
      || image.data.length > maximumBase64
      || image.data.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/u.test(image.data)
    ) return null;
    const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
    decodedBytes += image.data.length / 4 * 3 - padding;
  }
  return decodedBytes <= MAX_PROVIDER_HOST_TOOL_IMAGE_BYTES ? images : null;
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
  /** Admitted calls that count toward `MAX_HOST_TOOL_CALLS`. */
  private chargedCalls = 0;
  private settled = false;

  constructor(private readonly options: ProviderHostToolRuntimeOptions) {}

  definitions() {
    return this.options.bridge.definitions;
  }

  invoke(input: ProviderHostToolInvocation): Promise<ProviderHostToolResult> {
    if (this.settled) {
      return Promise.resolve(failure("This Inertia turn no longer owns chat-tool authority."));
    }
    if (!validIdentity(input.callId, 512) || !validIdentity(input.tool, 128)) {
      return Promise.resolve(failure("The provider sent a malformed Inertia tool call."));
    }
    if (!providerHostToolAccepted(this.options.bridge, input.tool)) {
      return Promise.resolve(failure(unknownProviderHostToolMessage(this.options.bridge, input.tool)));
    }
    if (this.seenCallIds.has(input.callId)) {
      // MCP/JSON-RPC only promises correlation, not run-global uniqueness.
      // Inertia deliberately chooses the stricter fail-closed policy so a
      // reconnect or replay cannot repeat a previously admitted mutation.
      return Promise.resolve(failure("The provider reused an Inertia tool-call identity."));
    }
    if (this.chargedCalls >= MAX_HOST_TOOL_CALLS) {
      return Promise.resolve(failure(
        `This turn already made ${MAX_HOST_TOOL_CALLS} Inertia tool calls, which is the limit for one turn. Retrying in this turn will not restore the allowance. Finish the turn; the next turn starts a new allowance.`,
        "host_tool_budget_exhausted",
      ));
    }
    if (this.seenCallIds.size >= MAX_HOST_TOOL_CALL_IDENTITIES) {
      return Promise.resolve(failure(
        `This turn already started ${MAX_HOST_TOOL_CALL_IDENTITIES} Inertia tool calls, which is the limit for one turn, including waits that timed out. Finish the turn; the next turn starts a new allowance.`,
        "host_tool_budget_exhausted",
      ));
    }
    if (this.pendingCalls.size >= MAX_PENDING_HOST_TOOL_CALLS) {
      return Promise.resolve(failure(
        `${MAX_PENDING_HOST_TOOL_CALLS} Inertia tool calls are already running. Wait for one to finish, then try again.`,
      ));
    }
    this.seenCallIds.add(input.callId);
    this.chargedCalls += 1;
    const controller = new AbortController();
    const abort = (): void => { this.cancelCall(input.callId); };
    const pending: PendingCall = {
      controller,
      detachSignal: () => input.signal?.removeEventListener("abort", abort),
    };
    this.pendingCalls.set(input.callId, pending);
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener("abort", abort, { once: true });
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
    if (controller.signal.aborted) {
      this.finishCall(input.callId, pending);
      return Promise.resolve(failure("The Inertia chat-tool call was cancelled."));
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
        const images = boundedHostImages(result.images);
        if (images === null) return failure("The Inertia chat-tool returned invalid images.");
        if (unchargedResults.has(result)) this.chargedCalls -= 1;
        const text = allowanceReportingResults.has(result)
          ? withRemainingAllowance(result.text, Math.max(0, MAX_HOST_TOOL_CALLS - this.chargedCalls))
          : result.text;
        return {
          success: result.success,
          text: boundedUtf8(text, MAX_PROVIDER_HOST_TOOL_RESULT_BYTES),
          ...(images ? { images } : {}),
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
    if (
      !pending
      || this.settled
      || this.pendingCalls.get(pending.callId)?.controller.signal.aborted !== false
    ) return false;
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
  ): Promise<ProviderHostToolApprovalDecision> {
    const call = this.pendingCalls.get(callId);
    if (
      this.settled
      || !call
      || call.controller.signal.aborted
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
    return new Promise<ProviderHostToolApprovalDecision>((resolve) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingApprovals.get(requestId);
        if (!pending) return;
        this.pendingApprovals.delete(requestId);
        pending.resolve("timeout");
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
