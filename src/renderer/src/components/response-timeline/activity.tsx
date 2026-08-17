import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Code2,
  ListChecks,
  Search,
  Terminal,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { markTestStreamingStage } from "../../utils/testStreamingTrace";
import clsx from "clsx";
import type {
  AgentActivity,
  AgentPlan,
  AgentTurn,
} from "@shared/contracts";
import {
  activityAttentionSeverity,
  activityDetailPresentation,
  activityExecutionCategory,
  activityNeedsAttention,
  buildTurnExecutionStream,
  formatElapsed,
  isInterruptedActivity,
  resolveActivityGroupPresentation,
  turnStatusLabel,
  workSummaryLabel,
  type ActivityAttentionSeverity,
  type ResponseTurn,
  type TurnExecutionStreamEntry,
} from "../../utils/responseTimeline";
import { ResponseMarkdown } from "../ResponseMarkdown";
import { parseReasoningSummary } from "../../utils/reasoningSummary";

export function ReasoningSummary({
  content,
  streaming = false,
}: {
  content: string;
  streaming?: boolean;
}): React.JSX.Element {
  const segments = useMemo(() => parseReasoningSummary(content), [content]);
  if (segments.length === 0) {
    return (
      <p className="turn-reasoning-body">
        {content}
        {streaming && <span className="streaming-caret" aria-hidden="true" />}
      </p>
    );
  }
  return (
    <ol className="turn-reasoning-steps">
      {segments.map((segment, index) => (
        <li
          key={segment.id}
          className={clsx(
            "turn-reasoning-step",
            streaming && index === segments.length - 1 && "is-active",
          )}
        >
          {segment.title && (
            <span className="turn-reasoning-step-title">{segment.title}</span>
          )}
          {segment.body && (
            <span className="turn-reasoning-step-body">{segment.body}</span>
          )}
          {streaming && index === segments.length - 1 && (
            <span className="streaming-caret" aria-hidden="true" />
          )}
        </li>
      ))}
    </ol>
  );
}

export function LiveElapsed({ startedAt }: { startedAt: string }): React.JSX.Element {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let timer: number | null = null;
    const stopTimer = (): void => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };
    const synchronize = (): void => {
      stopTimer();
      setNow(Date.now());
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      timer = window.setInterval(() => setNow(Date.now()), 100);
    };
    synchronize();
    document.addEventListener("visibilitychange", synchronize);
    window.addEventListener("focus", synchronize);
    window.addEventListener("blur", synchronize);
    return () => {
      stopTimer();
      document.removeEventListener("visibilitychange", synchronize);
      window.removeEventListener("focus", synchronize);
      window.removeEventListener("blur", synchronize);
    };
  }, []);
  return <span>{formatElapsed(Math.max(0, now - Date.parse(startedAt)), true)}</span>;
}

type ActivityLineSeverity = "neutral" | ActivityAttentionSeverity;

function activityTitleConveysSeverity(
  title: string,
  severity: ActivityAttentionSeverity,
): boolean {
  return severity === "failure"
    ? /\b(?:error|failed|failure)\b/iu.test(title)
    : /\b(?:blocked|canceled|cancelled|incomplete|interrupted|partial(?:ly)?|skipped|unsupported|warned|warning)\b/iu
      .test(title);
}

function splitActivityTitle(
  title: string,
  severity: ActivityLineSeverity,
): {
  leadingTarget: string;
  verb: string;
  trailingTarget: string;
} {
  const trimmed = title.trim();
  const words = trimmed.split(/\s+/u).filter(Boolean);
  let statusVerbIndex = -1;
  if (severity !== "neutral") {
    words.forEach((word, index) => {
      if (
        /^(?:blocked|canceled|cancelled|error|failed|failure|incomplete|interrupted|partial|partially|skipped|unsupported|warned|warning)$/iu.test(
          word.replace(/[.:,;!?]+$/u, ""),
        )
      ) {
        statusVerbIndex = index;
      }
    });
  }
  const verbIndex = statusVerbIndex >= 0 ? statusVerbIndex : 0;
  return {
    leadingTarget: words.slice(0, verbIndex).join(" "),
    verb: words[verbIndex] ?? "",
    trailingTarget: words.slice(verbIndex + 1).join(" "),
  };
}

export const ActivityRow = memo(function ActivityRow({
  activity,
  visibility,
  onBeforeToggle,
  onAfterToggle,
}: {
  activity: AgentActivity;
  visibility?: "recent" | "details" | "important";
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}): React.JSX.Element {
  const [detailExpanded, setDetailExpanded] = useState(false);
  const anchorToggleHandlers = useAnchoredDetailsToggle(onBeforeToggle, onAfterToggle);
  const interrupted = isInterruptedActivity(activity);
  const attentionSeverity = activityAttentionSeverity(activity);
  const needsAttention = attentionSeverity !== null;
  const severity: ActivityLineSeverity = attentionSeverity ?? "neutral";
  const detailPresentation = activityDetailPresentation(activity);
  const executionCategory = activityExecutionCategory(activity);
  const showDisclosure = Boolean(
    detailPresentation.full
    && (detailPresentation.expandable || needsAttention),
  );
  // Transport diagnostics are deliberately opt-in. The public failure summary
  // already lives in the row title; exit/signal/protocol detail belongs only
  // behind the Technical details disclosure.
  const showPreview = Boolean(
    detailPresentation.preview
    && showDisclosure
    && activity.kind !== "error"
    && !interrupted,
  );
  const Icon = severity !== "neutral"
    ? TriangleAlert
    : activity.status === "completed"
      ? Check
      : executionCategory === "searching"
        ? Search
        : executionCategory === "coding"
          ? Code2
          : executionCategory === "command"
            ? Terminal
            : executionCategory === "tool"
              ? Wrench
              : CircleDot;
  const fullLabel = [
    activity.title,
    showPreview ? detailPresentation.preview : null,
  ].filter(Boolean).join(" — ");
  const { leadingTarget, verb, trailingTarget } = splitActivityTitle(
    activity.title,
    severity,
  );
  const spokenState = interrupted
    ? "Interrupted"
    : severity === "failure"
      ? "Failed"
      : severity === "warning"
        ? "Warning"
        : turnStatusLabel(activity.status);
  const visibleState = attentionSeverity
    && !activityTitleConveysSeverity(activity.title, attentionSeverity)
    ? spokenState
    : null;
  return (
    <div
      className={clsx(
        "agent-activity",
        `is-${activity.status}`,
        needsAttention && "is-important",
        showDisclosure && "has-technical-detail",
      )}
      data-activity-kind={activity.kind}
      data-activity-category={executionCategory}
      data-activity-severity={severity}
      data-activity-visibility={visibility}
      title={fullLabel}
    >
      <Icon size={12} aria-hidden="true" />
      <span className={clsx(
        "agent-activity-copy",
        detailPresentation.full && !showPreview && !needsAttention && "has-detail",
        showPreview && "has-preview",
      )}>
        <span className="visually-hidden">{spokenState}: </span>
        {visibleState && (
          <span className="agent-activity-state" aria-hidden="true">{visibleState}</span>
        )}
        <strong className="agent-activity-title">
          {leadingTarget && (
            <span className="agent-activity-target">{`${leadingTarget} `}</span>
          )}
          <span className="agent-activity-verb">{verb}</span>
          {trailingTarget && (
            <span className="agent-activity-target">{` ${trailingTarget}`}</span>
          )}
        </strong>
        {detailPresentation.full && !showPreview && !needsAttention && (
          <small className="agent-activity-detail">
            <span className="visually-hidden"> — </span>
            {detailPresentation.full}
          </small>
        )}
        {showPreview && (
          <small className="agent-activity-detail-preview">
            <span className="visually-hidden">Technical output preview: </span>
            {detailPresentation.preview}
          </small>
        )}
      </span>
      {showDisclosure && (
        <details
          className="agent-activity-technical"
          open={detailExpanded}
          onToggle={(event) => setDetailExpanded(event.currentTarget.open)}
        >
          <summary {...anchorToggleHandlers}>
            <span>
              {activity.kind === "error" || interrupted
                ? "Technical details"
                : activity.kind === "command"
                  ? "Full command output"
                  : "Full output"}
            </span>
            <ChevronDown size={11} aria-hidden="true" />
          </summary>
          {detailExpanded && <pre>{detailPresentation.full}</pre>}
        </details>
      )}
    </div>
  );
});

export const PlanDetail = memo(function PlanDetail({ plan }: { plan: AgentPlan }): React.JSX.Element {
  return (
    <div className="turn-reasoning-detail" data-turn-plan={plan.turnId ?? "legacy"}>
      <span><ListChecks size={13} aria-hidden="true" />Plan</span>
      {plan.explanation && <p>{plan.explanation}</p>}
      {plan.steps.length > 0 && (
        <p>{plan.steps.map(({ step, status }) => `${status === "completed" ? "✓" : status === "inProgress" ? "•" : "○"} ${step}`).join("\n")}</p>
      )}
    </div>
  );
});

const CommentaryRow = memo(function CommentaryRow({
  entry,
  projectRoot,
  projectId,
  conversationId,
  defaultCodeWrap,
  onOpenProjectFile,
}: {
  entry: Extract<TurnExecutionStreamEntry, { kind: "commentary" }>;
  projectRoot: string;
  projectId: string;
  conversationId: string;
  defaultCodeWrap: boolean;
  onOpenProjectFile: (path: string) => void;
}): React.JSX.Element {
  useLayoutEffect(() => {
    if (entry.streaming && entry.content) {
      markTestStreamingStage("renderer-live-text-commit");
    }
  }, [entry.content, entry.streaming]);
  return (
    <article
      className={clsx("turn-commentary-row", entry.streaming && "is-streaming")}
      aria-label={entry.streaming ? "Live agent update" : "Agent update"}
      data-assistant-commentary-id={entry.message?.id ?? entry.id}
    >
      {entry.streaming
        ? (
            <div
              className="response-markdown is-streaming is-plain-stream"
              data-stream-renderer="plain-text"
            >
              <p>{entry.content}</p>
            </div>
          )
        : (
            <ResponseMarkdown
              content={entry.content}
              projectRoot={projectRoot}
              projectId={projectId}
              conversationId={conversationId}
              defaultCodeWrap={defaultCodeWrap}
              announceCopyFeedback={entry.message !== null}
              onOpenProjectFile={onOpenProjectFile}
            />
          )}
    </article>
  );
});

function FollowUpRow({
  entry,
}: {
  entry: Extract<TurnExecutionStreamEntry, { kind: "follow-up" }>;
}): React.JSX.Element {
  return (
    <article
      className="turn-follow-up-row"
      aria-label="Your follow-up"
      data-follow-up-message-id={entry.message.id}
    >
      <span>You</span>
      <p>{entry.message.content}</p>
    </article>
  );
}

export function useAnchoredDetailsToggle(
  onBeforeToggle?: () => void,
  onAfterToggle?: () => void,
): {
  onPointerDownCapture: () => void;
  onPointerCancelCapture: () => void;
  onKeyDownCapture: (event: ReactKeyboardEvent<HTMLElement>) => void;
  onClickCapture: () => void;
  onClick: () => void;
} {
  const prepared = useRef(false);
  const prepare = useCallback(() => {
    if (prepared.current) return;
    prepared.current = true;
    onBeforeToggle?.();
  }, [onBeforeToggle]);
  return {
    onPointerDownCapture: prepare,
    onPointerCancelCapture: () => {
      prepared.current = false;
    },
    onKeyDownCapture: (event) => {
      if (event.key === "Enter" || event.key === " ") prepare();
    },
    onClickCapture: prepare,
    onClick: () => {
      window.requestAnimationFrame(() => {
        onAfterToggle?.();
        prepared.current = false;
      });
    },
  };
}

export const ActivityGroup = memo(function ActivityGroup({
  entry,
  onBeforeToggle,
  onAfterToggle,
}: {
  entry: Extract<TurnExecutionStreamEntry, { kind: "activity-group" }>;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const { hiddenCount, visibleActivities } = resolveActivityGroupPresentation(
    entry.activities,
    expanded,
  );
  const containsAttention = entry.activities.some(activityNeedsAttention);
  const toggle = (): void => {
    onBeforeToggle?.();
    setExpanded((current) => !current);
    window.requestAnimationFrame(() => onAfterToggle?.());
  };
  return (
    <div
      className="turn-activity-group"
      data-activity-group={entry.id}
      data-activity-group-expanded={expanded}
      data-activity-group-mode={containsAttention ? "attention" : "calls"}
    >
      {visibleActivities.map((activity) => (
        <ActivityRow
          activity={activity}
          visibility={activityNeedsAttention(activity) ? "important" : "recent"}
          onBeforeToggle={onBeforeToggle}
          onAfterToggle={onAfterToggle}
          key={activity.id}
        />
      ))}
      {hiddenCount > 0 && (
        <button
          type="button"
          className="turn-activity-group-toggle"
          aria-expanded={expanded}
          onClick={toggle}
        >
          <ChevronDown size={12} aria-hidden="true" />
          <span>
            {expanded
              ? "Show fewer tool calls"
              : `+${hiddenCount} previous tool ${hiddenCount === 1 ? "call" : "calls"}`}
          </span>
        </button>
      )}
    </div>
  );
});

function ExecutionStream({
  entries,
  projectRoot,
  projectId,
  conversationId,
  defaultCodeWrap,
  onOpenProjectFile,
  onBeforeToggle,
  onAfterToggle,
}: {
  entries: TurnExecutionStreamEntry[];
  projectRoot: string;
  projectId: string;
  conversationId: string;
  defaultCodeWrap: boolean;
  onOpenProjectFile: (path: string) => void;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}): React.JSX.Element | null {
  if (entries.length === 0) return null;
  return (
    <div className="turn-execution-stream" role="list" aria-label="Agent work transcript">
      {entries.map((entry) => {
        if (entry.kind === "commentary") {
          return (
            <div role="listitem" key={entry.id}>
              <CommentaryRow
                entry={entry}
                projectRoot={projectRoot}
                projectId={projectId}
                conversationId={conversationId}
                defaultCodeWrap={defaultCodeWrap}
                onOpenProjectFile={onOpenProjectFile}
              />
            </div>
          );
        }
        if (entry.kind === "follow-up") {
          return (
            <div role="listitem" key={entry.id}>
              <FollowUpRow entry={entry} />
            </div>
          );
        }
        return (
          <div role="listitem" key={entry.id}>
            <ActivityGroup
              entry={entry}
              onBeforeToggle={onBeforeToggle}
              onAfterToggle={onAfterToggle}
            />
          </div>
        );
      })}
    </div>
  );
}

export function shouldCollapseSuccessfulWorkOnSettlement(input: {
  wasActive: boolean;
  isActive: boolean;
  status: AgentTurn["status"];
  autoCollapse: boolean;
}): boolean {
  return input.autoCollapse
    && input.wasActive
    && !input.isActive
    && input.status === "completed";
}

export function SettledWorkDetails({
  id,
  entries,
  turn,
  reasoningContent,
  includesReasoning,
  projectRoot,
  projectId,
  conversationId,
  defaultCodeWrap,
  onOpenProjectFile,
  onBeforeToggle,
  onAfterToggle,
}: {
  id?: string;
  entries: TurnExecutionStreamEntry[];
  turn: ResponseTurn;
  reasoningContent: string;
  includesReasoning: boolean;
  projectRoot: string;
  projectId: string;
  conversationId: string;
  defaultCodeWrap: boolean;
  onOpenProjectFile: (path: string) => void;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}): React.JSX.Element {
  return (
    <div className="turn-work-details" id={id}>
      <ExecutionStream
        entries={entries}
        projectRoot={projectRoot}
        projectId={projectId}
        conversationId={conversationId}
        defaultCodeWrap={defaultCodeWrap}
        onOpenProjectFile={onOpenProjectFile}
        onBeforeToggle={onBeforeToggle}
        onAfterToggle={onAfterToggle}
      />
      {includesReasoning && (
        <div className="turn-reasoning-detail">
          <span><BrainCircuit size={13} aria-hidden="true" />Reasoning summary</span>
          <ReasoningSummary content={reasoningContent} />
        </div>
      )}
      {turn.plans.map((plan) => <PlanDetail key={`${plan.runId}:${plan.turnId ?? "legacy"}`} plan={plan} />)}
    </div>
  );
}

export function WorkLog({
  turn,
  autoCollapse,
  reasoningContent,
  reasoningStreaming,
  liveContent,
  liveContentStreaming,
  showThinking,
  projectRoot,
  projectId,
  conversationId,
  defaultCodeWrap,
  onOpenProjectFile,
  onBeforeToggle,
  onAfterToggle,
}: {
  turn: ResponseTurn;
  autoCollapse: boolean;
  reasoningContent: string;
  reasoningStreaming: boolean;
  liveContent: string;
  liveContentStreaming: boolean;
  showThinking: boolean;
  projectRoot: string;
  projectId: string;
  conversationId: string;
  defaultCodeWrap: boolean;
  onOpenProjectFile: (path: string) => void;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(!autoCollapse);
  const workWasActive = useRef(turn.isActive);
  const anchorToggleHandlers = useAnchoredDetailsToggle(onBeforeToggle, onAfterToggle);
  const detailsId = `turn-work-details-${turn.id}`;
  useEffect(() => setExpanded(!autoCollapse), [autoCollapse]);
  useLayoutEffect(() => {
    const shouldCollapse = shouldCollapseSuccessfulWorkOnSettlement({
      wasActive: workWasActive.current,
      isActive: turn.isActive,
      status: turn.agentTurn.status,
      autoCollapse,
    });
    workWasActive.current = turn.isActive;
    if (shouldCollapse) setExpanded(false);
  }, [autoCollapse, turn.agentTurn.status, turn.isActive]);

  const includesReasoning = showThinking && Boolean(reasoningContent);
  // Provider lifecycle pings ("thinking", "turn completed", heartbeats) are
  // durable diagnostics, not useful transcript rows. Plans and reasoning have
  // dedicated presentations; warnings are already part of the work stream.
  const supplementalActivities: AgentActivity[] = [];
  const durableStream = useMemo(
    () => buildTurnExecutionStream(turn, {
      includeImportantActivities: turn.isActive,
    }),
    [turn],
  );
  // Transient text is always the final visible execution entry. Appending that
  // one row keeps settled commentary and activity-group identities stable
  // instead of sorting the complete workstream for every provider token. A
  // reconnect may retain the text while deliberately closing its live channel,
  // so only the current text channel gets live semantics and animation.
  const stream = useMemo<TurnExecutionStreamEntry[]>(() => {
    if (!turn.isActive || !liveContent) return durableStream;
    return [
      ...durableStream,
      {
        kind: "commentary",
        id: `live-commentary:${turn.id}`,
        createdAt: turn.agentTurn.updatedAt,
        message: null,
        content: liveContent,
        streaming: liveContentStreaming,
      },
    ];
  }, [
    durableStream,
    liveContent,
    liveContentStreaming,
    turn.agentTurn.updatedAt,
    turn.id,
    turn.isActive,
  ]);
  const supplementalCount = supplementalActivities.length
    + turn.plans.length
    + (includesReasoning ? 1 : 0);
  const planStepCount = turn.plans.reduce(
    (total, plan) => total + plan.steps.length,
    0,
  );
  const activeReasoning = includesReasoning && reasoningStreaming;
  const activeTraceLabel = activeReasoning
    ? "Thinking"
    : includesReasoning
      ? "Reasoning"
      : "Plan";
  const activeTraceCount = [
    includesReasoning ? "reasoning summary" : null,
    planStepCount > 0
      ? `${planStepCount} ${planStepCount === 1 ? "step" : "steps"}`
      : null,
  ].filter(Boolean).join(" · ") || `${supplementalCount} update`;

  if (turn.isActive) {
    if (stream.length === 0 && supplementalCount === 0) return null;
    return (
      <div className="turn-work-log is-live">
        <ExecutionStream
          entries={stream}
          projectRoot={projectRoot}
          projectId={projectId}
          conversationId={conversationId}
          defaultCodeWrap={defaultCodeWrap}
          onOpenProjectFile={onOpenProjectFile}
          onBeforeToggle={onBeforeToggle}
          onAfterToggle={onAfterToggle}
        />
        {supplementalCount > 0 && (
          <details
            data-agent-trace={activeReasoning
              ? "thinking"
              : includesReasoning
                ? "reasoning"
                : "plan"}
            open={expanded}
            onToggle={(event) => setExpanded(event.currentTarget.open)}
          >
            <summary
              aria-expanded={expanded}
              aria-controls={detailsId}
              {...anchorToggleHandlers}
            >
              <span>{activeTraceLabel}</span>
              <small>{activeTraceCount}</small>
              <ChevronDown size={13} className="turn-work-chevron" aria-hidden="true" />
            </summary>
            <div className="turn-work-details" id={detailsId} hidden={!expanded}>
              {expanded && includesReasoning && (
                <div className="turn-reasoning-detail">
                  <span><BrainCircuit size={13} aria-hidden="true" />Reasoning summary</span>
                  <ReasoningSummary
                    content={reasoningContent}
                    streaming={activeReasoning}
                  />
                </div>
              )}
              {expanded && turn.plans.map((plan) => <PlanDetail key={`${plan.runId}:${plan.turnId ?? "legacy"}`} plan={plan} />)}
              {expanded && supplementalActivities.map((activity) => (
                <ActivityRow activity={activity} visibility="details" key={activity.id} />
              ))}
            </div>
          </details>
        )}
      </div>
    );
  }

  const hasFoldableDetails = stream.length > 0 || supplementalCount > 0;
  const status = turn.agentTurn.status === "failed"
    ? "failed"
    : turn.agentTurn.status === "cancelled" || turn.agentTurn.status === "interrupted"
      ? "stopped"
      : "completed";
  const summaryContent = (
    <>
      {status === "failed"
        ? <TriangleAlert size={13} aria-hidden="true" />
        : status === "stopped"
          ? <CircleDot size={13} aria-hidden="true" />
          : <CheckCircle2 size={13} aria-hidden="true" />}
      <span>{workSummaryLabel(turn)}</span>
    </>
  );

  return (
    <div
      className="turn-work-log is-settled"
      data-settled-work-status={status}
      data-settled-work-visibility={hasFoldableDetails
        ? expanded ? "expanded" : "collapsed"
        : "static"}
    >
      {hasFoldableDetails && (
        <details
          open={expanded}
          onToggle={(event) => setExpanded(event.currentTarget.open)}
        >
          <summary
            className="turn-settled-summary"
            aria-expanded={expanded}
            aria-controls={detailsId}
            {...anchorToggleHandlers}
          >
            {summaryContent}
            <small>{expanded ? "Hide details" : "Details"}</small>
            <ChevronDown size={13} className="turn-work-chevron" aria-hidden="true" />
          </summary>
          <div id={detailsId} hidden={!expanded}>
            {expanded && (
              <SettledWorkDetails
                entries={stream}
                turn={turn}
                reasoningContent={reasoningContent}
                includesReasoning={includesReasoning}
                projectRoot={projectRoot}
                projectId={projectId}
                conversationId={conversationId}
                defaultCodeWrap={defaultCodeWrap}
                onOpenProjectFile={onOpenProjectFile}
                onBeforeToggle={onBeforeToggle}
                onAfterToggle={onAfterToggle}
              />
            )}
          </div>
        </details>
      )}
      {!hasFoldableDetails && (
        <div className="turn-settled-summary" data-settled-work-summary="static">
          {summaryContent}
        </div>
      )}
      {turn.importantActivities.map((activity) => (
        <ActivityRow
          activity={activity}
          onBeforeToggle={onBeforeToggle}
          onAfterToggle={onAfterToggle}
          key={activity.id}
        />
      ))}
    </div>
  );
}
