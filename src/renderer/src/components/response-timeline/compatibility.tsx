import {
  BrainCircuit,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import clsx from "clsx";
import { useMemo, useState } from "react";
import { formatClockTime } from "../../lib/format";
import {
  estimateTimelineItemRenderWeight,
  TIMELINE_VIRTUALIZATION_MIN_ROWS,
  TIMELINE_VIRTUALIZATION_MIN_WEIGHT,
  turnStatusLabel,
  type ResponseTimelineCompatibility,
} from "../../utils/responseTimeline";
import { ResponseMarkdown } from "../ResponseMarkdown";
import { SentMessageAttachmentList } from "../SentMessageAttachmentList";
import {
  ActivityRow,
  PlanDetail,
} from "./activity";
import { TurnTimeline } from "./turn";
import type { ResponseTimelineProps } from "./types";

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
  return (
    <section className="orphan-run-flow" aria-label="Recovered legacy and orphaned history" data-response-row-id="legacy-orphan-history">
      <details
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>Recovered legacy history</summary>
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
            {compatibility.messages.map((message) => (
              <article className={clsx("message", `is-${message.role}`)} key={message.id}>
                <div className="message-meta"><span>{message.role === "assistant" ? "Agent" : message.role === "user" ? "You" : "System"}</span>{props.showTimestamps && <time dateTime={message.createdAt}>{formatClockTime(message.createdAt)}</time>}</div>
                {message.role === "assistant"
                  ? <ResponseMarkdown content={message.content} projectRoot={props.projectRoot} projectId={props.projectId} conversationId={props.conversationId} defaultCodeWrap={props.defaultCodeWrap} onOpenProjectFile={props.onOpenTurnFile} />
                  : <div className="message-body">{message.content}</div>}
                <SentMessageAttachmentList attachments={message.attachments} />
              </article>
            ))}
            {compatibility.activities.map((activity) => <ActivityRow key={activity.id} activity={activity} />)}
            {compatibility.reasonings.map((reasoning) => (
              <div className="turn-reasoning-detail" key={reasoning.id}>
                <span><BrainCircuit size={13} aria-hidden="true" />Recovered reasoning</span>
                <p>{reasoning.content}</p>
              </div>
            ))}
            {compatibility.plans.map((plan) => <PlanDetail key={`${plan.runId}:${plan.turnId ?? "legacy"}`} plan={plan} />)}
            {compatibility.checkpoints.map((checkpoint) => (
              <div className="agent-activity" key={checkpoint.id}>
                <RotateCcw size={14} aria-hidden="true" />
                <span><strong>Recovered checkpoint</strong><small>{checkpoint.label}</small></span>
              </div>
            ))}
          </>
        )}
      </details>
    </section>
  );
}
