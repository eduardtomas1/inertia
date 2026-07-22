import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  startCodexAppServerRun,
  type CodexApprovalDecision,
  type CodexApprovalRequest,
  type CodexInputRequest,
  type CodexPlanStep,
} from "./codex-app-server";
import type { ThreadUsageSnapshot } from "../shared/contracts";
import { readCodexMetadata, type CodexMetadata } from "./codex-metadata";
import { executableCandidates, providerEnvironment, type ProviderEnvironment } from "./environment";

export const PROVIDER_IDS = ["codex", "claude", "cursor", "opencode"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];
export type ProviderInteractionMode = "build" | "plan";
export type ProviderAccessMode = "full" | "supervised" | "auto-edit";
export type ProviderInstallState = "checking" | "installed" | "not-installed" | "error";
export type ProviderAuthState = "checking" | "authenticated" | "unauthenticated" | "configured" | "unknown" | "error";

export interface ProviderCapabilities {
  resume: true;
  images: true;
  nativePlanMode: boolean;
  fullAccessFlag: string;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  command: string;
  capabilities: ProviderCapabilities;
}

export const PROVIDER_INFO: Readonly<Record<ProviderId, ProviderInfo>> = Object.freeze({
  codex: {
    id: "codex",
    name: "Codex",
    command: "codex",
    capabilities: {
      resume: true,
      images: true,
      nativePlanMode: true,
      fullAccessFlag: "--dangerously-bypass-approvals-and-sandbox",
    },
  },
  claude: {
    id: "claude",
    name: "Claude",
    command: "claude",
    capabilities: {
      resume: true,
      images: true,
      nativePlanMode: true,
      fullAccessFlag: "--dangerously-skip-permissions",
    },
  },
  cursor: {
    id: "cursor",
    name: "Cursor",
    command: "cursor-agent",
    capabilities: {
      resume: true,
      images: true,
      nativePlanMode: false,
      fullAccessFlag: "--force",
    },
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    capabilities: {
      resume: true,
      images: true,
      nativePlanMode: true,
      fullAccessFlag: "--auto",
    },
  },
});

export const PROVIDERS: readonly ProviderInfo[] = PROVIDER_IDS.map((id) => PROVIDER_INFO[id]);

export interface ProviderDetection {
  provider: ProviderInfo;
  available: boolean;
  version?: string;
  executable?: string;
  installState: ProviderInstallState;
  authState: ProviderAuthState;
  canRun: boolean;
  statusMessage?: string;
}

export interface ProviderDetectionOptions {
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  refreshEnvironment?: boolean;
}

interface ProviderRunRequest {
  providerId: ProviderId;
  cwd: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  interactionMode: ProviderInteractionMode;
  access: ProviderAccessMode;
  sessionId?: string;
  imagePaths?: readonly string[];
}

export type ProviderRunInput = ProviderRunRequest &
  (
    | { conversationId: string; threadId?: never }
    | { threadId: string; conversationId?: never }
  );

export type ProviderRunStatus =
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

interface ProviderEventBase {
  providerId: ProviderId;
  /** The caller's thread or conversation identifier, normalized to one key. */
  conversationId: string;
}

export interface ProviderTextEvent extends ProviderEventBase {
  type: "text";
  text: string;
}

export type ProviderActivityKind = "system" | "turn" | "tool" | "command" | "reasoning";
export type ProviderActivityPhase = "started" | "completed" | "failed" | "info";

export interface ProviderActivityEvent extends ProviderEventBase {
  type: "activity";
  kind: ProviderActivityKind;
  phase: ProviderActivityPhase;
  label: string;
}

export interface ProviderStatusEvent extends ProviderEventBase {
  type: "status";
  status: ProviderRunStatus;
  message?: string;
}

export interface ProviderSessionEvent extends ProviderEventBase {
  type: "session";
  sessionId: string;
}

export interface ProviderApprovalEvent extends ProviderEventBase {
  type: "approval";
  request: CodexApprovalRequest;
}

export interface ProviderApprovalResolvedEvent extends ProviderEventBase {
  type: "approval-resolved";
  requestId: string;
  decision: CodexApprovalDecision | "cancelled";
}

export interface ProviderInputEvent extends ProviderEventBase {
  type: "input";
  request: CodexInputRequest;
}

export interface ProviderInputResolvedEvent extends ProviderEventBase {
  type: "input-resolved";
  requestId: string;
}

export interface ProviderPlanEvent extends ProviderEventBase {
  type: "plan";
  explanation: string | null;
  steps: CodexPlanStep[];
}

export interface ProviderReasoningEvent extends ProviderEventBase {
  type: "reasoning-summary";
  text: string;
}

export interface ProviderUsageEvent extends ProviderEventBase {
  type: "usage";
  usage: Omit<ThreadUsageSnapshot, "conversationId" | "updatedAt">;
}

export type ProviderEvent =
  | ProviderTextEvent
  | ProviderActivityEvent
  | ProviderStatusEvent
  | ProviderSessionEvent
  | ProviderApprovalEvent
  | ProviderApprovalResolvedEvent
  | ProviderInputEvent
  | ProviderInputResolvedEvent
  | ProviderPlanEvent
  | ProviderReasoningEvent
  | ProviderUsageEvent;

export interface ProviderRunCallbacks {
  onEvent?: (event: ProviderEvent) => void;
  onText?: (event: ProviderTextEvent) => void;
  onActivity?: (event: ProviderActivityEvent) => void;
  onStatus?: (event: ProviderStatusEvent) => void;
  onSession?: (event: ProviderSessionEvent) => void;
  onApproval?: (event: ProviderApprovalEvent) => void;
  onApprovalResolved?: (event: ProviderApprovalResolvedEvent) => void;
  onInput?: (event: ProviderInputEvent) => void;
  onInputResolved?: (event: ProviderInputResolvedEvent) => void;
  onPlan?: (event: ProviderPlanEvent) => void;
  onReasoning?: (event: ProviderReasoningEvent) => void;
  onUsage?: (event: ProviderUsageEvent) => void;
}

export interface ProviderRunResult {
  providerId: ProviderId;
  conversationId: string;
  status: "completed" | "failed" | "cancelled";
  sessionId?: string;
  text: string;
  textTruncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export type ProviderRuntimeErrorCode = "invalid_input" | "already_running";

export class ProviderRuntimeError extends Error {
  readonly code: ProviderRuntimeErrorCode;

  constructor(code: ProviderRuntimeErrorCode, message: string) {
    super(message);
    this.name = "ProviderRuntimeError";
    this.code = code;
  }
}

export interface ProviderManagerOptions {
  commands?: Partial<Record<ProviderId, string>>;
  cancelGraceMs?: number;
}

export interface ProviderAuthLaunch {
  executable: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

interface ProviderInvocation {
  command: string;
  args: string[];
  stdin?: string;
}

interface ParserState {
  sessionId?: string;
  sawText: boolean;
  sawStreamingDelta: boolean;
  hadErrorEvent: boolean;
  failureText?: string;
}

interface ActiveRun {
  result: Promise<ProviderRunResult>;
  cancelRequested: boolean;
  settled: boolean;
  hardKillTimer?: NodeJS.Timeout;
  emitStatus: (status: ProviderRunStatus, message?: string) => void;
  cancel: (force: boolean) => void;
  respondToApproval?: (requestId: string, decision: CodexApprovalDecision) => boolean;
  respondToInput?: (requestId: string, answers: Record<string, string[]>) => boolean;
}

type JsonObject = Record<string, unknown>;

const MAX_NDJSON_LINE_CHARS = 1024 * 1024;
const MAX_STDERR_CHARS = 32 * 1024;
const MAX_RESULT_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_PROMPT_CHARS = 256 * 1024;
const MAX_IMAGE_COUNT = 32;
const DEFAULT_DETECTION_TIMEOUT_MS = 2_500;
const DEFAULT_CANCEL_GRACE_MS = 2_000;

const PROVIDER_AUTH: Readonly<Record<ProviderId, { statusArgs: readonly string[]; loginArgs: readonly string[] }>> = Object.freeze({
  codex: { statusArgs: ["login", "status"], loginArgs: ["login"] },
  claude: { statusArgs: ["auth", "status", "--json"], loginArgs: ["auth", "login"] },
  cursor: { statusArgs: ["status"], loginArgs: ["login"] },
  opencode: { statusArgs: ["auth", "list"], loginArgs: ["auth", "login"] },
});

const PLAN_PREFIX = [
  "You are in PLAN MODE.",
  "Inspect and reason about the project, but do not edit files or run mutating commands.",
  "Return a concrete implementation plan, including important risks and validation steps.",
  "",
].join("\n");

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boundedIdentifier(value: unknown): string | undefined {
  const text = stringValue(value)?.trim();
  if (!text || text.length > 512 || text.includes("\0")) return undefined;
  return text;
}

function sessionIdFrom(value: JsonObject): string | undefined {
  const keys = ["session_id", "sessionId", "sessionID", "thread_id"];
  const containers: unknown[] = [value, value.item, value.message, value.part, value.event];
  for (const candidate of containers) {
    const object = objectValue(candidate);
    if (!object) continue;
    for (const key of keys) {
      const sessionId = boundedIdentifier(object[key]);
      if (sessionId) return sessionId;
    }
  }
  return undefined;
}

function safeCallback(callback: (() => void) | undefined): void {
  if (!callback) return;
  try {
    callback();
  } catch {
    // Provider execution must not be interrupted by a UI callback.
  }
}

function makeEmitter(
  providerId: ProviderId,
  conversationId: string,
  callbacks: ProviderRunCallbacks,
): {
  event: (event: ProviderEvent) => void;
  text: (text: string) => void;
  activity: (kind: ProviderActivityKind, phase: ProviderActivityPhase, label: string) => void;
  status: (status: ProviderRunStatus, message?: string) => void;
  session: (sessionId: string) => void;
  approval: (request: CodexApprovalRequest) => void;
  approvalResolved: (requestId: string, decision: CodexApprovalDecision | "cancelled") => void;
  input: (request: CodexInputRequest) => void;
  inputResolved: (requestId: string) => void;
  plan: (explanation: string | null, steps: CodexPlanStep[]) => void;
  reasoning: (text: string) => void;
  usage: (usage: ProviderUsageEvent["usage"]) => void;
} {
  const event = (providerEvent: ProviderEvent): void => {
    safeCallback(() => callbacks.onEvent?.(providerEvent));
    switch (providerEvent.type) {
      case "text":
        safeCallback(() => callbacks.onText?.(providerEvent));
        break;
      case "activity":
        safeCallback(() => callbacks.onActivity?.(providerEvent));
        break;
      case "status":
        safeCallback(() => callbacks.onStatus?.(providerEvent));
        break;
      case "session":
        safeCallback(() => callbacks.onSession?.(providerEvent));
        break;
      case "approval":
        safeCallback(() => callbacks.onApproval?.(providerEvent));
        break;
      case "approval-resolved":
        safeCallback(() => callbacks.onApprovalResolved?.(providerEvent));
        break;
      case "input":
        safeCallback(() => callbacks.onInput?.(providerEvent));
        break;
      case "input-resolved":
        safeCallback(() => callbacks.onInputResolved?.(providerEvent));
        break;
      case "plan":
        safeCallback(() => callbacks.onPlan?.(providerEvent));
        break;
      case "reasoning-summary":
        safeCallback(() => callbacks.onReasoning?.(providerEvent));
        break;
      case "usage":
        safeCallback(() => callbacks.onUsage?.(providerEvent));
        break;
    }
  };

  const base = { providerId, conversationId };
  return {
    event,
    text: (text) => event({ ...base, type: "text", text }),
    activity: (kind, phase, label) => event({ ...base, type: "activity", kind, phase, label }),
    status: (status, message) => event({ ...base, type: "status", status, ...(message ? { message } : {}) }),
    session: (sessionId) => event({ ...base, type: "session", sessionId }),
    approval: (request) => event({ ...base, type: "approval", request }),
    approvalResolved: (requestId, decision) => event({ ...base, type: "approval-resolved", requestId, decision }),
    input: (request) => event({ ...base, type: "input", request }),
    inputResolved: (requestId) => event({ ...base, type: "input-resolved", requestId }),
    plan: (explanation, steps) => event({ ...base, type: "plan", explanation, steps }),
    reasoning: (text) => event({ ...base, type: "reasoning-summary", text }),
    usage: (usage) => event({ ...base, type: "usage", usage }),
  };
}

function humanizeToolName(value: unknown): string {
  const raw = stringValue(value)?.trim();
  if (!raw || raw.length > 80 || !/^[\w .:/-]+$/u.test(raw)) return "Tool";
  const words = raw
    .replace(/(?:tool[_ -]?call|toolcall)$/iu, "")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_:/.-]+/g, " ")
    .trim();
  if (!words) return "Tool";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function contentTexts(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : [];
  if (!Array.isArray(value)) return [];
  const texts: string[] = [];
  for (const entry of value) {
    const block = objectValue(entry);
    if (!block) continue;
    const text = stringValue(block.text);
    if ((block.type === "text" || block.type === "output_text") && text) texts.push(text);
  }
  return texts;
}

function toolNamesFromContent(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    const block = objectValue(entry);
    if (block?.type === "tool_use") names.push(humanizeToolName(block.name));
  }
  return names;
}

function cursorToolName(toolCall: unknown): string {
  const object = objectValue(toolCall);
  if (!object) return "Tool";
  const explicit = stringValue(object.name) ?? stringValue(object.tool);
  if (explicit) return humanizeToolName(explicit);
  const key = Object.keys(object).find((entry) => /toolcall$/iu.test(entry));
  return humanizeToolName(key);
}

function normalizeLine(
  providerId: ProviderId,
  line: string,
  state: ParserState,
  emitText: (text: string) => void,
  emitActivity: (kind: ProviderActivityKind, phase: ProviderActivityPhase, label: string) => void,
  emitSession: (sessionId: string) => void,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  const event = objectValue(parsed);
  if (!event) return;

  const capturedSessionId = sessionIdFrom(event);
  if (capturedSessionId && capturedSessionId !== state.sessionId) {
    state.sessionId = capturedSessionId;
    emitSession(capturedSessionId);
  }

  const type = stringValue(event.type) ?? "";
  const emitNonEmptyText = (text: unknown): void => {
    if (typeof text !== "string" || text.length === 0) return;
    state.sawText = true;
    emitText(text);
  };

  if (type === "error" || type === "turn.failed" || event.is_error === true) {
    state.hadErrorEvent = true;
    const error = objectValue(event.error);
    state.failureText ??= stringValue(event.message) ?? stringValue(error?.message) ?? stringValue(event.result);
    emitActivity("system", "failed", `${PROVIDER_INFO[providerId].name} reported an error`);
  }

  switch (providerId) {
    case "codex": {
      if (type === "turn.started") emitActivity("turn", "started", "Turn started");
      if (type === "turn.completed") emitActivity("turn", "completed", "Turn completed");

      const item = objectValue(event.item);
      if (!item) return;
      const itemType = stringValue(item.type);
      if (itemType === "agent_message" && type === "item.completed") {
        emitNonEmptyText(item.text);
        return;
      }
      if (itemType === "reasoning") {
        emitActivity("reasoning", type === "item.completed" ? "completed" : "started", "Reasoning");
        return;
      }
      if (itemType === "command_execution") {
        emitActivity("command", type === "item.completed" ? "completed" : "started", "Command");
        return;
      }
      if (itemType && itemType !== "agent_message") {
        emitActivity("tool", type === "item.completed" ? "completed" : "started", humanizeToolName(itemType));
      }
      return;
    }

    case "claude": {
      if (type === "system" && event.subtype === "init") {
        emitActivity("system", "started", "Session initialized");
      }
      if (type === "assistant") {
        const message = objectValue(event.message);
        if (!state.sawStreamingDelta) {
          for (const text of contentTexts(message?.content)) emitNonEmptyText(text);
        }
        for (const name of toolNamesFromContent(message?.content)) emitActivity("tool", "started", name);
        return;
      }
      if (type === "user") {
        const message = objectValue(event.message);
        if (Array.isArray(message?.content) && message.content.some((block) => objectValue(block)?.type === "tool_result")) {
          emitActivity("tool", "completed", "Tool");
        }
        return;
      }
      if (type === "stream_event") {
        const streamEvent = objectValue(event.event);
        const delta = objectValue(streamEvent?.delta);
        if (streamEvent?.type === "content_block_delta" && typeof delta?.text === "string" && delta.text.length > 0) {
          state.sawStreamingDelta = true;
          emitNonEmptyText(delta.text);
        }
        return;
      }
      if (type === "result") {
        if (event.is_error !== true && !state.sawText) emitNonEmptyText(event.result);
        emitActivity("turn", event.is_error === true ? "failed" : "completed", "Turn completed");
      }
      return;
    }

    case "cursor": {
      if (type === "system" && event.subtype === "init") {
        emitActivity("system", "started", "Session initialized");
      }
      if (type === "assistant") {
        const message = objectValue(event.message);
        for (const text of contentTexts(message?.content)) emitNonEmptyText(text);
        return;
      }
      if (type === "tool_call") {
        const phase = event.subtype === "completed" ? "completed" : event.subtype === "failed" ? "failed" : "started";
        emitActivity("tool", phase, cursorToolName(event.tool_call));
        return;
      }
      if (type === "result") {
        if (event.is_error !== true && !state.sawText) emitNonEmptyText(event.result);
        emitActivity("turn", event.is_error === true ? "failed" : "completed", "Turn completed");
      }
      return;
    }

    case "opencode": {
      const part = objectValue(event.part);
      if (type === "step_start") {
        emitActivity("turn", "started", "Step started");
        return;
      }
      if (type === "text") {
        emitNonEmptyText(part?.text ?? event.text);
        return;
      }
      if (type === "tool_use") {
        const toolState = objectValue(part?.state);
        const phase = toolState?.status === "completed" ? "completed" : toolState?.status === "error" ? "failed" : "started";
        emitActivity("tool", phase, humanizeToolName(part?.tool));
        return;
      }
      if (type === "step_finish") {
        const reason = stringValue(part?.reason);
        emitActivity("turn", "completed", reason === "stop" ? "Run completed" : "Step completed");
      }
    }
  }
}

class NdjsonDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private discardingLine = false;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onOverflow: () => void,
  ) {}

  push(chunk: Buffer): void {
    this.consume(this.decoder.write(chunk));
  }

  end(): void {
    this.consume(this.decoder.end());
    if (!this.discardingLine && this.buffer.trim()) this.onLine(this.buffer.trimEnd());
    this.buffer = "";
  }

  private consume(text: string): void {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      if (newline === -1) {
        const remainder = text.slice(offset);
        if (this.discardingLine) return;
        if (this.buffer.length + remainder.length > MAX_NDJSON_LINE_CHARS) {
          this.buffer = "";
          this.discardingLine = true;
          this.onOverflow();
        } else {
          this.buffer += remainder;
        }
        return;
      }

      const segment = text.slice(offset, newline);
      offset = newline + 1;
      if (this.discardingLine) {
        this.discardingLine = false;
        continue;
      }
      if (this.buffer.length + segment.length > MAX_NDJSON_LINE_CHARS) {
        this.buffer = "";
        this.onOverflow();
        continue;
      }
      const line = `${this.buffer}${segment}`.trimEnd();
      this.buffer = "";
      if (line) this.onLine(line);
    }
  }
}

class CappedTextBuffer {
  private value = "";
  truncated = false;

  constructor(private readonly maxChars: number) {}

  append(text: string): void {
    if (!text || this.truncated) return;
    const remaining = this.maxChars - this.value.length;
    if (text.length <= remaining) {
      this.value += text;
      return;
    }
    this.value += text.slice(0, Math.max(0, remaining));
    this.truncated = true;
  }

  toString(): string {
    return this.value;
  }
}

function imageContextPrompt(prompt: string, imagePaths: readonly string[]): string {
  if (imagePaths.length === 0) return prompt;
  const references = imagePaths.map((path) => `- ${JSON.stringify(path)}`).join("\n");
  return `${prompt}\n\nInspect these local image files as visual context:\n${references}`;
}

function buildInvocation(input: ProviderRunInput, command: string): ProviderInvocation {
  const imagePaths = input.imagePaths ?? [];
  const planPrompt = input.interactionMode === "plan" ? `${PLAN_PREFIX}${input.prompt}` : input.prompt;

  switch (input.providerId) {
    case "codex": {
      const args = input.sessionId ? ["exec", "resume"] : ["exec"];
      args.push("--json", "--skip-git-repo-check");
      if (input.access === "full") {
        args.push("--dangerously-bypass-approvals-and-sandbox");
      } else {
        args.push("--config", `sandbox_mode="${input.interactionMode === "plan" ? "read-only" : "workspace-write"}"`);
        args.push("--config", 'approval_policy="on-request"');
      }
      if (input.model) args.push("--model", input.model);
      for (const path of imagePaths) args.push("--image", path);
      if (input.sessionId) args.push(input.sessionId);
      args.push("-");
      return { command, args, stdin: planPrompt };
    }

    case "claude": {
      const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
      if (input.access === "full") args.push("--dangerously-skip-permissions");
      else args.push("--permission-mode", input.interactionMode === "plan" ? "plan" : input.access === "auto-edit" ? "acceptEdits" : "manual");
      if (input.model) args.push("--model", input.model);
      if (input.sessionId) args.push("--resume", input.sessionId);
      const prompt = input.access === "full" && input.interactionMode === "plan" ? planPrompt : input.prompt;
      return { command, args, stdin: imageContextPrompt(prompt, imagePaths) };
    }

    case "cursor": {
      const args = ["-p", "--output-format", "stream-json"];
      if (input.access === "full") args.push("--force");
      if (input.model) args.push("--model", input.model);
      if (input.sessionId) args.push("--resume", input.sessionId);
      args.push("--", imageContextPrompt(planPrompt, imagePaths));
      return { command, args };
    }

    case "opencode": {
      const args = ["run", "--format", "json"];
      if (input.access === "full") args.push("--auto");
      if (input.interactionMode === "plan") args.push("--agent", "plan");
      if (input.model) args.push("--model", input.model);
      if (input.sessionId) args.push("--session", input.sessionId);
      for (const path of imagePaths) args.push("--file", path);
      args.push("--", input.prompt);
      return { command, args };
    }
  }
}

function validateRunInput(input: ProviderRunInput): string {
  if (!isProviderId(input.providerId)) throw new ProviderRuntimeError("invalid_input", "Unknown provider.");
  const conversationId = (input.conversationId ?? input.threadId)?.trim();
  if (!conversationId || conversationId.length > 512 || conversationId.includes("\0")) {
    throw new ProviderRuntimeError("invalid_input", "A valid conversation identifier is required.");
  }
  if (!input.cwd.trim() || input.cwd.includes("\0")) {
    throw new ProviderRuntimeError("invalid_input", "A valid project directory is required.");
  }
  if (!input.prompt.trim()) throw new ProviderRuntimeError("invalid_input", "A prompt is required.");
  if (input.prompt.length > MAX_PROMPT_CHARS || input.prompt.includes("\0")) {
    throw new ProviderRuntimeError("invalid_input", "The prompt is too large.");
  }
  for (const value of [input.model, input.sessionId]) {
    if (value !== undefined && (!value.trim() || value.length > 512 || value.includes("\0"))) {
      throw new ProviderRuntimeError("invalid_input", "A provider option is invalid.");
    }
  }
  const imagePaths = input.imagePaths ?? [];
  if (imagePaths.length > MAX_IMAGE_COUNT) {
    throw new ProviderRuntimeError("invalid_input", "Too many images were attached.");
  }
  if (imagePaths.some((path) => !path.trim() || path.length > 4096 || path.includes("\0"))) {
    throw new ProviderRuntimeError("invalid_input", "An image path is invalid.");
  }
  return conversationId;
}

function publicFailureMessage(
  providerId: ProviderId,
  spawnError: NodeJS.ErrnoException | undefined,
  stderr: string,
  providerOutput = "",
): string {
  const providerName = PROVIDER_INFO[providerId].name;
  if (spawnError?.code === "ENOENT") return `${providerName} CLI is not installed or is not available on PATH.`;
  if (spawnError?.code === "EACCES") return `${providerName} CLI could not be started because it is not executable.`;
  const normalized = `${stderr}\n${providerOutput}`.toLowerCase();
  if (/requires a newer version|please upgrade (?:to )?the latest (?:app|cli)|cli.+out of date/.test(normalized)) {
    return `${providerName} needs an update before it can run the selected model.`;
  }
  if (/not (?:logged|signed) in|authentication required|failed to authenticate|oauth session expired|unauthorized|please (?:log|sign) in/.test(normalized)) {
    return `${providerName} is not authenticated. Sign in with its CLI and try again.`;
  }
  if (/rate.?limit|too many requests|quota/.test(normalized)) {
    return `${providerName} is temporarily rate limited. Try again shortly.`;
  }
  if (/model.+(?:not found|unknown|invalid|unavailable)/.test(normalized)) {
    return `The selected ${providerName} model is unavailable.`;
  }
  return `${providerName} could not complete the request.`;
}

function versionFromOutput(output: string): string | undefined {
  return output.match(/\bv?\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/u)?.[0];
}

interface ProbeResult {
  exitCode: number | null;
  output: string;
  started: boolean;
  timedOut: boolean;
}

async function probeProcess(
  executable: string,
  args: readonly string[],
  environment: ProviderEnvironment,
  cwd: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  return await new Promise<ProbeResult>((resolveProbe) => {
    const output = new CappedTextBuffer(16 * 1024);
    let settled = false;
    let started = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveProbe({ exitCode, output: output.toString(), started, timedOut });
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, [...args], {
        cwd,
        env: environment.env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      finish(null);
      return;
    }

    child.once("spawn", () => { started = true; });
    child.stdout.on("data", (chunk: Buffer) => output.append(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => output.append(chunk.toString("utf8")));
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
    child.stdin.end();

    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* The probe may already have exited. */ }
      finish(null);
    }, timeoutMs);
    timer.unref();
  });
}

function versionParts(version: string | undefined): number[] {
  return (version?.match(/\d+(?:\.\d+){1,2}/u)?.[0] ?? "0.0.0").split(".").map((part) => Number(part));
}

function compareVersions(left: string | undefined, right: string | undefined): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function terminateProviderProcess(child: ChildProcessWithoutNullStreams, force: boolean): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill.exe", ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      }).unref();
    } catch {
      try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* It may already be gone. */ }
    }
    return;
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* It may already be gone. */ }
  }
}

function authStateFromProbe(providerId: ProviderId, probe: ProbeResult): ProviderAuthState {
  if (!probe.started || probe.timedOut) return "unknown";
  const normalized = probe.output.replace(/\u001b\[[0-9;]*m/gu, "").trim();
  const lower = normalized.toLowerCase();

  if (providerId === "claude") {
    try {
      const status = JSON.parse(normalized) as { loggedIn?: unknown };
      if (status.loggedIn === true) return "authenticated";
      if (status.loggedIn === false) return "unauthenticated";
    } catch { /* Older Claude releases may return text. */ }
  }

  if (/not (?:logged|signed) in|loggedin["']?\s*:\s*false|authentication required|no credentials|please (?:log|sign) in/iu.test(lower)) {
    return providerId === "opencode" ? "unknown" : "unauthenticated";
  }
  if (/logged in|signed in|authenticated|loggedin["']?\s*:\s*true/iu.test(lower)) return "authenticated";
  if (providerId === "opencode" && probe.exitCode === 0 && normalized.length > 0) return "configured";
  if (probe.exitCode && probe.exitCode !== 0) return providerId === "opencode" ? "unknown" : "unauthenticated";
  return "unknown";
}

function statusMessage(installState: ProviderInstallState, authState: ProviderAuthState): string {
  if (installState === "not-installed") return "CLI not found";
  if (installState === "error") return "CLI did not respond";
  if (authState === "authenticated") return "Connected";
  if (authState === "configured") return "Configured";
  if (authState === "unauthenticated") return "Sign in required";
  if (authState === "error") return "Connection check failed";
  return "Installed; connection not confirmed";
}

export async function detectProvider(
  providerId: ProviderId,
  options: ProviderDetectionOptions = {},
): Promise<ProviderDetection> {
  const provider = PROVIDER_INFO[providerId];
  const command = options.command?.trim() || provider.command;
  const timeoutMs = Math.max(250, Math.min(options.timeoutMs ?? DEFAULT_DETECTION_TIMEOUT_MS, 10_000));
  const cwd = options.cwd ?? process.cwd();
  const environment = await providerEnvironment(options.refreshEnvironment === true);
  const candidates = await executableCandidates(command, environment, cwd);
  if (candidates.length === 0) {
    return {
      provider,
      available: false,
      installState: "not-installed",
      authState: "unknown",
      canRun: false,
      statusMessage: statusMessage("not-installed", "unknown"),
    };
  }

  const versionProbes = await Promise.all(candidates.map(async (executable) => {
    const probe = await probeProcess(executable, ["--version"], environment, cwd, timeoutMs);
    return { executable, probe, version: versionFromOutput(probe.output) };
  }));
  const working = versionProbes
    .filter(({ probe }) => probe.started && !probe.timedOut && probe.exitCode === 0)
    .sort((left, right) => compareVersions(right.version, left.version));
  const selected = working[0];
  if (!selected) {
    return {
      provider,
      available: false,
      installState: "error",
      authState: "unknown",
      canRun: false,
      statusMessage: statusMessage("error", "unknown"),
    };
  }

  const authProbe = await probeProcess(selected.executable, PROVIDER_AUTH[providerId].statusArgs, environment, cwd, timeoutMs);
  const authState = authStateFromProbe(providerId, authProbe);
  const authenticated = authState === "authenticated" || authState === "configured";
  const appServerProbe = providerId === "codex"
    ? await probeProcess(selected.executable, ["app-server", "--help"], environment, cwd, timeoutMs)
    : undefined;
  const appServerReady = !appServerProbe || (
    appServerProbe.started
    && !appServerProbe.timedOut
    && appServerProbe.exitCode === 0
    && /(?:codex\s+app-server|run the app server)/iu.test(appServerProbe.output)
  );
  const canRun = authenticated && appServerReady;
  return {
    provider,
    available: true,
    executable: selected.executable,
    ...(selected.version ? { version: selected.version } : {}),
    installState: "installed",
    authState,
    canRun,
    statusMessage: authenticated && !appServerReady
      ? "Update Codex CLI to enable agent conversations"
      : statusMessage("installed", authState),
  };
}

export async function detectProviders(
  options: Partial<Record<ProviderId, ProviderDetectionOptions>> = {},
): Promise<ProviderDetection[]> {
  return await Promise.all(PROVIDER_IDS.map((id) => detectProvider(id, options[id])));
}

export class ProviderManager {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly commands: Partial<Record<ProviderId, string>>;
  private readonly resolvedCommands = new Map<ProviderId, string>();
  private readonly cancelGraceMs: number;
  private processEnvironment: NodeJS.ProcessEnv | undefined;

  constructor(options: ProviderManagerOptions = {}) {
    this.commands = { ...options.commands };
    this.cancelGraceMs = Math.max(100, Math.min(options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS, 30_000));
  }

  isRunning(conversationId: string): boolean {
    return this.activeRuns.has(conversationId);
  }

  activeConversationIds(): string[] {
    return [...this.activeRuns.keys()];
  }

  async detect(providerId: ProviderId, options: Omit<ProviderDetectionOptions, "command"> = {}): Promise<ProviderDetection> {
    if (options.refreshEnvironment) await providerEnvironment(true);
    this.processEnvironment = (await providerEnvironment()).env;
    const configured = this.commands[providerId]?.trim() || PROVIDER_INFO[providerId].command;
    const detection = await detectProvider(providerId, { ...options, refreshEnvironment: false, command: configured });
    if (detection.executable) this.resolvedCommands.set(providerId, detection.executable);
    else this.resolvedCommands.delete(providerId);
    return detection;
  }

  async detectAll(options: Omit<ProviderDetectionOptions, "command"> = {}): Promise<ProviderDetection[]> {
    if (options.refreshEnvironment) await providerEnvironment(true);
    return await Promise.all(PROVIDER_IDS.map((id) => this.detect(id, { ...options, refreshEnvironment: false })));
  }

  async authLaunch(providerId: ProviderId): Promise<ProviderAuthLaunch> {
    let executable = this.resolvedCommands.get(providerId);
    if (!executable) executable = (await this.detect(providerId, { refreshEnvironment: true })).executable;
    if (!executable) throw new ProviderRuntimeError("invalid_input", `${PROVIDER_INFO[providerId].name} CLI is not installed.`);
    const environment = await providerEnvironment();
    this.processEnvironment = environment.env;
    return { executable, args: PROVIDER_AUTH[providerId].loginArgs, env: environment.env };
  }

  async metadata(providerId: ProviderId, cwd = process.cwd()): Promise<CodexMetadata> {
    if (providerId !== "codex") return { models: [], rateLimits: [] };
    let executable = this.resolvedCommands.get(providerId);
    if (!executable) executable = (await this.detect(providerId)).executable;
    if (!executable) return { models: [], rateLimits: [] };
    const environment = await providerEnvironment();
    this.processEnvironment = environment.env;
    return await readCodexMetadata(executable, environment.env, cwd);
  }

  run(input: ProviderRunInput, callbacks: ProviderRunCallbacks = {}): Promise<ProviderRunResult> {
    const conversationId = validateRunInput(input);
    if (this.activeRuns.has(conversationId)) {
      throw new ProviderRuntimeError("already_running", "This conversation already has an active provider run.");
    }

    const providerId = input.providerId;
    const emitter = makeEmitter(providerId, conversationId, callbacks);
    if (providerId === "codex" && input.access !== "full") {
      return this.runInteractiveCodex(input, conversationId, emitter);
    }
    const parserState: ParserState = {
      sessionId: input.sessionId,
      sawText: false,
      sawStreamingDelta: false,
      hadErrorEvent: false,
      failureText: undefined,
    };
    const stderr = new CappedTextBuffer(MAX_STDERR_CHARS);
    const resultText = new CappedTextBuffer(MAX_RESULT_TEXT_CHARS);
    let overflowReported = false;
    let spawnError: NodeJS.ErrnoException | undefined;

    const emitText = (text: string): void => {
      resultText.append(text);
      emitter.text(text);
    };
    const decoder = new NdjsonDecoder(
      (line) => normalizeLine(providerId, line, parserState, emitText, emitter.activity, emitter.session),
      () => {
        if (overflowReported) return;
        overflowReported = true;
        emitter.activity("system", "info", "Some oversized provider output was skipped");
      },
    );

    let invocation: ProviderInvocation;
    try {
      invocation = buildInvocation(input, this.commandFor(providerId));
    } catch {
      emitter.status("failed", "The provider could not be started.");
      return Promise.resolve({
        providerId,
        conversationId,
        status: "failed",
        sessionId: parserState.sessionId,
        text: "",
        textTruncated: false,
        exitCode: null,
        signal: null,
        error: "The provider could not be started.",
      });
    }

    emitter.status("starting");
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: input.cwd,
        env: this.processEnvironment ?? process.env,
        detached: process.platform !== "win32",
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      spawnError = error instanceof Error ? (error as NodeJS.ErrnoException) : undefined;
      const message = publicFailureMessage(providerId, spawnError, "");
      emitter.status("failed", message);
      return Promise.resolve({
        providerId,
        conversationId,
        status: "failed",
        sessionId: parserState.sessionId,
        text: "",
        textTruncated: false,
        exitCode: null,
        signal: null,
        error: message,
      });
    }

    let resolveResult!: (result: ProviderRunResult) => void;
    const result = new Promise<ProviderRunResult>((resolve) => {
      resolveResult = resolve;
    });
    const active: ActiveRun = {
      result,
      cancelRequested: false,
      settled: false,
      emitStatus: emitter.status,
      cancel: (force) => terminateProviderProcess(child, force),
    };
    this.activeRuns.set(conversationId, active);

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (active.settled) return;
      active.settled = true;
      if (active.hardKillTimer) clearTimeout(active.hardKillTimer);
      this.activeRuns.delete(conversationId);

      if (active.cancelRequested) {
        emitter.status("cancelled");
        resolveResult({
          providerId,
          conversationId,
          status: "cancelled",
          sessionId: parserState.sessionId,
          text: resultText.toString(),
          textTruncated: resultText.truncated,
          exitCode,
          signal,
        });
        return;
      }

      if (spawnError || exitCode !== 0 || parserState.hadErrorEvent) {
        const message = publicFailureMessage(providerId, spawnError, stderr.toString(), parserState.failureText);
        emitter.status("failed", message);
        resolveResult({
          providerId,
          conversationId,
          status: "failed",
          sessionId: parserState.sessionId,
          text: resultText.toString(),
          textTruncated: resultText.truncated,
          exitCode,
          signal,
          error: message,
        });
        return;
      }

      emitter.status("completed");
      resolveResult({
        providerId,
        conversationId,
        status: "completed",
        sessionId: parserState.sessionId,
        text: resultText.toString(),
        textTruncated: resultText.truncated,
        exitCode,
        signal,
      });
    };

    child.once("spawn", () => emitter.status("running"));
    child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk));
    child.stdout.once("end", () => decoder.end());
    child.stdout.on("error", (error: NodeJS.ErrnoException) => {
      spawnError ??= error;
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk.toString("utf8")));
    child.stderr.on("error", () => {
      // Stderr is diagnostic-only and is never exposed directly.
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (invocation.stdin !== undefined) spawnError ??= error;
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      spawnError = error;
      finish(null, null);
    });
    child.once("close", finish);

    try {
      child.stdin.end(invocation.stdin);
    } catch (error) {
      spawnError = error instanceof Error ? (error as NodeJS.ErrnoException) : undefined;
      try {
        child.kill();
      } catch {
        // The close/error event will settle the public result.
      }
    }

    return result;
  }

  cancel(conversationId: string): boolean {
    const active = this.activeRuns.get(conversationId);
    if (!active || active.settled || active.cancelRequested) return false;
    active.cancelRequested = true;
    active.emitStatus("cancelling");
    try {
      active.cancel(false);
    } catch {
      // The close event may already be queued.
    }
    active.hardKillTimer = setTimeout(() => {
      if (active.settled) return;
      try {
        active.cancel(true);
      } catch {
        // The process may have exited between the check and kill.
      }
    }, this.cancelGraceMs);
    active.hardKillTimer.unref();
    return true;
  }

  async disposeAll(): Promise<void> {
    const active = [...this.activeRuns.entries()];
    for (const [conversationId] of active) this.cancel(conversationId);
    await Promise.allSettled(active.map(([, run]) => run.result));
  }

  respondToApproval(conversationId: string, requestId: string, decision: CodexApprovalDecision): boolean {
    const active = this.activeRuns.get(conversationId);
    if (!active || active.settled || active.cancelRequested || !active.respondToApproval) return false;
    return active.respondToApproval(requestId, decision);
  }

  respondToInput(conversationId: string, requestId: string, answers: Record<string, string[]>): boolean {
    const active = this.activeRuns.get(conversationId);
    if (!active || active.settled || active.cancelRequested || !active.respondToInput) return false;
    return active.respondToInput(requestId, answers);
  }

  private runInteractiveCodex(
    input: ProviderRunInput,
    conversationId: string,
    emitter: ReturnType<typeof makeEmitter>,
  ): Promise<ProviderRunResult> {
    emitter.status("starting");
    let runningEmitted = false;
    const emitRunning = (): void => {
      if (runningEmitted) return;
      runningEmitted = true;
      emitter.status("running");
    };

    let codexRun: ReturnType<typeof startCodexAppServerRun>;
    try {
      codexRun = startCodexAppServerRun({
        executable: this.commandFor("codex"),
        environment: this.processEnvironment ?? process.env,
        cwd: input.cwd,
        prompt: input.prompt,
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.imagePaths ? { imagePaths: input.imagePaths } : {}),
        planMode: input.interactionMode === "plan",
        access: input.access === "auto-edit" ? "auto-edit" : "supervised",
        onText: emitter.text,
        onActivity: emitter.activity,
        onSession: emitter.session,
        onStatus: emitRunning,
        onApproval: emitter.approval,
        onApprovalResolved: emitter.approvalResolved,
        onInputRequest: emitter.input,
        onInputResolved: emitter.inputResolved,
        onPlan: emitter.plan,
        onReasoning: emitter.reasoning,
        onUsage: emitter.usage,
      });
    } catch (error) {
      const spawnError = error instanceof Error ? error as NodeJS.ErrnoException : undefined;
      const message = publicFailureMessage("codex", spawnError, "");
      emitter.status("failed", message);
      return Promise.resolve({
        providerId: "codex",
        conversationId,
        status: "failed",
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        text: "",
        textTruncated: false,
        exitCode: null,
        signal: null,
        error: message,
      });
    }

    let active!: ActiveRun;
    const result = codexRun.result.then((runtimeResult): ProviderRunResult => {
      const { diagnostic: runtimeDiagnostic, ...publicRuntimeResult } = runtimeResult;
      active.settled = true;
      if (active.hardKillTimer) clearTimeout(active.hardKillTimer);
      this.activeRuns.delete(conversationId);
      if (runtimeResult.status === "cancelled" || active.cancelRequested) {
        emitter.status("cancelled");
        return { providerId: "codex", conversationId, ...publicRuntimeResult, status: "cancelled" };
      }
      if (runtimeResult.status === "failed") {
        const message = publicFailureMessage("codex", undefined, runtimeDiagnostic ?? "");
        emitter.status("failed", message);
        return { providerId: "codex", conversationId, ...publicRuntimeResult, status: "failed", error: message };
      }
      emitter.status("completed");
      return { providerId: "codex", conversationId, ...publicRuntimeResult, status: "completed" };
    });

    active = {
      result,
      cancelRequested: false,
      settled: false,
      emitStatus: emitter.status,
      cancel: codexRun.cancel,
      respondToApproval: codexRun.respondToApproval,
      respondToInput: codexRun.respondToInput,
    };
    this.activeRuns.set(conversationId, active);
    return result;
  }

  private commandFor(providerId: ProviderId): string {
    const resolved = this.resolvedCommands.get(providerId);
    if (resolved) return resolved;
    const configured = this.commands[providerId]?.trim();
    if (configured && !configured.includes("\0")) return configured;
    return PROVIDER_INFO[providerId].command;
  }
}
