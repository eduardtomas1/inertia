import type {
  InitializeResponse,
  RequestPermissionRequest,
  SessionConfigOption,
  ToolCallStatus,
  Usage,
} from "@agentclientprotocol/sdk/unstable";

import { clipCodeUnits } from "../../shared/code-units";
import type { ProviderModel } from "../../shared/contracts";
import { acpPermissionDetail } from "./acp-permission-detail";
import type { createAgentHarnessEmitter } from "./agent-harness";
import {
  isSafeApprovalDisplayText,
  isSafeInteractionDisplayText,
} from "./approval-display";
import { INERTIA_HOST_MCP_NAME } from "./host-tool-mcp-config";
import type { AgentInputRequest, AgentPlanStep } from "./interactions";

const MAX_EVENT_TEXT_CHARS = 1024 * 1024;
const MAX_SESSION_TITLE_CHARS = 240;
const MAX_INPUT_OPTIONS = 20;
const MAX_INPUT_QUESTION_CHARS = 16_384;
const MAX_INPUT_OPTION_LABEL_CHARS = 512;
const MAX_INPUT_OPTION_ID_CHARS = 160;
const ANTIGRAVITY_INERTIA_MCP_TITLE = /^Run mcp_inertia-chat-manager_(?<tool>[A-Za-z0-9_]+)\??$/u;
const ANTIGRAVITY_PROXIED_MCP_TITLE = /^MCP Tool (?<tool>[A-Za-z0-9_]+)\??$/u;
const EFFORT_LABELS: Readonly<Record<string, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export interface AntigravityContextUsage {
  usedTokens: number | null;
  maxTokens: number | null;
}

export interface AntigravityInitializeCapabilities {
  supportsImages: boolean;
  supportsHttpMcp: boolean;
  supportsLoadSession: boolean;
  supportsResumeSession: boolean;
  supportsCloseSession: boolean;
  authMethods: InitializeResponse["authMethods"];
}

export interface AntigravityInputOption {
  id: string;
  label: string;
}

export interface AntigravityInputQuestionData {
  questionId: string;
  prompt: string;
  options: AntigravityInputOption[];
}

export function toolActivityPhase(
  status: ToolCallStatus | null | undefined,
): "started" | "completed" | "failed" {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "started";
}

export function planSteps(
  entries: ReadonlyArray<{ content: string; status: string }>,
): AgentPlanStep[] {
  return entries.slice(0, 100).map((entry) => ({
    step: bounded(entry.content),
    status: entry.status === "in_progress"
      ? "inProgress"
      : entry.status === "completed" || entry.status === "cancelled"
        ? entry.status
        : "pending",
  }));
}

export function emitAntigravityMetadata(
  configOptions: SessionConfigOption[],
  supportsImages: boolean,
  emitter: ReturnType<typeof createAgentHarnessEmitter>,
): void {
  const modelOption = configOptions.find((option) =>
    option.type === "select" && (option.category === "model" || option.id === "model"),
  );
  const models = selectChoices(modelOption);
  if (!modelOption || modelOption.type !== "select" || models.length === 0) {
    return;
  }
  const effortOption = configOptions.find((option) =>
    option.type === "select"
    && (
      option.category === "thought_level"
      || option.id === "thought_level"
      || option.id === "thinking_level"
      || option.id === "reasoning_effort"
    ),
  );
  const rawEfforts = selectChoices(effortOption).slice(0, 12);
  // Fixed-effort models (such as Orchestrator) either omit thought_level or
  // expose a single non-adjustable value. Only project adjustable choices.
  const adjustableEfforts = rawEfforts.length > 1 ? rawEfforts : [];
  const defaultEffort = effortOption?.type === "select"
    && adjustableEfforts.length > 0
    && typeof effortOption.currentValue === "string"
    ? effortOption.currentValue
    : "";
  const metadata: ProviderModel[] = models.map((model) => {
    const isCurrentModel = modelOption.currentValue === model.value;
    return {
      id: bounded(model.value),
      label: bounded(model.name || model.value),
      description: bounded(model.description || "Antigravity session model"),
      isDefault: isCurrentModel,
      inputModalities: supportsImages ? ["text", "image"] : ["text"],
      reasoningOptions: isCurrentModel
        ? adjustableEfforts.map((effort) => {
            const label = effortLabel(effort.value, effort.name);
            return {
              value: bounded(effort.value),
              label: bounded(label),
              description: bounded(
                effort.description || `${label} reasoning`,
              ),
            };
          })
        : [],
      defaultReasoningEffort: isCurrentModel ? defaultEffort : "",
      reasoningObserved: isCurrentModel,
    };
  });
  emitter.capability("model-discovery", true);
  emitter.rich({
    type: "metadata",
    metadata: { models: metadata },
    source: "session",
    complete: true,
  });
}

export function validateAntigravityInitialize(
  initialized: InitializeResponse,
): AntigravityInitializeCapabilities {
  if (initialized.protocolVersion !== 1) {
    throw new Error(
      `Unsupported Antigravity ACP protocol version: ${initialized.protocolVersion}.`,
    );
  }
  const name = initialized.agentInfo?.name?.toLowerCase() ?? "";
  if (name && !name.includes("antigravity") && !name.includes("agy")) {
    throw new Error(
      `The selected executable exposed ACP as '${bounded(initialized.agentInfo?.name ?? "unknown")}', not Antigravity.`,
    );
  }
  const capabilities = objectValue(initialized.agentCapabilities);
  const promptCapabilities = objectValue(
    capabilities?.promptCapabilities ?? capabilities?.prompt_capabilities,
  );
  const mcpCapabilities = objectValue(
    capabilities?.mcpCapabilities ?? capabilities?.mcp_capabilities,
  );
  const sessionCapabilities = objectValue(
    capabilities?.sessionCapabilities ?? capabilities?.session_capabilities,
  );
  return {
    supportsImages: promptCapabilities?.image === true,
    supportsHttpMcp: mcpCapabilities?.http === true,
    supportsLoadSession: capabilities?.loadSession === true || capabilities?.load_session === true,
    supportsResumeSession: Boolean(sessionCapabilities?.resume),
    supportsCloseSession: Boolean(sessionCapabilities?.close),
    authMethods: initialized.authMethods,
  };
}

export function isAntigravityUserInputRequest(
  params: Pick<RequestPermissionRequest, "toolCall">,
): boolean {
  return typeof params.toolCall.toolCallId === "string"
    && params.toolCall.toolCallId.startsWith("interaction_");
}

export function antigravityInputOptions(
  params: Pick<RequestPermissionRequest, "toolCall" | "options">,
): AntigravityInputQuestionData | null {
  if (!isAntigravityUserInputRequest(params)) return null;
  const questionId = params.toolCall.toolCallId;
  if (!questionId || questionId.length > 1_000 || questionId.includes("\0")) {
    return null;
  }
  if (
    !Array.isArray(params.options)
    || params.options.length === 0
    || params.options.length > MAX_INPUT_OPTIONS
  ) {
    return null;
  }
  const seenIds = new Set<string>();
  const options: AntigravityInputOption[] = [];
  for (const option of params.options) {
    if (
      typeof option?.optionId !== "string"
      || option.optionId.trim().length === 0
      || option.optionId.length > MAX_INPUT_OPTION_ID_CHARS
      || seenIds.has(option.optionId)
    ) {
      return null;
    }
    const rawLabel = typeof option.name === "string" && option.name.trim()
      ? option.name.trim()
      : option.optionId;
    if (!isSafeApprovalDisplayText(rawLabel)) return null;
    const label = boundQuestionText(rawLabel, MAX_INPUT_OPTION_LABEL_CHARS);
    if (!isSafeInteractionDisplayText(label, { maxChars: MAX_INPUT_OPTION_LABEL_CHARS })) {
      return null;
    }
    seenIds.add(option.optionId);
    options.push({ id: option.optionId, label });
  }
  const rawPrompt = typeof params.toolCall.title === "string" && params.toolCall.title.trim()
    ? params.toolCall.title.trim()
    : "Choose an option.";
  if (!isSafeApprovalDisplayText(rawPrompt, true)) return null;
  const prompt = boundQuestionText(rawPrompt, MAX_INPUT_QUESTION_CHARS);
  if (
    !isSafeInteractionDisplayText(prompt, {
      allowLineBreaks: true,
      maxChars: MAX_INPUT_QUESTION_CHARS,
    })
  ) {
    return null;
  }
  return { questionId, prompt, options };
}

export function antigravityInputRequest(
  requestId: string,
  input: AntigravityInputQuestionData,
): AgentInputRequest {
  return {
    requestId,
    autoResolutionMs: null,
    questions: [{
      id: input.questionId,
      header: "Question",
      question: input.prompt,
      isOther: false,
      isSecret: false,
      allowMultiple: false,
      options: input.options.map((option) => ({
        id: option.id,
        label: option.label,
        description: option.label,
      })),
    }],
  };
}

export function resolveAntigravityInputOptionId(
  params: Pick<RequestPermissionRequest, "toolCall" | "options">,
  displayInput: AntigravityInputQuestionData,
  answers: Record<string, string[]>,
): string | undefined {
  const answer = answers[displayInput.questionId]?.[0];
  if (typeof answer !== "string" || answer.length === 0) return undefined;
  const exact = displayInput.options.find((option) => option.id === answer);
  const selected = exact ?? (() => {
    const matches = displayInput.options.filter((option) => option.label === answer);
    return matches.length === 1 ? matches[0] : undefined;
  })();
  if (!selected) return undefined;
  const sourceInput = antigravityInputOptions(params);
  return sourceInput?.options.find(({ id }) => id === selected.id)?.id;
}

export function antigravityRawCommand(
  rawInput: Record<string, unknown> | undefined,
): string | undefined {
  if (!rawInput) return undefined;
  for (const key of ["command", "CommandLine", "command_line", "commandLine"] as const) {
    const value = rawInput[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function antigravityRawCwd(
  rawInput: Record<string, unknown> | undefined,
): string | undefined {
  if (!rawInput) return undefined;
  for (const key of ["cwd", "Cwd", "WorkingDirectory", "working_dir", "workingDir"] as const) {
    const value = rawInput[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

export function antigravityRawDescription(
  rawInput: Record<string, unknown> | undefined,
): string | undefined {
  if (!rawInput) return undefined;
  for (const key of ["description", "Description"] as const) {
    const value = rawInput[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

export function isAntigravityInertiaMcpRequest(
  params: Pick<RequestPermissionRequest, "toolCall">,
): boolean {
  const title = params.toolCall.title?.trim() ?? "";
  const rawInput = objectValue(params.toolCall.rawInput);
  if (antigravityRawCommand(rawInput) !== undefined) return false;
  const proxiedTool = ANTIGRAVITY_PROXIED_MCP_TITLE.exec(title)?.groups?.tool;
  if (proxiedTool !== undefined) {
    if (rawInput?.ServerName !== INERTIA_HOST_MCP_NAME) return false;
    if (rawInput.ToolName !== undefined && rawInput.ToolName !== proxiedTool) {
      return false;
    }
    return true;
  }
  return ANTIGRAVITY_INERTIA_MCP_TITLE.test(title);
}

export function antigravityApprovalBody(
  params: RequestPermissionRequest,
  fallbackCwd: string,
): { command?: string; detail?: string; cwd: string } {
  const rawInput = objectValue(params.toolCall.rawInput);
  const rawCwd = antigravityRawCwd(rawInput);
  const cwd = rawCwd && isSafeApprovalDisplayText(rawCwd)
    ? bounded(rawCwd)
    : fallbackCwd;
  const command = params.toolCall.kind === "execute"
    ? antigravityRawCommand(rawInput)
    : undefined;
  if (command !== undefined) {
    const description = antigravityRawDescription(rawInput);
    return {
      command: bounded(command),
      ...(description ? { detail: bounded(description) } : {}),
      cwd,
    };
  }
  return {
    detail: bounded(acpPermissionDetail(params, "Antigravity requested permission.")),
    cwd,
  };
}

export function antigravityToolDetailPayload(
  rawOutput: unknown,
  content: unknown,
  locations: ReadonlyArray<{ path: string; line?: number | null }> | null | undefined,
): unknown {
  const payload = rawOutput ?? content;
  if (!locations || locations.length === 0) return payload;
  const locationText = locations
    .slice(0, 16)
    .map((loc) => (typeof loc.line === "number" ? `${loc.path}:${loc.line}` : loc.path))
    .join("\n");
  if (payload === undefined || payload === null) return locationText;
  if (typeof payload === "string") return `${locationText}\n${payload}`;
  return { locations: locationText, output: payload };
}

export function sanitizeAntigravitySessionTitle(
  value: string | null | undefined,
): string {
  if (typeof value !== "string") return "";
  return clipCodeUnits(
    value
      .replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
    MAX_SESSION_TITLE_CHARS,
  );
}

function boundQuestionText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const prefix = text.slice(0, limit - 3).replace(/[\uD800-\uDBFF]$/u, "");
  return `${prefix}...`;
}

export function emitAntigravityPromptUsage(
  usage: Usage,
  contextUsage: AntigravityContextUsage,
  emitter: ReturnType<typeof createAgentHarnessEmitter>,
): void {
  emitter.capability("usage-tokens", true);
  emitter.rich({
    type: "usage",
    usage: {
      usedTokens: contextUsage.usedTokens,
      totalProcessedTokens: tokenCount(usage.totalTokens),
      totalProcessedScope: "session",
      maxTokens: contextUsage.maxTokens,
      inputTokens: tokenCount(usage.inputTokens),
      cachedInputTokens: tokenCount(usage.cachedReadTokens),
      cacheWriteInputTokens: tokenCount(usage.cachedWriteTokens),
      outputTokens: tokenCount(usage.outputTokens),
      reasoningOutputTokens: tokenCount(usage.thoughtTokens),
      compactsAutomatically: null,
    },
  });
}

export function tokenCount(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : null;
}

function effortLabel(value: string, name: string | undefined): string {
  const known = EFFORT_LABELS[value.toLowerCase()];
  if (known) return known;
  return name?.trim() || value;
}

function selectChoices(
  option: SessionConfigOption | undefined,
): Array<{
  value: string;
  name: string;
  description?: string | null;
}> {
  if (!option || option.type !== "select") return [];
  return option.options
    .flatMap((entry) => "options" in entry ? entry.options : [entry])
    .slice(0, 64);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function bounded(value: string): string {
  return clipCodeUnits(value, MAX_EVENT_TEXT_CHARS);
}
