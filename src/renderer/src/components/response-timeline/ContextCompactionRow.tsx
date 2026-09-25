import type { AgentActivity, ChatMessage } from "@shared/contracts";
import { contextCompactionLabel } from "@shared/context-compaction";
import type { ResponseTimelineItem } from "../../utils/responseTimeline";
import { ContextCompactionIcon } from "../ContextCompactionIcon";
import "./ContextCompactionRow.css";

const COMPACTED_CONTEXT = "Compacted context";
const COMPACTING_CONTEXT = "Compacting context";
const BEFORE_TOKENS = /^Before: (\d+) tokens$/mu;
const AFTER_TOKENS = /^After: (\d+) tokens$/mu;

function reportedTokens(activities: readonly AgentActivity[], pattern: RegExp): number | null {
  for (const { detail } of activities) {
    const match = detail?.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

export function ContextCompactionMarker({
  label,
  elapsed,
}: {
  label: string;
  elapsed?: React.ReactNode;
}): React.JSX.Element {
  const live = elapsed !== undefined;
  const detail = live ? null : label.slice(COMPACTED_CONTEXT.length).trim();
  return (
    <div
      className="context-compaction-separator"
      data-compaction-state={live ? "live" : "settled"}
      role="separator"
      aria-label={label}
    >
      <span aria-hidden="true" />
      <small className="context-compaction-marker" aria-hidden="true">
        <ContextCompactionIcon />
        <span>{live ? COMPACTING_CONTEXT : COMPACTED_CONTEXT}</span>
        {detail && <i>·</i>}
        {detail && <span>{detail}</span>}
        {live && <i>·</i>}
        {elapsed}
      </small>
      <span aria-hidden="true" />
    </div>
  );
}

export function ContextCompactionActivityMarker({
  activities,
  elapsed,
}: {
  activities: readonly AgentActivity[];
  elapsed?: React.ReactNode;
}): React.JSX.Element {
  const live = elapsed !== undefined
    && activities.some(({ status }) => status === "running");
  return (
    <ContextCompactionMarker
      label={live
        ? COMPACTING_CONTEXT
        : contextCompactionLabel({
            beforeTokens: reportedTokens(activities, BEFORE_TOKENS),
            afterTokens: reportedTokens(activities, AFTER_TOKENS),
          })}
      elapsed={live ? elapsed : undefined}
    />
  );
}

export function PendingContextCompaction({
  since,
  items,
  elapsed,
}: {
  since: string;
  items: readonly ResponseTimelineItem[];
  elapsed: React.ReactNode;
}): React.JSX.Element | null {
  const started = Date.parse(since);
  if (items.some((item) => item.kind === "compaction"
    && Date.parse(item.message.createdAt) >= started)) return null;
  return (
    <div className="context-compaction-row" data-compaction-pending="">
      <ContextCompactionMarker label={COMPACTING_CONTEXT} elapsed={elapsed} />
    </div>
  );
}

export function ContextCompactionRow({ message }: { message: ChatMessage }): React.JSX.Element | null {
  if (!message.compaction) return null;
  const label = contextCompactionLabel(message.compaction);
  return (
    <section className="context-compaction-row" data-response-row-id={message.id} tabIndex={-1} aria-label={label}>
      <article className="message is-user turn-user-request">
        <div className="message-body">{message.content}</div>
      </article>
      <ContextCompactionMarker label={label} />
    </section>
  );
}
