import {
  isCodexApprovalRequestMethod,
  parseCodexApprovalRequest,
} from "./approvals";
import {
  codexGoalContinuationGraceMs,
  codexSubagentDrainTimeoutMs,
  commandExecutionLabel,
  type CodexRunPhase,
} from "./app-server-config";
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
  parseCodexInputRequest,
} from "./questions";
import { completedReasoningSummary } from "./reasoning";
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

type CodexSubagentUpdate = Parameters<
  NonNullable<CodexAppServerOptions["onSubagent"]>
>[0];

type CodexSubagentAuthority = "activity" | "state" | "turn";

const SUBAGENT_AUTHORITY: Record<CodexSubagentAuthority, number> = {
  activity: 0,
  state: 1,
  turn: 2,
};

const LIVE_SUBAGENT_STATUSES = new Set<CodexSubagentUpdate["status"]>([
  "queued",
  "spawned",
  "running",
  "waiting",
]);

const TERMINAL_SUBAGENT_STATUSES =
  new Set<CodexSubagentUpdate["status"]>([
    "completed",
    "failed",
    "cancelled",
    "interrupted",
    "unknown",
    "lost",
  ]);

interface CodexSubagentProjection {
  status: CodexSubagentUpdate["status"];
  authority: CodexSubagentAuthority;
  isLive: boolean;
}

interface PendingParentCompletion {
  status: CodexAppServerResult["status"];
  exitCode: number | null;
}

export class CodexAppServerEvents {
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingInputs = new Map<string, PendingInput>();
  private readonly deltaItems = new Set<string>();
  private readonly reasoningDeltaItems = new Set<string>();
  private readonly childParents = new Map<string, string>();
  private readonly childResults = new Map<string, CappedTextBuffer>();
  private readonly childDeltaItems = new Set<string>();
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
  private nativeGoalStatus: AgentGoalStatus | null;

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
    this.liveSubagentIds.clear();
  }

  cancelPendingParentCompletion(): boolean {
    if (!this.pendingParentCompletion) return false;
    this.dispose();
    this.host.finish("cancelled", null, null);
    return true;
  }

  settleInteractions(): void {
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
    this.host.options.onInputResolved?.(requestId);
    return true;
  }

  handleServerRequest(
    id: RpcId,
    method: string,
    params: JsonObject,
  ): void {
    if (this.host.isSettled()) return;
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

    const requestedInput = parseCodexInputRequest(method, params);
    if (requestedInput) {
      this.pendingInputs.set(requestedInput.requestId, {
        rpcId: id,
        request: requestedInput,
      });
      this.host.options.onInputRequest?.(requestedInput);
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

    this.host.writeMessage({
      id,
      error: {
        code: -32601,
        message: "Method not supported by this client.",
      },
    });
  }

  private isOwnedProviderThread(threadId: string): boolean {
    const rootThreadId = this.host.providerThreadId();
    if (!rootThreadId) return false;
    let currentThreadId: string | undefined = threadId;
    const visited = new Set<string>();
    while (currentThreadId) {
      if (currentThreadId === rootThreadId) return true;
      if (visited.has(currentThreadId)) return false;
      visited.add(currentThreadId);
      currentThreadId = this.childParents.get(currentThreadId);
    }
    return false;
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
    if (method === "thread/started" && this.handleChildThread(params)) return;

    const notificationThreadId = boundedText(params.threadId, 512);
    const notificationTurnId = boundedText(params.turnId, 512)
      ?? boundedText(objectValue(params.turn)?.id, 512);
    if (
      notificationThreadId
      && this.childParents.has(notificationThreadId)
      && this.handleChildNotification(
        method,
        params,
        notificationThreadId,
      )
    ) return;

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
        !this.host.providerThreadId()
        || notificationThreadId !== this.host.providerThreadId()
        || !notificationTurnId
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
      if (itemId) this.deltaItems.add(itemId);
      this.host.resultText.append(delta);
      this.host.options.onText?.(delta);
      return;
    }
    if (method === "item/reasoning/summaryTextDelta") {
      const delta = stringValue(params.delta);
      if (!delta) return;
      const itemId = boundedText(params.itemId, 512);
      if (itemId) this.reasoningDeltaItems.add(itemId);
      this.host.options.onReasoning?.(delta);
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const usage = parseCodexTokenUsage(params.tokenUsage);
      if (usage) this.host.options.onUsage?.(usage);
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      this.handleItem(method, params);
      return;
    }
    if (method === "error") {
      const error = objectValue(params.error);
      const message =
        boundedText(error?.message, 4_000) ?? "Codex reported an error.";
      this.host.setLastError(message);
      if (params.willRetry !== true) {
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
    if (method === "turn/plan/updated") {
      const plan = parseCodexPlan(params);
      this.host.options.onPlan?.(plan.explanation, plan.steps);
      return;
    }
    if (method === "turn/completed") {
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
        if (this.nativeGoalStatus === "active") {
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
    }
  }

  projectGoalResponse(
    threadId: string,
    goal: unknown,
  ): ProviderGoalSnapshot | null {
    return this.projectGoalUpdate({ threadId, goal });
  }

  projectGoalCleared(threadId: string): boolean {
    if (threadId !== this.host.providerThreadId()) return false;
    this.nativeGoalStatus = null;
    this.host.options.onGoalCleared?.(threadId);
    this.finishAwaitingGoalContinuation();
    return true;
  }

  private projectGoalUpdate(
    params: JsonObject,
  ): ProviderGoalSnapshot | null {
    const update = parseCodexGoalUpdatedNotification(params);
    if (!update || update.threadId !== this.host.providerThreadId()) {
      return null;
    }
    this.nativeGoalStatus = update.goal.status;
    this.host.options.onGoalUpdated?.(update.threadId, update.goal);
    if (update.goal.status !== "active") {
      this.finishAwaitingGoalContinuation();
    }
    return update.goal;
  }

  private awaitGoalContinuation(): void {
    if (this.goalContinuationTimer) return;
    this.host.setActiveTurnId(undefined);
    this.host.setPhase("awaiting-goal-continuation");
    this.goalContinuationTimer = setTimeout(() => {
      this.goalContinuationTimer = undefined;
      this.completeParentTurn("completed", 0);
    }, this.goalContinuationGraceMs);
    this.goalContinuationTimer.unref();
  }

  private finishAwaitingGoalContinuation(): void {
    if (this.host.phase() !== "awaiting-goal-continuation") return;
    if (this.goalContinuationTimer) {
      clearTimeout(this.goalContinuationTimer);
      this.goalContinuationTimer = undefined;
    }
    this.completeParentTurn("completed", 0);
  }

  private completeParentTurn(
    status: CodexAppServerResult["status"],
    exitCode: number | null,
  ): void {
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
    isLive = LIVE_SUBAGENT_STATUSES.has(update.status),
  ): void {
    const providerAgentId = update.providerAgentId;
    if (providerAgentId) {
      const current = this.subagentProjection.get(providerAgentId);
      if (current) {
        const weaker =
          SUBAGENT_AUTHORITY[authority] < SUBAGENT_AUTHORITY[current.authority];
        const stronger =
          SUBAGENT_AUTHORITY[authority] > SUBAGENT_AUTHORITY[current.authority];
        const clarifiesUnknown =
          current.status === "unknown"
          && update.status !== "unknown"
          && SUBAGENT_AUTHORITY[authority]
            >= SUBAGENT_AUTHORITY[current.authority];
        const authoritativelyRevivesTerminalUnknown =
          !current.isLive
          && isLive
          && current.status === "unknown"
          && update.status !== "unknown"
          && stronger;
        if (
          !current.isLive
          && isLive
          && !authoritativelyRevivesTerminalUnknown
        ) {
          return;
        }
        if (
          TERMINAL_SUBAGENT_STATUSES.has(current.status)
          && (
            weaker
            || (
              !stronger
              && !clarifiesUnknown
              && update.status !== current.status
            )
          )
        ) {
          return;
        }
      }
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

  private collabStatus(
    providerStatus: string | null,
  ): CodexSubagentUpdate["status"] | null {
    if (providerStatus === "pendingInit") return "queued";
    if (providerStatus === "running") return "running";
    if (providerStatus === "interrupted") return "interrupted";
    if (providerStatus === "completed") return "completed";
    if (providerStatus === "errored") return "failed";
    if (providerStatus === "notFound") return "lost";
    if (providerStatus === "shutdown") return "unknown";
    return providerStatus ? "unknown" : null;
  }

  private emitCollabAgentItem(
    item: JsonObject,
    itemPhase: "started" | "completed",
  ): boolean {
    if (stringValue(item.type) !== "collabAgentToolCall") return false;
    const tool = stringValue(item.tool);
    if (
      tool !== "spawnAgent"
      && tool !== "sendInput"
      && tool !== "resumeAgent"
      && tool !== "wait"
      && tool !== "closeAgent"
    ) return true;
    const senderThreadId = boundedText(item.senderThreadId, 1_000);
    const receiverThreadIds = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds.flatMap((value) => {
          const id = boundedText(value, 1_000);
          return id ? [id] : [];
        })
      : [];
    const toolUseId = boundedText(item.id, 1_000) ?? null;
    const prompt = boundedText(item.prompt, 4_000) ?? null;
    const agentsStates = objectValue(item.agentsStates) ?? {};
    for (const providerAgentId of receiverThreadIds) {
      if (senderThreadId) {
        this.childParents.set(providerAgentId, senderThreadId);
      }
      const agentState = objectValue(agentsStates[providerAgentId]);
      const providerStatus =
        boundedText(agentState?.status, 200) ?? null;
      const exactStatus = this.collabStatus(providerStatus);
      const fallbackStatus: CodexSubagentUpdate["status"] | null =
        tool === "spawnAgent"
          ? itemPhase === "started" ? "spawned" : "running"
          : tool === "wait"
            ? itemPhase === "started" ? "waiting" : "running"
            : tool === "closeAgent"
              ? null
              : "running";
      const status = exactStatus ?? fallbackStatus;
      if (!status) continue;
      const terminal = TERMINAL_SUBAGENT_STATUSES.has(status);
      const isLive = status === "unknown"
        ? providerStatus !== "shutdown"
        : LIVE_SUBAGENT_STATUSES.has(status);
      this.emitSubagent({
        providerTaskId: null,
        providerAgentId,
        parentProviderAgentId:
          senderThreadId && senderThreadId !== this.host.providerThreadId()
            ? senderThreadId
            : null,
        parentProviderToolUseId: null,
        providerToolUseId: toolUseId,
        providerRole: null,
        providerName: null,
        providerStatus,
        status,
        description: tool === "spawnAgent" ? prompt : null,
        progress: terminal
          ? null
          : boundedText(agentState?.message, 4_000) ?? null,
        result: terminal
          ? boundedText(agentState?.message, 16_000) ?? null
          : null,
      }, exactStatus ? "state" : "activity", isLive);
    }
    return true;
  }

  private emitSubagentActivity(item: JsonObject): boolean {
    if (stringValue(item.type) !== "subAgentActivity") return false;
    const providerAgentId = boundedText(item.agentThreadId, 1_000);
    const kind = stringValue(item.kind);
    if (!providerAgentId || !kind) return true;
    const parentProviderAgentId =
      this.childParents.get(providerAgentId) ?? null;
    this.emitSubagent({
      providerTaskId: null,
      providerAgentId,
      parentProviderAgentId:
        parentProviderAgentId === this.host.providerThreadId()
          ? null
          : parentProviderAgentId,
      parentProviderToolUseId: null,
      providerToolUseId: boundedText(item.id, 1_000) ?? null,
      providerRole: null,
      providerName: null,
      providerStatus: kind,
      status: kind === "started" || kind === "interacted"
        ? "running"
        : kind === "interrupted"
          ? "interrupted"
          : "unknown",
      description: null,
      progress: null,
      result: null,
    }, kind === "started" || kind === "interacted" ? "activity" : "state",
    kind !== "interrupted");
    return true;
  }

  private handleResolvedRequest(params: JsonObject): void {
    const resolvedRpcId = rpcId(params.requestId);
    if (resolvedRpcId === undefined) return;
    for (const [requestId, pending] of this.pendingApprovals) {
      if (pending.rpcId !== resolvedRpcId) continue;
      this.pendingApprovals.delete(requestId);
      this.host.options.onApprovalResolved?.(requestId, "cancelled");
      return;
    }
    for (const [requestId, pending] of this.pendingInputs) {
      if (pending.rpcId !== resolvedRpcId) continue;
      this.pendingInputs.delete(requestId);
      this.host.options.onInputResolved?.(requestId);
      return;
    }
  }

  private handleChildThread(params: JsonObject): boolean {
    const thread = objectValue(params.thread);
    const childThreadId = boundedText(thread?.id, 1_000);
    const parentThreadId = boundedText(thread?.parentThreadId, 1_000);
    if (
      !childThreadId
      || !parentThreadId
      || childThreadId === this.host.providerThreadId()
      || (
        parentThreadId !== this.host.providerThreadId()
        && !this.childParents.has(parentThreadId)
      )
    ) return false;
    this.childParents.set(childThreadId, parentThreadId);
    this.emitSubagent({
      providerTaskId: null,
      providerAgentId: childThreadId,
      parentProviderAgentId:
        parentThreadId === this.host.providerThreadId()
          ? null
          : parentThreadId,
      parentProviderToolUseId: null,
      providerToolUseId: null,
      providerRole: boundedText(thread?.agentRole, 200) ?? null,
      providerName:
        boundedText(thread?.agentNickname, 200)
        ?? boundedText(thread?.name, 200)
        ?? null,
      providerStatus: null,
      status: "running",
      description: boundedText(thread?.preview, 4_000) ?? null,
      progress: null,
      result: null,
    }, "activity");
    return true;
  }

  private handleChildNotification(
    method: string,
    params: JsonObject,
    threadId: string,
  ): boolean {
    if (method === "item/agentMessage/delta") {
      const delta = stringValue(params.delta);
      if (delta) {
        const itemId = boundedText(params.itemId, 1_000);
        if (itemId) this.childDeltaItems.add(itemId);
        const buffer =
          this.childResults.get(threadId) ?? new CappedTextBuffer(16_000);
        buffer.append(delta);
        this.childResults.set(threadId, buffer);
      }
      return true;
    }
    if (method === "item/started" || method === "item/completed") {
      const item = objectValue(params.item);
      if (!item) return true;
      if (this.emitCollabAgentItem(
        item,
        method === "item/started" ? "started" : "completed",
      )) return true;
      if (this.emitSubagentActivity(item)) return true;
      if (
        method === "item/completed"
        && stringValue(item.type) === "agentMessage"
      ) {
        const text = stringValue(item.text);
        const itemId = boundedText(item.id, 1_000);
        if (text && (!itemId || !this.childDeltaItems.has(itemId))) {
          const buffer =
            this.childResults.get(threadId) ?? new CappedTextBuffer(16_000);
          buffer.append(text);
          this.childResults.set(threadId, buffer);
          this.emitSubagent({
            providerTaskId: null,
            providerAgentId: threadId,
            parentProviderAgentId:
              this.childParents.get(threadId) === this.host.providerThreadId()
                ? null
                : this.childParents.get(threadId) ?? null,
            parentProviderToolUseId: null,
            providerToolUseId: itemId ?? null,
            providerRole: null,
            providerName: null,
            providerStatus: null,
            status: "running",
            description: null,
            progress: boundedText(text, 4_000) ?? null,
            result: null,
          }, "activity");
        }
      }
      return true;
    }
    if (method !== "turn/completed") return false;
    const turn = objectValue(params.turn);
    const status = stringValue(turn?.status);
    const turnError = objectValue(turn?.error);
    const result = this.childResults.get(threadId)?.toString();
    const terminalStatus: CodexSubagentUpdate["status"] =
      status === "completed"
        ? "completed"
        : status === "failed"
          ? "failed"
          : status === "interrupted"
            ? "interrupted"
            : "unknown";
    const failure = boundedText(turnError?.message, 16_000) ?? null;
    const output = boundedText(result, 16_000) ?? null;
    this.emitSubagent({
      providerTaskId: null,
      providerAgentId: threadId,
      parentProviderAgentId:
        this.childParents.get(threadId) === this.host.providerThreadId()
          ? null
          : this.childParents.get(threadId) ?? null,
      parentProviderToolUseId: null,
      providerToolUseId: null,
      providerRole: null,
      providerName: null,
      providerStatus: boundedText(status, 200) ?? null,
      status: terminalStatus,
      description: null,
      progress: null,
      result: terminalStatus === "failed"
        ? failure ?? output
        : output ?? failure,
    }, "turn");
    this.childResults.delete(threadId);
    return true;
  }

  private handleItem(
    method: "item/started" | "item/completed",
    params: JsonObject,
  ): void {
    const item = objectValue(params.item);
    const activityId = boundedText(item?.id, 1_000);
    if (activityId) this.host.setLastActivityId(activityId);
    if (
      item
      && this.emitCollabAgentItem(
        item,
        method === "item/started" ? "started" : "completed",
      )
    ) return;
    if (item && this.emitSubagentActivity(item)) return;
    const itemType = stringValue(item?.type);
    const phase = method === "item/completed" ? "completed" : "started";
    if (itemType === "reasoning") {
      this.emitActivity("reasoning", phase, "Thinking");
      if (method === "item/completed" && item) {
        const summary = completedReasoningSummary(
          item,
          this.reasoningDeltaItems,
        );
        if (summary) this.host.options.onReasoning?.(summary);
      }
    } else if (itemType === "commandExecution" && item) {
      const command = item.command ?? item.cmd;
      const output = item.aggregatedOutput
        ?? item.output
        ?? [item.stdout, item.stderr];
      const activityDetail = providerActivityDetailSections({
        command,
        ...(method === "item/completed" ? { output } : {}),
      });
      this.emitActivity(
        "command",
        phase,
        commandExecutionLabel(item),
        {
          ...(activityId ? { activityId } : {}),
          ...(activityDetail ? { detail: activityDetail } : {}),
        },
      );
    } else if (itemType === "fileChange") {
      this.emitActivity(
        "tool",
        phase,
        "File change",
        activityId ? { activityId } : undefined,
      );
    } else if (itemType === "agentMessage" && method === "item/completed") {
      const itemId = boundedText(item?.id, 512);
      const text = stringValue(item?.text);
      if (text && (!itemId || !this.deltaItems.has(itemId))) {
        this.host.resultText.append(text);
        this.host.options.onText?.(text);
      }
    }
  }
}
