import type {
  InitializeResponse,
  SessionConfigOption,
  ToolCallStatus,
  Usage,
} from "@agentclientprotocol/sdk";

import type { ProviderModel } from "../../shared/contracts";
import type { createAgentHarnessEmitter } from "./agent-harness";
import type { AgentPlanStep } from "./interactions";

const MAX_EVENT_TEXT_CHARS = 1024 * 1024;

export interface KimiContextUsage {
  usedTokens: number | null;
  maxTokens: number | null;
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
      : entry.status === "completed"
        ? "completed"
        : "pending",
  }));
}

export function emitKimiMetadata(
  configOptions: SessionConfigOption[],
  supportsImages: boolean,
  emit: ReturnType<typeof createAgentHarnessEmitter>["rich"],
): void {
  const modelOption = configOptions.find((option) =>
    option.type === "select" && option.category === "model",
  );
  const models = selectChoices(modelOption);
  if (!modelOption || modelOption.type !== "select" || models.length === 0) {
    return;
  }
  const effortOption = configOptions.find((option) =>
    option.type === "select" && option.category === "thought_level",
  );
  const efforts = selectChoices(effortOption).slice(0, 12);
  const defaultEffort = effortOption?.type === "select"
    && typeof effortOption.currentValue === "string"
    ? effortOption.currentValue
    : "";
  const metadata: ProviderModel[] = models.map((model) => {
    const isCurrentModel = modelOption.currentValue === model.value;
    return {
      id: bounded(model.value),
      label: bounded(model.name || model.value),
      description: bounded(model.description || "Kimi Code session model"),
      isDefault: isCurrentModel,
      inputModalities: supportsImages ? ["text", "image"] : ["text"],
      // Kimi advertises thought levels for only the selected model. Do not
      // project those choices onto models whose support has not been observed.
      reasoningOptions: isCurrentModel
        ? efforts.map((effort) => ({
            value: bounded(effort.value),
            label: bounded(effort.name || effort.value),
            description: bounded(
              effort.description
              || `${effort.name || effort.value} reasoning`,
            ),
          }))
        : [],
      defaultReasoningEffort: isCurrentModel ? defaultEffort : "",
    };
  });
  emit({
    type: "metadata",
    metadata: { models: metadata },
    source: "session",
    complete: true,
  });
}

export function validateKimiInitialize(
  initialized: InitializeResponse,
): void {
  if (initialized.protocolVersion !== 1) {
    throw new Error(
      `Unsupported Kimi ACP protocol version: ${initialized.protocolVersion}.`,
    );
  }
  const name = initialized.agentInfo?.name?.toLowerCase() ?? "";
  if (name && !name.includes("kimi")) {
    throw new Error(
      `The selected executable exposed ACP as '${bounded(initialized.agentInfo?.name ?? "unknown")}', not Kimi Code.`,
    );
  }
}

export function emitKimiPromptUsage(
  usage: Usage,
  contextUsage: KimiContextUsage,
  emit: ReturnType<typeof createAgentHarnessEmitter>["rich"],
): void {
  emit({
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

function bounded(value: string): string {
  return value.slice(0, MAX_EVENT_TEXT_CHARS);
}
