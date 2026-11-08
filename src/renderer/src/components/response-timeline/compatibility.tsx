import {
  ChevronRight,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import clsx from "clsx";
import type { ChatMessage } from "@shared/contracts";
import { MessageOrigin } from "./MessageOrigin";
import { useMemo, useState } from "react";
import { formatFullDateTime, formatMessageTime } from "../../lib/format";
import {
  estimateTimelineItemRenderWeight,
  TIMELINE_VIRTUALIZATION_MIN_ROWS,
  TIMELINE_VIRTUALIZATION_MIN_WEIGHT,
  turnStatusLabel,
  type ResponseTimelineCompatibility,
} from "../../utils/responseTimeline";
import { messageContextMenu } from "./messageContextMenu";
import { useTaskCreator } from "../tasks/taskCreation";
import { ResponseMarkdown } from "../ResponseMarkdown";
import { SentMessageAttachmentList } from "../SentMessageAttachmentList";
import { ActivityRow } from "./activity";
import { PlanDetail } from "./PlanDetail";
import { TurnTimeline } from "./turn";
import type { ResponseTimelineProps } from "./types";
import { TooltipText } from "../TooltipText";

const LEGACY_MESSAGE_LABELS: Record<ChatMessage["role"], string> = {
  user: "Your request",
  assistant: "Assistant answer",
  system: "Agent system notice",
};

function legacyExchanges(messages: ChatMessage[]): ChatMessage[][] {
  const exchanges: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  for (const message of messages) {
    current.push(message);
    if (message.role !== "assistant") continue;
    exchanges.push(current);
    current = [];
  }
  if (current.length > 0) exchanges.push(current);
  return exchanges;
}

export function CompatibilityTimeline({
  compatibility,
  props,
}: {
  compatibility: ResponseTimelineCompatibility;
  props: ResponseTimelineProps;
}): React.JSX.Element {
  const deferContent = useMemo(() => {
    const recordCount = compatibility.inferredTurns.length
      + compatibility.malformedTurns.length
      + compatibility.messages.length
      + compatibility.activities.length
      + compatibility.reasonings.length
      + compatibility.plans.length
      + compatibility.checkpoints.length;
    return recordCount >= TIMELINE_VIRTUALIZATION_MIN_ROWS
      || estimateTimelineItemRenderWeight({
        kind: "compatibility",
        id: "legacy-orphan-history",
        compatibility,
      }) >= TIMELINE_VIRTUALIZATION_MIN_WEIGHT;
  }, [compatibility]);
  return (
    <CompatibilityDisclosure
      key={`${props.conversationId}:${deferContent ? "deferred" : "ordinary"}`}
      compatibility={compatibility}
      initiallyExpanded={!deferContent}
      props={props}
    />
  );
}

function CompatibilityDisclosure({
  compatibility,
  initiallyExpanded,
  props,
}: {
  compatibility: ResponseTimelineCompatibility;
  initiallyExpanded: boolean;
  props: ResponseTimelineProps;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const taskCreator = useTaskCreator();
  return (
    <section className="orphan-run-flow" aria-label="Recovered legacy and orphaned history" data-response-row-id="legacy-orphan-history" tabIndex={-1}>
      <details
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>
          <ChevronRight className="orphan-run-flow-chevron" size={14} aria-hidden="true" />
          Recovered legacy history
        </summary>
        {expanded && (
          <>
            <p>These records could not be verified as ordinary authoritative turns.</p>
            {compatibility.inferredTurns.map((turn) => (
              <TurnTimeline
                key={turn.id}
                turn={turn}
                props={props}
                subagents={[]}
                previousArtifactTurnId={null}
              />
            ))}
            {compatibility.malformedTurns.map((turn) => (
              <div className="agent-activity is-failed" key={turn.id}>
                <TriangleAlert size={14} aria-hidden="true" />
                <span><strong>Malformed turn record</strong><small>{turn.id} · {turnStatusLabel(turn.status)}</small></span>
              </div>
            ))}
            {legacyExchanges(compatibility.messages).map((exchange) => {
              const timed = [...exchange].reverse().find(({ role }) => role !== "system");
              return (
                <div className="legacy-exchange" key={exchange[0]!.id}>
                  {exchange.map((message) => (
                    <article className={clsx("message", `is-${message.role}`)} key={message.id} aria-label={LEGACY_MESSAGE_LABELS[message.role]} data-message-search-id={message.id} tabIndex={-1} {...messageContextMenu(message, message.content, taskCreator)}>
                      {message.role === "system"
                        ? <div className="message-meta"><span>System</span>{props.showTimestamps && <TooltipText tooltip={formatFullDateTime(message.createdAt)}><time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time></TooltipText>}</div>
                        : message.privateConnectDeviceId && <div className="message-meta"><MessageOrigin message={message} /></div>}
                      {message.role === "assistant"
                        ? <ResponseMarkdown content={message.content} projectRoot={props.projectRoot} projectId={props.projectId} conversationId={props.conversationId} defaultCodeWrap={props.defaultCodeWrap} onOpenProjectFile={props.onOpenTurnFile} />
                        : <div className="message-body">{message.content}</div>}
                      <SentMessageAttachmentList attachments={message.attachments} />
                    </article>
                  ))}
                  {props.showTimestamps && timed && (
                    <footer className="turn-meta" aria-label="Message time">
                      <div className="turn-meta-primary">
                        <TooltipText tooltip={formatFullDateTime(timed.createdAt)}><time dateTime={timed.createdAt}>{formatMessageTime(timed.createdAt)}</time></TooltipText>
                      </div>
                    </footer>
                  )}
                </div>
              );
            })}
            {compatibility.activities.map((activity) => (
              <div
                className="turn-activity-group"
                data-activity-group-state="single"
                key={activity.id}
              >
                <ActivityRow activity={activity} />
              </div>
            ))}
            {compatibility.reasonings.map((reasoning) => (
              <div className="turn-reasoning-detail" key={reasoning.id}>
                <span>Recovered reasoning</span>
                <p>{reasoning.content}</p>
              </div>
            ))}
            {compatibility.plans.map((plan) => <PlanDetail key={`${plan.runId}:${plan.turnId ?? "legacy"}`} plan={plan} />)}
            {compatibility.checkpoints.map((checkpoint) => (
              <div className="agent-activity" key={checkpoint.id}>
                <RotateCcw size={14} aria-hidden="true" />
                <span><strong>Recovered checkpoint</strong><small>{checkpoint.label}</small></span>
                <button
                  type="button"
                  className="message-revert"
                  disabled={props.checkpointRestoreDisabled}
                  onClick={() => props.onRevertCheckpoint(checkpoint)}
                >Restore checkpoint</button>
              </div>
            ))}
          </>
        )}
      </details>
    </section>
  );
}
