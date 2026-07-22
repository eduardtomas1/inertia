import { boundedText, objectValue, type JsonObject } from "./protocol";

export function completedReasoningSummary(item: JsonObject, streamedItemIds: ReadonlySet<string>): string | undefined {
  const itemId = boundedText(item.id, 512);
  if (itemId && streamedItemIds.has(itemId)) return undefined;
  const summary = Array.isArray(item.summary)
    ? item.summary.flatMap((part) => boundedText(objectValue(part)?.text, 32_000) ?? []).join("\n")
    : "";
  return summary || undefined;
}
