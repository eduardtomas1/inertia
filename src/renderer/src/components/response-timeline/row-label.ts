import type { ResponseTimelineItem } from "../../utils/responseTimeline";
import { contextCompactionRowLabel } from "./ContextCompactionRow";
import type { ProviderIdentityLabels } from "@shared/provider-identities";
import { providerHandoffText } from "../../utils/providerHandoff";
import { watcherCheckTitle } from "../../utils/watcherLinks";
import { watcherNoteLabel } from "./WatcherNoteRow";
import { DUO_COMPARISON_REQUEST_LABEL } from "../../utils/response-timeline/virtualization";

const TIMELINE_ARTICLE_REQUEST_LABEL_MAX_CHARS = 96;

export function responseTimelineArticleLabel(
  item: ResponseTimelineItem,
  providerIdentityLabels?: ProviderIdentityLabels,
): string {
  if (item.kind === "handoff") return providerHandoffText(item.handoff, providerIdentityLabels).label;
  if (item.kind === "compaction") return item.message.compaction ? contextCompactionRowLabel(item.message.compaction) : "Compacted context";
  if (item.kind === "compatibility") {
    return "Recovered legacy and orphaned history";
  }
  if (item.kind === "watcher-note") return watcherNoteLabel(item.note);
  const wake = item.turn.watcherWake;
  if (wake) return `Turn ${item.turn.index}: ${watcherCheckTitle(wake)}`;
  if (item.turn.userMessage.duoComparison) return `Turn ${item.turn.index}: ${DUO_COMPARISON_REQUEST_LABEL}`;
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
