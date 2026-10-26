import type { AgentActivity, ChatMessage } from "@shared/contracts";
import {
  contextCompactionLabel,
  type ContextCompaction,
  type ContextCompactionTrigger,
} from "@shared/context-compaction";
import type { ResponseTimelineItem } from "../../utils/responseTimeline";
import "./ContextCompactionRow.css";

const COMPACTED_CONTEXT = "Compacted context";
const COMPACTED_ON_RETURN = "Compacted on return";
const COMPACTING_CONTEXT = "Compacting context";
const COMPACTING_BEFORE_SENDING = "Compacting before sending";
const BEFORE_TOKENS = /^Before: (\d+) tokens$/mu;
const AFTER_TOKENS = /^After: (\d+) tokens$/mu;

function reportedTokens(activities: readonly AgentActivity[], pattern: RegExp): number | null {
  for (const { detail } of activities) {
    const match = detail?.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

export function contextCompactionRowLabel(
  compaction: Pick<ContextCompaction, "beforeTokens" | "afterTokens" | "trigger">,
): string {
  const label = contextCompactionLabel(compaction);
  return compaction.trigger === "on-return"
    ? `${COMPACTED_ON_RETURN}${label.slice(COMPACTED_CONTEXT.length)}`
    : label;
}

function settledTitle(label: string): string {
  return label.startsWith(COMPACTED_ON_RETURN) ? COMPACTED_ON_RETURN : COMPACTED_CONTEXT;
}

export function ContextCompactionMarker({
  label,
  elapsed,
}: {
  label: string;
  elapsed?: React.ReactNode;
}): React.JSX.Element {
  const live = elapsed !== undefined;
  const title = live ? label : settledTitle(label);
  const detail = live ? null : label.slice(title.length).trim();
  return (
    <div
      className="context-compaction-separator"
      data-compaction-state={live ? "live" : "settled"}
      role="separator"
      aria-label={label}
    >
      <span aria-hidden="true" />
      <small className="context-compaction-marker" aria-hidden="true">
        <span>{title}</span>
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
  trigger = "manual",
  items,
  elapsed,
}: {
  since: string;
  trigger?: ContextCompactionTrigger | null;
  items: readonly ResponseTimelineItem[];
  elapsed: React.ReactNode;
}): React.JSX.Element | null {
  const started = Date.parse(since);
  if (items.some((item) => item.kind === "compaction"
    && Date.parse(item.message.createdAt) >= started)) return null;
  return (
    <div className="context-compaction-row" data-compaction-pending="" data-compaction-trigger={trigger ?? "manual"}>
      <ContextCompactionMarker
        label={trigger === "on-return" ? COMPACTING_BEFORE_SENDING : COMPACTING_CONTEXT}
        elapsed={elapsed}
      />
    </div>
  );
}

export function ContextCompactionRow({ message }: { message: ChatMessage }): React.JSX.Element | null {
  if (!message.compaction) return null;
  const label = contextCompactionRowLabel(message.compaction);
  const onReturn = message.compaction.trigger === "on-return";
  return (
    <section
      className="context-compaction-row"
      data-response-row-id={message.id}
      data-compaction-trigger={message.compaction.trigger ?? "manual"}
      tabIndex={-1}
      aria-label={label}
    >
      {!onReturn && (
        <article className="message is-user turn-user-request">
          <div className="message-body">{message.content}</div>
        </article>
      )}
      <ContextCompactionMarker label={label} />
    </section>
  );
}
