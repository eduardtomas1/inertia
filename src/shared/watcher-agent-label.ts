import { clipCodeUnits } from "./code-units";

export const MAX_WATCHER_AGENT_LABEL_CHARS = 80;
const WATCHER_AGENT_LABEL_SEPARATOR = " · ";

interface WatcherAgentLabelSource {
  providerId: string;
  modelSelection: { alias?: string | null; modelId?: string | null };
}

function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, " ").replace(/\s+/gu, " ").trim();
}

export function watcherAgentLabel(
  conversation: WatcherAgentLabelSource | undefined,
  providerLabels: Readonly<Record<string, string | undefined>> | undefined,
): string {
  if (!conversation) return "Watcher";
  const provider = oneLine(providerLabels?.[conversation.providerId] ?? "") || oneLine(conversation.providerId) || "Watcher";
  const selection = conversation.modelSelection;
  const model = oneLine(selection.alias ?? "")
    || (selection.modelId && selection.modelId !== "provider-default" ? oneLine(selection.modelId) : "");
  const label = model ? `${provider}${WATCHER_AGENT_LABEL_SEPARATOR}${model}` : provider;
  return clipCodeUnits(label, MAX_WATCHER_AGENT_LABEL_CHARS).trim() || "Watcher";
}
