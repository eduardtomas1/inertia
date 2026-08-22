import {
  isCodexApprovalRequestMethod,
  parseCodexApprovalRequest,
} from "./approvals";
import {
  codexGoalContinuationGraceMs,
  codexSubagentDrainTimeoutMs,
  type CodexRunPhase,
} from "./app-server-config";
import {
  CodexSubagentLifecycle,
  type CodexSubagentAuthority,
  type CodexSubagentProjection,
  type CodexSubagentUpdate,
} from "./app-server-subagents";
import {
  isLiveCodexSubagentStatus,
  shouldAcceptCodexSubagentProjection,
} from "./app-server-subagent-projection";
import {
  CodexHostToolRuntime,
  isHostToolApprovalId,
} from "./app-server-host-tools";
import {
  parseCodexGoalClearedNotification,
  parseCodexGoalUpdatedNotification,
} from "./goals";
import { parseCodexPlan } from "./plans";
import {
  boundedText,
  CappedTextBuffer,
  objectValue,
  rpcId,
  stringValue,
  type JsonObject,
  type RpcId,
} from "./protocol";
import {
  codexInputAnswers,
  isCodexInputRequestMethod,
  parseCodexOwnedInputRequest,
} from "./questions";
import {
  handleCodexAuxiliaryServerRequest,
} from "./app-server-requests";
import {
  handleCodexHook,
  handleCodexItem,
  type CodexItemActivity,
} from "./app-server-item-events";
import { projectCodexSecurityNotification } from "./app-server-security-events";
import { projectCodexRuntimeNotification } from "./app-server-runtime-notifications";
import { parseCodexTokenUsage } from "./usage";
import type { AgentGoalStatus } from "../../shared/contracts";
import { parseCodexRateLimits } from "../codex-metadata";
import {
  providerActivityDetailSections,
} from "../provider/activity-detail";
import type {
  ProviderGoalSnapshot,
  ProviderRunFailure,
} from "../provider/contracts";
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentInputRequest,
} from "../provider/interactions";
import type {
  CodexAppServerOptions,
  CodexAppServerResult,
} from "./types";

interface PendingApproval {
  rpcId: RpcId;
  request: AgentApprovalRequest;
  protocol: "decision" | "permissions" | "legacy-review";
  requestedPermissions?: JsonObject;
}

interface PendingInput {
  rpcId: RpcId;
  request: AgentInputRequest;
}

export interface CodexAppServerEventHost {
  options: CodexAppServerOptions;
  resultText: CappedTextBuffer;
  isSettled: () => boolean;
  phase: () => CodexRunPhase;
  setPhase: (phase: CodexRunPhase) => void;
  providerThreadId: () => string | undefined;
  activeTurnId: () => string | undefined;
  setActiveTurnId: (turnId: string | undefined) => void;
  cancelRequested: () => boolean;
  lastError: () => string | undefined;
  setLastError: (message: string) => void;
  setLastProtocolMethod: (method: string) => void;
  setLastActivityId: (activityId: string) => void;
  setTerminalEvent: (event: string) => void;
  writeMessage: (message: JsonObject) => boolean;
  cancel: () => void;
  finish: (
    status: CodexAppServerResult["status"],
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ) => void;
  rememberFailure: (
    reason: ProviderRunFailure["reason"],
    message: string,
    technicalDetail?: string,
  ) => void;
}

interface PendingParentCompletion {
  status: CodexAppServerResult["status"];
  exitCode: number | null;
}

const MAX_CODEX_PENDING_SERVER_REQUESTS = 32;
const MAX_CODEX_TRACKED_ITEM_ACTIVITIES = 4_096;

function rpcRequestKey(id: RpcId): string {
  return `${typeof id}:${String(id)}`;
}

export class CodexAppServerEvents {
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingInputs = new Map<string, PendingInput>();
  private readonly pendingServerRequestIds = new Set<string>();
  private readonly deltaItems = new Set<string>();
  private readonly reasoningDeltaItems = new Set<string>();
  private readonly itemActivities = new Map<string, CodexItemActivity>();
  private readonly completedTurnIds = new Set<string>();
  private readonly subagentProjection = new Map<
    string,
    CodexSubagentProjection
  >();
  private readonly liveSubagentIds = new Set<string>();
  private subagentSequence = 0;
  private pendingParentCompletion: PendingParentCompletion | null = null;
  private subagentDrainTimer: NodeJS.Timeout | undefined;
  private readonly subagentDrainTimeoutMs: number;
  private goalContinuationTimer: NodeJS.Timeout | undefined;
  private readonly goalContinuationGraceMs: number;
  private pendingGoalMutationCompletion: PendingParentCompletion | null = null;
  private nativeGoalStatus: AgentGoalStatus | null;
  private nativeGoalSnapshot: ProviderGoalSnapshot | null = null;
  private nativeGoalUpdatedAt: string | null = null;
  private nativeGoalSequence = 0;
  private nativeGoalFingerprint: string | null = null;
  private readonly nativeGoalRevisionFingerprints = new Set<string>();
  private pendingGoalMutations = 0;
  private pendingGoalActivations = 0;
  private readonly subagents: CodexSubagentLifecycle;
  private readonly hostTools: CodexHostToolRuntime;

  constructor(private readonly host: CodexAppServerEventHost) {
    this.subagentDrainTimeoutMs = codexSubagentDrainTimeoutMs(
      host.options.subagentDrainTimeoutMs,
    );
    this.goalContinuationGraceMs = codexGoalContinuationGraceMs(
      host.options.goalContinuationGraceMs,
    );
    this.nativeGoalStatus = host.options.goalContinuationExpected
      ? "active"
      : null;
    this.subagents = new CodexSubagentLifecycle({
      rootThreadId: host.providerThreadId,
      rootTurnId: host.activeTurnId,
      emitSubagent: (update, authority, isLive) => {
        this.emitSubagent(update, authority, isLive);
      },
      projection: (providerAgentId) =>
        this.subagentProjection.get(providerAgentId),
      rejectMalformed: (message) => this.rejectMalformedSubagent(message),
    });
    this.hostTools = new CodexHostToolRuntime({
      options: host.options,
      isSettled: host.isSettled,
      providerThreadId: host.providerThreadId,
      activeTurnId: host.activeTurnId,
      reserveServerRequest: (id) => this.reserveServerRequest(id),
      releaseServerRequest: (id) => {
        this.pendingServerRequestIds.delete(rpcRequestKey(id));
      },
      writeMessage: host.writeMessage,
      cancel: host.cancel,
    });
  }

  dispose(): void {
    if (this.subagentDrainTimer) {
      clearTimeout(this.subagentDrainTimer);
      this.subagentDrainTimer = undefined;
    }
    if (this.goalContinuationTimer) {
      clearTimeout(this.goalContinuationTimer);
      this.goalContinuationTimer = undefined;
    }
    this.pendingParentCompletion = null;
    this.pendingGoalMutationCompletion = null;
    this.liveSubagentIds.clear();
    this.completedTurnIds.clear();
    this.deltaItems.clear();
    this.reasoningDeltaItems.clear();
    this.itemActivities.clear();
    this.subagents.dispose();
    this.hostTools.settle("cancel");
  }

  cancelPendingParentCompletion(): boolean {
    if (!this.pendingParentCompletion) return false;
    this.discardPendingParentCompletion();
    return true;
  }

  interruptibleChildTurns(): ReadonlyArray<{
    threadId: string;
    turnId: string;
  }> {
    return this.subagents.interruptibleTurns();
  }

  hasObservedTurn(turnId: string): boolean {
    return this.host.activeTurnId() === turnId
      || this.completedTurnIds.has(turnId);
  }

  goalProjectionSequence(): number {
    return this.nativeGoalSequence;
  }

  beginGoalMutation(activatesGoal: boolean): void {
    this.pendingGoalMutations += 1;
    if (activatesGoal) this.pendingGoalActivations += 1;
    if (this.pendingParentCompletion) {
      this.discardPendingParentCompletion();
      this.host.setActiveTurnId(undefined);
      this.host.setPhase("awaiting-goal-continuation");
    }
    if (this.host.phase() !== "awaiting-goal-continuation") return;
    if (this.goalContinuationTimer) {
      clearTimeout(this.goalContinuationTimer);
      this.goalContinuationTimer = undefined;
    }
    this.discardPendingParentCompletion();
  }

  endGoalMutation(activatesGoal: boolean): void {
    if (this.pendingGoalMutations > 0) {
      this.pendingGoalMutations -= 1;
    }
    if (activatesGoal && this.pendingGoalActivations > 0) {
      this.pendingGoalActivations -= 1;
    }
    if (this.pendingGoalMutations === 0) {
      const pendingCompletion = this.pendingGoalMutationCompletion;
      if (pendingCompletion) {
        this.pendingGoalMutationCompletion = null;
        this.completeParentTurn(
          pendingCompletion.status,
          pendingCompletion.exitCode,
        );
        return;
      }
      if (this.host.phase() !== "awaiting-goal-continuation") return;
      if (this.nativeGoalStatus === "active") {
        this.armGoalContinuationTimer();
      } else {
        this.finishAwaitingGoalContinuation();
      }
    }
  }

  awaitInitialGoalTurn(): void {
    // The provider can start the first goal turn before the goal/set response
    // continuation resumes. In that case the event-driven running phase owns
    // the lifecycle already. Otherwise, bound the wait exactly like every
    // later provider-authored goal continuation.
    if (this.host.phase() !== "starting-turn") return;
    this.awaitGoalContinuation();
  }

  settleInteractions(): void {
    this.hostTools.settle("cancel");
    for (const { rpcId: id, request, protocol } of
      this.pendingApprovals.values()) {
      this.host.writeMessage({
        id,
        result: protocol === "permissions"
          ? { permissions: {}, scope: "turn" }
          : protocol === "legacy-review"
            ? { decision: "abort" }
            : { decision: "cancel" },
      });
      this.host.options.onApprovalResolved?.(request.requestId, "cancelled");
    }
    this.pendingApprovals.clear();
    for (const { rpcId: id, request } of this.pendingInputs.values()) {
      this.host.writeMessage({ id, result: { answers: {} } });
      this.host.options.onInputResolved?.(request.requestId);
    }
    this.pendingInputs.clear();
    this.pendingServerRequestIds.clear();
  }

  respondToApproval(
    requestId: string,
    decision: AgentApprovalDecision,
  ): boolean {
    if (isHostToolApprovalId(requestId)) {
      return this.hostTools.respondToApproval(requestId, decision);
    }
    const pending = this.pendingApprovals.get(requestId);
    if (
      !pending
      || this.host.isSettled()
      || !pending.request.availableDecisions.includes(decision)
    ) return false;
    const result: JsonObject = pending.protocol === "permissions"
      ? {
          permissions: decision === "approve"
            ? pending.requestedPermissions ?? {}
            : {},
          scope: "turn",
        }
      : pending.protocol === "legacy-review"
        ? {
            decision: decision === "approve"
              ? "approved"
              : decision === "deny"
                ? { denied: { rejection: "Denied by the user in Inertia." } }
                : "abort",
          }
        : {
          decision: decision === "approve"
            ? "accept"
            : decision === "deny"
              ? "decline"
              : "cancel",
        };
    if (!this.host.writeMessage({ id: pending.rpcId, result })) return false;
    this.pendingApprovals.delete(requestId);
    this.pendingServerRequestIds.delete(rpcRequestKey(pending.rpcId));
    this.host.options.onApprovalResolved?.(requestId, decision);
    if (decision === "cancel") this.host.cancel();
    return true;
  }

  respondToInput(
    requestId: string,
    answers: Record<string, string[]>,
  ): boolean {
    const pending = this.pendingInputs.get(requestId);
    if (!pending || this.host.isSettled()) return false;
    const response = codexInputAnswers(pending.request, answers);
    if (!response) return false;
    if (!this.host.writeMessage({
      id: pending.rpcId,
      result: { answers: response },
    })) return false;
    this.pendingInputs.delete(requestId);
    this.pendingServerRequestIds.delete(rpcRequestKey(pending.rpcId));
    this.host.options.onInputResolved?.(requestId);
    return true;
  }

  handleServerRequest(
    id: RpcId,
    method: string,
    params: JsonObject,
  ): void {
    if (this.host.isSettled()) return;
    const requestKey = rpcRequestKey(id);
    if (this.pendingServerRequestIds.has(requestKey)) {
      const message = "Codex reused an outstanding JSON-RPC request id.";
      this.host.setLastError(message);
      this.host.rememberFailure(
        "malformed-protocol",
        "Codex sent an ambiguous server request.",
        message,
      );
      this.emitActivity("system", "failed", message);
      // Do not emit a second response with the duplicate id. Cancellation
      // settles the original request exactly once before closing transport.
      this.hostTools.settle("cancel");
      this.host.cancel();
      return;
    }
    if (method === "item/tool/call") {
      this.hostTools.handle(id, params);
      return;
    }
    const parsedApproval = parseCodexApprovalRequest(method, params);
    if (parsedApproval) {
      if (
        parsedApproval.providerThreadId
        && !this.isOwnedProviderThread(parsedApproval.providerThreadId)
      ) {
        const message = "Codex sent an approval for a different provider thread.";
        this.host.writeMessage({ id, error: { code: -32602, message } });
        this.host.setLastError(message);
        this.emitActivity("system", "failed", message);
        this.host.cancel();
        return;
      }
      const { request: approval } = parsedApproval;
      if (isHostToolApprovalId(approval.requestId)) {
        const message = "Codex reused a reserved Inertia approval identity.";
        this.host.writeMessage({ id, error: { code: -32602, message } });
        this.host.setLastError(message);
        this.host.cancel();
        return;
      }
      if (approval.availableDecisions.length === 0) {
        const message =
          "Codex offered no approval decision supported by this client.";
        this.host.writeMessage({
          id,
          error: { code: -32602, message },
        });
        this.host.setLastError(message);
        this.emitActivity(
          "system",
          "failed",
          "Codex requested an unsupported approval decision",
        );
        this.host.cancel();
        return;
      }
      if (!this.reserveServerRequest(id)) return;
      this.pendingApprovals.set(approval.requestId, {
        rpcId: id,
        request: approval,
        protocol: parsedApproval.protocol,
        ...(parsedApproval.requestedPermissions
          ? { requestedPermissions: parsedApproval.requestedPermissions }
          : {}),
      });
      this.host.options.onApproval?.(approval);
      return;
    }
    if (isCodexApprovalRequestMethod(method)) {
      const message =
        "Codex sent an approval request this client could not safely represent.";
      this.host.writeMessage({
        id,
        error: { code: -32602, message },
      });
      this.host.setLastError(message);
      this.emitActivity(
        "system",
        "failed",
        "Codex requested an unsupported approval shape",
      );
      this.host.cancel();
      return;
    }

    const requestedInput = parseCodexOwnedInputRequest(method, params);
    if (requestedInput) {
      if (!this.subagents.isOwnedProviderTurn(
        requestedInput.providerThreadId,
        requestedInput.providerTurnId,
      )) {
        const message =
          "Codex sent a user-input request for a different provider turn.";
        this.host.writeMessage({ id, error: { code: -32602, message } });
        this.host.setLastError(message);
        this.emitActivity("system", "failed", message);
        this.host.cancel();
        return;
      }
      if (!this.reserveServerRequest(id)) return;
      const { request } = requestedInput;
      this.pendingInputs.set(request.requestId, {
        rpcId: id,
        request,
      });
      this.host.options.onInputRequest?.(request);
      return;
    }
    if (isCodexInputRequestMethod(method)) {
      const message =
        "Codex sent a user-input request this client could not safely represent.";
      this.host.writeMessage({
        id,
        error: { code: -32602, message },
      });
      this.host.setLastError(message);
      this.emitActivity(
        "system",
        "failed",
        "Codex requested an unsupported user-input shape",
      );
      this.host.cancel();
      return;
    }

    if (handleCodexAuxiliaryServerRequest({
      id,
      method,
      params,
      isOwnedProviderThread: (threadId) => this.isOwnedProviderThread(threadId),
      isOwnedProviderTurn: (threadId, turnId) =>
        this.subagents.isOwnedProviderTurn(threadId, turnId),
      writeMessage: this.host.writeMessage,
      setLastError: this.host.setLastError,
      emitActivity: (activityPhase, label) =>
        this.emitActivity("system", activityPhase, label),
      cancel: this.host.cancel,
    })) return;

    this.host.writeMessage({
      id,
      error: {
        code: -32601,
        message: "Method not supported by this client.",
      },
    });
  }

  private reserveServerRequest(id: RpcId): boolean {
    if (
      this.pendingServerRequestIds.size
      >= MAX_CODEX_PENDING_SERVER_REQUESTS
    ) {
      const message =
        `Codex exceeded the ${MAX_CODEX_PENDING_SERVER_REQUESTS}-request interaction limit.`;
      this.host.writeMessage({ id, error: { code: -32600, message } });
      this.host.setLastError(message);
      this.host.rememberFailure(
        "malformed-protocol",
        "Codex sent too many concurrent server requests.",
        message,
      );
      this.emitActivity("system", "failed", message);
      this.host.cancel();
      return false;
    }
    this.pendingServerRequestIds.add(rpcRequestKey(id));
    return true;
  }

  private isOwnedProviderThread(threadId: string): boolean {
    return this.subagents.isOwnedProviderThread(threadId);
  }

  private rejectMalformedSubagent(message: string): void {
    this.host.setLastError(message);
    this.host.rememberFailure(
      "malformed-protocol",
      "Codex sent malformed delegated-agent lifecycle data.",
      message,
    );
    this.emitActivity(
      "system",
      "failed",
      "Codex sent malformed delegated-agent lifecycle data",
    );
    this.host.cancel();
  }

  handleNotification(method: string, params: JsonObject): void {
    if (this.host.isSettled()) return;
    this.host.setLastProtocolMethod(method);
    if (method === "account/rateLimits/updated") {
      const limits = parseCodexRateLimits({
        rateLimits: params.rateLimits,
        rateLimitsByLimitId: params.rateLimitsByLimitId,
      });
      if (limits.length > 0) {
        this.host.options.onRateLimits?.(limits, false);
      }
      return;
    }
    if (method === "serverRequest/resolved") {
      this.handleResolvedRequest(params);
      return;
    }
    if (projectCodexSecurityNotification(
      method,
      params,
      (...activity) => this.host.options.onActivity?.(...activity),
    )) return;
    const notificationThreadId = boundedText(params.threadId, 512);
    const notificationTurnId = boundedText(params.turnId, 512)
      ?? boundedText(objectValue(params.turn)?.id, 512);
    if (this.subagents.handleNotification(method, params)) return;

    const runtimeProjection = projectCodexRuntimeNotification({
      providerThreadId: this.host.providerThreadId,
      activeTurnId: this.host.activeTurnId,
      emitActivity: (...activity) => this.host.options.onActivity?.(...activity),
    }, method, params);
    if (runtimeProjection === "active-thread-deleted") {
      const message = "Codex deleted the active thread before the turn completed.";
      this.host.setLastError(message);
      this.host.setTerminalEvent("thread/deleted");
      this.host.rememberFailure("codex-error", message);
      this.emitActivity("system", "failed", message);
      this.completeParentTurn("failed", 1);
      return;
    }
    if (runtimeProjection === "handled") return;

    if (method === "thread/closed") {
      if (notificationThreadId !== this.host.providerThreadId()) return;
      const message = "Codex closed the active thread before the turn completed.";
      this.host.setLastError(message);
      this.host.setTerminalEvent("thread/closed");
      this.host.rememberFailure("codex-error", message);
      this.emitActivity("system", "failed", message);
      this.completeParentTurn("failed", 1);
      return;
    }

    if (method === "thread/status/changed") {
      if (
        notificationThreadId !== this.host.providerThreadId()
      ) return;
      const status = stringValue(objectValue(params.status)?.type);
      if (status === "systemError" || status === "notLoaded") {
        this.emitActivity(
          "system",
          status === "systemError" ? "failed" : "info",
          status === "systemError"
            ? "Codex thread reported a system error"
            : "Codex thread is no longer loaded",
        );
      }
      return;
    }

    if (method === "hook/started" || method === "hook/completed") {
      if (
        notificationThreadId !== this.host.providerThreadId()
        || (
          notificationTurnId
          && this.host.activeTurnId()
          && notificationTurnId !== this.host.activeTurnId()
        )
      ) return;
      handleCodexHook(this.host, method, params);
      return;
    }

    if (method === "thread/goal/updated") {
      this.projectGoalUpdate(params);
      return;
    }
    if (method === "thread/goal/cleared") {
      const threadId = parseCodexGoalClearedNotification(params);
      if (threadId) this.projectGoalCleared(threadId);
      return;
    }

    if (method === "turn/started") {
      const phase = this.host.phase();
      if (
        phase !== "starting-turn"
        && phase !== "running"
        && phase !== "awaiting-goal-continuation"
      ) return;
      if (
        phase === "awaiting-goal-continuation"
        && this.nativeGoalStatus !== "active"
        && this.pendingGoalActivations === 0
      ) return;
      if (
        !this.host.providerThreadId()
        || notificationThreadId !== this.host.providerThreadId()
        || !notificationTurnId
        || this.completedTurnIds.has(notificationTurnId)
      ) return;
      if (
        phase !== "awaiting-goal-continuation"
        && this.host.activeTurnId()
        && notificationTurnId !== this.host.activeTurnId()
      ) return;
      if (this.goalContinuationTimer) {
        clearTimeout(this.goalContinuationTimer);
        this.goalContinuationTimer = undefined;
      }
      if (phase === "awaiting-goal-continuation") {
        this.discardPendingParentCompletion();
      }
      this.host.setActiveTurnId(notificationTurnId);
      this.host.setPhase("running");
      this.host.options.onStatus?.("running");
      this.emitActivity("turn", "started", "Turn started");
      return;
    }

    if (
      this.host.phase() !== "running"
      || !this.host.providerThreadId()
      || !this.host.activeTurnId()
      || notificationThreadId !== this.host.providerThreadId()
      || notificationTurnId !== this.host.activeTurnId()
    ) return;

    if (method === "item/agentMessage/delta") {
      const delta = stringValue(params.delta);
      if (!delta) return;
      const itemId = boundedText(params.itemId, 512);
      if (itemId && !this.trackStreamItem(this.deltaItems, itemId)) return;
      this.host.resultText.append(delta);
      this.host.options.onText?.(delta);
      return;
    }
    if (method === "item/reasoning/summaryTextDelta") {
      const delta = stringValue(params.delta);
      if (!delta) return;
      const itemId = boundedText(params.itemId, 512);
      if (
        itemId
        && !this.trackStreamItem(this.reasoningDeltaItems, itemId)
      ) return;
      this.host.options.onReasoning?.(delta);
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const usage = parseCodexTokenUsage(params.tokenUsage);
      if (usage) this.host.options.onUsage?.(usage);
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      handleCodexItem(
        {
          options: this.host.options,
          appendResultText: (text) => this.host.resultText.append(text),
          setLastActivityId: this.host.setLastActivityId,
          handleSubagentItem: (item, phase, threadId) =>
            this.subagents.handleItem(item, phase, threadId),
        },
        {
          deltaItems: this.deltaItems,
          reasoningDeltaItems: this.reasoningDeltaItems,
          itemActivities: this.itemActivities,
          maxTrackedActivities: MAX_CODEX_TRACKED_ITEM_ACTIVITIES,
        },
        method,
        params,
      );
      return;
    }
    if (method === "item/mcpToolCall/progress") {
      const itemId = boundedText(params.itemId, 1_000);
      const progress = boundedText(params.message, 8_000);
      if (!itemId || !progress) return;
      const activity = this.itemActivities.get(itemId) ?? {
        kind: "tool" as const,
        label: "MCP tool",
      };
      this.emitActivity(activity.kind, "started", activity.label, {
        activityId: itemId,
        detail: `Progress:\n${progress}`,
      });
      return;
    }
    if (method === "item/commandExecution/terminalInteraction") {
      const itemId = boundedText(params.itemId, 1_000);
      if (!itemId) return;
      const processId = boundedText(params.processId, 1_000);
      const input = boundedText(params.stdin, 8_000);
      const activity = this.itemActivities.get(itemId) ?? {
        kind: "command" as const,
        label: "Command",
      };
      const detail = [
        processId ? `Process: ${processId}` : null,
        input ? `Terminal input:\n${input}` : null,
      ].filter((value): value is string => Boolean(value)).join("\n\n");
      this.emitActivity(activity.kind, "started", activity.label, {
        activityId: itemId,
        ...(detail ? { detail } : {}),
      });
      return;
    }
    if (
      method === "item/commandExecution/outputDelta"
      || method === "item/fileChange/outputDelta"
    ) {
      const itemId = boundedText(params.itemId, 1_000);
      const delta = stringValue(params.delta);
      if (!itemId || !delta) return;
      const activity = this.itemActivities.get(itemId) ?? {
        kind: method === "item/commandExecution/outputDelta"
          ? "command" as const
          : "tool" as const,
        label: method === "item/commandExecution/outputDelta"
          ? "Command"
          : "File change",
      };
      this.emitActivity(activity.kind, "started", activity.label, {
        activityId: itemId,
        detail: providerActivityDetailSections({ output: delta }) ?? undefined,
      });
      return;
    }
    if (method === "error") {
      const error = objectValue(params.error);
      const message =
        boundedText(error?.message, 4_000) ?? "Codex reported an error.";
      this.host.setLastError(message);
      if (params.willRetry === true) {
        this.emitActivity(
          "system",
          "info",
          "Codex is retrying after an error",
          {
            ...(boundedText(params.itemId, 1_000)
              ? { activityId: boundedText(params.itemId, 1_000)! }
              : {}),
            detail: providerActivityDetailSections({ error: message })!,
          },
        );
      } else {
        this.host.rememberFailure(
          "codex-error",
          "Codex reported an error.",
          message,
        );
        this.emitActivity(
          "system",
          "failed",
          "Codex reported an error",
          {
            ...(boundedText(params.itemId, 1_000)
              ? { activityId: boundedText(params.itemId, 1_000)! }
              : {}),
            detail: providerActivityDetailSections({ error: message })!,
          },
        );
      }
      return;
    }
    if (method === "model/rerouted") {
      const fromModel = boundedText(params.fromModel, 160);
      const toModel = boundedText(params.toModel, 160);
      const reason = boundedText(params.reason, 500);
      this.emitActivity(
        "system",
        "info",
        fromModel && toModel
          ? `Model rerouted · ${fromModel} → ${toModel}`
          : "Codex rerouted the model",
        reason ? { detail: `Reason:\n${reason}` } : undefined,
      );
      return;
    }
    if (method === "thread/compacted") {
      this.emitActivity("system", "completed", "Context compacted");
      return;
    }
    if (method === "item/plan/delta") {
      const itemId = boundedText(params.itemId, 1_000);
      const delta = boundedText(params.delta, 8_000);
      if (!delta) return;
      this.emitActivity("turn", "started", "Plan updated", {
        ...(itemId ? { activityId: itemId } : {}),
        detail: `Progress:\n${delta}`,
      });
      return;
    }
    if (method === "turn/diff/updated") {
      const diff = boundedText(params.diff, 128_000);
      this.emitActivity(
        "tool",
        "started",
        "Patch updated",
        diff ? { detail: `Diff:\n${diff}` } : undefined,
      );
      return;
    }
    if (method === "turn/plan/updated") {
      const plan = parseCodexPlan(params);
      this.host.options.onPlan?.(plan.explanation, plan.steps);
      return;
    }
    if (method === "turn/completed") {
      if (!notificationTurnId) return;
      this.completedTurnIds.add(notificationTurnId);
      const turn = objectValue(params.turn);
      const status = stringValue(turn?.status);
      const turnError = objectValue(turn?.error);
      const lastError =
        boundedText(turnError?.message, 4_000) ?? this.host.lastError();
      if (lastError) this.host.setLastError(lastError);
      this.host.setTerminalEvent("turn/completed");
      const activityPhase = status === "completed"
        ? "completed"
        : status === "failed"
          ? "failed"
          : "info";
      const activityLabel = status === "completed"
        ? "Turn completed"
        : status === "failed"
          ? "Turn failed"
          : status === "interrupted"
            ? "Turn interrupted"
            : "Turn ended with an unknown status";
      this.emitActivity(
        "turn",
        activityPhase,
        activityLabel,
      );
      if (this.host.cancelRequested() || status === "interrupted") {
        this.completeParentTurn("cancelled", null);
      } else if (status === "failed") {
        this.host.rememberFailure(
          "codex-error",
          "Codex could not complete the turn.",
          lastError,
        );
        this.completeParentTurn("failed", 1);
      } else if (status === "completed") {
        if (
          this.nativeGoalStatus === "active"
          || this.pendingGoalMutations > 0
        ) {
          this.awaitGoalContinuation();
        } else {
          this.completeParentTurn("completed", 0);
        }
      } else {
        const detail = status
          ? `Unsupported parent turn status: ${status}`
          : "The parent turn status was missing.";
        this.host.rememberFailure(
          "malformed-protocol",
          "Codex ended the turn without a supported outcome.",
          detail,
        );
        this.completeParentTurn("failed", 1);
      }
      this.deltaItems.clear();
      this.reasoningDeltaItems.clear();
      this.itemActivities.clear();
    }
  }

  projectGoalResponse(
    threadId: string,
    goal: unknown,
    sequenceAtResponse: number,
  ): ProviderGoalSnapshot | null {
    const update = parseCodexGoalUpdatedNotification({ threadId, goal });
    if (!update || update.threadId !== this.host.providerThreadId()) {
      return null;
    }
    // The decoder can accept later notifications before the awaiting request
    // resumes. Prefer that sequenced snapshot when second-resolution provider
    // timestamps cannot distinguish the response from the later update.
    const supersededByNotification =
      this.nativeGoalSequence > sequenceAtResponse
      && (
        this.nativeGoalSnapshot === null
        || (
          this.nativeGoalUpdatedAt !== null
          && update.goal.updatedAt <= this.nativeGoalUpdatedAt
        )
      );
    if (supersededByNotification) {
      if (!this.nativeGoalSnapshot) {
        throw new Error(
          "Codex cleared the goal before the update completed.",
        );
      }
      return this.nativeGoalSnapshot;
    }
    if (!this.acceptGoalUpdate(update.threadId, update.goal, "response")) {
      return this.nativeGoalSnapshot ?? update.goal;
    }
    return update.goal;
  }

  projectGoalCleared(threadId: string): boolean {
    if (threadId !== this.host.providerThreadId()) return false;
    this.nativeGoalStatus = null;
    this.nativeGoalSnapshot = null;
    this.nativeGoalUpdatedAt = null;
    this.nativeGoalFingerprint = null;
    this.nativeGoalRevisionFingerprints.clear();
    this.nativeGoalSequence += 1;
    this.host.options.onGoalCleared?.(threadId);
    this.finishAwaitingGoalContinuation();
    return true;
  }

  projectGoalClearResponse(
    threadId: string,
    sequenceAtResponse: number,
  ): boolean {
    if (threadId !== this.host.providerThreadId()) return false;
    if (this.nativeGoalSequence > sequenceAtResponse) {
      return this.nativeGoalSnapshot === null;
    }
    return this.projectGoalCleared(threadId);
  }

  private projectGoalUpdate(
    params: JsonObject,
  ): ProviderGoalSnapshot | null {
    const update = parseCodexGoalUpdatedNotification(params);
    if (!update || update.threadId !== this.host.providerThreadId()) {
      return null;
    }
    return this.acceptGoalUpdate(update.threadId, update.goal)
      ? update.goal
      : null;
  }

  private acceptGoalUpdate(
    threadId: string,
    goal: ProviderGoalSnapshot,
    source: "notification" | "response" = "notification",
  ): boolean {
    if (
      this.nativeGoalUpdatedAt
      && goal.updatedAt < this.nativeGoalUpdatedAt
    ) return false;
    const fingerprint = JSON.stringify([
      goal.objective,
      goal.status,
      goal.tokenBudget,
      goal.tokensUsed,
      goal.timeUsedSeconds,
      goal.createdAt,
      goal.updatedAt,
    ]);
    if (goal.updatedAt !== this.nativeGoalUpdatedAt) {
      this.nativeGoalRevisionFingerprints.clear();
      this.nativeGoalFingerprint = null;
    } else if (
      source === "notification"
      && fingerprint !== this.nativeGoalFingerprint
      && this.nativeGoalRevisionFingerprints.has(fingerprint)
    ) {
      return false;
    }
    this.nativeGoalUpdatedAt = goal.updatedAt;
    this.nativeGoalStatus = goal.status;
    this.nativeGoalSnapshot = goal;
    this.nativeGoalFingerprint = fingerprint;
    this.nativeGoalRevisionFingerprints.add(fingerprint);
    this.nativeGoalSequence += 1;
    this.host.options.onGoalUpdated?.(threadId, goal);
    if (goal.status !== "active") {
      this.finishAwaitingGoalContinuation();
    }
    return true;
  }

  private awaitGoalContinuation(): void {
    this.host.setActiveTurnId(undefined);
    this.host.setPhase("awaiting-goal-continuation");
    this.armGoalContinuationTimer();
  }

  private armGoalContinuationTimer(): void {
    if (
      this.goalContinuationTimer
      || this.pendingGoalMutations > 0
      || this.host.phase() !== "awaiting-goal-continuation"
      || this.nativeGoalStatus !== "active"
    ) return;
    this.goalContinuationTimer = setTimeout(() => {
      this.goalContinuationTimer = undefined;
      this.host.rememberFailure(
        "goal-continuation-timeout",
        "Codex kept the goal active but did not start another turn in time.",
      );
      this.completeParentTurn("failed", 1);
    }, this.goalContinuationGraceMs);
    this.goalContinuationTimer.unref();
  }

  private finishAwaitingGoalContinuation(): void {
    if (this.host.phase() !== "awaiting-goal-continuation") return;
    if (this.goalContinuationTimer) {
      clearTimeout(this.goalContinuationTimer);
      this.goalContinuationTimer = undefined;
    }
    if (this.pendingGoalMutations > 0) return;
    this.completeParentTurn("completed", 0);
  }

  private completeParentTurn(
    status: CodexAppServerResult["status"],
    exitCode: number | null,
  ): void {
    if (status !== "cancelled" && this.pendingGoalMutations > 0) {
      this.pendingGoalMutationCompletion ??= { status, exitCode };
      return;
    }
    if (status !== "completed" || this.liveSubagentIds.size === 0) {
      this.host.finish(status, exitCode, null);
      return;
    }
    if (this.pendingParentCompletion) return;
    this.pendingParentCompletion = { status, exitCode };
    this.subagentDrainTimer = setTimeout(() => {
      this.subagentDrainTimer = undefined;
      this.finishPendingParentCompletion();
    }, this.subagentDrainTimeoutMs);
    this.subagentDrainTimer.unref();
  }

  private finishPendingParentCompletion(): void {
    const completion = this.pendingParentCompletion;
    if (!completion) return;
    this.pendingParentCompletion = null;
    if (this.subagentDrainTimer) {
      clearTimeout(this.subagentDrainTimer);
      this.subagentDrainTimer = undefined;
    }
    this.host.finish(completion.status, completion.exitCode, null);
  }

  private discardPendingParentCompletion(): void {
    this.pendingParentCompletion = null;
    if (this.subagentDrainTimer) {
      clearTimeout(this.subagentDrainTimer);
      this.subagentDrainTimer = undefined;
    }
  }

  private emitActivity(
    kind: "system" | "turn" | "tool" | "command" | "reasoning",
    phase: "started" | "completed" | "failed" | "info",
    label: string,
    detail?: Parameters<NonNullable<
      CodexAppServerOptions["onActivity"]
    >>[3],
  ): void {
    this.host.options.onActivity?.(kind, phase, label, detail);
  }

  private emitSubagent(
    update: Omit<CodexSubagentUpdate, "sequence" | "isLive">,
    authority: CodexSubagentAuthority,
    isLive = isLiveCodexSubagentStatus(update.status),
  ): void {
    const providerAgentId = update.providerAgentId;
    if (providerAgentId) {
      const current = this.subagentProjection.get(providerAgentId);
      if (!shouldAcceptCodexSubagentProjection(
        current,
        update,
        authority,
        isLive,
      )) return;
      this.subagentProjection.set(providerAgentId, {
        status: update.status,
        authority,
        isLive,
      });
      if (isLive) {
        this.liveSubagentIds.add(providerAgentId);
      } else {
        this.liveSubagentIds.delete(providerAgentId);
      }
    }
    this.subagentSequence += 1;
    this.host.options.onSubagent?.({
      sequence: this.subagentSequence,
      ...update,
      isLive,
    });
    if (
      this.pendingParentCompletion
      && this.liveSubagentIds.size === 0
    ) {
      this.finishPendingParentCompletion();
    }
  }

  private handleResolvedRequest(params: JsonObject): void {
    const resolvedRpcId = rpcId(params.requestId);
    if (resolvedRpcId === undefined) return;
    for (const [requestId, pending] of this.pendingApprovals) {
      if (pending.rpcId !== resolvedRpcId) continue;
      this.pendingApprovals.delete(requestId);
      this.pendingServerRequestIds.delete(rpcRequestKey(pending.rpcId));
      this.host.options.onApprovalResolved?.(requestId, "cancelled");
      this.emitActivity(
        "system",
        "completed",
        "Approval request resolved by Codex",
      );
      return;
    }
    for (const [requestId, pending] of this.pendingInputs) {
      if (pending.rpcId !== resolvedRpcId) continue;
      this.pendingInputs.delete(requestId);
      this.pendingServerRequestIds.delete(rpcRequestKey(pending.rpcId));
      this.host.options.onInputResolved?.(requestId);
      this.emitActivity(
        "system",
        "completed",
        "Input request resolved by Codex",
      );
      return;
    }
  }

  private trackStreamItem(items: Set<string>, itemId: string): boolean {
    if (items.has(itemId)) return true;
    if (items.size >= MAX_CODEX_TRACKED_ITEM_ACTIVITIES) {
      const message =
        `Codex exceeded the ${MAX_CODEX_TRACKED_ITEM_ACTIVITIES}-item streaming correlation limit.`;
      this.host.setLastError(message);
      this.host.rememberFailure(
        "malformed-protocol",
        "Codex sent too many concurrent streaming items.",
        message,
      );
      this.emitActivity("system", "failed", message);
      this.host.cancel();
      return false;
    }
    items.add(itemId);
    return true;
  }

}
