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
  ListChecks,
  TriangleAlert,
} from "lucide-react";
import clsx from "clsx";
import type {
  AgentActivity,
  AgentPlan,
  AgentTurn,
} from "@shared/contracts";
import {
  activityAttentionSeverity,
  activityDetailPresentation,
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
      timer = window.setInterval(() => setNow(Date.now()), 1_000);
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
  return <span>{formatElapsed(Math.max(0, now - Date.parse(startedAt)))}</span>;
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
  const anchorToggleHandlers = useAnchoredDetailsToggle(onBeforeToggle, onAfterToggle);
  const interrupted = isInterruptedActivity(activity);
  const attentionSeverity = activityAttentionSeverity(activity);
  const needsAttention = attentionSeverity !== null;
  const severity: ActivityLineSeverity = attentionSeverity ?? "neutral";
  const detailPresentation = activityDetailPresentation(activity);
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
        <details className="agent-activity-technical">
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
          <pre>{detailPresentation.full}</pre>
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
}: {
  entry: Extract<TurnExecutionStreamEntry, { kind: "commentary" }>;
  projectRoot: string;
  projectId: string;
  conversationId: string;
  defaultCodeWrap: boolean;
}): React.JSX.Element {
  return (
    <article
      className={clsx("turn-commentary-row", entry.streaming && "is-streaming")}
      aria-label={entry.streaming ? "Live agent update" : "Agent update"}
      data-assistant-commentary-id={entry.message?.id ?? entry.id}
    >
      <ResponseMarkdown
        content={entry.content}
        projectRoot={projectRoot}
        projectId={projectId}
        conversationId={conversationId}
        defaultCodeWrap={defaultCodeWrap}
        streaming={entry.streaming}
      />
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
  onBeforeToggle,
  onAfterToggle,
}: {
  entries: TurnExecutionStreamEntry[];
  projectRoot: string;
  projectId: string;
  conversationId: string;
  defaultCodeWrap: boolean;
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
        onBeforeToggle={onBeforeToggle}
        onAfterToggle={onAfterToggle}
      />
      {includesReasoning && (
        <div className="turn-reasoning-detail">
          <span><BrainCircuit size={13} aria-hidden="true" />Reasoning summary</span>
          <p>{reasoningContent}</p>
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
  liveContent,
  showThinking,
  projectRoot,
  projectId,
  conversationId,
  defaultCodeWrap,
  onBeforeToggle,
  onAfterToggle,
}: {
  turn: ResponseTurn;
  autoCollapse: boolean;
  reasoningContent: string;
  liveContent: string;
  showThinking: boolean;
  projectRoot: string;
  projectId: string;
  conversationId: string;
  defaultCodeWrap: boolean;
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
  // Streaming text is always the final visible execution entry. Appending that
  // one row keeps settled commentary and activity-group identities stable
  // instead of sorting the complete workstream for every provider token.
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
        streaming: true,
      },
    ];
  }, [
    durableStream,
    liveContent,
    turn.agentTurn.updatedAt,
    turn.id,
    turn.isActive,
  ]);
  const supplementalCount = supplementalActivities.length
    + turn.plans.length
    + (includesReasoning ? 1 : 0);

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
          onBeforeToggle={onBeforeToggle}
          onAfterToggle={onAfterToggle}
        />
        {supplementalCount > 0 && (
          <details
            open={expanded}
            onToggle={(event) => setExpanded(event.currentTarget.open)}
          >
            <summary
              aria-expanded={expanded}
              aria-controls={detailsId}
              {...anchorToggleHandlers}
            >
              <span>More run details</span>
              <small>{supplementalCount}</small>
              <ChevronDown size={13} className="turn-work-chevron" aria-hidden="true" />
            </summary>
            <div className="turn-work-details" id={detailsId}>
              {includesReasoning && (
                <div className="turn-reasoning-detail">
                  <span><BrainCircuit size={13} aria-hidden="true" />Reasoning summary</span>
                  <p>{reasoningContent}<span className="streaming-caret" aria-hidden="true" /></p>
                </div>
              )}
              {turn.plans.map((plan) => <PlanDetail key={`${plan.runId}:${plan.turnId ?? "legacy"}`} plan={plan} />)}
              {supplementalActivities.map((activity) => (
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
          <SettledWorkDetails
            id={detailsId}
            entries={stream}
            turn={turn}
            reasoningContent={reasoningContent}
            includesReasoning={includesReasoning}
            projectRoot={projectRoot}
            projectId={projectId}
            conversationId={conversationId}
            defaultCodeWrap={defaultCodeWrap}
            onBeforeToggle={onBeforeToggle}
            onAfterToggle={onAfterToggle}
          />
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
