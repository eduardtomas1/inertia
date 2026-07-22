import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export const PROVIDER_IDS = ["codex", "claude", "cursor", "opencode"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];
export type ProviderInteractionMode = "build" | "plan";
export type ProviderAccessMode = "full" | "supervised" | "auto-edit";

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
      nativePlanMode: false,
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
}

export interface ProviderDetectionOptions {
  command?: string;
  cwd?: string;
  timeoutMs?: number;
}

interface ProviderRunRequest {
  providerId: ProviderId;
  cwd: string;
  prompt: string;
  model?: string;
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

export type ProviderEvent =
  | ProviderTextEvent
  | ProviderActivityEvent
  | ProviderStatusEvent
  | ProviderSessionEvent;

export interface ProviderRunCallbacks {
  onEvent?: (event: ProviderEvent) => void;
  onText?: (event: ProviderTextEvent) => void;
  onActivity?: (event: ProviderActivityEvent) => void;
  onStatus?: (event: ProviderStatusEvent) => void;
  onSession?: (event: ProviderSessionEvent) => void;
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

interface ProviderInvocation {
  command: string;
  args: string[];
  stdin?: string;
}

interface ParserState {
  sessionId?: string;
  sawText: boolean;
  hadErrorEvent: boolean;
}

interface ActiveRun {
  child: ChildProcessWithoutNullStreams;
  result: Promise<ProviderRunResult>;
  cancelRequested: boolean;
  settled: boolean;
  hardKillTimer?: NodeJS.Timeout;
  emitStatus: (status: ProviderRunStatus, message?: string) => void;
}

type JsonObject = Record<string, unknown>;

const MAX_NDJSON_LINE_CHARS = 1024 * 1024;
const MAX_STDERR_CHARS = 32 * 1024;
const MAX_RESULT_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_PROMPT_CHARS = 256 * 1024;
const MAX_IMAGE_COUNT = 32;
const DEFAULT_DETECTION_TIMEOUT_MS = 2_500;
const DEFAULT_CANCEL_GRACE_MS = 2_000;

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
    }
  };

  const base = { providerId, conversationId };
  return {
    event,
    text: (text) => event({ ...base, type: "text", text }),
    activity: (kind, phase, label) => event({ ...base, type: "activity", kind, phase, label }),
    status: (status, message) => event({ ...base, type: "status", status, ...(message ? { message } : {}) }),
    session: (sessionId) => event({ ...base, type: "session", sessionId }),
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
        for (const text of contentTexts(message?.content)) emitNonEmptyText(text);
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
        if (streamEvent?.type === "content_block_delta") emitNonEmptyText(delta?.text);
        return;
      }
      if (type === "result") {
        if (!state.sawText) emitNonEmptyText(event.result);
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
        if (!state.sawText) emitNonEmptyText(event.result);
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
      const args = ["-p", "--output-format", "stream-json", "--verbose"];
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
): string {
  const providerName = PROVIDER_INFO[providerId].name;
  if (spawnError?.code === "ENOENT") return `${providerName} CLI is not installed or is not available on PATH.`;
  if (spawnError?.code === "EACCES") return `${providerName} CLI could not be started because it is not executable.`;
  const normalized = stderr.toLowerCase();
  if (/not (?:logged|signed) in|authentication required|unauthorized|please (?:log|sign) in/.test(normalized)) {
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

export async function detectProvider(
  providerId: ProviderId,
  options: ProviderDetectionOptions = {},
): Promise<ProviderDetection> {
  const provider = PROVIDER_INFO[providerId];
  const command = options.command?.trim() || provider.command;
  const timeoutMs = Math.max(250, Math.min(options.timeoutMs ?? DEFAULT_DETECTION_TIMEOUT_MS, 10_000));
  const output = new CappedTextBuffer(4 * 1024);

  return await new Promise<ProviderDetection>((resolve) => {
    let settled = false;
    let started = false;
    const finish = (available: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ provider, available, ...(available && versionFromOutput(output.toString()) ? { version: versionFromOutput(output.toString()) } : {}) });
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, ["--version"], {
        cwd: options.cwd ?? process.cwd(),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      resolve({ provider, available: false });
      return;
    }

    child.once("spawn", () => {
      started = true;
    });
    child.stdout.on("data", (chunk: Buffer) => output.append(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => output.append(chunk.toString("utf8")));
    child.once("error", () => finish(false));
    child.once("close", () => finish(started));
    child.stdin.end();

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // A timed-out probe may already have exited.
      }
      finish(started);
    }, timeoutMs);
    timer.unref();
  });
}

export async function detectProviders(
  options: Partial<Record<ProviderId, ProviderDetectionOptions>> = {},
): Promise<ProviderDetection[]> {
  return await Promise.all(PROVIDER_IDS.map((id) => detectProvider(id, options[id])));
}

export class ProviderManager {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly commands: Partial<Record<ProviderId, string>>;
  private readonly cancelGraceMs: number;

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

  detect(providerId: ProviderId, options: Omit<ProviderDetectionOptions, "command"> = {}): Promise<ProviderDetection> {
    return detectProvider(providerId, { ...options, command: this.commandFor(providerId) });
  }

  detectAll(options: Omit<ProviderDetectionOptions, "command"> = {}): Promise<ProviderDetection[]> {
    return Promise.all(PROVIDER_IDS.map((id) => this.detect(id, options)));
  }

  run(input: ProviderRunInput, callbacks: ProviderRunCallbacks = {}): Promise<ProviderRunResult> {
    const conversationId = validateRunInput(input);
    if (this.activeRuns.has(conversationId)) {
      throw new ProviderRuntimeError("already_running", "This conversation already has an active provider run.");
    }

    const providerId = input.providerId;
    const emitter = makeEmitter(providerId, conversationId, callbacks);
    const parserState: ParserState = {
      sessionId: input.sessionId,
      sawText: false,
      hadErrorEvent: false,
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
      child,
      result,
      cancelRequested: false,
      settled: false,
      emitStatus: emitter.status,
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
        const message = publicFailureMessage(providerId, spawnError, stderr.toString());
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
      active.child.kill("SIGTERM");
    } catch {
      // The close event may already be queued.
    }
    active.hardKillTimer = setTimeout(() => {
      if (active.settled) return;
      try {
        active.child.kill("SIGKILL");
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

  private commandFor(providerId: ProviderId): string {
    const configured = this.commands[providerId]?.trim();
    if (configured && !configured.includes("\0")) return configured;
    return PROVIDER_INFO[providerId].command;
  }
}
