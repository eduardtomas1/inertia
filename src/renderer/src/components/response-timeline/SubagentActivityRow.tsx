import { memo, useId, useState } from "react";
import { ChevronDown, Cloud, Eye, Plug, Terminal, Users, Workflow } from "lucide-react";
import clsx from "clsx";
import type { AgentActivity, SubagentTrace } from "@shared/contracts";
import { formatElapsed } from "../../utils/responseTimeline";
import { subagentElapsedMs } from "../../utils/subagentDisclosure";
import {
  isBackgroundCommandTrace,
  subagentAccessibleName,
  subagentCurrentStep,
  subagentIdentityLabel,
  subagentKindLabel,
  subagentModelLabel,
  subagentTaskStateWord,
  subagentTaskTitle,
} from "../../utils/subagentTaskPresentation";
import { SubagentElapsed } from "../SubagentElapsed";
import { WorkingOrb } from "../working-indicator/WorkingOrb";
import { useWorkingIndicator } from "../working-indicator/WorkingIndicatorContext";
import {
  orbMotionForSubagent,
  resolveOrbMotion,
  usesActivityOrbs,
} from "../working-indicator/orbMotion";

const KIND_ICONS: Record<SubagentTrace["taskKind"], typeof Users> = {
  agent: Users,
  workflow: Workflow,
  remote: Cloud,
  shell: Terminal,
  monitor: Eye,
  mcp: Plug,
};

const STEP_STATES: Record<NonNullable<SubagentTrace["steps"]>[number]["status"], string> = {
  running: "Running",
  completed: "Done",
  failed: "Failed",
};

function rowStatus(trace: SubagentTrace): AgentActivity["status"] {
  if (trace.isLive) return "running";
  return trace.status === "failed" || trace.status === "interrupted" || trace.status === "lost"
    ? "failed"
    : "completed";
}

function SettledElapsed({ trace }: { trace: SubagentTrace }): React.JSX.Element | null {
  if (trace.status === "lost") return null;
  const elapsed = trace.durationMs ?? subagentElapsedMs(trace, Date.parse(trace.updatedAt));
  return <span className="subagent-elapsed">{formatElapsed(elapsed)}</span>;
}

interface SubagentActivityRowProps {
  trace: SubagentTrace;
  activity?: AgentActivity;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}

/**
 * A delegated agent or background command in place of the generic tool row
 * that started it. Every provider string is rendered as plain text. Steps
 * stay folded unless the user opens them and stay as the user left them when
 * the task ends, and the doing line keeps its height once shown, so the row
 * never changes height on its own above the reader.
 */
export const SubagentActivityRow = memo(function SubagentActivityRow({
  trace,
  activity,
  onBeforeToggle,
  onAfterToggle,
}: SubagentActivityRowProps): React.JSX.Element {
  const [stepsOpen, setStepsOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const stepsId = useId();
  const resultId = useId();
  const live = trace.isLive;
  const indicator = useWorkingIndicator();
  const orb = live && usesActivityOrbs(indicator)
    ? resolveOrbMotion(indicator, orbMotionForSubagent(trace.status))
    : null;
  const command = isBackgroundCommandTrace(trace);
  const state = subagentTaskStateWord(trace);
  const title = subagentTaskTitle(trace);
  const name = subagentAccessibleName(trace);
  const titleIsCommand = command && !trace.description && Boolean(trace.command);
  const meta = [
    command ? subagentKindLabel(trace) : subagentIdentityLabel(trace) ?? subagentKindLabel(trace),
    subagentModelLabel(trace),
  ].filter((part): part is string => Boolean(part));
  const current = subagentCurrentStep(trace);
  const [doingLineShown, setDoingLineShown] = useState(Boolean(current));
  if (current && !doingLineShown) setDoingLineShown(true);
  const steps = trace.steps ?? [];
  const notice = command && !live ? trace.result : null;
  const doing = stepsOpen ? notice : current ?? notice;
  const showResult = !command && Boolean(trace.result);
  const Icon = KIND_ICONS[trace.taskKind] ?? Users;
  const toggle = (set: (next: (open: boolean) => boolean) => void): void => {
    onBeforeToggle?.();
    set((open) => !open);
    window.requestAnimationFrame(() => onAfterToggle?.());
  };
  return (
    <div
      className={clsx(
        "agent-activity subagent-activity",
        `is-${rowStatus(trace)}`,
        state.danger && "is-important",
        (stepsOpen || resultOpen) && "is-detail-open",
      )}
      data-activity-kind={activity?.kind ?? "tool"}
      data-activity-work="tool"
      data-activity-severity={state.danger ? "failure" : "neutral"}
      data-subagent-trace={trace.id}
      data-subagent-kind={trace.taskKind}
    >
      <span
        className="agent-activity-icon"
        aria-hidden="true"
        data-activity-indicator={orb ? "orb" : undefined}
      >
        {orb ? <WorkingOrb size={14} design={orb.design} pace={orb.pace} /> : <Icon size={14} />}
      </span>
      <span className="agent-activity-copy subagent-activity-copy">
        <span className="visually-hidden">{`${subagentKindLabel(trace)}, ${state.word}: `}</span>
        <strong className={clsx("agent-activity-title subagent-activity-title", titleIsCommand && "is-command")}>
          {title}
        </strong>
      </span>
      {steps.length > 0 && (
        <button
          type="button"
          className="agent-activity-disclosure"
          aria-expanded={stepsOpen}
          aria-controls={stepsOpen ? stepsId : undefined}
          aria-label={`Steps for ${name}`}
          onClick={() => toggle(setStepsOpen)}
        >
          <span>Steps</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      )}
      {showResult && (
        <button
          type="button"
          className="agent-activity-disclosure"
          aria-expanded={resultOpen}
          aria-controls={resultOpen ? resultId : undefined}
          aria-label={`Result for ${name}`}
          onClick={() => toggle(setResultOpen)}
        >
          <span>Result</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      )}
      <span className="subagent-activity-meta">
        {meta.map((part) => <span key={part}>{part}</span>)}
        <span className={state.danger ? "subagent-activity-danger" : undefined}>{state.word}</span>
        {live ? <SubagentElapsed trace={trace} /> : <SettledElapsed trace={trace} />}
      </span>
      {command && trace.description && trace.command && (
        <code className="subagent-activity-command">{trace.command}</code>
      )}
      {doing ? (
        <span className="subagent-activity-doing">{doing}</span>
      ) : doingLineShown && !stepsOpen ? (
        <span className="subagent-activity-doing" aria-hidden="true">{" "}</span>
      ) : null}
      {stepsOpen && (
        <ol className="subagent-activity-steps" id={stepsId} aria-label={`Recent steps for ${name}`}>
          {steps.map((step, index) => (
            <li key={`${index}:${step.label}`} data-step-status={live || step.status !== "running" ? step.status : "unfinished"}>
              <span className="visually-hidden">
                {`${live || step.status !== "running" ? STEP_STATES[step.status] : "Not finished"}: `}
              </span>
              {step.label}
            </li>
          ))}
        </ol>
      )}
      {showResult && resultOpen && (
        <pre className="agent-activity-output" id={resultId}>{trace.result}</pre>
      )}
    </div>
  );
}, (previous, next) => (previous.trace === next.trace
  || (previous.trace.id === next.trace.id
    && previous.trace.sequence === next.trace.sequence
    && previous.trace.updatedAt === next.trace.updatedAt))
  && previous.activity?.id === next.activity?.id
  && previous.activity?.kind === next.activity?.kind
  && previous.onBeforeToggle === next.onBeforeToggle
  && previous.onAfterToggle === next.onAfterToggle);

/** Delegated work that has no timeline row of its own, shown compactly. */
export function UnlinkedSubagentRows({
  traces,
  onBeforeToggle,
  onAfterToggle,
}: {
  traces: readonly SubagentTrace[];
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}): React.JSX.Element | null {
  if (traces.length === 0) return null;
  return (
    <div className="turn-activity-group subagent-unlinked-rows" role="list" aria-label="Delegated tasks">
      {traces.map((trace) => (
        <div role="listitem" key={trace.id}>
          <SubagentActivityRow
            trace={trace}
            onBeforeToggle={onBeforeToggle}
            onAfterToggle={onAfterToggle}
          />
        </div>
      ))}
    </div>
  );
}
