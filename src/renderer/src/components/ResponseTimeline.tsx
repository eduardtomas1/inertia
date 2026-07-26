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
  Clock3,
  Copy,
  ExternalLink,
  FileCode2,
  Files,
  GitCompareArrows,
  ListChecks,
  Paperclip,
  RotateCcw,
  Square,
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
  ProviderInfo,
} from "@shared/contracts";
import { formatClockTime } from "../lib/format";
import { finalAnswerIdentityLabel } from "../utils/finalAnswerIdentity";
import {
  activityNeedsAttention,
  buildTurnExecutionStream,
  buildResponseTimeline,
  buildTimelineMinimapMarkers,
  estimateTimelineRowSize,
  formatElapsed,
  resolveTimelineKeyboardIntent,
  shouldShowTimelineMinimap,
  shouldVirtualizeTimeline,
  stabilizeResponseTimeline,
  turnExecutionElapsedMs,
  turnQueueElapsedMs,
  turnStatusLabel,
  workSummaryLabel,
  type ResponseTimelineItem,
  type ResponseTimelineCompatibility,
  type ResponseTurn,
  type TurnExecutionStreamEntry,
  type TurnGitArtifactSummary,
} from "../utils/responseTimeline";
import { ApprovalCard, InputRequestCard } from "./AgentRequestCard";
import { ResponseMarkdown } from "./ResponseMarkdown";

export interface ResponseTimelineProps {
  turns: AgentTurn[];
  messages: ChatMessage[];
  activities: AgentActivity[];
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
      <span>{copied ? "Copied" : "Copy answer"}</span>
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

function ActivityRow({
  activity,
  visibility,
}: {
  activity: AgentActivity;
  visibility?: "recent" | "details" | "important";
}): React.JSX.Element {
  const Icon = activity.status === "failed" ? TriangleAlert : activity.status === "completed" ? CheckCircle2 : CircleDot;
  return (
    <div
      className={clsx("agent-activity", `is-${activity.status}`, activityNeedsAttention(activity) && "is-important")}
      data-activity-visibility={visibility}
    >
      <Icon size={14} aria-hidden="true" />
      <span>
        <span className="visually-hidden">{turnStatusLabel(activity.status === "running" ? "running" : activity.status)}: </span>
        <strong>{activity.title}</strong>
        {activity.detail && <small>{activity.detail}</small>}
      </span>
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

function ActivityGroup({
  entry,
  onBeforeToggle,
  onAfterToggle,
}: {
  entry: Extract<TurnExecutionStreamEntry, { kind: "activity-group" }>;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const latest = entry.activities.at(-1)!;
  const alwaysVisible = new Set(entry.activities
    .filter((activity) =>
      activity.id === latest.id
      || activityNeedsAttention(activity))
    .map(({ id }) => id));
  const hiddenCount = entry.activities.filter(({ id }) => !alwaysVisible.has(id)).length;
  const visibleActivities = expanded
    ? entry.activities
    : entry.activities.filter(({ id }) => alwaysVisible.has(id));
  const toggle = (): void => {
    onBeforeToggle?.();
    setExpanded((current) => !current);
    window.requestAnimationFrame(() => onAfterToggle?.());
  };
  return (
    <div className="turn-activity-group" data-activity-group={entry.id}>
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
              ? "Show fewer calls"
              : `${hiddenCount} earlier ${hiddenCount === 1 ? "call" : "calls"}`}
          </span>
        </button>
      )}
      {visibleActivities.map((activity) => (
        <ActivityRow
          activity={activity}
          visibility={activityNeedsAttention(activity) ? "important" : "recent"}
          key={activity.id}
        />
      ))}
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
      {entries.map((entry) => entry.kind === "commentary"
        ? (
            <div role="listitem" key={entry.id}>
              <CommentaryRow
                entry={entry}
                projectRoot={projectRoot}
                projectId={projectId}
                conversationId={conversationId}
                defaultCodeWrap={defaultCodeWrap}
              />
            </div>
          )
        : (
            <div role="listitem" key={entry.id}>
              <ActivityGroup
                entry={entry}
                onBeforeToggle={onBeforeToggle}
                onAfterToggle={onAfterToggle}
              />
            </div>
          ))}
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
  const anchorToggleHandlers = useAnchoredDetailsToggle(onBeforeToggle, onAfterToggle);
  const detailsId = `turn-work-details-${turn.id}`;
  useEffect(() => setExpanded(!autoCollapse), [autoCollapse]);

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
    <div className="turn-work-log is-settled" data-settled-work-status={status}>
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
          <div className="turn-work-details" id={detailsId}>
            <ExecutionStream
              entries={stream}
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
            {supplementalActivities.map((activity) => <ActivityRow activity={activity} key={activity.id} />)}
          </div>
        </details>
      )}
      {!hasFoldableDetails && (
        <div className="turn-settled-summary" data-settled-work-summary="static">
          {summaryContent}
        </div>
      )}
      {turn.importantActivities.map((activity) => <ActivityRow activity={activity} key={activity.id} />)}
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
        <span><strong>Changed by this turn</strong><small>Capturing the historical Git state…</small></span>
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
  const patchAvailable = artifact.patchState === "available" || artifact.patchState === "truncated";
  const completenessWarning = artifact.failureReason
    ?? (artifact.completeness === "truncated"
      ? "The complete file summary is retained, but the stored patch was truncated."
      : artifact.completeness === "partial"
        ? "Only a partial historical Git capture is available for this turn."
        : artifact.patchState === "expired"
          ? "The stored patch has expired; the historical file summary is still available."
          : artifact.patchState === "failed"
            ? "The historical file summary is available, but its stored patch could not be read."
            : artifact.patchState === "none"
              ? "The historical file summary is available without a stored patch."
              : null);
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
            {artifact.completeness !== "complete" && " · incomplete"}
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

const EXPECTED_NON_GIT_ARTIFACT_FAILURES = new Set([
  "This workspace is not a Git repository.",
  "The selected folder is not a Git repository.",
]);

function shouldShowChangedFilesSummary(artifact: TurnGitArtifactSummary): boolean {
  return !(
    artifact.status === "unavailable"
    && artifact.completeness === "unavailable"
    && EXPECTED_NON_GIT_ARTIFACT_FAILURES.has(artifact.failureReason ?? "")
  );
}

function defaultTurnDurationLabel(turn: ResponseTurn): string {
  const execution = turnExecutionElapsedMs(turn);
  if (execution === null) {
    return turn.isActive
      ? `Queued ${formatElapsed(turnQueueElapsedMs(turn))}`
      : "Not started";
  }
  const duration = formatElapsed(execution);
  if (turn.isActive) return `Working ${duration}`;
  if (turn.agentTurn.status === "completed") return `Worked ${duration}`;
  return `Ran ${duration}`;
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
  onBeforeToggle,
  onAfterToggle,
}: {
  turn: ResponseTurn;
  terminalAnswer: ChatMessage | null;
  showTimestamp: boolean;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}): React.JSX.Element {
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const { agentTurn } = turn;
  const selection = agentTurn.modelSelection;
  const queueDuration = formatElapsed(turnQueueElapsedMs(turn));
  const execution = turnExecutionElapsedMs(turn);
  const detailsId = `turn-run-details-${turn.id}`;
  const toggleDetails = (): void => {
    onBeforeToggle?.();
    setDetailsExpanded((current) => !current);
    window.requestAnimationFrame(() => onAfterToggle?.());
  };
  return (
    <footer className="turn-meta" aria-label="Final answer actions and run metadata">
      <div className="turn-meta-primary">
        {terminalAnswer && (
          <CopyAnswerButton content={terminalAnswer.content} ariaLabel="Copy final answer" />
        )}
        {showTimestamp && terminalAnswer && (
          <time dateTime={terminalAnswer.createdAt}>{formatClockTime(terminalAnswer.createdAt)}</time>
        )}
        <span data-turn-status={agentTurn.status}>{turnStatusLabel(agentTurn.status)}</span>
        <span className="turn-duration">{defaultTurnDurationLabel(turn)}</span>
        <button
          type="button"
          className="turn-run-details-toggle"
          aria-expanded={detailsExpanded}
          aria-controls={detailsId}
          onClick={toggleDetails}
        >
          <span>Run details</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      </div>
      <dl className="turn-run-details" id={detailsId} hidden={!detailsExpanded}>
        <div><dt>Harness ID</dt><dd><code>{selection.harnessId}</code></dd></div>
        <div><dt>Backend profile ID</dt><dd><code>{selection.backendProfileId}</code></dd></div>
        <div><dt>Exact model ID</dt><dd><code>{selection.modelId}</code></dd></div>
        <div><dt>Reasoning level</dt><dd><code>{selection.reasoningEffort ?? "(default)"}</code></dd></div>
        <div><dt>Mode</dt><dd><code>{agentTurn.interactionMode}</code></dd></div>
        <div><dt>Access</dt><dd><code>{agentTurn.accessMode}</code></dd></div>
        <div><dt>Queue duration</dt><dd>{queueDuration}</dd></div>
        <div><dt>Execution duration</dt><dd>{execution === null ? "Not started" : formatElapsed(execution)}</dd></div>
        <div><dt>Historical association</dt><dd>{agentTurn.association === "authoritative" ? "Authoritative" : "Inferred"}</dd></div>
        <div><dt>Artifact completeness</dt><dd>{artifactCompletenessLabel(turn.gitArtifact)}</dd></div>
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
        <div className="message-attachments turn-user-request-attachments" aria-label="Request attachments">
          {turn.userMessage.attachments.map((attachment) => (
            <span key={attachment.id}>
              <Paperclip size={12} aria-hidden="true" />
              <span>Image · {attachment.name}</span>
            </span>
          ))}
        </div>
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
      className="agent-run-flow turn-agent-execution"
      aria-label={`${providerLabel} activity`}
      data-turn-layer="agent-execution"
    >
      {turn.isActive ? (
        <div className="turn-execution-rail is-live">
          <header className="turn-working-state">
            <span className="turn-working-status" role="status" aria-live="polite" aria-atomic="true">
              <span className="turn-working-pulse"><CircleDot size={14} aria-hidden="true" /></span>
              <strong>{statusLabel}</strong>
            </span>
            <span className="turn-working-elapsed" aria-live="off">
              <span className="turn-working-separator" aria-hidden="true">·</span>
              <Clock3 size={12} aria-hidden="true" />
              <LiveElapsed startedAt={timerStart} />
            </span>
            <button
              type="button"
              className="turn-stop-action"
              aria-label={`Stop ${providerLabel} run`}
              onClick={props.onStop}
            >
              <Square size={11} fill="currentColor" aria-hidden="true" />
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
      ) : (
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
      )}
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
  liveContent: string,
  retainedLiveContent: string,
): FinalAnswerPresentation | null {
  const terminalAnswer = turn.terminalAssistantMessage;
  if (terminalAnswer) {
    if (!terminalAnswer.content) return null;
    return {
      content: terminalAnswer.content,
      phase: "persisted",
      markdownStreaming: false,
      showCaret: false,
      terminalAnswer,
    };
  }

  if (turn.isActive) return null;
  const content = liveContent || retainedLiveContent;
  if (!content) return null;
  return {
    content,
    phase: "settling",
    markdownStreaming: true,
    showCaret: false,
    terminalAnswer: null,
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
      <header className="final-answer-identity">
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
  const providerLabel = props.providers.find(({ id }) => id === turn.agentTurn.providerId)?.label
    ?? turn.agentTurn.providerId;
  const timerStart = turn.startedAt ?? turn.requestedAt;
  const wasActive = useRef(turn.isActive);
  const [completionAnnouncement, setCompletionAnnouncement] = useState("");
  const renderedAnswerWhileActive = useRef(
    turn.isActive && Boolean(turn.terminalAssistantMessage?.content),
  );
  const [settlingTransition, setSettlingTransition] = useState<{
    revealAnswer: boolean;
  } | null>(null);
  if (turn.isActive && turn.terminalAssistantMessage?.content) {
    renderedAnswerWhileActive.current = true;
  }
  const isSettling = settlingTransition !== null;
  const isRevealingSettledAnswer = settlingTransition?.revealAnswer ?? false;

  useLayoutEffect(() => {
    const announcement = turnCompletionAnnouncement(wasActive.current, turn, providerLabel);
    if (announcement) {
      setCompletionAnnouncement(announcement);
      setSettlingTransition({
        revealAnswer: !renderedAnswerWhileActive.current,
      });
    }
    wasActive.current = turn.isActive;
  }, [
    providerLabel,
    turn,
    turn.isActive,
  ]);
  useEffect(() => {
    if (!settlingTransition) return;
    const timer = window.setTimeout(() => setSettlingTransition(null), 220);
    return () => window.clearTimeout(timer);
  }, [settlingTransition]);

  return (
    <section
      className={clsx(
        "response-turn",
        turn.isActive && "is-active",
        isSettling && "is-settling",
        isRevealingSettledAnswer && "is-revealing-settled-answer",
      )}
      aria-label={`Turn ${turn.index}`}
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

      {turn.systemMessages.map((message) => (
        <article
          className="message is-system"
          aria-label="Agent system notice"
          data-turn-work-notice=""
          key={message.id}
        >
          <div className="message-meta"><span>System</span>{props.showTimestamps && <time dateTime={message.createdAt}>{formatClockTime(message.createdAt)}</time>}</div>
          <div className="message-body">{message.content}</div>
        </article>
      ))}

      <FinalAnswerDocument
        turn={turn}
        props={props}
        liveContent={liveContent}
      />

      {turn.terminalAssistantMessage && (
        <TurnMetadata
          turn={turn}
          terminalAnswer={turn.terminalAssistantMessage}
          showTimestamp={props.showTimestamps}
          onBeforeToggle={() => onBeforeToggle?.(turn.id)}
          onAfterToggle={() => onAfterToggle?.(turn.id)}
        />
      )}
      {props.showChangedFileSummaries
        && turn.gitArtifact
        && shouldShowChangedFilesSummary(turn.gitArtifact) && (
          <ChangedFilesSummary
            artifact={turn.gitArtifact}
            previousTurnId={previousArtifactTurnId}
            props={props}
            onBeforeToggle={() => onBeforeToggle?.(turn.id)}
            onAfterToggle={() => onAfterToggle?.(turn.id)}
          />
        )}
    </section>
  );
}

function sameTurnTimelineProps(
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
    && left.providers === right.providers
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
  const getItemKey = useCallback(
    (index: number) => timeline[index]?.id ?? `missing-${index}`,
    [timeline],
  );
  const estimateSize = useCallback((index: number) => {
    const item = timeline[index];
    if (!item) return 280;
    const artifact = item.kind === "turn" ? item.turn.gitArtifact : null;
    return estimateTimelineRowSize(item, {
      availableWidth: props.scrollElementRef?.current?.clientWidth,
      workDetailsExpanded: !props.autoCollapseWorkLog,
      showThinking: props.showThinking,
      showChangedFiles: props.showChangedFileSummaries
        && artifact !== null
        && shouldShowChangedFilesSummary(artifact),
    });
  }, [
    props.autoCollapseWorkLog,
    props.scrollElementRef,
    props.showChangedFileSummaries,
    props.showThinking,
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
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    !manuallyAdjustedRows.current.has(String(item.key))
    && item.start < (instance.scrollOffset ?? 0) + 1;

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
    const settle = (remainingFrames: number): void => {
      if (pendingAnchors.current.get(sourceTurnId) !== anchor) {
        if (activeAnchorRestorations.current.get(sourceTurnId) === anchor.sequence) {
          activeAnchorRestorations.current.delete(sourceTurnId);
        }
        return;
      }
      const adjustment = adjustToAnchor();
      stableFrames = adjustment !== null && adjustment < 0.5 ? stableFrames + 1 : 0;
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
