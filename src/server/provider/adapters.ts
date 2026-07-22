import { PROVIDER_INFO } from "./catalog";
import {
  PROVIDER_IDS,
  ProviderRuntimeError,
  type ProviderActivityKind,
  type ProviderActivityPhase,
  type ProviderId,
  type ProviderRunInput,
} from "./contracts";

export interface ProviderInvocation {
  command: string;
  args: string[];
  stdin?: string;
}

export interface ProviderParserState {
  sessionId?: string;
  sawText: boolean;
  sawStreamingDelta: boolean;
  hadErrorEvent: boolean;
  failureText?: string;
}

type JsonObject = Record<string, unknown>;

const MAX_PROMPT_CHARS = 256 * 1024;
const MAX_IMAGE_COUNT = 32;
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

export function normalizeProviderLine(
  providerId: ProviderId,
  line: string,
  state: ProviderParserState,
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

function imageContextPrompt(prompt: string, imagePaths: readonly string[]): string {
  if (imagePaths.length === 0) return prompt;
  const references = imagePaths.map((path) => `- ${JSON.stringify(path)}`).join("\n");
  return `${prompt}\n\nInspect these local image files as visual context:\n${references}`;
}

export function buildProviderInvocation(input: ProviderRunInput, command: string): ProviderInvocation {
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

export function validateProviderRunInput(input: ProviderRunInput): string {
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

export function providerFailureMessage(
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
