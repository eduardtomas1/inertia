import type { SessionConfigOption } from "@agentclientprotocol/sdk";

import type { ProviderModel } from "../../shared/contracts";
import type { createAgentHarnessEmitter } from "./agent-harness";

const MAX_EVENT_TEXT_CHARS = 1024 * 1024;

export function emitCursorMetadata(
  configOptions: SessionConfigOption[],
  supportsImages: boolean,
  emitter: ReturnType<typeof createAgentHarnessEmitter>,
): void {
  const modelOption = configOptions.find((option) =>
    option.type === "select" && option.category === "model");
  const models = selectChoices(modelOption);
  if (!modelOption || modelOption.type !== "select" || models.length === 0) {
    return;
  }
  const effortOption = configOptions.find((option) =>
    option.type === "select" && option.category === "thought_level");
  const efforts = selectChoices(effortOption).slice(0, 12);
  const defaultEffort = effortOption?.type === "select"
    && typeof effortOption.currentValue === "string"
    ? effortOption.currentValue
    : "";
  const metadata: ProviderModel[] = models.map((model) => ({
    id: bounded(model.value),
    label: bounded(model.name || model.value),
    description: bounded(model.description || "Cursor session model"),
    isDefault: modelOption.currentValue === model.value,
    inputModalities: supportsImages ? ["text", "image"] : ["text"],
    reasoningOptions: efforts.map((effort) => ({
      value: bounded(effort.value),
      label: bounded(effort.name || effort.value),
      description: bounded(
        effort.description || `${effort.name || effort.value} reasoning`,
      ),
    })),
    defaultReasoningEffort: defaultEffort,
  }));
  emitter.capability("model-discovery", true);
  emitter.rich({
    type: "metadata",
    metadata: { models: metadata },
    source: "session",
    complete: true,
  });
}

function selectChoices(
  option: SessionConfigOption | undefined,
): Array<{ value: string; name: string; description?: string | null }> {
  if (!option || option.type !== "select") return [];
  return option.options
    .flatMap((entry) => "options" in entry ? entry.options : [entry])
    .slice(0, 64);
}

function bounded(value: string): string {
  return value.slice(0, MAX_EVENT_TEXT_CHARS);
}
