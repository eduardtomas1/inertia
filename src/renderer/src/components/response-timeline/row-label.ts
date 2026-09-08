import type { ResponseTimelineItem } from "../../utils/responseTimeline";
import { contextCompactionLabel } from "@shared/context-compaction";

const TIMELINE_ARTICLE_REQUEST_LABEL_MAX_CHARS = 96;

export function responseTimelineArticleLabel(
  item: ResponseTimelineItem,
): string {
  if (item.kind === "compaction") return item.message.compaction ? contextCompactionLabel(item.message.compaction) : "Compacted context";
  if (item.kind === "compatibility") {
    return "Recovered legacy and orphaned history";
  }
  const request = item.turn.userMessage.content.trim().replace(/\s+/gu, " ");
  const requestLabel = request
    ? request.length > TIMELINE_ARTICLE_REQUEST_LABEL_MAX_CHARS
      ? `${request.slice(0, TIMELINE_ARTICLE_REQUEST_LABEL_MAX_CHARS - 1)}…`
      : request
    : item.turn.userMessage.attachments.length > 0
      ? "Request with attachments"
      : "Request";
  return `Turn ${item.turn.index}: ${requestLabel}`;
}
