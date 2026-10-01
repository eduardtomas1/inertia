import { Fragment, memo, type CSSProperties } from "react";
import { ChevronDown, Eye, Square } from "lucide-react";

import type { AgentTurn, SubagentTrace } from "@shared/contracts";
import { formatCount } from "../lib/usageFormat";
import {
  backgroundTaskContextUsage,
  backgroundTaskDoingNow,
  backgroundTaskElapsedMs,
  backgroundTaskLatestStep,
  backgroundTaskTitle,
  backgroundTaskTokens,
} from "../utils/backgroundTasks";
import {
  isLiveSubagentTrace,
  subagentProviderLabel,
  subagentStatusLabel,
} from "../utils/subagentDisclosure";
import { formatElapsed } from "../utils/responseTimeline";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import { SubagentElapsed } from "./SubagentElapsed";
import { SubagentStatusMark } from "./SubagentStatusMark";

export interface BackgroundTaskRowProps {
  trace: SubagentTrace;
  turns: readonly AgentTurn[];
  route: string;
  relationship: string;
  nested: boolean;
  depth: number;
  omittedAncestors: number;
  index: number;
  detailsId: string;
  expanded: boolean;
  stopping: boolean;
  now?: number;
  canOpen: boolean;
  canFollowUp: boolean;
  canStop: boolean;
  onToggleDetails: (traceId: string) => void;
  onOpen: (traceId: string) => void;
  onFollowUp: (traceId: string) => void;
  onStop: (traceId: string) => void;
}

function TaskContextDetail({
  context,
}: {
  context: { remainingPercent: number; label: string };
}): React.JSX.Element {
  return (
    <dd className="background-task-context">
      <span
        className="usage-surface-track is-context"
        role="meter"
        aria-label="Context window remaining"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={context.remainingPercent}
        aria-valuetext={context.label}
      >
        <i style={{ "--usage-remaining": `${context.remainingPercent}%` } as CSSProperties} />
      </span>
      <small>{context.label}</small>
    </dd>
  );
}

function TaskDetails({
  id,
  trace,
  turns,
  route,
  relationship,
  now,
}: Pick<BackgroundTaskRowProps, "trace" | "turns" | "route" | "relationship" | "now"> & {
  id: string;
}): React.JSX.Element {
  const live = isLiveSubagentTrace(trace);
  const tokens = backgroundTaskTokens(trace, turns);
  const context = backgroundTaskContextUsage(trace.usage);
  const latestStep = backgroundTaskLatestStep(trace.usage);
  const runtime = live ? null : backgroundTaskElapsedMs(trace, now ?? Date.now());
  const rows: [string, React.ReactNode][] = [
    ["Task", trace.description],
    ["Doing now", live ? trace.activity : null],
    ["Progress", trace.progress],
    ["Outcome", trace.result],
    ["Model", trace.model],
    ["Total tokens", tokens.value === null ? tokens.reason : formatCount(tokens.value)],
    ["Latest step", latestStep && (
      <dd key="latest-step" className="background-task-step">
        {latestStep.map((part, index) => (
          <Fragment key={part}>
            {index > 0 && " "}
            <span>{index < latestStep.length - 1 ? `${part} ·` : part}</span>
          </Fragment>
        ))}
      </dd>
    )],
    ["Context", context ? <TaskContextDetail key="context" context={context} /> : null],
    ["Tool uses", trace.toolUseCount === null ? null : formatCount(trace.toolUseCount)],
    ["Runtime", live ? null : runtime === null ? "Not reported" : formatElapsed(runtime)],
    ["Route", route],
    ["Provider state", trace.providerStatus],
    ["Relationship", relationship],
  ];
  return (
    <dl id={id} className="subagent-trace-details background-task-details">
      {rows.map(([label, value]) => value !== null && value !== "" && (
        <div key={label}>
          <dt>{label}</dt>
          {typeof value === "string" ? <dd>{value}</dd> : value}
        </div>
      ))}
    </dl>
  );
}

function TaskElapsed({
  trace,
  now,
}: Pick<BackgroundTaskRowProps, "trace" | "now">): React.JSX.Element {
  if (isLiveSubagentTrace(trace)) return <SubagentElapsed trace={trace} now={now} />;
  const elapsed = backgroundTaskElapsedMs(trace, now ?? Date.now());
  if (elapsed !== null) return <span className="subagent-elapsed">{formatElapsed(elapsed)}</span>;
  return (
    <span className="subagent-elapsed">
      <span aria-hidden="true">—</span>
      <span className="visually-hidden">Runtime not reported</span>
    </span>
  );
}

export const BackgroundTaskRow = memo(function BackgroundTaskRow({
  trace,
  turns,
  route,
  relationship,
  nested,
  depth,
  omittedAncestors,
  index,
  detailsId,
  expanded,
  stopping,
  now,
  canOpen,
  canFollowUp,
  canStop,
  onToggleDetails,
  onOpen,
  onFollowUp,
  onStop,
}: BackgroundTaskRowProps): React.JSX.Element {
  const title = backgroundTaskTitle(trace);
  const live = isLiveSubagentTrace(trace);
  const doing = backgroundTaskDoingNow(trace);
  const tokens = backgroundTaskTokens(trace, turns);
  return (
    <li
      className="background-task-row"
      data-task-id={trace.id}
      data-focus-row={`agent:${trace.id}`}
      data-status={trace.status}
      data-live={live}
      data-depth={depth}
      data-expanded={expanded ? "true" : "false"}
      aria-label={`${title}, ${subagentStatusLabel(trace)}, ${route}`}
      style={{
        "--background-task-depth": depth,
        "--motion-index": Math.min(index, 6),
      } as CSSProperties}
    >
      <SubagentStatusMark key={trace.status} trace={trace} />
      <div className="background-task-main">
        <div className="background-task-heading">
          <strong>{title}</strong>
          <ProviderBrandIcon
            providerId={trace.providerId}
            label={subagentProviderLabel(trace)}
            size={12}
            className="background-task-provider"
          />
          {trace.model && <span className="background-task-model">{trace.model}</span>}
          <span className="background-task-status">
            {subagentStatusLabel({ ...trace, providerStatus: null })}
          </span>
        </div>
        {doing && <p className="background-task-doing">{doing}</p>}
        {nested && <small className="background-task-note">{relationship}</small>}
        {omittedAncestors > 0 && (
          <small className="background-task-note">
            {omittedAncestors} earlier {omittedAncestors === 1 ? "ancestor" : "ancestors"} compacted
          </small>
        )}
      </div>
      <div className="background-task-metrics">
        <TaskElapsed trace={trace} now={now} />
        <span className="background-task-tokens" data-reported={tokens.value !== null}>
          <span aria-hidden="true">{tokens.text}</span>
          <small aria-hidden="true">tokens</small>
          <span className="visually-hidden">
            {tokens.value === null
              ? `Tokens: ${tokens.reason}`
              : `${formatCount(tokens.value)} tokens`}
          </span>
        </span>
      </div>
      <div className="background-task-actions">
        {canOpen && (
          <button
            type="button"
            data-focus-key="open"
            aria-label={`View parent turn for ${title}`}
            onClick={() => onOpen(trace.id)}
          >
            <Eye size={11} aria-hidden="true" />
            View turn
          </button>
        )}
        {canFollowUp && (
          <button
            type="button"
            data-focus-key="guide"
            aria-label={`Guide parent about ${title}`}
            onClick={() => onFollowUp(trace.id)}
          >
            Guide parent
          </button>
        )}
        <button
          type="button"
          data-focus-key="details"
          className="background-task-details-toggle"
          aria-label={`Details for ${title}`}
          aria-expanded={expanded}
          aria-controls={expanded ? detailsId : undefined}
          onClick={() => onToggleDetails(trace.id)}
        >
          Details
          <ChevronDown size={11} aria-hidden="true" />
        </button>
        {canStop && (
          <button
            type="button"
            data-focus-key="stop"
            className="background-task-stop"
            aria-label={`${stopping ? "Stopping" : "Stop"} ${title}`}
            disabled={stopping}
            onClick={() => onStop(trace.id)}
          >
            <Square size={9} fill="currentColor" aria-hidden="true" />
            {stopping ? "Stopping…" : "Stop"}
          </button>
        )}
      </div>
      {expanded && (
        <div className="subagent-detail-reveal background-task-details-reveal">
          <TaskDetails
            id={detailsId}
            trace={trace}
            turns={turns}
            route={route}
            relationship={relationship}
            now={now}
          />
        </div>
      )}
    </li>
  );
});
