import { spawn } from "node:child_process";

import { INERTIA_VERSION } from "../shared/version";
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

const MAX_LINE_CHARS = 1024 * 1024;
const MAX_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_DIAGNOSTIC_CHARS = 32 * 1024;
const RPC_TIMEOUT_MS = 30_000;

type CodexRunPhase = "opening" | "starting-turn" | "running" | "settled";

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

function isRecoverableResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("thread") && ["not found", "missing", "unknown", "does not exist", "no such"].some((part) => message.includes(part));
}

export function startCodexAppServerRun(options: CodexAppServerOptions): CodexAppServerRun {
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
  let nextRequestId = 1;
  let providerThreadId = options.sessionId;
  let activeTurnId: string | undefined;
  let cancelRequested = false;
  let settled = false;
  let spawned = false;
  let phase: CodexRunPhase = "opening";
  let lastError: string | undefined;
  let compatibilityError: CodexAppServerResult["compatibilityError"];
  let resolveResult!: (result: CodexAppServerResult) => void;

  const result = new Promise<CodexAppServerResult>((resolve) => {
    resolveResult = resolve;
  });

  const writeMessage = (message: JsonObject): boolean => {
    if (settled || child.stdin.destroyed || !child.stdin.writable) return false;
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
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
    settled = true;
    phase = "settled";
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
      ...(compatibilityError ? { compatibilityError } : {}),
    });
    if (child.exitCode === null && child.signalCode === null) terminateProcessTree(child, false);
  };

  const request = (method: string, params: JsonObject): Promise<JsonObject> => {
    const id = nextRequestId;
    nextRequestId += 1;
    return new Promise<JsonObject>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`${method} timed out.`));
      }, RPC_TIMEOUT_MS);
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
  ): void => options.onActivity?.(kind, phase, label);

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

    const notificationThreadId = boundedText(params.threadId, 512);
    const notificationTurnId = boundedText(params.turnId, 512) ?? boundedText(objectValue(params.turn)?.id, 512);

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
      const itemType = stringValue(item?.type);
      const phase = method === "item/completed" ? "completed" : "started";
      if (itemType === "reasoning") {
        emitActivity("reasoning", phase, "Thinking");
        if (method === "item/completed" && item) {
          const summary = completedReasoningSummary(item, reasoningDeltaItems);
          if (summary) options.onReasoning?.(summary);
        }
      }
      else if (itemType === "commandExecution" && item) emitActivity("command", phase, commandExecutionLabel(item));
      else if (itemType === "fileChange") emitActivity("tool", phase, "File change");
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
      if (params.willRetry !== true) emitActivity("system", "failed", "Codex reported an error");
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
      emitActivity("turn", status === "failed" ? "failed" : "completed", status === "failed" ? "Turn failed" : "Turn completed");
      if (cancelRequested || status === "interrupted") finish("cancelled", null, null);
      else if (status === "failed") finish("failed", 1, null);
      else finish("completed", 0, null);
    }
  };

  const handleLine = (line: string): void => {
    if (settled) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      diagnostic.append("Codex App Server returned invalid JSON.\n");
      return;
    }
    const message = objectValue(parsed);
    if (!message) return;
    const id = rpcId(message.id);
    const method = stringValue(message.method);
    const params = objectValue(message.params) ?? {};

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
        pending.reject(new Error(errorMessage));
      } else {
        pending.resolve(objectValue(message.result) ?? {});
      }
      return;
    }

    if (method) handleNotification(method, params);
  };

  let decoder!: JsonLineDecoder;
  decoder = new JsonLineDecoder(MAX_LINE_CHARS, handleLine, () => {
    decoder.stop();
    lastError = "Codex App Server emitted an oversized protocol message.";
    finish("failed", null, null);
  });

  child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk));
  child.stdout.once("end", () => decoder.end());
  child.stderr.on("data", (chunk: Buffer) => diagnostic.append(chunk.toString("utf8")));
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (!settled) lastError ??= error.message;
  });
  child.once("error", (error: NodeJS.ErrnoException) => {
    lastError = error.message;
    finish(cancelRequested ? "cancelled" : "failed", null, null);
  });
  child.once("close", (code, signal) => {
    if (!settled) finish(cancelRequested ? "cancelled" : "failed", code, signal);
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
        };
        let opened: JsonObject;
        if (options.sessionId) {
          try {
            opened = await request("thread/resume", { threadId: options.sessionId, excludeTurns: true, ...threadConfig });
          } catch (error) {
            if (!isRecoverableResumeError(error)) throw error;
            opened = await request("thread/start", threadConfig);
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

  return { child, result, cancel, respondToApproval, respondToInput };
}
