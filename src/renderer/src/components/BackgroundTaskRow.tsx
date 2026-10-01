import { Fragment, type CSSProperties } from "react";
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
  subagentHasNestedParent,
  subagentProviderLabel,
  subagentRelationshipLabel,
  subagentRouteLabel,
  subagentStatusLabel,
} from "../utils/subagentDisclosure";
import { formatElapsed } from "../utils/responseTimeline";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import { SubagentElapsed } from "./SubagentElapsed";
import { SubagentStatusMark } from "./SubagentStatusMark";

export interface BackgroundTaskRowProps {
  trace: SubagentTrace;
  traces: readonly SubagentTrace[];
  turns: readonly AgentTurn[];
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
  onToggleDetails: () => void;
  onOpen: () => void;
  onFollowUp: () => void;
  onStop: () => void;
}

function TaskContextDetail({
  context,
}: {
  context: { percent: number; label: string };
}): React.JSX.Element {
  return (
    <dd className="background-task-context">
      <span
        className="usage-surface-track is-context"
        role="meter"
        aria-label="Context window used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={context.percent}
        aria-valuetext={context.label}
      >
        <i style={{ "--usage-remaining": `${context.percent}%` } as CSSProperties} />
      </span>
      <small>{context.label}</small>
    </dd>
  );
}

function TaskDetails({
  id,
  trace,
  traces,
  turns,
  now,
}: Pick<BackgroundTaskRowProps, "trace" | "traces" | "turns" | "now"> & {
  id: string;
}): React.JSX.Element {
  const live = isLiveSubagentTrace(trace);
  const tokens = backgroundTaskTokens(trace, turns);
  const context = backgroundTaskContextUsage(trace.usage);
  const latestStep = backgroundTaskLatestStep(trace.usage);
  const rows: [string, React.ReactNode][] = [
    ["Task", trace.description],
    ["Latest activity", trace.progress],
    ["Outcome", trace.result],
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
    ["Runtime", live ? null : formatElapsed(backgroundTaskElapsedMs(trace, now ?? Date.now()))],
    ["Route", subagentRouteLabel(trace, turns)],
    ["Provider state", trace.providerStatus],
    ["Relationship", subagentRelationshipLabel(trace, traces)],
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

export function BackgroundTaskRow({
  trace,
  traces,
  turns,
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
  const provider = subagentProviderLabel(trace);
  const route = subagentRouteLabel(trace, turns);
  return (
    <li
      className="background-task-row"
      data-task-id={trace.id}
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
          <strong title={title}>{title}</strong>
          <ProviderBrandIcon
            providerId={trace.providerId}
            label={provider}
            size={12}
            className="background-task-provider"
          />
          {trace.model && (
            <span className="background-task-model" title={`Model: ${trace.model}`}>
              {trace.model}
            </span>
          )}
          <span
            className="background-task-status"
            title={trace.providerStatus ? `Provider state: ${trace.providerStatus}` : undefined}
          >
            {subagentStatusLabel({ ...trace, providerStatus: null })}
          </span>
        </div>
        {doing && <p className="background-task-doing" title={doing}>{doing}</p>}
        {subagentHasNestedParent(trace) && (
          <small className="background-task-note">{subagentRelationshipLabel(trace, traces)}</small>
        )}
        {omittedAncestors > 0 && (
          <small className="background-task-note">
            {omittedAncestors} earlier {omittedAncestors === 1 ? "ancestor" : "ancestors"} compacted
          </small>
        )}
      </div>
      <div className="background-task-metrics">
        {!live && trace.durationMs !== null
          ? <span className="subagent-elapsed">{formatElapsed(trace.durationMs)}</span>
          : <SubagentElapsed trace={trace} now={now} />}
        <span className="background-task-tokens" data-reported={tokens.value !== null}>
          <span aria-hidden="true" title={tokens.reason ?? undefined}>{tokens.text}</span>
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
          <button type="button" aria-label={`View parent turn for ${title}`} onClick={onOpen}>
            <Eye size={11} aria-hidden="true" />
            View turn
          </button>
        )}
        {canFollowUp && (
          <button
            type="button"
            aria-label={`Guide parent about ${title}`}
            title="Draft guidance to the active parent; nothing is sent yet."
            onClick={onFollowUp}
          >
            Guide parent
          </button>
        )}
        <button
          type="button"
          className="background-task-details-toggle"
          aria-label={`Details for ${title}`}
          aria-expanded={expanded}
          aria-controls={expanded ? detailsId : undefined}
          onClick={onToggleDetails}
        >
          Details
          <ChevronDown size={11} aria-hidden="true" />
        </button>
        {canStop && (
          <button
            type="button"
            className="background-task-stop"
            aria-label={`${stopping ? "Stopping" : "Stop"} ${title}`}
            disabled={stopping}
            onClick={onStop}
          >
            <Square size={9} fill="currentColor" aria-hidden="true" />
            {stopping ? "Stopping…" : "Stop"}
          </button>
        )}
      </div>
      {expanded && (
        <div className="subagent-detail-reveal background-task-details-reveal">
          <TaskDetails id={detailsId} trace={trace} traces={traces} turns={turns} now={now} />
        </div>
      )}
    </li>
  );
}
