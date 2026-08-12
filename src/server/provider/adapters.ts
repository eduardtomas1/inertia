import { isAbsolute } from "node:path";

import { PROVIDER_INFO } from "./catalog";
import {
  continuationIdentitySchema,
  knownHarnessIdSchema,
  modelBackendProfileSchema,
  modelSelectionSchema,
  nativeBackendProfile,
  type ModelBackendProfile,
} from "../../shared/model-routing";
import {
  PROVIDER_IDS,
  ProviderRuntimeError,
  type ProviderActivityKind,
  type ProviderActivityPhase,
  type ProviderId,
  type ProviderRunInput,
} from "./contracts";
import { providerActivityDetailSections } from "./activity-detail";

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
  sawTerminalEvent?: boolean;
  failureText?: string;
  toolActivities?: Map<
    string,
    { kind: ProviderActivityKind; label: string }
  >;
}

type JsonObject = Record<string, unknown>;

const MAX_PROMPT_CHARS = 256 * 1024;
const MAX_IMAGE_COUNT = 32;
const MAX_SKILL_COUNT = 8;
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
  emitActivity: (
    kind: ProviderActivityKind,
    phase: ProviderActivityPhase,
    label: string,
    detail?: { activityId?: string; detail?: string },
  ) => void,
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
    if (type === "turn.failed") state.sawTerminalEvent = true;
    state.hadErrorEvent = true;
    const error = objectValue(event.error);
    state.failureText ??= stringValue(event.message) ?? stringValue(error?.message) ?? stringValue(event.result);
    const detail = providerActivityDetailSections({ error: state.failureText });
    emitActivity(
      "system",
      "failed",
      `${PROVIDER_INFO[providerId].name} reported an error`,
      detail ? { detail } : undefined,
    );
  }

  switch (providerId) {
    case "codex": {
      if (type === "turn.started") emitActivity("turn", "started", "Turn started");
      if (type === "turn.completed") {
        state.sawTerminalEvent = true;
        emitActivity("turn", "completed", "Turn completed");
      }

      const item = objectValue(event.item);
      if (!item) return;
      const itemType = stringValue(item.type);
      if (itemType === "agent_message" && type === "item.completed") {
        emitNonEmptyText(item.text);
        return;
      }
      if (itemType === "reasoning") {
        emitActivity(
          "reasoning",
          type === "item.completed" ? "completed" : "started",
          "Reasoning",
          boundedIdentifier(item.id) ? { activityId: boundedIdentifier(item.id)! } : undefined,
        );
        return;
      }
      if (itemType === "command_execution") {
        const detail = providerActivityDetailSections({
          command: item.command ?? item.cmd,
          ...(type === "item.completed"
            ? {
                output: item.aggregated_output
                  ?? item.aggregatedOutput
                  ?? item.output
                  ?? [item.stdout, item.stderr],
              }
            : {}),
        });
        emitActivity(
          "command",
          type === "item.completed" ? "completed" : "started",
          "Command",
          {
            ...(boundedIdentifier(item.id)
              ? { activityId: boundedIdentifier(item.id)! }
              : {}),
            ...(detail ? { detail } : {}),
          },
        );
        return;
      }
      if (itemType && itemType !== "agent_message") {
        emitActivity(
          "tool",
          type === "item.completed" ? "completed" : "started",
          humanizeToolName(itemType),
          boundedIdentifier(item.id) ? { activityId: boundedIdentifier(item.id)! } : undefined,
        );
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
        if (Array.isArray(message?.content)) {
          for (const blockValue of message.content) {
            const block = objectValue(blockValue);
            if (block?.type !== "tool_use") continue;
            const label = humanizeToolName(block.name);
            const kind = block.name === "Bash" ? "command" : "tool";
            const activityId = boundedIdentifier(block.id);
            if (activityId) {
              (state.toolActivities ??= new Map()).set(activityId, {
                kind,
                label,
              });
            }
            const input = objectValue(block.input);
            const detail = kind === "command"
              ? providerActivityDetailSections({ command: input?.command })
              : null;
            emitActivity(kind, "started", label, {
              ...(activityId ? { activityId } : {}),
              ...(detail ? { detail } : {}),
            });
          }
        }
        return;
      }
      if (type === "user") {
        const message = objectValue(event.message);
        if (Array.isArray(message?.content)) {
          for (const blockValue of message.content) {
            const block = objectValue(blockValue);
            if (block?.type !== "tool_result") continue;
            const activityId = boundedIdentifier(block.tool_use_id);
            const activity = activityId
              ? state.toolActivities?.get(activityId)
              : undefined;
            const failed = block.is_error === true;
            const detail = providerActivityDetailSections({
              [failed ? "error" : "output"]: block.content,
            });
            emitActivity(
              activity?.kind ?? "tool",
              failed ? "failed" : "completed",
              activity?.label ?? "Tool",
              {
                ...(activityId ? { activityId } : {}),
                ...(detail ? { detail } : {}),
              },
            );
            if (activityId) state.toolActivities?.delete(activityId);
          }
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
        state.sawTerminalEvent = true;
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
        const toolCall = objectValue(event.tool_call);
        const activityId = boundedIdentifier(toolCall?.toolCallId)
          ?? boundedIdentifier(toolCall?.id)
          ?? boundedIdentifier(event.tool_call_id);
        const kind = toolCall?.kind === "execute" ? "command" : "tool";
        const rawInput = objectValue(toolCall?.rawInput);
        const failed = phase === "failed";
        const detail = providerActivityDetailSections({
          command: rawInput?.command,
          [failed ? "error" : "output"]:
            toolCall?.rawOutput ?? toolCall?.output ?? toolCall?.content,
        });
        emitActivity(kind, phase, cursorToolName(event.tool_call), {
          ...(activityId ? { activityId } : {}),
          ...(detail ? { detail } : {}),
        });
        return;
      }
      if (type === "result") {
        state.sawTerminalEvent = true;
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
        const tool = stringValue(part?.tool);
        const input = objectValue(toolState?.input);
        const error = objectValue(toolState?.error);
        const detail = providerActivityDetailSections({
          command: input?.command,
          ...(phase === "failed"
            ? { error: stringValue(error?.message) ?? toolState?.error }
            : { output: toolState?.output }),
        });
        emitActivity(
          tool === "bash" ? "command" : "tool",
          phase,
          humanizeToolName(tool),
          {
            ...(boundedIdentifier(part?.callID) ?? boundedIdentifier(part?.id)
              ? {
                  activityId: (boundedIdentifier(part?.callID)
                    ?? boundedIdentifier(part?.id))!,
                }
              : {}),
            ...(detail ? { detail } : {}),
          },
        );
        return;
      }
      if (type === "step_finish") {
        const reason = stringValue(part?.reason);
        if (reason === "stop") state.sawTerminalEvent = true;
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
  if (!knownHarnessIdSchema.safeParse(input.harnessId).success) {
    throw new ProviderRuntimeError("invalid_input", "Unknown agent harness.");
  }
  if (!modelBackendProfileSchema.safeParse(input.backendProfile).success) {
    throw new ProviderRuntimeError("invalid_input", "The model backend profile is invalid.");
  }
  if (!modelSelectionSchema.safeParse(input.modelSelection).success) {
    throw new ProviderRuntimeError("invalid_input", "The model selection is invalid.");
  }
  if (!continuationIdentitySchema.safeParse(input.continuationIdentity).success) {
    throw new ProviderRuntimeError("invalid_input", "The continuation identity is invalid.");
  }
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
  if (
    input.goalContinuationExpected !== undefined
    && typeof input.goalContinuationExpected !== "boolean"
  ) {
    throw new ProviderRuntimeError(
      "invalid_input",
      "The goal continuation hint is invalid.",
    );
  }
  if (
    input.goalContinuationExpected === true
    && (
      input.providerId !== "codex"
      || input.harnessId !== "codex-app-server"
      || (!input.sessionId && !input.goalStart)
    )
  ) {
    throw new ProviderRuntimeError(
      "invalid_input",
      "The goal continuation hint is invalid.",
    );
  }
  if (input.goalStart) {
    const objective = input.goalStart.objective?.trim();
    const budget = input.goalStart.tokenBudget;
    if (
      input.providerId !== "codex"
      || input.harnessId !== "codex-app-server"
      || (input.goalStart.objective !== undefined && (
        !objective
        || objective.length > 4_000
        || objective.includes("\0")
      ))
      || (
        budget !== undefined
        && budget !== null
        && (
          !Number.isSafeInteger(budget)
          || budget < 1
          || budget > 1_000_000_000
        )
      )
    ) {
      throw new ProviderRuntimeError(
        "invalid_input",
        "The native goal start request is invalid.",
      );
    }
  }
  if (input.operation) {
    const instruction = input.operation.instruction?.trim();
    if (
      input.operation.kind !== "compact"
      || !input.sessionId
      || input.turnId !== undefined
      || input.goalStart !== undefined
      || input.goalContinuationExpected !== undefined
      || (input.imagePaths?.length ?? 0) > 0
      || (input.skills?.length ?? 0) > 0
      || (input.operation.instruction !== undefined && (
        !instruction
        || instruction.length > 4_000
        || instruction.includes("\0")
      ))
    ) {
      throw new ProviderRuntimeError(
        "invalid_input",
        "The provider compaction request is invalid.",
      );
    }
  }
  for (const value of [input.runId, input.turnId, input.model, input.sessionId]) {
    if (value !== undefined && (!value.trim() || value.length > 512 || value.includes("\0"))) {
      throw new ProviderRuntimeError("invalid_input", "A provider option is invalid.");
    }
  }
  if ((input.runId === undefined) !== (input.turnId === undefined)) {
    throw new ProviderRuntimeError("invalid_input", "Run and turn identities must be provided together.");
  }
  const imagePaths = input.imagePaths ?? [];
  if (imagePaths.length > MAX_IMAGE_COUNT) {
    throw new ProviderRuntimeError("invalid_input", "Too many images were attached.");
  }
  if (imagePaths.some((path) => !path.trim() || path.length > 4096 || path.includes("\0"))) {
    throw new ProviderRuntimeError("invalid_input", "An image path is invalid.");
  }
  const skills = input.skills ?? [];
  if (skills.length > MAX_SKILL_COUNT) {
    throw new ProviderRuntimeError("invalid_input", "Too many skills were selected.");
  }
  if (
    skills.length > 0
    && input.harnessId !== "codex-app-server"
    && input.harnessId !== "claude-agent-sdk"
  ) {
    throw new ProviderRuntimeError(
      "invalid_input",
      "The selected harness does not support structured skills.",
    );
  }
  if (skills.some((skill) =>
    !skill.name.trim()
    || skill.name.length > 160
    || skill.name.includes("\0")
    || (
      input.harnessId === "codex-app-server"
      && (
        skill.source !== "codex-native"
        || !skill.path.trim()
        || !isAbsolute(skill.path)
        || skill.path.length > 4096
        || skill.path.includes("\0")
      )
    )
    || (
      input.harnessId === "claude-agent-sdk"
      && skill.source !== "claude-native"
    )
  )) {
    throw new ProviderRuntimeError("invalid_input", "A skill reference is invalid.");
  }
  return conversationId;
}

export function providerFailureMessage(
  providerId: ProviderId,
  spawnError: NodeJS.ErrnoException | undefined,
  stderr: string,
  providerOutput = "",
  backendProfile?: Pick<
    ModelBackendProfile,
    "id" | "displayName" | "authenticationMode"
  >,
): string {
  const providerName = PROVIDER_INFO[providerId].name;
  const customBackend = backendProfile !== undefined
    && backendProfile.id !== nativeBackendProfile(providerId).id;
  const backendName = customBackend
    ? safeProviderBackendLabel(backendProfile.displayName)
    : providerName;
  if (spawnError?.code === "ENOENT") return `${providerName} CLI is not installed or is not available on PATH.`;
  if (spawnError?.code === "EACCES") return `${providerName} CLI could not be started because it is not executable.`;
  const normalized = `${stderr}\n${providerOutput}`.toLowerCase();
  if (/requires a newer version|please upgrade (?:to )?the latest (?:app|cli)|cli.+out of date/.test(normalized)) {
    return `${providerName} needs an update before it can run the selected model.`;
  }
  if (/not (?:logged|signed) in|authentication required|failed to authenticate|oauth session expired|unauthorized|credential (?:is )?unavailable|invalid (?:api[ -]?key|token|credential)|please (?:log|sign) in|\b401\b/.test(normalized)) {
    return customBackend
      ? `Authentication failed for ${backendName}. Check this model backend's credential and try again.`
      : `${providerName} is not authenticated. Sign in with its CLI and try again.`;
  }
  if (/rate.?limit|too many requests|quota|\b429\b/.test(normalized)) {
    return `${backendName} is temporarily rate limited. Try again shortly.`;
  }
  if (/model.+(?:not found|unknown|invalid|unavailable)/.test(normalized)) {
    return `The selected ${backendName} model is unavailable.`;
  }
  return `${backendName} could not complete the request.`;
}

/** Safe persisted backend labels may still contain control characters. */
export function safeProviderBackendLabel(value: string): string {
  const label = value
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
  return label || "the selected model backend";
}
