/** Longest agent label a watcher note or the dock shows. Equal to `MAX_WATCHER_LABEL_CHARS`. */
export const MAX_WATCHER_AGENT_LABEL_CHARS = 80;
export const WATCHER_AGENT_LABEL_SEPARATOR = " · ";

export interface WatcherAgentLabelSource {
  providerId: string;
  modelSelection: { alias?: string | null; modelId?: string | null };
}

function clipCodeUnits(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const last = value.charCodeAt(maximum - 1);
  return value.slice(0, last >= 0xD800 && last <= 0xDBFF ? maximum - 1 : maximum);
}

function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, " ").replace(/\s+/gu, " ").trim();
}

/**
 * The single name of a watcher's agent: the provider identity label, then the
 * model when one is chosen ("Codex · gpt-5"), or the provider alone for the
 * provider's default model. The server stamps it on forwarded notes and the
 * renderer uses it in the dock, so both name the agent the same way. Kept
 * free of schema dependencies so renderer callers stay out of the zod chunk.
 */
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
