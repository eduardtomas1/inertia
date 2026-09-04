import type {
  InitializeResponse,
  ToolCallStatus,
  Usage,
} from "@agentclientprotocol/sdk";

import type { ProviderModel } from "../../shared/contracts";
import type { createAgentHarnessEmitter } from "./agent-harness";
import type { GeminiSessionModels } from "./gemini-acp-session";
import type { AgentPlanStep } from "./interactions";

const MAX_EVENT_TEXT_CHARS = 1024 * 1024;

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
      : entry.status === "completed"
        ? "completed"
        : "pending",
  }));
}

export function emitGeminiMetadata(
  models: GeminiSessionModels | null,
  supportsImages: boolean,
  emit: ReturnType<typeof createAgentHarnessEmitter>["rich"],
): void {
  if (!models || models.availableModels.length === 0) return;
  const metadata: ProviderModel[] = models.availableModels.map((model) => ({
    id: model.modelId,
    label: model.name,
    description: model.description ?? "Gemini CLI session model",
    isDefault: model.modelId === models.currentModelId,
    inputModalities: supportsImages ? ["text", "image"] : ["text"],
    // Gemini ACP does not expose thinking-level configuration per model.
    reasoningOptions: [],
    defaultReasoningEffort: "",
  }));
  emit({
    type: "metadata",
    metadata: { models: metadata },
    source: "session",
    complete: true,
  });
}

export function validateGeminiInitialize(
  value: unknown,
): InitializeResponse {
  const initialized = objectValue(value);
  if (!initialized) {
    throw new Error("Gemini ACP returned a malformed initialize response.");
  }
  if (initialized.protocolVersion !== 1) {
    throw new Error(
      `Unsupported Gemini ACP protocol version: ${initialized.protocolVersion}.`,
    );
  }
  const agentInfo = objectValue(initialized.agentInfo);
  const rawName = agentInfo?.name;
  if (rawName !== "gemini-cli") {
    throw new Error(
      `The selected executable exposed ACP as '${bounded(typeof rawName === "string" ? rawName : "unknown")}', not Gemini CLI.`,
    );
  }
  const version = agentInfo?.version;
  if (
    typeof version !== "string"
    || version.length === 0
    || version.length > 100
    || /[\u0000-\u001f\u007f]/u.test(version)
  ) {
    throw new Error("Gemini ACP returned malformed agent version metadata.");
  }
  const capabilities = objectValue(initialized.agentCapabilities);
  if (!capabilities) {
    throw new Error("Gemini ACP returned malformed agent capabilities.");
  }
  if (
    capabilities.promptCapabilities !== undefined
    && capabilities.promptCapabilities !== null
    && !objectValue(capabilities.promptCapabilities)
  ) throw new Error("Gemini ACP returned malformed prompt capabilities.");
  if (
    capabilities.mcpCapabilities !== undefined
    && capabilities.mcpCapabilities !== null
    && !objectValue(capabilities.mcpCapabilities)
  ) throw new Error("Gemini ACP returned malformed MCP capabilities.");
  return initialized as unknown as InitializeResponse;
}

export function emitGeminiPromptUsage(
  response: unknown,
  contextUsage: {
    usedTokens: number | null;
    maxTokens: number | null;
  },
  emit: ReturnType<typeof createAgentHarnessEmitter>["rich"],
): void {
  const root = objectValue(response);
  const standard = objectValue(root?.usage) as Partial<Usage> | undefined;
  const quota = objectValue(objectValue(root?._meta)?.quota);
  const quotaTokens = objectValue(quota?.token_count);

  const inputTokens = tokenCount(
    standard?.inputTokens ?? quotaTokens?.input_tokens,
  );
  const outputTokens = tokenCount(
    standard?.outputTokens ?? quotaTokens?.output_tokens,
  );
  const totalTokens = tokenCount(standard?.totalTokens)
    ?? safeSum(inputTokens, outputTokens);
  const cachedInputTokens = tokenCount(standard?.cachedReadTokens);
  const cacheWriteInputTokens = tokenCount(standard?.cachedWriteTokens);
  const reasoningOutputTokens = tokenCount(standard?.thoughtTokens);
  if (
    inputTokens === null
    && outputTokens === null
    && totalTokens === null
    && cachedInputTokens === null
    && cacheWriteInputTokens === null
    && reasoningOutputTokens === null
  ) return;

  emit({
    type: "usage",
    usage: {
      usedTokens: contextUsage.usedTokens,
      totalProcessedTokens: totalTokens,
      totalProcessedScope: "run",
      maxTokens: contextUsage.maxTokens,
      inputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      outputTokens,
      reasoningOutputTokens,
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

function safeSum(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null;
  const total = left + right;
  return Number.isSafeInteger(total) ? total : null;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function bounded(value: string): string {
  return value.replaceAll("\0", "").slice(0, MAX_EVENT_TEXT_CHARS);
}
