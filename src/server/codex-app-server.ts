import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type CodexApprovalDecision = "approve" | "deny" | "cancel";
export type CodexApprovalKind = "command" | "file-change" | "permissions";

export interface CodexApprovalNetworkScope {
  host: string;
  protocol: "http" | "https" | "socks5Tcp" | "socks5Udp";
}

export interface CodexApprovalPermissionRoot {
  path: string;
  access: "read" | "write";
}

export interface CodexApprovalRequest {
  requestId: string;
  kind: CodexApprovalKind;
  title: string;
  detail?: string;
  command?: string;
  cwd?: string;
  reason?: string;
  networkScope?: CodexApprovalNetworkScope;
  permissionRoots: CodexApprovalPermissionRoot[];
  availableDecisions: CodexApprovalDecision[];
}

export interface CodexInputOption {
  label: string;
  description: string;
}

export interface CodexInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: CodexInputOption[];
}

export interface CodexInputRequest {
  requestId: string;
  questions: CodexInputQuestion[];
  autoResolutionMs: number | null;
}

export interface CodexPlanStep {
  step: string;
  status: "pending" | "inProgress" | "completed";
}

export interface CodexUsageSnapshot {
  usedTokens: number;
  totalProcessedTokens: number | null;
  maxTokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  compactsAutomatically: boolean;
}

export interface CodexAppServerOptions {
  executable: string;
  environment: NodeJS.ProcessEnv;
  cwd: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  sessionId?: string;
  imagePaths?: readonly string[];
  planMode: boolean;
  access: "supervised" | "auto-edit";
  onText?: (text: string) => void;
  onActivity?: (kind: "system" | "turn" | "tool" | "command" | "reasoning", phase: "started" | "completed" | "failed" | "info", label: string) => void;
  onSession?: (sessionId: string) => void;
  onStatus?: (status: "running") => void;
  onApproval?: (request: CodexApprovalRequest) => void;
  onApprovalResolved?: (requestId: string, decision: CodexApprovalDecision | "cancelled") => void;
  onInputRequest?: (request: CodexInputRequest) => void;
  onInputResolved?: (requestId: string) => void;
  onPlan?: (explanation: string | null, steps: CodexPlanStep[]) => void;
  onReasoning?: (text: string) => void;
  onUsage?: (usage: CodexUsageSnapshot) => void;
}

export interface CodexAppServerResult {
  status: "completed" | "failed" | "cancelled";
  sessionId?: string;
  text: string;
  textTruncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  diagnostic?: string;
}

export interface CodexAppServerRun {
  child: ChildProcessWithoutNullStreams;
  result: Promise<CodexAppServerResult>;
  cancel: (force?: boolean) => void;
  respondToApproval: (requestId: string, decision: CodexApprovalDecision) => boolean;
  respondToInput: (requestId: string, answers: Record<string, string[]>) => boolean;
}

type JsonObject = Record<string, unknown>;
type RpcId = string | number;

interface PendingClientRequest {
  method: string;
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface PendingApproval {
  rpcId: RpcId;
  request: CodexApprovalRequest;
  protocol: "decision" | "permissions";
  requestedPermissions?: JsonObject;
}

interface PendingInput {
  rpcId: RpcId;
  request: CodexInputRequest;
}

const MAX_LINE_CHARS = 1024 * 1024;
const MAX_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_DIAGNOSTIC_CHARS = 32 * 1024;
const RPC_TIMEOUT_MS = 30_000;
const MAX_PERMISSION_ROOTS = 12;

type CodexRunPhase = "opening" | "starting-turn" | "running" | "settled";

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function tokenUsage(value: unknown): CodexUsageSnapshot | undefined {
  const usage = objectValue(value);
  const last = objectValue(usage?.last);
  const total = objectValue(usage?.total);
  const usedTokens = nonNegativeNumber(last?.totalTokens);
  if (usedTokens === null || usedTokens <= 0) return undefined;
  return {
    usedTokens,
    totalProcessedTokens: nonNegativeNumber(total?.totalTokens),
    maxTokens: nonNegativeNumber(usage?.modelContextWindow),
    inputTokens: nonNegativeNumber(last?.inputTokens),
    cachedInputTokens: nonNegativeNumber(last?.cachedInputTokens),
    outputTokens: nonNegativeNumber(last?.outputTokens),
    reasoningOutputTokens: nonNegativeNumber(last?.reasoningOutputTokens),
    compactsAutomatically: true,
  };
}

function boundedText(value: unknown, maxChars: number): string | undefined {
  const text = stringValue(value)?.replaceAll("\0", "").trim();
  if (!text) return undefined;
  return text.slice(0, maxChars);
}

function rpcId(value: unknown): RpcId | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function isRecoverableResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("thread") && ["not found", "missing", "unknown", "does not exist", "no such"].some((part) => message.includes(part));
}

function terminate(child: ChildProcessWithoutNullStreams, force: boolean): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill.exe", ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      }).unref();
      return;
    } catch {
      // Fall through to the direct child signal.
    }
  } else {
    try {
      process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
      return;
    } catch {
      // The process group may already be gone.
    }
  }
  try {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    // The child may already have exited.
  }
}

class CappedBuffer {
  private value = "";
  truncated = false;

  constructor(private readonly maxChars: number) {}

  append(text: string): void {
    if (!text || this.truncated) return;
    const remaining = this.maxChars - this.value.length;
    this.value += text.slice(0, Math.max(0, remaining));
    if (text.length > remaining) this.truncated = true;
  }

  toString(): string {
    return this.value;
  }
}

class JsonLineDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private discarding = false;
  private stopped = false;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onOverflow: () => void,
  ) {}

  push(chunk: Buffer): void {
    if (this.stopped) return;
    this.consume(this.decoder.write(chunk));
  }

  end(): void {
    if (this.stopped) return;
    this.consume(this.decoder.end());
    if (this.stopped) return;
    if (!this.discarding && this.buffer.trim()) this.onLine(this.buffer.trimEnd());
    this.buffer = "";
  }

  stop(): void {
    this.stopped = true;
    this.buffer = "";
  }

  private consume(text: string): void {
    let offset = 0;
    while (!this.stopped && offset < text.length) {
      const newline = text.indexOf("\n", offset);
      if (newline === -1) {
        if (this.discarding) return;
        const remainder = text.slice(offset);
        if (this.buffer.length + remainder.length > MAX_LINE_CHARS) {
          this.buffer = "";
          this.discarding = true;
          this.onOverflow();
        } else {
          this.buffer += remainder;
        }
        return;
      }

      const segment = text.slice(offset, newline);
      offset = newline + 1;
      if (this.discarding) {
        this.discarding = false;
        continue;
      }
      if (this.buffer.length + segment.length > MAX_LINE_CHARS) {
        this.buffer = "";
        this.onOverflow();
        if (this.stopped) return;
        continue;
      }
      const line = `${this.buffer}${segment}`.trimEnd();
      this.buffer = "";
      if (line) this.onLine(line);
    }
  }
}

function permissionPath(value: unknown): string | undefined {
  const path = objectValue(value);
  if (!path) return undefined;
  if (path.type === "path") return boundedText(path.path, 4_096);
  if (path.type === "glob_pattern") {
    const pattern = boundedText(path.pattern, 4_080);
    return pattern ? `glob: ${pattern}` : undefined;
  }
  if (path.type !== "special") return undefined;
  const special = objectValue(path.value);
  const kind = boundedText(special?.kind, 80);
  if (!kind) return undefined;
  const base = kind === "root" ? "/" : kind.replaceAll("_", " ");
  const subpath = boundedText(special?.subpath, 4_000);
  return subpath ? `${base}: ${subpath}` : base;
}

function permissionRoots(value: unknown): CodexApprovalPermissionRoot[] {
  const profile = objectValue(value);
  const fileSystem = objectValue(profile?.fileSystem);
  if (!fileSystem) return [];
  const roots: CodexApprovalPermissionRoot[] = [];
  const seen = new Set<string>();
  const add = (path: unknown, access: "read" | "write"): void => {
    const bounded = boundedText(path, 4_096);
    if (!bounded || roots.length >= MAX_PERMISSION_ROOTS) return;
    const key = `${access}\0${bounded}`;
    if (seen.has(key)) return;
    seen.add(key);
    roots.push({ path: bounded, access });
  };
  for (const path of Array.isArray(fileSystem.read) ? fileSystem.read : []) add(path, "read");
  for (const path of Array.isArray(fileSystem.write) ? fileSystem.write : []) add(path, "write");
  for (const value of Array.isArray(fileSystem.entries) ? fileSystem.entries : []) {
    if (roots.length >= MAX_PERMISSION_ROOTS) break;
    const entry = objectValue(value);
    if (entry?.access !== "read" && entry?.access !== "write") continue;
    add(permissionPath(entry.path), entry.access);
  }
  return roots;
}

function networkScope(value: unknown): CodexApprovalNetworkScope | undefined {
  const context = objectValue(value);
  const host = boundedText(context?.host, 512);
  const protocol = context?.protocol;
  if (!host || (protocol !== "http" && protocol !== "https" && protocol !== "socks5Tcp" && protocol !== "socks5Udp")) return undefined;
  return { host, protocol };
}

interface ParsedApprovalRequest {
  request: CodexApprovalRequest;
  protocol: PendingApproval["protocol"];
  requestedPermissions?: JsonObject;
}

function approvalRequest(method: string, params: JsonObject): ParsedApprovalRequest | undefined {
  const requestId = randomUUID();
  const command = boundedText(params.command, 4_000);
  const cwd = boundedText(params.cwd, 4_096);
  const reason = boundedText(params.reason, 1_000);
  const additionalPermissions = objectValue(params.additionalPermissions);
  const requestedNetworkScope = networkScope(params.networkApprovalContext);
  const requestedPermissionRoots = permissionRoots(additionalPermissions);
  const decisionMap: Record<string, CodexApprovalDecision> = {
    accept: "approve",
    decline: "deny",
    cancel: "cancel",
  };
  const rawAdvertisedDecisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : undefined;
  const advertised: CodexApprovalDecision[] = rawAdvertisedDecisions
    ? rawAdvertisedDecisions.flatMap((value): CodexApprovalDecision[] => typeof value === "string" && decisionMap[value] ? [decisionMap[value]] : [])
    : [];
  const availableDecisions: CodexApprovalDecision[] = rawAdvertisedDecisions
    ? [...new Set(advertised)]
    : ["approve", "deny", "cancel"];

  if (method === "item/commandExecution/requestApproval") {
    return {
      protocol: "decision",
      request: {
        requestId,
        kind: "command",
        title: "Approve command",
        ...(command ? { command } : {}),
        ...(cwd ? { cwd } : {}),
        ...(reason ? { reason } : {}),
        ...(requestedNetworkScope ? { networkScope: requestedNetworkScope } : {}),
        permissionRoots: requestedPermissionRoots,
        detail: command ?? reason ?? "Codex wants to run a command.",
        availableDecisions,
      },
    };
  }
  if (method === "item/fileChange/requestApproval") {
    const grantRoot = boundedText(params.grantRoot, 4_096);
    return {
      protocol: "decision",
      request: {
        requestId,
        kind: "file-change",
        title: "Approve file changes",
        ...(grantRoot ? { cwd: grantRoot } : {}),
        ...(reason ? { reason } : {}),
        permissionRoots: grantRoot ? [{ path: grantRoot, access: "write" }] : [],
        detail: reason ?? (grantRoot ? `Allow changes under ${grantRoot}` : "Codex wants to change project files."),
        availableDecisions,
      },
    };
  }
  if (method === "item/permissions/requestApproval") {
    const requestedPermissions = objectValue(params.permissions);
    if (!requestedPermissions) return undefined;
    const roots = permissionRoots(requestedPermissions);
    const network = objectValue(requestedPermissions.network);
    return {
      protocol: "permissions",
      requestedPermissions,
      request: {
        requestId,
        kind: "permissions",
        title: "Approve additional access",
        ...(cwd ? { cwd } : {}),
        ...(reason ? { reason } : {}),
        permissionRoots: roots,
        detail: reason ?? (network?.enabled === true ? "Codex requests network access." : "Codex requests additional file access."),
        availableDecisions: ["approve", "deny", "cancel"],
      },
    };
  }
  return undefined;
}

function inputRequest(method: string, params: JsonObject): CodexInputRequest | undefined {
  if (method !== "item/tool/requestUserInput" || !Array.isArray(params.questions)) return undefined;
  const questions: CodexInputQuestion[] = [];
  for (const value of params.questions.slice(0, 3)) {
    const question = objectValue(value);
    if (!question) continue;
    const id = boundedText(question.id, 120);
    const prompt = boundedText(question.question, 1_000);
    if (!id || !prompt) continue;
    const options: CodexInputOption[] = [];
    if (Array.isArray(question.options)) {
      for (const rawOption of question.options.slice(0, 3)) {
        const option = objectValue(rawOption);
        const label = boundedText(option?.label, 160);
        if (!label) continue;
        options.push({
          label,
          description: boundedText(option?.description, 500) ?? "",
        });
      }
    }
    questions.push({
      id,
      header: boundedText(question.header, 120) ?? "Question",
      question: prompt,
      isOther: question.isOther === true,
      isSecret: question.isSecret === true,
      options,
    });
  }
  if (questions.length === 0) return undefined;
  const autoResolutionMs = typeof params.autoResolutionMs === "number" && Number.isFinite(params.autoResolutionMs)
    ? Math.max(0, Math.min(Math.trunc(params.autoResolutionMs), 24 * 60 * 60 * 1_000))
    : null;
  return { requestId: randomUUID(), questions, autoResolutionMs };
}

export function startCodexAppServerRun(options: CodexAppServerOptions): CodexAppServerRun {
  const child = spawn(options.executable, ["app-server"], {
    cwd: options.cwd,
    env: options.environment,
    detached: process.platform !== "win32",
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const resultText = new CappedBuffer(MAX_TEXT_CHARS);
  const diagnostic = new CappedBuffer(MAX_DIAGNOSTIC_CHARS);
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
    });
    if (child.exitCode === null && child.signalCode === null) terminate(child, false);
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
    const parsedApproval = approvalRequest(method, params);
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

    const requestedInput = inputRequest(method, params);
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
      const usage = tokenUsage(params.tokenUsage);
      if (usage) options.onUsage?.(usage);
      return;
    }

    if (method === "item/started" || method === "item/completed") {
      const item = objectValue(params.item);
      const itemType = stringValue(item?.type);
      const phase = method === "item/completed" ? "completed" : "started";
      if (itemType === "reasoning") {
        emitActivity("reasoning", phase, "Thinking");
        if (method === "item/completed") {
          const itemId = boundedText(item?.id, 512);
          if (!itemId || !reasoningDeltaItems.has(itemId)) {
            const summary = Array.isArray(item?.summary)
              ? item.summary.flatMap((part) => boundedText(objectValue(part)?.text, 32_000) ?? []).join("\n")
              : "";
            if (summary) options.onReasoning?.(summary);
          }
        }
      }
      else if (itemType === "commandExecution") emitActivity("command", phase, "Command");
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
      const steps: CodexPlanStep[] = [];
      if (Array.isArray(params.plan)) {
        for (const value of params.plan.slice(0, 50)) {
          const planStep = objectValue(value);
          const step = boundedText(planStep?.step, 1_000);
          const status = stringValue(planStep?.status);
          if (!step || (status !== "pending" && status !== "inProgress" && status !== "completed")) continue;
          steps.push({ step, status });
        }
      }
      options.onPlan?.(boundedText(params.explanation, 4_000) ?? null, steps);
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
  decoder = new JsonLineDecoder(handleLine, () => {
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
          clientInfo: { name: "inertia", title: "Inertia", version: "0.0.3" },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        });
        notify("initialized");

        const readOnly = options.planMode || options.access === "supervised";
        const approvalPolicy = options.access === "supervised" ? "untrusted" : "on-request";
        const threadConfig = {
          cwd: options.cwd,
          approvalPolicy,
          approvalsReviewer: "user",
          sandbox: readOnly ? "read-only" : "workspace-write",
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
          approvalPolicy,
          approvalsReviewer: "user",
          sandboxPolicy: readOnly
            ? { type: "readOnly", networkAccess: false }
            : { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
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
      terminate(child, force);
      return;
    }
    void request("turn/interrupt", { threadId: providerThreadId, turnId: activeTurnId }).catch(() => {
      if (!settled) terminate(child, true);
    });
  };

  const respondToApproval = (requestId: string, decision: CodexApprovalDecision): boolean => {
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
    const response: Record<string, { answers: string[] }> = {};
    for (const question of pending.request.questions) {
      const values = answers[question.id];
      if (!Array.isArray(values) || values.length === 0) return false;
      const exact = values.filter((value): value is string => typeof value === "string").slice(0, 5);
      if (exact.length === 0 || exact.some((value) => !value.trim() || value.length > 4_000 || value.includes("\0"))) return false;
      response[question.id] = { answers: exact };
    }
    if (!writeMessage({ id: pending.rpcId, result: { answers: response } })) return false;
    pendingInputs.delete(requestId);
    options.onInputResolved?.(requestId);
    return true;
  };

  return { child, result, cancel, respondToApproval, respondToInput };
}
