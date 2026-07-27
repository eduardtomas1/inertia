import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Copy,
  ExternalLink,
  FileCode2,
  Files,
  GitCompareArrows,
  ListChecks,
  Paperclip,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import clsx from "clsx";
import type {
  AgentActivity,
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  AgentReasoning,
  AgentTurn,
  ChatMessage,
  CheckpointSummary,
  InterfaceScale,
  ProviderInfo,
  ResponseDensity,
  SubagentTrace,
} from "@shared/contracts";
import { formatClockTime } from "../lib/format";
import {
  activeWorkIdentityLabel,
  finalAnswerIdentityLabel,
} from "../utils/finalAnswerIdentity";
import { INTERFACE_SCALE_WILL_CHANGE_EVENT } from "../utils/interfaceScale";
import {
  activityAttentionSeverity,
  activityDetailPresentation,
  activityNeedsAttention,
  buildTurnExecutionStream,
  buildResponseTimeline,
  buildTimelineMinimapMarkers,
  estimateTimelineRowSize,
  formatElapsed,
  isInterruptedActivity,
  resolveTimelineKeyboardIntent,
  resolveActivityGroupPresentation,
  shouldAdjustTimelineScrollPosition,
  shouldConsolidateSettledWorkIntoRunDetails,
  shouldFollowTimeline,
  shouldShowTimelineMinimap,
  shouldShowTurnGitArtifactSummary,
  shouldVirtualizeTimeline,
  stabilizeResponseTimeline,
  turnExecutionElapsedMs,
  turnQueueElapsedMs,
  turnStatusLabel,
  workSummaryLabel,
  type ResponseTimelineItem,
  type ResponseTimelineCompatibility,
  type ResponseTurn,
  type ActivityAttentionSeverity,
  type TurnExecutionStreamEntry,
  type TurnGitArtifactSummary,
} from "../utils/responseTimeline";
import { ApprovalCard, InputRequestCard } from "./AgentRequestCard";
import { ResponseMarkdown } from "./ResponseMarkdown";
import { SubagentDisclosure } from "./SubagentDisclosure";

export interface ResponseTimelineProps {
  turns: AgentTurn[];
  messages: ChatMessage[];
  activities: AgentActivity[];
  subagents?: SubagentTrace[];
  reasonings: AgentReasoning[];
  plans: AgentPlan[];
  checkpoints: CheckpointSummary[];
  gitArtifacts?: TurnGitArtifactSummary[];
  projectRoot: string;
  projectId: string;
  conversationId: string;
  providers: ProviderInfo[];
  streamingText: string;
  streamingReasoning: string;
  approvals: AgentApprovalRequest[];
  inputRequests: AgentInputRequest[];
  showTimestamps: boolean;
  showThinking: boolean;
  defaultCodeWrap: boolean;
  autoCollapseWorkLog: boolean;
  showChangedFileSummaries: boolean;
  checkpointRestoreDisabled: boolean;
  scrollElementRef?: RefObject<HTMLDivElement | null>;
  timelineElementRef?: RefObject<HTMLDivElement | null>;
  onRespondToApproval: (
    request: AgentApprovalRequest,
    decision: AgentApprovalDecision,
  ) => Promise<void>;
  onRespondToInput: (
    request: AgentInputRequest,
    answers: Record<string, string[]>,
  ) => Promise<void>;
  onRevertCheckpoint: (checkpoint: CheckpointSummary) => void;
  onOpenTurnDiff: (turnId: string, path?: string) => void;
  onCompareTurnArtifacts: (earlierTurnId: string, laterTurnId: string) => void;
  onOpenTurnFile: (path: string) => void;
  onStop: () => void;
  onStopSubagent?: (trace: SubagentTrace) => Promise<void>;
}

function useCopyAction(): [boolean, (content: string) => Promise<void>] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const copy = async (content: string): Promise<void> => {
    if (!navigator.clipboard || !content) return;
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      return;
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1_500);
  };
  return [copied, copy];
}

function CopyAnswerButton({
  content,
  ariaLabel = "Copy answer",
}: {
  content: string;
  ariaLabel?: string;
}): React.JSX.Element {
  const [copied, copy] = useCopyAction();
  const copiedAriaLabel = `${ariaLabel.replace(/^Copy\s+/u, "")} copied`;
  return (
    <button
      type="button"
      className="turn-action"
      title={copied ? "Answer copied" : ariaLabel}
      aria-label={copied ? copiedAriaLabel : ariaLabel}
      onClick={() => void copy(content)}
    >
      {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

function LiveElapsed({ startedAt }: { startedAt: string }): React.JSX.Element {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
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

export function ActivityRow({
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
}

function PlanDetail({ plan }: { plan: AgentPlan }): React.JSX.Element {
  return (
    <div className="turn-reasoning-detail" data-turn-plan={plan.turnId ?? "legacy"}>
      <span><ListChecks size={13} aria-hidden="true" />Plan</span>
      {plan.explanation && <p>{plan.explanation}</p>}
      {plan.steps.length > 0 && (
        <p>{plan.steps.map(({ step, status }) => `${status === "completed" ? "✓" : status === "inProgress" ? "•" : "○"} ${step}`).join("\n")}</p>
      )}
    </div>
  );
}

function CommentaryRow({
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
      {entry.streaming && <span className="streaming-caret" aria-hidden="true" />}
    </article>
  );
}

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

function useAnchoredDetailsToggle(
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

export function ActivityGroup({
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
}

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

function SettledWorkDetails({
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

function WorkLog({
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
  const stream = buildTurnExecutionStream(turn, {
    liveContent: turn.isActive ? liveContent : "",
    includeImportantActivities: turn.isActive,
  });
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

function ChangedFilesSummary({
  artifact,
  previousTurnId,
  props,
  onBeforeToggle,
  onAfterToggle,
}: {
  artifact: TurnGitArtifactSummary;
  previousTurnId: string | null;
  props: ResponseTimelineProps;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const anchorToggleHandlers = useAnchoredDetailsToggle(onBeforeToggle, onAfterToggle);
  const detailsId = `turn-changed-files-details-${artifact.id}`;
  if (artifact.status === "pending") {
    return (
      <div
        className="turn-changed-files is-pending"
        data-turn-git-artifact-id={artifact.id}
        data-turn-jump-target="artifact"
        tabIndex={-1}
      >
        <Files size={13} aria-hidden="true" />
        <span><strong>Capturing changes…</strong><small>Git history will appear here when ready.</small></span>
      </div>
    );
  }
  if (
    artifact.status === "unavailable"
    || artifact.status === "failed"
    || artifact.completeness === "unavailable"
  ) {
    return (
      <div
        className="turn-changed-files is-unavailable"
        data-turn-git-artifact-id={artifact.id}
        data-turn-jump-target="artifact"
        tabIndex={-1}
      >
        <TriangleAlert size={13} aria-hidden="true" />
        <span>
          <strong>Turn changes unavailable</strong>
          <small>{artifact.failureReason ?? "No authoritative Git snapshot was captured for this turn."}</small>
        </span>
      </div>
    );
  }
  const patchAvailable = turnGitArtifactPatchAvailable(artifact);
  const completenessWarning = turnGitArtifactCompletenessWarning(artifact);
  return (
    <details
      className="turn-changed-files"
      open={expanded}
      aria-label="Changed by this turn"
      data-turn-git-artifact-id={artifact.id}
      data-turn-jump-target="artifact"
      tabIndex={-1}
      onToggle={(event) => {
        setExpanded(event.currentTarget.open);
      }}
    >
      <summary
        aria-expanded={expanded}
        aria-controls={detailsId}
        {...anchorToggleHandlers}
      >
        <Files size={13} aria-hidden="true" />
        <span className="turn-changed-files-summary-copy">
          <strong>{artifact.files.length} {artifact.files.length === 1 ? "file" : "files"} changed</strong>
          <small>
            · +{artifact.insertions} −{artifact.deletions}
            {artifact.branch && ` · ${artifact.branch}`}
          </small>
        </span>
        <span className="turn-changed-files-toggle">
          {expanded ? "Hide" : "View"}
          <ChevronDown size={13} aria-hidden="true" />
        </span>
      </summary>
      <div className="turn-changed-files-body" id={detailsId}>
        {completenessWarning && (
          <p className="turn-changed-files-warning">
            <TriangleAlert size={12} aria-hidden="true" />
            <span>{completenessWarning}</span>
          </p>
        )}
        <div className="turn-changed-files-list" role="list">
          {artifact.files.slice(0, 12).map((file) => (
            <span key={file.path} title={file.path} role="listitem">
              <button
                type="button"
                disabled={!patchAvailable}
                title={patchAvailable ? `Open this turn's diff for ${file.path}` : "The stored patch is unavailable"}
                onClick={() => props.onOpenTurnDiff(artifact.turnId, file.path)}
              >
                <FileCode2 size={13} aria-hidden="true" />
                <code>{file.path}</code>
                <small>{file.status} · +{file.insertions} −{file.deletions}</small>
              </button>
              <button
                type="button"
                title={`Open ${file.path}`}
                aria-label={`Open ${file.path}`}
                onClick={() => props.onOpenTurnFile(file.path)}
              >
                <ExternalLink size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
        {artifact.files.length > 12 && <p className="turn-changed-files-overflow">And {artifact.files.length - 12} more files.</p>}
        <div className="turn-changed-files-actions">
          <button type="button" disabled={!patchAvailable} onClick={() => props.onOpenTurnDiff(artifact.turnId)}>
            <GitCompareArrows size={12} aria-hidden="true" />Open exact turn diff
          </button>
          {previousTurnId && (
            <button type="button" onClick={() => props.onCompareTurnArtifacts(previousTurnId, artifact.turnId)}>
              <GitCompareArrows size={12} aria-hidden="true" />Compare with previous turn
            </button>
          )}
        </div>
      </div>
    </details>
  );
}

export function turnGitArtifactPatchAvailable(
  artifact: TurnGitArtifactSummary,
): boolean {
  return artifact.patchState === "available" || artifact.patchState === "truncated";
}

export function turnGitArtifactCompletenessWarning(
  artifact: TurnGitArtifactSummary,
): string | null {
  if (artifact.failureReason) return artifact.failureReason;
  const warnings: string[] = [];
  if (artifact.completeness === "truncated") {
    warnings.push(
      "This historical artifact reached a capture limit; its file list, totals, or stored patch may be incomplete.",
    );
  } else if (artifact.completeness === "partial") {
    warnings.push("Only a partial historical Git capture is available for this turn.");
  }
  if (artifact.patchState === "expired") {
    warnings.push("The stored patch has expired; the historical file summary is still available.");
  } else if (artifact.patchState === "failed") {
    warnings.push("The historical file summary is available, but its stored patch could not be read.");
  } else if (artifact.patchState === "none") {
    warnings.push("The historical file summary is available without a stored patch.");
  }
  return warnings.length > 0 ? warnings.join(" ") : null;
}

export function shouldShowChangedFilesSummary(
  artifact: TurnGitArtifactSummary,
): boolean {
  return shouldShowTurnGitArtifactSummary(artifact);
}

export interface TurnRunDetail {
  label: string;
  value: string;
  technical: boolean;
}

export interface TurnMetadataPresentation {
  statusLabel: string;
  durationLabel: string;
  details: TurnRunDetail[];
}

function sessionContinuationLabel(agentTurn: AgentTurn): string {
  if (agentTurn.providerSessionBefore !== null) return "Resumed existing session";
  if (agentTurn.providerSessionAfter !== null) return "Started new session";
  return "Not recorded";
}

export function turnMetadataPresentation(
  turn: ResponseTurn,
  now = Date.now(),
): TurnMetadataPresentation {
  const { agentTurn } = turn;
  const selection = agentTurn.modelSelection;
  const execution = turnExecutionElapsedMs(turn, now);
  let durationLabel: string;
  if (execution === null) {
    durationLabel = turn.isActive
      ? `Queued ${formatElapsed(turnQueueElapsedMs(turn, now))}`
      : "Not started";
  } else {
    const duration = formatElapsed(execution);
    durationLabel = turn.isActive
      ? `Working ${duration}`
      : agentTurn.status === "completed"
        ? `Worked ${duration}`
        : `Ran ${duration}`;
  }

  const details: TurnRunDetail[] = [
    { label: "Harness ID", value: selection.harnessId, technical: true },
    { label: "Backend profile ID", value: selection.backendProfileId, technical: true },
    { label: "Exact model ID", value: selection.modelId, technical: true },
    {
      label: "Requested alias",
      value: selection.alias ?? "Not requested",
      technical: selection.alias !== null,
    },
    {
      label: "Reasoning level",
      value: selection.reasoningEffort ?? "Default",
      technical: selection.reasoningEffort !== null,
    },
    { label: "Interaction mode", value: agentTurn.interactionMode, technical: true },
    { label: "Access mode", value: agentTurn.accessMode, technical: true },
    {
      label: "Queue duration",
      value: formatElapsed(turnQueueElapsedMs(turn, now)),
      technical: false,
    },
    {
      label: "Execution duration",
      value: execution === null ? "Not started" : formatElapsed(execution),
      technical: false,
    },
    {
      label: "Historical association",
      value: agentTurn.association === "authoritative" ? "Authoritative" : "Inferred",
      technical: false,
    },
    {
      label: "Session continuation",
      value: sessionContinuationLabel(agentTurn),
      technical: false,
    },
  ];
  if (
    turn.gitArtifact === null
    || shouldShowChangedFilesSummary(turn.gitArtifact)
  ) {
    details.push({
      label: "Artifact completeness",
      value: artifactCompletenessLabel(turn.gitArtifact),
      technical: false,
    });
  }
  return {
    statusLabel: turnStatusLabel(agentTurn.status),
    durationLabel,
    details,
  };
}

export function turnCompletionAnnouncement(
  wasActive: boolean,
  turn: ResponseTurn,
  providerLabel: string,
): string {
  if (!wasActive || turn.isActive) return "";
  return `${providerLabel}: ${workSummaryLabel(turn)}.`;
}

function artifactCompletenessLabel(artifact: TurnGitArtifactSummary | null): string {
  if (artifact === null) return "Not captured";
  switch (artifact.completeness) {
    case "complete": return "Complete";
    case "truncated": return "Truncated";
    case "partial": return "Partial";
    case "unavailable": return "Unavailable";
  }
}

function TurnMetadata({
  turn,
  terminalAnswer,
  showTimestamp,
  settledWorkDetails,
  workDetailsExpandedByDefault,
  onBeforeToggle,
  onAfterToggle,
}: {
  turn: ResponseTurn;
  terminalAnswer: ChatMessage | null;
  showTimestamp: boolean;
  settledWorkDetails?: React.JSX.Element | null;
  workDetailsExpandedByDefault?: boolean;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}): React.JSX.Element {
  const [detailsExpanded, setDetailsExpanded] = useState(
    workDetailsExpandedByDefault === true,
  );
  const { agentTurn } = turn;
  const presentation = turnMetadataPresentation(turn);
  const detailsId = `turn-run-details-${turn.id}`;
  const detailsLabelId = `${detailsId}-label`;
  const togglePrepared = useRef(false);
  const prepareToggle = (): void => {
    if (togglePrepared.current) return;
    togglePrepared.current = true;
    onBeforeToggle?.();
  };
  const toggleDetails = (): void => {
    prepareToggle();
    setDetailsExpanded((current) => !current);
  };
  useLayoutEffect(() => {
    if (!togglePrepared.current) return;
    onAfterToggle?.();
    togglePrepared.current = false;
  }, [detailsExpanded, onAfterToggle]);
  useEffect(() => {
    setDetailsExpanded(workDetailsExpandedByDefault === true);
  }, [workDetailsExpandedByDefault]);
  return (
    <footer className="turn-meta" aria-label="Final answer actions and run metadata">
      <div className="turn-meta-primary">
        {terminalAnswer && (
          <CopyAnswerButton content={terminalAnswer.content} ariaLabel="Copy final answer" />
        )}
        {showTimestamp && terminalAnswer && (
          <time dateTime={terminalAnswer.createdAt}>{formatClockTime(terminalAnswer.createdAt)}</time>
        )}
        <span data-turn-status={agentTurn.status}>{presentation.statusLabel}</span>
        <span className="turn-duration">{presentation.durationLabel}</span>
        <button
          type="button"
          className="turn-run-details-toggle"
          id={detailsLabelId}
          aria-expanded={detailsExpanded}
          aria-controls={detailsId}
          onPointerDownCapture={prepareToggle}
          onPointerCancelCapture={() => {
            togglePrepared.current = false;
          }}
          onKeyDownCapture={(event) => {
            if (event.key === "Enter" || event.key === " ") prepareToggle();
          }}
          onClickCapture={prepareToggle}
          onClick={toggleDetails}
        >
          <span>Run details</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      </div>
      <dl
        className="turn-run-details"
        id={detailsId}
        aria-labelledby={detailsLabelId}
        hidden={!detailsExpanded}
      >
        {presentation.details.map((detail) => (
          <div key={detail.label}>
            <dt>{detail.label}</dt>
            <dd>{detail.technical ? <code>{detail.value}</code> : detail.value}</dd>
          </div>
        ))}
        {settledWorkDetails && (
          <div className="turn-run-work-details">
            <dt>Execution transcript</dt>
            <dd>{settledWorkDetails}</dd>
          </div>
        )}
      </dl>
    </footer>
  );
}

function UserRequestLayer({
  turn,
  props,
}: {
  turn: ResponseTurn;
  props: ResponseTimelineProps;
}): React.JSX.Element {
  const isDocumentLike = turn.userMessage.content.length >= 280;
  return (
    <article
      className={clsx("message is-user turn-user-request", isDocumentLike && "is-document-like")}
      aria-label="Your request"
      data-request-layout={isDocumentLike ? "document" : "content"}
      data-turn-layer="user-request"
      data-turn-request-context={turn.id}
      data-turn-jump-target="request"
      tabIndex={-1}
    >
      <div className="message-meta">
        <span>You</span>
        {props.showTimestamps && <time dateTime={turn.userMessage.createdAt}>{formatClockTime(turn.userMessage.createdAt)}</time>}
        {turn.checkpoint && <button type="button" className="message-revert" title={props.checkpointRestoreDisabled ? "Stop the active run before restoring a checkpoint" : "Restore the project to before this turn"} disabled={props.checkpointRestoreDisabled} onClick={() => props.onRevertCheckpoint(turn.checkpoint!)}><RotateCcw size={11} />Revert</button>}
      </div>
      <div className="message-body">{turn.userMessage.content}</div>
      {turn.userMessage.attachments.length > 0 && (
        <ul className="message-attachments turn-user-request-context" aria-label="Request context">
          {turn.userMessage.attachments.map((attachment) => (
            <li
              className="turn-user-request-context-chip"
              data-request-context-kind="image"
              key={attachment.id}
              title={`Image · ${attachment.name}`}
            >
              <Paperclip size={12} aria-hidden="true" />
              <span>Image · {attachment.name}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function AgentExecutionLayer({
  turn,
  props,
  providerLabel,
  reasoningContent,
  liveContent,
  timerStart,
  completionAnnouncement,
  onBeforeToggle,
  onAfterToggle,
}: {
  turn: ResponseTurn;
  props: ResponseTimelineProps;
  providerLabel: string;
  reasoningContent: string;
  liveContent: string;
  timerStart: string;
  completionAnnouncement: string;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}): React.JSX.Element {
  const consolidatesSettledWork = shouldConsolidateSettledWorkIntoRunDetails(turn);
  const subagents = (props.subagents ?? []).filter(
    ({ turnId }) => turnId === turn.agentTurn.id,
  );
  const statusLabel = turn.agentTurn.status === "queued"
    ? `${providerLabel} is queued`
    : turn.agentTurn.status === "starting"
      ? `${providerLabel} is starting`
      : turn.agentTurn.status === "waiting-for-approval"
        ? `${providerLabel} needs approval`
        : turn.agentTurn.status === "waiting-for-input"
          ? `${providerLabel} has a question`
          : `${providerLabel} is working`;
  return (
    <section
      className={clsx(
        "agent-run-flow turn-agent-execution",
        consolidatesSettledWork && "is-quiet-settled",
      )}
      aria-label={`${providerLabel} activity`}
      data-turn-layer="agent-execution"
    >
      {turn.isActive ? (
        <div
          className="turn-execution-rail is-live"
          data-active-work-region=""
          data-active-work-state={turn.agentTurn.status}
          data-work-identity-source="persisted-model-selection"
        >
          <header className="turn-working-state" title={providerLabel}>
            <span className="turn-working-status" role="status" aria-live="polite" aria-atomic="true">
              <strong>{statusLabel}</strong>
            </span>
            <span className="turn-working-elapsed" aria-live="off">
              <span className="turn-working-separator" aria-hidden="true">·</span>
              <LiveElapsed startedAt={timerStart} />
            </span>
            <button
              type="button"
              className="turn-stop-action"
              aria-label={`Stop ${providerLabel} run`}
              onClick={props.onStop}
            >
              <span>Stop</span>
            </button>
          </header>
          <WorkLog
            turn={turn}
            autoCollapse={props.autoCollapseWorkLog}
            reasoningContent={reasoningContent}
            liveContent={liveContent}
            showThinking={props.showThinking}
            projectRoot={props.projectRoot}
            projectId={props.projectId}
            conversationId={props.conversationId}
            defaultCodeWrap={props.defaultCodeWrap}
            onBeforeToggle={onBeforeToggle}
            onAfterToggle={onAfterToggle}
          />
        </div>
      ) : !consolidatesSettledWork ? (
        <div className="turn-execution-rail is-settled">
          <WorkLog
            turn={turn}
            autoCollapse={props.autoCollapseWorkLog}
            reasoningContent={reasoningContent}
            liveContent=""
            showThinking={props.showThinking}
            projectRoot={props.projectRoot}
            projectId={props.projectId}
            conversationId={props.conversationId}
            defaultCodeWrap={props.defaultCodeWrap}
            onBeforeToggle={onBeforeToggle}
            onAfterToggle={onAfterToggle}
          />
        </div>
      ) : null}
      <SubagentDisclosure
        subagents={subagents}
        turns={props.turns}
        onStopSubagent={props.onStopSubagent}
      />
      <span
        className="visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-turn-completion-announcement=""
      >
        {completionAnnouncement}
      </span>
      {turn.approvals.map((request) => <ApprovalCard key={request.id} request={request} onRespond={props.onRespondToApproval} />)}
      {turn.inputRequests.map((request) => <InputRequestCard key={request.id} request={request} onRespond={props.onRespondToInput} />)}
      {turn.systemMessages.map((message) => (
        <article
          className="message is-system turn-system-notice"
          aria-label="Agent system notice"
          data-turn-work-notice=""
          key={message.id}
        >
          <div className="message-meta">
            <span>System</span>
            {props.showTimestamps && <time dateTime={message.createdAt}>{formatClockTime(message.createdAt)}</time>}
          </div>
          <div className="message-body">{message.content}</div>
        </article>
      ))}
    </section>
  );
}

export interface FinalAnswerPresentation {
  content: string;
  phase: "streaming" | "settling" | "persisted";
  markdownStreaming: boolean;
  showCaret: boolean;
  terminalAnswer: ChatMessage | null;
}

export function resolveFinalAnswerPresentation(
  turn: Pick<ResponseTurn, "isActive" | "terminalAssistantMessage">,
  _liveContent: string,
  _retainedLiveContent: string,
): FinalAnswerPresentation | null {
  if (turn.isActive) return null;
  const terminalAnswer = turn.terminalAssistantMessage;
  if (!terminalAnswer?.content) return null;
  return {
    content: terminalAnswer.content,
    phase: "persisted",
    markdownStreaming: false,
    showCaret: false,
    terminalAnswer,
  };
}

function FinalAnswerDocument({
  turn,
  props,
  liveContent,
}: {
  turn: ResponseTurn;
  props: ResponseTimelineProps;
  liveContent: string;
}): React.JSX.Element | null {
  const retainedLiveContent = useRef(liveContent);
  if (turn.isActive && liveContent) retainedLiveContent.current = liveContent;
  const presentation = resolveFinalAnswerPresentation(
    turn,
    liveContent,
    retainedLiveContent.current,
  );
  if (!presentation) return null;
  const isStreaming = presentation.phase === "streaming";

  return (
    <article
      className={clsx(
        "message is-assistant turn-final-answer-document",
        isStreaming ? "is-streaming" : "is-final-answer",
      )}
      aria-label={isStreaming ? "Streaming assistant answer" : "Final assistant answer"}
      data-answer-phase={presentation.phase}
      data-terminal-answer-id={presentation.terminalAnswer?.id}
      data-turn-jump-target="final"
      data-turn-layer="final-answer"
      tabIndex={-1}
    >
      <header
        className="final-answer-identity"
        aria-label="Historical answer identity"
        data-identity-source="persisted-model-selection"
      >
        <span data-final-answer-identity="historical-model-selection">
          {finalAnswerIdentityLabel(turn.agentTurn.modelSelection)}
        </span>
        {presentation.showCaret && <span className="live-label">Live</span>}
      </header>
      <ResponseMarkdown
        content={presentation.content}
        projectRoot={props.projectRoot}
        projectId={props.projectId}
        conversationId={props.conversationId}
        defaultCodeWrap={props.defaultCodeWrap}
        streaming={presentation.markdownStreaming}
      />
      {presentation.showCaret && <span className="streaming-caret" aria-hidden="true" />}
    </article>
  );
}

function SupportingLedgerLayer({
  turn,
  props,
  previousArtifactTurnId,
  onBeforeToggle,
  onAfterToggle,
}: {
  turn: ResponseTurn;
  props: ResponseTimelineProps;
  previousArtifactTurnId: string | null;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}): React.JSX.Element | null {
  if (turn.isActive) return null;
  const consolidatesSettledWork = shouldConsolidateSettledWorkIntoRunDetails(turn);
  const settledWorkStream = consolidatesSettledWork
    ? buildTurnExecutionStream(turn)
    : [];
  const includesReasoning = consolidatesSettledWork
    && props.showThinking
    && Boolean(turn.reasoning?.content);
  const hasSettledWorkDetails = settledWorkStream.length > 0
    || includesReasoning
    || turn.plans.length > 0;
  const showChangedFiles = props.showChangedFileSummaries
    && turn.gitArtifact !== null
    && shouldShowChangedFilesSummary(turn.gitArtifact);
  if (!turn.terminalAssistantMessage && !showChangedFiles) return null;

  return (
    <section
      className="turn-supporting-ledger"
      aria-label="Supporting turn ledger"
      data-turn-layer="supporting-ledger"
    >
      {turn.terminalAssistantMessage && (
        <TurnMetadata
          turn={turn}
          terminalAnswer={turn.terminalAssistantMessage}
          showTimestamp={props.showTimestamps}
          settledWorkDetails={hasSettledWorkDetails
            ? (
                <SettledWorkDetails
                  entries={settledWorkStream}
                  turn={turn}
                  reasoningContent={turn.reasoning?.content ?? ""}
                  includesReasoning={includesReasoning}
                  projectRoot={props.projectRoot}
                  projectId={props.projectId}
                  conversationId={props.conversationId}
                  defaultCodeWrap={props.defaultCodeWrap}
                  onBeforeToggle={onBeforeToggle}
                  onAfterToggle={onAfterToggle}
                />
              )
            : null}
          workDetailsExpandedByDefault={hasSettledWorkDetails
            && !props.autoCollapseWorkLog}
          onBeforeToggle={onBeforeToggle}
          onAfterToggle={onAfterToggle}
        />
      )}
      {showChangedFiles && turn.gitArtifact && (
        <ChangedFilesSummary
          artifact={turn.gitArtifact}
          previousTurnId={previousArtifactTurnId}
          props={props}
          onBeforeToggle={onBeforeToggle}
          onAfterToggle={onAfterToggle}
        />
      )}
    </section>
  );
}

function TurnTimelineComponent({
  turn,
  props,
  previousArtifactTurnId,
  onBeforeToggle,
  onAfterToggle,
}: {
  turn: ResponseTurn;
  props: ResponseTimelineProps;
  previousArtifactTurnId: string | null;
  onBeforeToggle?: (turnId: string) => void;
  onAfterToggle?: (turnId: string) => void;
}): React.JSX.Element {
  const liveContent = turn.isActive && !turn.terminalAssistantMessage
    ? props.streamingText
    : "";
  const reasoningContent = turn.isActive
    ? props.streamingReasoning || turn.reasoning?.content || ""
    : turn.reasoning?.content || "";
  const providerLabel = activeWorkIdentityLabel(turn.agentTurn.modelSelection);
  const timerStart = turn.startedAt ?? turn.requestedAt;
  const wasActive = useRef(turn.isActive);
  const [completionAnnouncement, setCompletionAnnouncement] = useState("");
  const [settlingTransition, setSettlingTransition] = useState<{
    revealAnswer: boolean;
  } | null>(null);
  const isSettling = settlingTransition !== null;
  const isRevealingSettledAnswer = settlingTransition?.revealAnswer ?? false;

  useLayoutEffect(() => {
    const announcement = turnCompletionAnnouncement(wasActive.current, turn, providerLabel);
    if (announcement) {
      setCompletionAnnouncement(announcement);
      setSettlingTransition({
        // Task 12 deliberately never renders a final document while active.
        // A terminal row already present in the settlement snapshot is still
        // newly visible and receives the restrained document reveal.
        revealAnswer: Boolean(turn.terminalAssistantMessage?.content),
      });
    } else if (
      settlingTransition
      && !settlingTransition.revealAnswer
      && !turn.isActive
      && turn.terminalAssistantMessage?.content
    ) {
      // Keep a short persistence gap inside the same transition window without
      // promoting transient prose or restarting the completion timer.
      setSettlingTransition({ revealAnswer: true });
    }
    wasActive.current = turn.isActive;
  }, [
    providerLabel,
    settlingTransition,
    turn,
    turn.isActive,
  ]);
  useEffect(() => {
    if (!isSettling) return;
    const timer = window.setTimeout(() => setSettlingTransition(null), 220);
    return () => window.clearTimeout(timer);
  }, [isSettling]);

  return (
    <section
      className={clsx(
        "response-turn",
        turn.isActive && "is-active",
        isSettling && "is-settling",
        isRevealingSettledAnswer && "is-revealing-settled-answer",
      )}
      aria-label={`Turn ${turn.index}`}
      data-completion-transition={isSettling ? "active-to-settled" : undefined}
      data-response-row-id={turn.id}
      data-turn-id={turn.id}
      data-turn-association={turn.agentTurn.association}
      data-turn-git-artifact-slot={turn.id}
      tabIndex={-1}
    >
      <UserRequestLayer turn={turn} props={props} />

      <AgentExecutionLayer
        turn={turn}
        props={props}
        providerLabel={providerLabel}
        reasoningContent={reasoningContent}
        liveContent={liveContent}
        timerStart={timerStart}
        completionAnnouncement={completionAnnouncement}
        onBeforeToggle={() => onBeforeToggle?.(turn.id)}
        onAfterToggle={() => onAfterToggle?.(turn.id)}
      />

      <FinalAnswerDocument
        turn={turn}
        props={props}
        liveContent={liveContent}
      />

      <SupportingLedgerLayer
        turn={turn}
        props={props}
        previousArtifactTurnId={previousArtifactTurnId}
        onBeforeToggle={() => onBeforeToggle?.(turn.id)}
        onAfterToggle={() => onAfterToggle?.(turn.id)}
      />
    </section>
  );
}

export function sameTurnTimelineProps(
  previous: {
    turn: ResponseTurn;
    props: ResponseTimelineProps;
    previousArtifactTurnId: string | null;
    onBeforeToggle?: (turnId: string) => void;
    onAfterToggle?: (turnId: string) => void;
  },
  next: {
    turn: ResponseTurn;
    props: ResponseTimelineProps;
    previousArtifactTurnId: string | null;
    onBeforeToggle?: (turnId: string) => void;
    onAfterToggle?: (turnId: string) => void;
  },
): boolean {
  const left = previous.props;
  const right = next.props;
  return previous.turn === next.turn
    && previous.previousArtifactTurnId === next.previousArtifactTurnId
    && previous.onBeforeToggle === next.onBeforeToggle
    && previous.onAfterToggle === next.onAfterToggle
    && left.projectRoot === right.projectRoot
    && left.projectId === right.projectId
    && left.conversationId === right.conversationId
    && left.showTimestamps === right.showTimestamps
    && left.showThinking === right.showThinking
    && left.defaultCodeWrap === right.defaultCodeWrap
    && left.autoCollapseWorkLog === right.autoCollapseWorkLog
    && left.showChangedFileSummaries === right.showChangedFileSummaries
    && left.checkpointRestoreDisabled === right.checkpointRestoreDisabled
    && left.onRespondToApproval === right.onRespondToApproval
    && left.onRespondToInput === right.onRespondToInput
    && left.onRevertCheckpoint === right.onRevertCheckpoint
    && left.onOpenTurnDiff === right.onOpenTurnDiff
    && left.onCompareTurnArtifacts === right.onCompareTurnArtifacts
    && left.onOpenTurnFile === right.onOpenTurnFile
    && left.onStop === right.onStop
    && left.onStopSubagent === right.onStopSubagent
    && left.subagents === right.subagents
    && (!next.turn.isActive || (
      left.streamingText === right.streamingText
      && left.streamingReasoning === right.streamingReasoning
    ));
}

const TurnTimeline = memo(TurnTimelineComponent, sameTurnTimelineProps);

function CompatibilityTimeline({
  compatibility,
  props,
}: {
  compatibility: ResponseTimelineCompatibility;
  props: ResponseTimelineProps;
}): React.JSX.Element {
  return (
    <section className="orphan-run-flow" aria-label="Recovered legacy and orphaned history" data-response-row-id="legacy-orphan-history">
      <details open>
        <summary>Recovered legacy history</summary>
        <p>These records could not be verified as ordinary authoritative turns.</p>
        {compatibility.inferredTurns.map((turn) => (
          <TurnTimeline
            key={turn.id}
            turn={turn}
            props={props}
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
              ? <ResponseMarkdown content={message.content} projectRoot={props.projectRoot} projectId={props.projectId} conversationId={props.conversationId} defaultCodeWrap={props.defaultCodeWrap} />
              : <div className="message-body">{message.content}</div>}
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
      </details>
    </section>
  );
}

type TimelineJumpTarget = "turn" | "request" | "final" | "artifact";

function findTurnElement(
  root: HTMLElement | null | undefined,
  turnId: string,
): HTMLElement | null {
  if (!root) return null;
  return [...root.querySelectorAll<HTMLElement>("[data-turn-id]")]
    .find((element) => element.dataset.turnId === turnId) ?? null;
}

function currentPlainTimelineIndex(
  root: HTMLElement | null | undefined,
  scrollElement: HTMLElement | null | undefined,
  timeline: ResponseTimelineItem[],
): number {
  if (!root || !scrollElement || timeline.length === 0) return 0;
  const scrollTop = scrollElement.getBoundingClientRect().top;
  const visible = [...root.querySelectorAll<HTMLElement>("[data-response-row-id]")]
    .find((element) => element.getBoundingClientRect().bottom > scrollTop + 8);
  const index = visible
    ? timeline.findIndex(({ id }) => id === visible.dataset.responseRowId)
    : -1;
  return index >= 0 ? index : Math.max(0, timeline.length - 1);
}

function currentInterfaceScale(): InterfaceScale {
  if (typeof document === "undefined") return "default";
  const value = document.documentElement.dataset.interfaceScale;
  return value === "compact"
    || value === "comfortable"
    || value === "large"
    ? value
    : "default";
}

function currentResponseDensity(root: HTMLElement | null | undefined): ResponseDensity {
  const workspace = root?.closest<HTMLElement>(".chat-workspace");
  if (workspace?.classList.contains("response-density-compact")) return "compact";
  if (workspace?.classList.contains("response-density-comfortable")) return "comfortable";
  return "default";
}

interface TimelineEstimateLayout {
  availableWidth: number;
  interfaceScale: InterfaceScale;
  responseDensity: ResponseDensity;
}

interface TimelineLayoutAnchor {
  rowId: string | null;
  viewportOffset: number;
  wasFollowing: boolean;
}

const DEFAULT_TIMELINE_ESTIMATE_LAYOUT: TimelineEstimateLayout = {
  availableWidth: 880,
  interfaceScale: "default",
  responseDensity: "default",
};

function useTimelineEstimateLayout(
  timelineElementRef: RefObject<HTMLDivElement | null> | undefined,
  conversationId: string,
  onBeforeLayoutChange: () => void,
): TimelineEstimateLayout {
  const [layout, setLayout] = useState(DEFAULT_TIMELINE_ESTIMATE_LAYOUT);
  useLayoutEffect(() => {
    const timelineElement = timelineElementRef?.current;
    if (!timelineElement) return;
    const workspace = timelineElement.closest<HTMLElement>(".chat-workspace");
    let lastLayout = DEFAULT_TIMELINE_ESTIMATE_LAYOUT;
    const measure = (): void => {
      const next = {
        availableWidth: Math.max(320, Math.round(timelineElement.clientWidth)),
        interfaceScale: currentInterfaceScale(),
        responseDensity: currentResponseDensity(timelineElement),
      };
      if (
        lastLayout.availableWidth === next.availableWidth
        && lastLayout.interfaceScale === next.interfaceScale
        && lastLayout.responseDensity === next.responseDensity
      ) return;
      onBeforeLayoutChange();
      lastLayout = next;
      setLayout(next);
    };
    measure();
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(measure);
    resizeObserver?.observe(timelineElement);
    const mutationObserver = typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(measure);
    window.addEventListener(
      INTERFACE_SCALE_WILL_CHANGE_EVENT,
      onBeforeLayoutChange,
    );
    mutationObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-interface-scale"],
    });
    if (workspace) {
      mutationObserver?.observe(workspace, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }
    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener(
        INTERFACE_SCALE_WILL_CHANGE_EVENT,
        onBeforeLayoutChange,
      );
    };
  }, [conversationId, onBeforeLayoutChange, timelineElementRef]);
  return layout;
}

interface TimelineGutter {
  available: number;
  minimapLeft: number;
}

const EMPTY_TIMELINE_GUTTER: TimelineGutter = { available: 0, minimapLeft: 0 };

function useTimelineGutter(
  scrollElementRef: RefObject<HTMLDivElement | null> | undefined,
  timelineElement: HTMLDivElement | null,
  enabled: boolean,
  conversationId: string,
): TimelineGutter {
  const [gutter, setGutter] = useState<TimelineGutter>(EMPTY_TIMELINE_GUTTER);
  useLayoutEffect(() => {
    if (!enabled) {
      setGutter(EMPTY_TIMELINE_GUTTER);
      return;
    }
    const scrollElement = scrollElementRef?.current
      ?? timelineElement?.closest<HTMLDivElement>(".message-scroll")
      ?? null;
    if (!scrollElement || !timelineElement) return;
    const measure = (): void => {
      const scrollBounds = scrollElement.getBoundingClientRect();
      const timelineBounds = timelineElement.getBoundingClientRect();
      const visibleTurn = timelineElement.querySelector<HTMLElement>(".response-turn");
      const rowLeft = visibleTurn?.getBoundingClientRect().left
        ?? timelineBounds.left + Math.max(0, (timelineElement.clientWidth - Math.min(760, timelineElement.clientWidth)) / 2);
      const available = Math.max(0, Math.round(rowLeft - scrollBounds.left));
      const minimapLeft = Math.round(
        scrollBounds.left + Math.max(6, (available - 12) / 2) - timelineBounds.left,
      );
      setGutter((current) =>
        current.available === available && current.minimapLeft === minimapLeft
          ? current
          : { available, minimapLeft });
    };
    measure();
    const frame = window.requestAnimationFrame(measure);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(scrollElement);
    observer.observe(timelineElement);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [conversationId, enabled, scrollElementRef, timelineElement]);
  return gutter;
}

interface TimelineMarker {
  timelineIndex: number;
  id: string;
  label: string;
  number: number;
}

function TimelineMinimap({
  activeIndex,
  left,
  markers,
  onNavigate,
}: {
  activeIndex: number;
  left: number;
  markers: TimelineMarker[];
  onNavigate: (index: number, target: TimelineJumpTarget) => void;
}): React.JSX.Element {
  let activeMarker = 0;
  markers.forEach((marker, index) => {
    if (marker.timelineIndex <= activeIndex) activeMarker = index;
  });
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const focused = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : event.key === "ArrowUp"
          ? Math.max(0, focused - 1)
          : Math.min(buttons.length - 1, focused + 1);
    buttons[next]?.focus();
  };
  return (
    <div
      className="timeline-minimap-anchor"
      style={{ "--timeline-minimap-left": `${left}px` } as React.CSSProperties}
    >
      <nav className="timeline-minimap" aria-label="Conversation minimap" onKeyDown={onKeyDown}>
        {markers.map((marker, index) => (
          <button
            type="button"
            key={marker.id}
            aria-current={index === activeMarker ? "true" : undefined}
            aria-label={`Go to turn ${marker.number}: ${marker.label}`}
            tabIndex={index === activeMarker ? 0 : -1}
            title={`Turn ${marker.number}: ${marker.label}`}
            onClick={() => onNavigate(marker.timelineIndex, "turn")}
          />
        ))}
      </nav>
    </div>
  );
}

export function ResponseTimeline(props: ResponseTimelineProps): React.JSX.Element {
  const previousTimeline = useRef<ResponseTimelineItem[]>([]);
  const pendingLayoutAnchor = useRef<TimelineLayoutAnchor | null>(null);
  const captureLayoutAnchorRef = useRef<() => void>(() => undefined);
  const captureLayoutAnchorBeforeChange = useCallback(() => {
    captureLayoutAnchorRef.current();
  }, []);
  const builtTimeline = useMemo(() => buildResponseTimeline({
    turns: props.turns,
    messages: props.messages,
    activities: props.activities,
    reasonings: props.reasonings,
    plans: props.plans,
    approvals: props.approvals,
    inputRequests: props.inputRequests,
    checkpoints: props.checkpoints,
    gitArtifacts: props.gitArtifacts,
  }), [
    props.activities,
    props.approvals,
    props.checkpoints,
    props.gitArtifacts,
    props.inputRequests,
    props.messages,
    props.plans,
    props.reasonings,
    props.turns,
  ]);
  const timeline = useMemo(() => {
    const next = stabilizeResponseTimeline(builtTimeline, previousTimeline.current);
    previousTimeline.current = next;
    return next;
  }, [builtTimeline]);
  const previousComparableTurn = useMemo(() => {
    const result = new Map<string, string>();
    const previousByWorktree = new Map<string, string>();
    for (const item of timeline) {
      if (item.kind !== "turn") continue;
      const artifact = item.turn.gitArtifact;
      if (
        !artifact
        || artifact.status === "pending"
        || artifact.repositoryIdentity === null
        || artifact.worktreeIdentity === null
        || artifact.afterFingerprint === null
      ) continue;
      const key = `${artifact.repositoryIdentity}\u0000${artifact.worktreeIdentity}`;
      const previousTurnId = previousByWorktree.get(key);
      if (previousTurnId) result.set(artifact.turnId, previousTurnId);
      previousByWorktree.set(key, artifact.turnId);
    }
    return result;
  }, [timeline]);
  const virtualized = shouldVirtualizeTimeline(timeline.length);
  const estimateLayout = useTimelineEstimateLayout(
    props.timelineElementRef,
    props.conversationId,
    captureLayoutAnchorBeforeChange,
  );
  const getItemKey = useCallback(
    (index: number) => timeline[index]?.id ?? `missing-${index}`,
    [timeline],
  );
  const estimateSize = useCallback((index: number) => {
    const item = timeline[index];
    if (!item) return 280;
    const artifact = item.kind === "turn" ? item.turn.gitArtifact : null;
    const expandsConsolidatedWork = item.kind === "turn"
      && !props.autoCollapseWorkLog
      && shouldConsolidateSettledWorkIntoRunDetails(item.turn);
    return estimateTimelineRowSize(item, {
      ...estimateLayout,
      workDetailsExpanded: !props.autoCollapseWorkLog,
      runDetailsExpanded: expandsConsolidatedWork,
      showThinking: props.showThinking,
      showChangedFiles: props.showChangedFileSummaries
        && artifact !== null
        && shouldShowChangedFilesSummary(artifact),
    });
  }, [
    props.autoCollapseWorkLog,
    props.showChangedFileSummaries,
    props.showThinking,
    estimateLayout,
    timeline,
  ]);
  const virtualizer = useVirtualizer({
    count: timeline.length,
    enabled: virtualized,
    getScrollElement: () => props.scrollElementRef?.current ?? null,
    getItemKey,
    estimateSize,
    overscan: 4,
    anchorTo: "end",
    followOnAppend: false,
    useAnimationFrameWithResizeObserver: true,
  });
  type ExpansionAnchor = {
    sequence: number;
    sourceTurnId: string;
    sourceHeight: number | null;
    rowId: string;
    viewportOffset: number;
  };
  const nextExpansionAnchorSequence = useRef(0);
  const pendingAnchors = useRef(new Map<string, ExpansionAnchor>());
  const activeAnchorRestorations = useRef(new Map<string, number>());
  const manuallyAdjustedRows = useRef(new Set<string>());
  const layoutAnchorActive = useRef(false);
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    shouldAdjustTimelineScrollPosition({
      itemStart: item.start,
      itemSize: item.size,
      scrollOffset: instance.scrollOffset ?? 0,
      firstMeasurement: !instance.itemSizeCache.has(item.key),
      scrollDirection: instance.scrollDirection,
      manuallyAnchored: layoutAnchorActive.current
        || manuallyAdjustedRows.current.has(String(item.key)),
    });
  captureLayoutAnchorRef.current = () => {
    if (pendingLayoutAnchor.current) return;
    const scrollElement = props.scrollElementRef?.current;
    const root = props.timelineElementRef?.current;
    if (!scrollElement || !root) return;
    const wasFollowing = shouldFollowTimeline(
      scrollElement.scrollTop,
      scrollElement.clientHeight,
      scrollElement.scrollHeight,
    );
    const viewportTop = scrollElement.getBoundingClientRect().top;
    const anchor = wasFollowing
      ? null
      : [...root.querySelectorAll<HTMLElement>("[data-response-row-id]")]
          .find((row) => row.getBoundingClientRect().bottom > viewportTop + 8) ?? null;
    pendingLayoutAnchor.current = {
      rowId: anchor?.dataset.responseRowId ?? null,
      viewportOffset: anchor
        ? anchor.getBoundingClientRect().top - viewportTop
        : 0,
      wasFollowing,
    };
  };
  const previousEstimateLayout = useRef(estimateLayout);
  useLayoutEffect(() => {
    const previous = previousEstimateLayout.current;
    previousEstimateLayout.current = estimateLayout;
    if (
      !virtualized
      || (
        previous.availableWidth === estimateLayout.availableWidth
        && previous.interfaceScale === estimateLayout.interfaceScale
        && previous.responseDensity === estimateLayout.responseDensity
      )
    ) {
      pendingLayoutAnchor.current = null;
      return;
    }
    const scrollElement = props.scrollElementRef?.current;
    const root = props.timelineElementRef?.current;
    if (!scrollElement || !root) return;
    captureLayoutAnchorRef.current();
    const layoutAnchor = pendingLayoutAnchor.current;
    pendingLayoutAnchor.current = null;
    if (!layoutAnchor) return;
    const { rowId, viewportOffset, wasFollowing } = layoutAnchor;
    const anchorIndex = rowId === null
      ? -1
      : timeline.findIndex((item) => item.id === rowId);
    layoutAnchorActive.current = true;
    virtualizer.measure();

    let cancelled = false;
    let attempts = 0;
    let stableFrames = 0;
    const settleUntil = performance.now() + 2_000;
    const maximumSettleFrames = 360;
    const removeIntentListeners = (): void => {
      scrollElement.removeEventListener("wheel", cancelForUserIntent);
      scrollElement.removeEventListener("touchstart", cancelForUserIntent);
      scrollElement.removeEventListener("pointerdown", cancelForUserIntent);
      scrollElement.removeEventListener("keydown", cancelForUserIntent);
    };
    const finishRestoration = (): void => {
      if (cancelled) return;
      cancelled = true;
      layoutAnchorActive.current = false;
      removeIntentListeners();
    };
    const restore = (): void => {
      if (cancelled) return;
      if (wasFollowing) {
        scrollElement.scrollTo({ top: scrollElement.scrollHeight, behavior: "auto" });
        finishRestoration();
        return;
      }
      const row = rowId
        ? [...root.querySelectorAll<HTMLElement>("[data-response-row-id]")]
            .find((element) => element.dataset.responseRowId === rowId)
        : null;
      if (!row) {
        if (anchorIndex >= 0 && attempts % 4 === 0) {
          virtualizer.scrollToIndex(anchorIndex, { align: "start", behavior: "auto" });
        }
        attempts += 1;
        if (attempts < maximumSettleFrames) {
          window.requestAnimationFrame(restore);
        } else {
          finishRestoration();
        }
        return;
      }
      const currentOffset = row.getBoundingClientRect().top
        - scrollElement.getBoundingClientRect().top;
      const delta = currentOffset - viewportOffset;
      if (Math.abs(delta) >= 0.5) scrollElement.scrollTop += delta;
      stableFrames = Math.abs(delta) < 0.5 ? stableFrames + 1 : 0;
      attempts += 1;
      if (
        attempts < maximumSettleFrames
        && (performance.now() < settleUntil || stableFrames < 8)
      ) {
        window.requestAnimationFrame(restore);
      } else {
        finishRestoration();
      }
    };
    function cancelForUserIntent(): void {
      finishRestoration();
    }
    scrollElement.addEventListener("wheel", cancelForUserIntent, { passive: true });
    scrollElement.addEventListener("touchstart", cancelForUserIntent, { passive: true });
    scrollElement.addEventListener("pointerdown", cancelForUserIntent);
    scrollElement.addEventListener("keydown", cancelForUserIntent);
    const frame = window.requestAnimationFrame(restore);
    return () => {
      finishRestoration();
      window.cancelAnimationFrame(frame);
    };
  }, [
    estimateLayout,
    props.scrollElementRef,
    props.timelineElementRef,
    timeline,
    virtualized,
    virtualizer,
  ]);

  const captureExpansionAnchor = useCallback((sourceTurnId: string): void => {
    const scrollElement = props.scrollElementRef?.current;
    const root = props.timelineElementRef?.current;
    if (!scrollElement || !root) return;
    const viewportTop = scrollElement.getBoundingClientRect().top;
    const rows = [...root.querySelectorAll<HTMLElement>("[data-response-row-id]")];
    const sourceIndex = rows.findIndex((row) => row.dataset.responseRowId === sourceTurnId);
    const rowsAfterSource = sourceIndex >= 0 ? rows.slice(sourceIndex + 1) : rows;
    const anchor = rowsAfterSource.find((row) => row.getBoundingClientRect().top >= viewportTop + 8)
      ?? rowsAfterSource.find((row) => row.getBoundingClientRect().bottom > viewportTop + 8)
      ?? rows.find((row) => row.getBoundingClientRect().top >= viewportTop + 8)
      ?? rows.find((row) => row.getBoundingClientRect().bottom > viewportTop + 8);
    if (!anchor?.dataset.responseRowId) return;
    const source = sourceIndex >= 0 ? rows[sourceIndex] : undefined;
    const capturedAnchor: ExpansionAnchor = {
      sequence: nextExpansionAnchorSequence.current += 1,
      sourceTurnId,
      sourceHeight: source?.getBoundingClientRect().height ?? null,
      rowId: anchor.dataset.responseRowId,
      viewportOffset: anchor.getBoundingClientRect().top - viewportTop,
    };
    pendingAnchors.current.set(sourceTurnId, capturedAnchor);
    manuallyAdjustedRows.current.add(sourceTurnId);
  }, [props.scrollElementRef, props.timelineElementRef]);

  const restoreExpansionAnchor = useCallback((sourceTurnId: string): void => {
    const anchor = pendingAnchors.current.get(sourceTurnId);
    if (!anchor) return;
    if (activeAnchorRestorations.current.get(sourceTurnId) === anchor.sequence) return;
    const scrollElement = props.scrollElementRef?.current;
    const root = props.timelineElementRef?.current;
    if (!scrollElement || !root) return;
    activeAnchorRestorations.current.set(sourceTurnId, anchor.sequence);
    let sourceHeight = anchor.sourceHeight;
    const adjustToAnchor = (): number | null => {
      const rows = [...root.querySelectorAll<HTMLElement>("[data-response-row-id]")];
      const source = rows.find((element) => element.dataset.responseRowId === sourceTurnId);
      const row = rows
        .find((element) => element.dataset.responseRowId === anchor.rowId);
      if (!row) {
        if (source && sourceHeight !== null) {
          const currentSourceHeight = source.getBoundingClientRect().height;
          const sizeDelta = currentSourceHeight - sourceHeight;
          if (Math.abs(sizeDelta) >= 0.5) scrollElement.scrollTop += sizeDelta;
          sourceHeight = currentSourceHeight;
          return Math.abs(sizeDelta);
        }
        return null;
      }
      const currentOffset = row.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top;
      const delta = currentOffset - anchor.viewportOffset;
      if (Math.abs(delta) >= 0.5) scrollElement.scrollTop += delta;
      if (source) sourceHeight = source.getBoundingClientRect().height;
      return Math.abs(delta);
    };
    let stableFrames = 0;
    let sawAdjustment = false;
    const settle = (remainingFrames: number): void => {
      if (pendingAnchors.current.get(sourceTurnId) !== anchor) {
        if (activeAnchorRestorations.current.get(sourceTurnId) === anchor.sequence) {
          activeAnchorRestorations.current.delete(sourceTurnId);
        }
        return;
      }
      const adjustment = adjustToAnchor();
      if (adjustment !== null && adjustment >= 0.5) sawAdjustment = true;
      stableFrames = sawAdjustment && adjustment !== null && adjustment < 0.5
        ? stableFrames + 1
        : 0;
      if (remainingFrames > 0 && stableFrames < 2) {
        window.requestAnimationFrame(() => settle(remainingFrames - 1));
        return;
      }
      pendingAnchors.current.delete(sourceTurnId);
      activeAnchorRestorations.current.delete(sourceTurnId);
      manuallyAdjustedRows.current.delete(sourceTurnId);
    };
    settle(10);
  }, [props.scrollElementRef, props.timelineElementRef]);

  const virtualItems = virtualized ? virtualizer.getVirtualItems() : [];
  const activeIndex = virtualized
    ? virtualizer.range?.startIndex ?? virtualItems[0]?.index ?? 0
    : 0;
  const [virtualWindowElement, setVirtualWindowElement] = useState<HTMLDivElement | null>(null);
  const gutter = useTimelineGutter(
    props.scrollElementRef,
    virtualWindowElement,
    virtualized,
    props.conversationId,
  );
  const turnItems = useMemo(() => timeline.flatMap((item, timelineIndex) =>
    item.kind === "turn" ? [{ turn: item.turn, timelineIndex }] : []), [timeline]);
  const markers = useMemo<TimelineMarker[]>(() =>
    buildTimelineMinimapMarkers(turnItems.map(({ turn }) => turn)).map((marker) => ({
      ...marker,
      number: turnItems[marker.index]!.turn.index,
      timelineIndex: turnItems[marker.index]!.timelineIndex,
    })), [turnItems]);

  const focusTimelineItem = useCallback((
    index: number,
    target: TimelineJumpTarget,
  ): void => {
    if (timeline.length === 0) return;
    const boundedIndex = Math.max(0, Math.min(index, timeline.length - 1));
    const item = timeline[boundedIndex];
    if (!item) return;
    if (virtualized) {
      virtualizer.scrollToIndex(boundedIndex, {
        align: target === "turn" ? "center" : "start",
        behavior: "auto",
      });
    }

    let attempts = 0;
    const focus = (): void => {
      const root = props.timelineElementRef?.current;
      const row = item.kind === "turn"
        ? findTurnElement(root, item.turn.id)
        : root?.querySelector<HTMLElement>('[data-response-row-id="legacy-orphan-history"]') ?? null;
      if (!row && attempts < 8) {
        attempts += 1;
        window.requestAnimationFrame(focus);
        return;
      }
      if (!row) return;
      if (!virtualized) row.scrollIntoView({ block: target === "turn" ? "center" : "start" });
      const destination = target === "turn"
        ? row
        : row.querySelector<HTMLElement>(`[data-turn-jump-target="${target}"]`) ?? row;
      destination.focus({ preventScroll: true });
    };
    window.requestAnimationFrame(focus);
  }, [props.timelineElementRef, timeline, virtualized, virtualizer]);

  useEffect(() => {
    const scrollElement = props.scrollElementRef?.current;
    if (!scrollElement) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.matches("input, textarea, select")
        || target?.isContentEditable
      ) return;
      const current = virtualized
        ? virtualizer.getVirtualItemForOffset(scrollElement.scrollTop + 8)?.index ?? 0
        : currentPlainTimelineIndex(props.timelineElementRef?.current, scrollElement, timeline);
      const intent = resolveTimelineKeyboardIntent(event, current, timeline.length);
      if (!intent) return;
      event.preventDefault();
      focusTimelineItem(intent.index, intent.target);
    };
    scrollElement.addEventListener("keydown", onKeyDown);
    return () => scrollElement.removeEventListener("keydown", onKeyDown);
  }, [
    focusTimelineItem,
    props.scrollElementRef,
    props.timelineElementRef,
    timeline,
    virtualized,
    virtualizer,
  ]);

  const renderItem = (item: ResponseTimelineItem): React.JSX.Element => item.kind === "turn"
    ? (
      <TurnTimeline
        turn={item.turn}
        props={props}
        previousArtifactTurnId={previousComparableTurn.get(item.turn.id) ?? null}
        onBeforeToggle={captureExpansionAnchor}
        onAfterToggle={restoreExpansionAnchor}
      />
    )
    : <CompatibilityTimeline compatibility={item.compatibility} props={props} />;

  return (
    <>
      {shouldShowTimelineMinimap(timeline.length, gutter.available) && (
        <TimelineMinimap
          activeIndex={activeIndex}
          left={gutter.minimapLeft}
          markers={markers}
          onNavigate={focusTimelineItem}
        />
      )}
      {virtualized
        ? (
          <div
            ref={setVirtualWindowElement}
            className="response-virtual-window"
            role="feed"
            aria-label={`${timeline.length} conversation turns`}
            data-timeline-side-gutter={gutter.available}
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualItems.map((virtualItem) => {
              const item = timeline[virtualItem.index];
              if (!item) return null;
              return (
                <div
                  className="response-virtual-item"
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  {renderItem(item)}
                </div>
              );
            })}
          </div>
        )
        : timeline.map((item) => <div className="response-static-item" key={item.id}>{renderItem(item)}</div>)}
    </>
  );
}
