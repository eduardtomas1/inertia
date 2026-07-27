import { spawn } from "node:child_process";

import { INERTIA_VERSION } from "../shared/version";
import { staleProviderSessionDecision } from "../shared/continuation-policy";
import { parseCodexApprovalRequest } from "./codex/approvals";
import { parseCodexPlan } from "./codex/plans";
import {
  boundedText,
  CappedTextBuffer,
  JsonLineDecoder,
  objectValue,
  rpcId,
  stringValue,
  type JsonObject,
  type JsonLineDecoderFailure,
  type RpcId,
} from "./codex/protocol";
import { codexInputAnswers, parseCodexInputRequest } from "./codex/questions";
import { completedReasoningSummary } from "./codex/reasoning";
import { parseCodexTokenUsage } from "./codex/usage";
import { parseCodexRateLimits } from "./codex-metadata";
import type {
  CodexAppServerOptions,
  CodexAppServerResult,
  CodexAppServerRun,
} from "./codex/types";
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentInputRequest,
} from "./provider/interactions";
import {
  providerActivityDetailSections,
  sanitizeProviderActivityDetail,
} from "./provider/activity-detail";
import type { ProviderRunFailure } from "./provider/contracts";
import { providerProcessInvocation } from "./provider/process";
import { terminateProcessTree } from "./process-lifecycle";

export type {
  CodexAppServerOptions,
  CodexAppServerResult,
  CodexAppServerRun,
  CodexUsageSnapshot,
} from "./codex/types";
export type {
  AgentApprovalDecision,
  AgentApprovalKind,
  AgentApprovalNetworkScope,
  AgentApprovalPermissionRoot,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentInputQuestion,
  AgentPlanStep,
} from "./provider/interactions";

interface PendingClientRequest {
  method: string;
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface PendingApproval {
  rpcId: RpcId;
  request: AgentApprovalRequest;
  protocol: "decision" | "permissions";
  requestedPermissions?: JsonObject;
}

interface PendingInput {
  rpcId: RpcId;
  request: AgentInputRequest;
}

export const CODEX_APP_SERVER_MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const CODEX_APP_SERVER_MAX_PROTOCOL_BYTES = 256 * 1024 * 1024;
const MAX_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_DIAGNOSTIC_CHARS = 32 * 1024;
const RPC_TIMEOUT_MS = 30_000;
const TRANSPORT_CLOSE_GRACE_MS = 100;

type CodexRunPhase = "opening" | "starting-turn" | "running" | "settled";

function codexProtocolLimits(
  override: CodexAppServerOptions["protocolLimits"],
): { maxFrameBytes: number; maxProtocolBytes: number } {
  if (!override) {
    return {
      maxFrameBytes: CODEX_APP_SERVER_MAX_FRAME_BYTES,
      maxProtocolBytes: CODEX_APP_SERVER_MAX_PROTOCOL_BYTES,
    };
  }
  if (
    !Number.isSafeInteger(override.maxFrameBytes)
    || override.maxFrameBytes < 1
    || !Number.isSafeInteger(override.maxProtocolBytes)
    || override.maxProtocolBytes < override.maxFrameBytes
  ) {
    throw new Error("The Codex App Server protocol limits are invalid.");
  }
  return override;
}

function commandExecutionLabel(item: JsonObject): string {
  const raw = boundedText(item.command, 4_000)
    ?? boundedText(item.cmd, 4_000)
    ?? (Array.isArray(item.command)
      ? item.command.filter((value): value is string => typeof value === "string").join(" ")
      : undefined);
  if (!raw) return "Command";
  const packageScript = /\b(npm|pnpm|yarn|bun)\s+(?:(run)\s+)?([A-Za-z0-9:_-]{1,80})/u.exec(raw);
  if (!packageScript) return "Command";
  return `${packageScript[1]} ${packageScript[2] ? "run " : ""}${packageScript[3]}`;
}

interface CodexAccessPolicy {
  approvalPolicy: "untrusted" | "on-request" | "never";
  threadSandbox: "read-only" | "workspace-write" | "danger-full-access";
  turnSandboxPolicy: JsonObject;
}

function codexAccessPolicy(options: Pick<CodexAppServerOptions, "access" | "planMode">): CodexAccessPolicy {
  if (options.access === "full") {
    return {
      approvalPolicy: "never",
      threadSandbox: "danger-full-access",
      turnSandboxPolicy: { type: "dangerFullAccess" },
    };
  }

  const readOnly = options.planMode || options.access === "supervised";
  return {
    approvalPolicy: options.access === "supervised" ? "untrusted" : "on-request",
    threadSandbox: readOnly ? "read-only" : "workspace-write",
    turnSandboxPolicy: readOnly
      ? { type: "readOnly", networkAccess: false }
      : { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  };
}

function isUnsupportedFullAccessError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const unsupported = "(?:unknown|unsupported|unrecognized|invalid)";
  const fullAccess = "(?:danger-full-access|dangerFullAccess)";
  return new RegExp(`${unsupported}.{0,160}${fullAccess}|${fullAccess}.{0,160}${unsupported}`, "iu").test(message);
}

function isStaleResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("thread") && ["not found", "missing", "unknown", "does not exist", "no such"].some((part) => message.includes(part));
}

function validateCodexModelProvider(
  options: Pick<CodexAppServerOptions, "environment" | "modelProvider">,
): CodexAppServerOptions["modelProvider"] {
  const provider = options.modelProvider;
  if (!provider) return undefined;
  let baseUrl: URL;
  try {
    baseUrl = new URL(provider.baseUrl);
  } catch {
    throw new Error("The Codex Responses backend configuration is invalid.");
  }
  const literalLoopback = baseUrl.hostname === "localhost"
    || baseUrl.hostname === "[::1]"
    || (
      baseUrl.hostname.split(".").length === 4
      && baseUrl.hostname.split(".")[0] === "127"
      && baseUrl.hostname.split(".").every((part) =>
        /^\d{1,3}$/u.test(part) && Number(part) <= 255)
    );
  if (
    !/^[A-Za-z0-9_-]{1,64}$/u.test(provider.providerId)
    || provider.displayName.length < 1
    || provider.displayName.length > 120
    || /[\0\r\n]/u.test(provider.displayName)
    || (
      baseUrl.protocol !== "https:"
      && !(baseUrl.protocol === "http:" && literalLoopback)
    )
    || Boolean(baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash)
    || provider.baseUrl.length > 2_048
  ) {
    throw new Error("The Codex Responses backend configuration is invalid.");
  }
  if (
    provider.credentialEnvironmentKey !== null
    && (
      !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(provider.credentialEnvironmentKey)
      || !options.environment[provider.credentialEnvironmentKey]
    )
  ) {
    throw new Error("The Codex Responses backend credential is unavailable.");
  }
  return provider;
}

export function startCodexAppServerRun(options: CodexAppServerOptions): CodexAppServerRun {
  const modelProvider = validateCodexModelProvider(options);
  const protocolLimits = codexProtocolLimits(options.protocolLimits);
  const invocation = providerProcessInvocation(options.executable, ["app-server"], options.environment);
  const child = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: options.environment,
    detached: process.platform !== "win32",
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const resultText = new CappedTextBuffer(MAX_TEXT_CHARS);
  const diagnostic = new CappedTextBuffer(MAX_DIAGNOSTIC_CHARS);
  const pendingRequests = new Map<number, PendingClientRequest>();
  const pendingApprovals = new Map<string, PendingApproval>();
  const pendingInputs = new Map<string, PendingInput>();
  const deltaItems = new Set<string>();
  const reasoningDeltaItems = new Set<string>();
  const childParents = new Map<string, string>();
  const childResults = new Map<string, CappedTextBuffer>();
  const childDeltaItems = new Set<string>();
  let nextRequestId = 1;
  let subagentSequence = 0;
  let providerThreadId = options.sessionId;
  let activeTurnId: string | undefined;
  let cancelRequested = false;
  let settled = false;
  let spawned = false;
  let phase: CodexRunPhase = "opening";
  let lastError: string | undefined;
  let failure: ProviderRunFailure | undefined;
  let lastProtocolMethod: string | undefined;
  let lastActivityId: string | undefined;
  let terminalEvent: string | undefined;
  let transportCloseTimer: NodeJS.Timeout | undefined;
  let decoder: JsonLineDecoder | undefined;
  let compatibilityError: CodexAppServerResult["compatibilityError"];
  let continuationError: CodexAppServerResult["continuationError"];
  let resolveResult!: (result: CodexAppServerResult) => void;

  const result = new Promise<CodexAppServerResult>((resolve) => {
    resolveResult = resolve;
  });

  const rememberFailure = (
    reason: ProviderRunFailure["reason"],
    message: string,
    technicalDetail?: string,
  ): void => {
    failure ??= {
      reason,
      message,
      phase,
      ...(terminalEvent ? { terminalEvent } : {}),
      ...(lastActivityId ? { activityId: lastActivityId } : {}),
      ...(technicalDetail ? { technicalDetail } : {}),
    };
  };

  const settledFailure = (
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): ProviderRunFailure | undefined => {
    if (!failure) return undefined;
    const details = [
      `Reason: ${failure.reason}`,
      `Phase: ${failure.phase ?? phase}`,
      `Exit code: ${exitCode ?? "none"}`,
      `Signal: ${signal ?? "none"}`,
      `Terminal event: ${failure.terminalEvent ?? terminalEvent ?? "not received"}`,
      `Turn: ${activeTurnId ?? "not started"}`,
      `Activity: ${failure.activityId ?? lastActivityId ?? "not reported"}`,
      `Last protocol method: ${lastProtocolMethod ?? "none"}`,
      failure.technicalDetail,
      lastError,
      diagnostic.toString(),
    ].filter((value): value is string => Boolean(value));
    const technicalDetail = sanitizeProviderActivityDetail(details.join("\n"), {
      workspaceRoot: options.cwd,
    });
    return {
      ...failure,
      ...(terminalEvent ? { terminalEvent } : {}),
      ...(lastActivityId ? { activityId: lastActivityId } : {}),
      ...(technicalDetail ? { technicalDetail } : {}),
    };
  };

  const writeMessage = (message: JsonObject): boolean => {
    if (settled || child.stdin.destroyed || !child.stdin.writable) return false;
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      rememberFailure(
        "transport-closed",
        "The Codex App Server connection closed while sending a request.",
      );
      return false;
    }
  };

  const settlePendingRequests = (message: string): void => {
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    pendingRequests.clear();
  };

  const settleApprovals = (decision: "cancelled"): void => {
    for (const { rpcId: id, request, protocol } of pendingApprovals.values()) {
      writeMessage({
        id,
        result: protocol === "permissions" ? { permissions: {}, scope: "turn" } : { decision: "cancel" },
      });
      options.onApprovalResolved?.(request.requestId, decision);
    }
    pendingApprovals.clear();
  };

  const settleInputs = (): void => {
    for (const { rpcId: id, request } of pendingInputs.values()) {
      writeMessage({ id, result: { answers: {} } });
      options.onInputResolved?.(request.requestId);
    }
    pendingInputs.clear();
  };

  const finish = (
    status: CodexAppServerResult["status"],
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    if (settled) return;
    if (transportCloseTimer) {
      clearTimeout(transportCloseTimer);
      transportCloseTimer = undefined;
    }
    const finalFailure = status === "failed"
      ? settledFailure(exitCode, signal)
      : undefined;
    settled = true;
    phase = "settled";
    decoder?.stop();
    settlePendingRequests("Codex App Server stopped before responding.");
    settleApprovals("cancelled");
    settleInputs();
    resolveResult({
      status,
      ...(providerThreadId ? { sessionId: providerThreadId } : {}),
      text: resultText.toString(),
      textTruncated: resultText.truncated,
      exitCode,
      signal,
      ...((lastError || diagnostic.toString()) ? { diagnostic: lastError ?? diagnostic.toString() } : {}),
      ...(finalFailure ? { failure: finalFailure } : {}),
      ...(compatibilityError ? { compatibilityError } : {}),
      ...(continuationError ? { continuationError } : {}),
    });
    if (child.exitCode === null && child.signalCode === null) terminateProcessTree(child, false);
  };

  const request = (method: string, params: JsonObject): Promise<JsonObject> => {
    const id = nextRequestId;
    nextRequestId += 1;
    return new Promise<JsonObject>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        rememberFailure(
          "rpc-timeout",
          "Codex App Server did not respond in time.",
          `RPC method: ${method}`,
        );
        reject(new Error(`${method} timed out.`));
      }, options.rpcTimeoutMs ?? RPC_TIMEOUT_MS);
      timeout.unref();
      pendingRequests.set(id, { method, resolve, reject, timeout });
      if (!writeMessage({ method, id, params })) {
        clearTimeout(timeout);
        pendingRequests.delete(id);
        reject(new Error(`Could not send ${method}.`));
      }
    });
  };

  const notify = (method: string, params?: JsonObject): void => {
    writeMessage(params === undefined ? { method } : { method, params });
  };

  const emitActivity = (
    kind: "system" | "turn" | "tool" | "command" | "reasoning",
    phase: "started" | "completed" | "failed" | "info",
    label: string,
    detail?: Parameters<NonNullable<CodexAppServerOptions["onActivity"]>>[3],
  ): void => options.onActivity?.(kind, phase, label, detail);

  type CodexSubagentUpdate = Parameters<
    NonNullable<CodexAppServerOptions["onSubagent"]>
  >[0];

  const emitSubagent = (
    update: Omit<CodexSubagentUpdate, "sequence">,
  ): void => {
    subagentSequence += 1;
    options.onSubagent?.({ sequence: subagentSequence, ...update });
  };

  const collabStatus = (
    value: unknown,
  ): CodexSubagentUpdate["status"] | null => {
    if (value === "pendingInit") return "spawned";
    if (value === "running") return "running";
    if (value === "interrupted") return "cancelled";
    if (value === "completed" || value === "shutdown") return "completed";
    if (value === "errored") return "failed";
    if (value === "notFound") return "lost";
    return null;
  };

  const emitCollabAgentItem = (
    item: JsonObject,
    itemPhase: "started" | "completed",
  ): boolean => {
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
      if (senderThreadId) childParents.set(providerAgentId, senderThreadId);
      const agentState = objectValue(agentsStates[providerAgentId]);
      const exactStatus = collabStatus(agentState?.status);
      const fallbackStatus: CodexSubagentUpdate["status"] =
        tool === "spawnAgent"
          ? itemPhase === "started" ? "spawned" : "running"
          : tool === "wait"
            ? itemPhase === "started" ? "waiting" : "running"
            : tool === "closeAgent"
              ? "cancelled"
              : "running";
      emitSubagent({
        providerTaskId: null,
        providerAgentId,
        parentProviderAgentId:
          senderThreadId && senderThreadId !== providerThreadId
            ? senderThreadId
            : null,
        parentProviderToolUseId: null,
        providerToolUseId: toolUseId,
        providerRole: null,
        providerName: null,
        status: exactStatus ?? fallbackStatus,
        description: tool === "spawnAgent" ? prompt : null,
        progress: boundedText(agentState?.message, 4_000) ?? null,
        result: exactStatus === "completed"
          ? boundedText(agentState?.message, 16_000) ?? null
          : null,
      });
    }
    return true;
  };

  const emitSubagentActivity = (item: JsonObject): boolean => {
    if (stringValue(item.type) !== "subAgentActivity") return false;
    const providerAgentId = boundedText(item.agentThreadId, 1_000);
    const kind = stringValue(item.kind);
    if (!providerAgentId || !kind) return true;
    const parentProviderAgentId = childParents.get(providerAgentId) ?? null;
    emitSubagent({
      providerTaskId: null,
      providerAgentId,
      parentProviderAgentId:
        parentProviderAgentId === providerThreadId
          ? null
          : parentProviderAgentId,
      parentProviderToolUseId: null,
      providerToolUseId: boundedText(item.id, 1_000) ?? null,
      providerRole: null,
      providerName: null,
      status: kind === "started"
        ? "running"
        : kind === "interrupted"
          ? "cancelled"
          : "running",
      description: null,
      progress: null,
      result: null,
    });
    return true;
  };

  const handleServerRequest = (id: RpcId, method: string, params: JsonObject): void => {
    if (settled) return;
    const parsedApproval = parseCodexApprovalRequest(method, params);
    if (parsedApproval) {
      const { request: approval } = parsedApproval;
      if (approval.availableDecisions.length === 0) {
        const message = "Codex offered no approval decision supported by this client.";
        writeMessage({ id, error: { code: -32602, message } });
        lastError = message;
        emitActivity("system", "failed", "Codex requested an unsupported approval decision");
        cancel();
        return;
      }
      pendingApprovals.set(approval.requestId, {
        rpcId: id,
        request: approval,
        protocol: parsedApproval.protocol,
        ...(parsedApproval.requestedPermissions ? { requestedPermissions: parsedApproval.requestedPermissions } : {}),
      });
      options.onApproval?.(approval);
      return;
    }

    const requestedInput = parseCodexInputRequest(method, params);
    if (requestedInput) {
      pendingInputs.set(requestedInput.requestId, { rpcId: id, request: requestedInput });
      options.onInputRequest?.(requestedInput);
      return;
    }

    // Unknown server-initiated methods are rejected rather than guessed or auto-approved.
    writeMessage({ id, error: { code: -32601, message: "Method not supported by this client." } });
  };

  const handleNotification = (method: string, params: JsonObject): void => {
    if (settled) return;
    lastProtocolMethod = method;
    if (method === "account/rateLimits/updated") {
      const limits = parseCodexRateLimits({ rateLimits: params.rateLimits, rateLimitsByLimitId: params.rateLimitsByLimitId });
      if (limits.length > 0) options.onRateLimits?.(limits, false);
      return;
    }
    if (method === "serverRequest/resolved") {
      const resolvedRpcId = rpcId(params.requestId);
      if (resolvedRpcId === undefined) return;
      for (const [requestId, pending] of pendingApprovals) {
        if (pending.rpcId !== resolvedRpcId) continue;
        pendingApprovals.delete(requestId);
        options.onApprovalResolved?.(requestId, "cancelled");
        return;
      }
      for (const [requestId, pending] of pendingInputs) {
        if (pending.rpcId !== resolvedRpcId) continue;
        pendingInputs.delete(requestId);
        options.onInputResolved?.(requestId);
        return;
      }
      return;
    }

    if (method === "thread/started") {
      const thread = objectValue(params.thread);
      const childThreadId = boundedText(thread?.id, 1_000);
      const parentThreadId = boundedText(thread?.parentThreadId, 1_000);
      if (
        childThreadId
        && parentThreadId
        && childThreadId !== providerThreadId
        && (
          parentThreadId === providerThreadId
          || childParents.has(parentThreadId)
        )
      ) {
        childParents.set(childThreadId, parentThreadId);
        emitSubagent({
          providerTaskId: null,
          providerAgentId: childThreadId,
          parentProviderAgentId:
            parentThreadId === providerThreadId ? null : parentThreadId,
          parentProviderToolUseId: null,
          providerToolUseId: null,
          providerRole: boundedText(thread?.agentRole, 200) ?? null,
          providerName:
            boundedText(thread?.agentNickname, 200)
            ?? boundedText(thread?.name, 200)
            ?? null,
          status: "running",
          description: boundedText(thread?.preview, 4_000) ?? null,
          progress: null,
          result: null,
        });
        return;
      }
    }

    const notificationThreadId = boundedText(params.threadId, 512);
    const notificationTurnId = boundedText(params.turnId, 512) ?? boundedText(objectValue(params.turn)?.id, 512);
    const knownChild = notificationThreadId
      ? childParents.has(notificationThreadId)
      : false;

    if (knownChild && notificationThreadId) {
      if (method === "item/agentMessage/delta") {
        const delta = stringValue(params.delta);
        if (delta) {
          const itemId = boundedText(params.itemId, 1_000);
          if (itemId) childDeltaItems.add(itemId);
          const buffer = childResults.get(notificationThreadId)
            ?? new CappedTextBuffer(16_000);
          buffer.append(delta);
          childResults.set(notificationThreadId, buffer);
        }
        return;
      }
      if (method === "item/started" || method === "item/completed") {
        const item = objectValue(params.item);
        if (!item) return;
        if (emitCollabAgentItem(
          item,
          method === "item/started" ? "started" : "completed",
        )) return;
        if (emitSubagentActivity(item)) return;
        if (
          method === "item/completed"
          && stringValue(item.type) === "agentMessage"
        ) {
          const text = stringValue(item.text);
          const itemId = boundedText(item.id, 1_000);
          if (text && (!itemId || !childDeltaItems.has(itemId))) {
            const buffer = childResults.get(notificationThreadId)
              ?? new CappedTextBuffer(16_000);
            buffer.append(text);
            childResults.set(notificationThreadId, buffer);
            emitSubagent({
              providerTaskId: null,
              providerAgentId: notificationThreadId,
              parentProviderAgentId:
                childParents.get(notificationThreadId) === providerThreadId
                  ? null
                  : childParents.get(notificationThreadId) ?? null,
              parentProviderToolUseId: null,
              providerToolUseId: itemId ?? null,
              providerRole: null,
              providerName: null,
              status: "running",
              description: null,
              progress: boundedText(text, 4_000) ?? null,
              result: null,
            });
          }
        }
        return;
      }
      if (method === "turn/completed") {
        const turn = objectValue(params.turn);
        const status = stringValue(turn?.status);
        const turnError = objectValue(turn?.error);
        const result = childResults.get(notificationThreadId)?.toString();
        emitSubagent({
          providerTaskId: null,
          providerAgentId: notificationThreadId,
          parentProviderAgentId:
            childParents.get(notificationThreadId) === providerThreadId
              ? null
              : childParents.get(notificationThreadId) ?? null,
          parentProviderToolUseId: null,
          providerToolUseId: null,
          providerRole: null,
          providerName: null,
          status: status === "failed"
            ? "failed"
            : status === "interrupted"
              ? "cancelled"
              : "completed",
          description: null,
          progress: null,
          result:
            boundedText(turnError?.message, 16_000)
            ?? boundedText(result, 16_000)
            ?? null,
        });
        childResults.delete(notificationThreadId);
        return;
      }
    }

    if (method === "turn/started") {
      if (phase !== "starting-turn" && phase !== "running") return;
      if (!providerThreadId || notificationThreadId !== providerThreadId || !notificationTurnId) return;
      if (activeTurnId && notificationTurnId !== activeTurnId) return;
      activeTurnId = notificationTurnId;
      phase = "running";
      options.onStatus?.("running");
      emitActivity("turn", "started", "Turn started");
      return;
    }

    if (phase !== "running" || !providerThreadId || !activeTurnId) return;
    if (notificationThreadId !== providerThreadId || notificationTurnId !== activeTurnId) return;

    if (method === "item/agentMessage/delta") {
      const delta = stringValue(params.delta);
      if (!delta) return;
      const itemId = boundedText(params.itemId, 512);
      if (itemId) deltaItems.add(itemId);
      resultText.append(delta);
      options.onText?.(delta);
      return;
    }

    if (method === "item/reasoning/summaryTextDelta") {
      const delta = stringValue(params.delta);
      if (!delta) return;
      const itemId = boundedText(params.itemId, 512);
      if (itemId) reasoningDeltaItems.add(itemId);
      options.onReasoning?.(delta);
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      const usage = parseCodexTokenUsage(params.tokenUsage);
      if (usage) options.onUsage?.(usage);
      return;
    }

    if (method === "item/started" || method === "item/completed") {
      const item = objectValue(params.item);
      lastActivityId = boundedText(item?.id, 1_000) ?? lastActivityId;
      if (
        item
        && emitCollabAgentItem(
          item,
          method === "item/started" ? "started" : "completed",
        )
      ) return;
      if (item && emitSubagentActivity(item)) return;
      const itemType = stringValue(item?.type);
      const phase = method === "item/completed" ? "completed" : "started";
      if (itemType === "reasoning") {
        emitActivity("reasoning", phase, "Thinking");
        if (method === "item/completed" && item) {
          const summary = completedReasoningSummary(item, reasoningDeltaItems);
          if (summary) options.onReasoning?.(summary);
        }
      }
      else if (itemType === "commandExecution" && item) {
        const command = item.command ?? item.cmd;
        const output = item.aggregatedOutput
          ?? item.output
          ?? [item.stdout, item.stderr];
        const activityDetail = providerActivityDetailSections({
          command,
          ...(method === "item/completed" ? { output } : {}),
        });
        emitActivity(
          "command",
          phase,
          commandExecutionLabel(item),
          {
            ...(boundedText(item.id, 1_000)
              ? { activityId: boundedText(item.id, 1_000)! }
              : {}),
            ...(activityDetail
              ? { detail: activityDetail }
              : {}),
          },
        );
      }
      else if (itemType === "fileChange") {
        emitActivity(
          "tool",
          phase,
          "File change",
          boundedText(item?.id, 1_000)
            ? { activityId: boundedText(item?.id, 1_000)! }
            : undefined,
        );
      }
      else if (itemType === "agentMessage" && method === "item/completed") {
        const itemId = boundedText(item?.id, 512);
        const text = stringValue(item?.text);
        if (text && (!itemId || !deltaItems.has(itemId))) {
          resultText.append(text);
          options.onText?.(text);
        }
      }
      return;
    }

    if (method === "error") {
      const error = objectValue(params.error);
      lastError = boundedText(error?.message, 4_000) ?? "Codex reported an error.";
      if (params.willRetry !== true) {
        rememberFailure("codex-error", "Codex reported an error.", lastError);
        emitActivity(
          "system",
          "failed",
          "Codex reported an error",
          {
            ...(boundedText(params.itemId, 1_000)
              ? { activityId: boundedText(params.itemId, 1_000)! }
              : {}),
            detail: providerActivityDetailSections({ error: lastError })!,
          },
        );
      }
      return;
    }

    if (method === "turn/plan/updated") {
      const plan = parseCodexPlan(params);
      options.onPlan?.(plan.explanation, plan.steps);
      return;
    }

    if (method === "turn/completed") {
      const turn = objectValue(params.turn);
      const status = stringValue(turn?.status);
      const turnError = objectValue(turn?.error);
      lastError = boundedText(turnError?.message, 4_000) ?? lastError;
      terminalEvent = "turn/completed";
      emitActivity("turn", status === "failed" ? "failed" : "completed", status === "failed" ? "Turn failed" : "Turn completed");
      if (cancelRequested || status === "interrupted") finish("cancelled", null, null);
      else if (status === "failed") {
        rememberFailure("codex-error", "Codex could not complete the turn.", lastError);
        finish("failed", 1, null);
      }
      else finish("completed", 0, null);
    }
  };

  const handleLine = (line: string): void => {
    if (settled) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      rememberFailure(
        "malformed-protocol",
        "Codex App Server returned a malformed protocol message.",
        "A JSONL frame could not be decoded as JSON.",
      );
      finish("failed", null, null);
      return;
    }
    const message = objectValue(parsed);
    if (!message) {
      rememberFailure(
        "malformed-protocol",
        "Codex App Server returned a malformed protocol message.",
        "The decoded JSONL frame was not a JSON object.",
      );
      finish("failed", null, null);
      return;
    }
    const id = rpcId(message.id);
    const method = stringValue(message.method);
    const params = objectValue(message.params) ?? {};
    lastProtocolMethod = method ?? lastProtocolMethod;

    if (id !== undefined && method) {
      handleServerRequest(id, method, params);
      return;
    }

    if (id !== undefined && typeof id === "number") {
      const pending = pendingRequests.get(id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      pendingRequests.delete(id);
      const error = objectValue(message.error);
      if (error) {
        const errorMessage = boundedText(error.message, 4_000) ?? `${pending.method} failed.`;
        rememberFailure("codex-error", "Codex rejected a protocol request.", errorMessage);
        pending.reject(new Error(errorMessage));
      } else {
        pending.resolve(objectValue(message.result) ?? {});
      }
      return;
    }

    if (method) {
      handleNotification(method, params);
      return;
    }
    rememberFailure(
      "malformed-protocol",
      "Codex App Server returned a malformed protocol message.",
      "The JSON-RPC message could not be routed.",
    );
    finish("failed", null, null);
  };

  const decoderFailure = (decoderError: JsonLineDecoderFailure): void => {
    decoder?.stop();
    if (decoderError === "malformed-utf8") {
      rememberFailure(
        "malformed-protocol",
        "Codex App Server returned invalid UTF-8.",
        "The JSONL transport emitted a frame that was not valid UTF-8.",
      );
    } else {
      const scope = decoderError === "line-overflow" ? "frame" : "run";
      rememberFailure(
        "protocol-overflow",
        "Codex App Server exceeded Inertia's protocol safety limit.",
        scope === "frame"
          ? `A JSONL frame exceeded ${protocolLimits.maxFrameBytes} bytes.`
          : `JSONL output exceeded ${protocolLimits.maxProtocolBytes} bytes for one run.`,
      );
    }
    finish("failed", null, null);
  };
  decoder = new JsonLineDecoder(
    protocolLimits.maxFrameBytes,
    handleLine,
    decoderFailure,
    protocolLimits.maxProtocolBytes,
  );

  child.stdout.on("data", (chunk: Buffer) => decoder?.push(chunk));
  const handleTransportClose = (): void => {
    if (settled || transportCloseTimer) return;
    decoder?.end();
    if (settled) return;
    transportCloseTimer = setTimeout(() => {
      transportCloseTimer = undefined;
      if (settled) return;
      rememberFailure(
        "transport-closed",
        "The Codex App Server connection closed before the turn completed.",
      );
      finish("failed", null, null);
    }, TRANSPORT_CLOSE_GRACE_MS);
    transportCloseTimer.unref();
  };
  child.stdout.once("end", handleTransportClose);
  child.stdout.once("close", handleTransportClose);
  child.stderr.on("data", (chunk: Buffer) => diagnostic.append(chunk.toString("utf8")));
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (!settled) {
      lastError ??= error.message;
      rememberFailure(
        "transport-closed",
        "The Codex App Server connection closed while sending a request.",
        error.message,
      );
    }
  });
  child.once("error", (error: NodeJS.ErrnoException) => {
    lastError = error.message;
    rememberFailure("process-exit", "Codex App Server could not be started.", error.message);
    finish(cancelRequested ? "cancelled" : "failed", null, null);
  });
  child.once("close", (code, signal) => {
    if (settled) return;
    rememberFailure(
      signal ? "process-signal" : "process-exit",
      signal
        ? "Codex App Server stopped unexpectedly."
        : "Codex App Server exited before the turn completed.",
    );
    finish(cancelRequested ? "cancelled" : "failed", code, signal);
  });

  child.once("spawn", () => {
    spawned = true;
    void (async () => {
      try {
        await request("initialize", {
          clientInfo: { name: "inertia", title: "Inertia", version: INERTIA_VERSION },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        });
        notify("initialized");

        const accessPolicy = codexAccessPolicy(options);
        const threadConfig = {
          cwd: options.cwd,
          approvalPolicy: accessPolicy.approvalPolicy,
          approvalsReviewer: "user",
          sandbox: accessPolicy.threadSandbox,
          ...(options.model ? { model: options.model } : {}),
          ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
          ...(modelProvider ? {
            modelProvider: modelProvider.providerId,
            config: {
              [`model_providers.${modelProvider.providerId}`]: {
                name: modelProvider.displayName,
                base_url: modelProvider.baseUrl,
                wire_api: "responses",
                requires_openai_auth: false,
                ...(modelProvider.credentialEnvironmentKey
                  ? { env_key: modelProvider.credentialEnvironmentKey }
                  : {}),
              },
            },
          } : {}),
        };
        let opened: JsonObject;
        if (options.sessionId) {
          try {
            opened = await request("thread/resume", { threadId: options.sessionId, excludeTurns: true, ...threadConfig });
          } catch (error) {
            if (!isStaleResumeError(error)) throw error;
            continuationError = "stale-provider-session";
            throw new Error(staleProviderSessionDecision().reason);
          }
        } else {
          opened = await request("thread/start", threadConfig);
        }

        const thread = objectValue(opened.thread);
        const openedThreadId = boundedText(thread?.id, 512);
        if (!openedThreadId) throw new Error("Codex did not return a thread identifier.");
        providerThreadId = openedThreadId;
        options.onSession?.(openedThreadId);

        if (cancelRequested) {
          finish("cancelled", null, null);
          return;
        }

        const effectiveModel = boundedText(opened.model, 160) ?? options.model;
        if (options.planMode && !effectiveModel) throw new Error("Codex did not return an effective model for Plan mode.");
        const input: JsonObject[] = [{ type: "text", text: options.prompt, text_elements: [] }];
        for (const path of options.imagePaths ?? []) input.push({ type: "localImage", path });
        phase = "starting-turn";
        const started = await request("turn/start", {
          threadId: openedThreadId,
          input,
          approvalPolicy: accessPolicy.approvalPolicy,
          approvalsReviewer: "user",
          sandboxPolicy: accessPolicy.turnSandboxPolicy,
          ...(options.model ? { model: options.model } : {}),
          ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
          summary: "auto",
          ...(options.planMode ? {
            collaborationMode: {
              mode: "plan",
              settings: {
                model: effectiveModel,
                reasoning_effort: options.reasoningEffort ?? null,
                developer_instructions: null,
              },
            },
          } : {}),
        });
        if (settled) return;
        const turn = objectValue(started.turn);
        const startedTurnId = boundedText(turn?.id, 512);
        if (!startedTurnId) throw new Error("Codex did not return a turn identifier.");
        if (activeTurnId && activeTurnId !== startedTurnId) throw new Error("Codex returned inconsistent turn identifiers.");
        activeTurnId = startedTurnId;
        phase = "running";
        options.onStatus?.("running");
      } catch (error) {
        if (options.access === "full" && isUnsupportedFullAccessError(error)) {
          compatibilityError = "full-access-unsupported";
        }
        lastError = error instanceof Error ? error.message : "Codex App Server could not start.";
        rememberFailure("codex-error", "Codex App Server could not start the turn.", lastError);
        finish(cancelRequested ? "cancelled" : "failed", null, null);
      }
    })();
  });

  const cancel = (force = false): void => {
    if (settled) return;
    cancelRequested = true;
    settleApprovals("cancelled");
    settleInputs();
    if (force || !spawned || !providerThreadId || !activeTurnId) {
      terminateProcessTree(child, force);
      return;
    }
    void request("turn/interrupt", { threadId: providerThreadId, turnId: activeTurnId }).catch(() => {
      if (!settled) terminateProcessTree(child, true);
    });
  };

  const respondToApproval = (requestId: string, decision: AgentApprovalDecision): boolean => {
    const pending = pendingApprovals.get(requestId);
    if (!pending || settled || !pending.request.availableDecisions.includes(decision)) return false;
    const result: JsonObject = pending.protocol === "permissions"
      ? {
          permissions: decision === "approve" ? pending.requestedPermissions ?? {} : {},
          scope: "turn",
        }
      : {
          decision: decision === "approve" ? "accept" : decision === "deny" ? "decline" : "cancel",
        };
    if (!writeMessage({ id: pending.rpcId, result })) return false;
    pendingApprovals.delete(requestId);
    options.onApprovalResolved?.(requestId, decision);
    if (decision === "cancel") cancel();
    return true;
  };

  const respondToInput = (requestId: string, answers: Record<string, string[]>): boolean => {
    const pending = pendingInputs.get(requestId);
    if (!pending || settled) return false;
    const response = codexInputAnswers(pending.request, answers);
    if (!response) return false;
    if (!writeMessage({ id: pending.rpcId, result: { answers: response } })) return false;
    pendingInputs.delete(requestId);
    options.onInputResolved?.(requestId);
    return true;
  };

  const steer = async (content: string): Promise<boolean> => {
    const text = content.replaceAll("\0", "").trim();
    if (
      !text
      || settled
      || cancelRequested
      || phase !== "running"
      || !providerThreadId
      || !activeTurnId
    ) return false;
    try {
      await request("turn/steer", {
        threadId: providerThreadId,
        input: [{ type: "text", text, text_elements: [] }],
        expectedTurnId: activeTurnId,
      });
      return true;
    } catch {
      return false;
    }
  };

  return {
    child,
    result,
    cancel,
    respondToApproval,
    respondToInput,
    steer,
  };
}
