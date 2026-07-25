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
import {
  isKimiThroughClaudeSelection,
  modelSelectionIdentityLabel,
} from "../../../shared/claude-backend-profiles";
import { formatClockTime } from "../lib/format";
import {
  buildResponseTimeline,
  buildTimelineMinimapMarkers,
  estimateTimelineRowSize,
  formatElapsed,
  resolveTimelineKeyboardIntent,
  shouldShowTimelineMinimap,
  shouldVirtualizeTimeline,
  stabilizeResponseTimeline,
  turnStatusLabel,
  turnTimingLabels,
  workSummaryLabel,
  type ResponseTimelineItem,
  type ResponseTimelineCompatibility,
  type ResponseTurn,
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

function CopyAnswerButton({ content }: { content: string }): React.JSX.Element {
  const [copied, copy] = useCopyAction();
  return (
    <button type="button" className="turn-action" title="Copy answer" onClick={() => void copy(content)}>
      {copied ? <Check size={12} /> : <Copy size={12} />}
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

function ActivityRow({ activity }: { activity: AgentActivity }): React.JSX.Element {
  const Icon = activity.status === "failed" ? TriangleAlert : activity.status === "completed" ? CheckCircle2 : CircleDot;
  return (
    <div className={clsx("agent-activity", `is-${activity.status}`, activity.kind === "error" && "is-important")}>
      <Icon size={14} aria-hidden="true" />
      <span><strong>{activity.title}</strong>{activity.detail && <small>{activity.detail}</small>}</span>
    </div>
  );
}

function LiveReasoning({ content }: { content: string }): React.JSX.Element {
  return (
    <details className="thinking-summary is-live" open>
      <summary><BrainCircuit size={14} aria-hidden="true" /><span>Reasoning summary</span><small>Live</small></summary>
      <div>{content}<span className="streaming-caret" aria-hidden="true" /></div>
    </details>
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

function CommentaryDetail({
  message,
  projectRoot,
  projectId,
  conversationId,
  defaultCodeWrap,
}: {
  message: ChatMessage;
  projectRoot: string;
  projectId: string;
  conversationId: string;
  defaultCodeWrap: boolean;
}): React.JSX.Element {
  return (
    <div className="turn-reasoning-detail" data-assistant-commentary-id={message.id}>
      <span>Commentary</span>
      <ResponseMarkdown
        content={message.content}
        projectRoot={projectRoot}
        projectId={projectId}
        conversationId={conversationId}
        defaultCodeWrap={defaultCodeWrap}
      />
      <CopyAnswerButton content={message.content} />
    </div>
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

function WorkLog({
  turn,
  autoCollapse,
  reasoningContent,
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
  useEffect(() => setExpanded(!autoCollapse), [autoCollapse]);
  if (turn.isActive) {
    if (turn.activities.length === 0 && turn.plans.length === 0) return null;
    return (
      <div className="turn-work-log is-live">
        {turn.plans.map((plan) => <PlanDetail key={`${plan.runId}:${plan.turnId ?? "legacy"}`} plan={plan} />)}
        {turn.activities.map((activity) => <ActivityRow activity={activity} key={activity.id} />)}
      </div>
    );
  }

  const includesReasoning = showThinking && Boolean(reasoningContent);
  const hasFoldableDetails = includesReasoning
    || turn.foldableActivities.length > 0
    || turn.commentaryMessages.length > 0
    || turn.plans.length > 0;
  if (!hasFoldableDetails && turn.importantActivities.length === 0) return null;

  return (
    <div className="turn-work-log is-settled">
      {hasFoldableDetails && (
        <details
          open={expanded}
          onToggle={(event) => {
            setExpanded(event.currentTarget.open);
          }}
        >
          <summary {...anchorToggleHandlers}>
            {turn.agentTurn.status === "failed"
              ? <TriangleAlert size={14} aria-hidden="true" />
              : turn.agentTurn.status === "cancelled" || turn.agentTurn.status === "interrupted"
                ? <CircleDot size={14} aria-hidden="true" />
                : <CheckCircle2 size={14} aria-hidden="true" />}
            <span>{workSummaryLabel(turn)}</span>
            <small>{expanded ? "Hide" : "Details"}</small>
            <ChevronDown size={13} className="turn-work-chevron" aria-hidden="true" />
          </summary>
          <div className="turn-work-details">
            {includesReasoning && (
              <div className="turn-reasoning-detail">
                <span><BrainCircuit size={13} aria-hidden="true" />Reasoning summary</span>
                <p>{reasoningContent}</p>
              </div>
            )}
            {turn.plans.map((plan) => <PlanDetail key={`${plan.runId}:${plan.turnId ?? "legacy"}`} plan={plan} />)}
            {turn.commentaryMessages.map((message) => (
              <CommentaryDetail
                key={message.id}
                message={message}
                projectRoot={projectRoot}
                projectId={projectId}
                conversationId={conversationId}
                defaultCodeWrap={defaultCodeWrap}
              />
            ))}
            {turn.foldableActivities.map((activity) => <ActivityRow activity={activity} key={activity.id} />)}
          </div>
        </details>
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
  const anchorToggleHandlers = useAnchoredDetailsToggle(onBeforeToggle, onAfterToggle);
  if (artifact.status === "pending") {
    return (
      <div
        className="turn-changed-files is-pending"
        data-turn-git-artifact-id={artifact.id}
        data-turn-jump-target="artifact"
        tabIndex={-1}
      >
        <Files size={14} />
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
        <TriangleAlert size={14} />
        <span>
          <strong>Turn changes unavailable</strong>
          <small>{artifact.failureReason ?? "No authoritative Git snapshot was captured for this turn."}</small>
        </span>
      </div>
    );
  }
  const patchAvailable = artifact.patchState === "available" || artifact.patchState === "truncated";
  const scopes = [...artifact.files.reduce((result, file) => {
    const [first, second] = file.path.split("/");
    const scope = second ? first! : "root";
    result.set(scope, (result.get(scope) ?? 0) + 1);
    return result;
  }, new Map<string, number>())].sort(([left], [right]) => left.localeCompare(right));
  return (
    <details
      className="turn-changed-files"
      data-turn-git-artifact-id={artifact.id}
      data-turn-jump-target="artifact"
      tabIndex={-1}
    >
      <summary {...anchorToggleHandlers}>
        <Files size={14} />
        <span>
          <strong>Changed by this turn</strong>
          <small>
            {artifact.files.length} {artifact.files.length === 1 ? "file" : "files"}
            {artifact.insertions > 0 && ` · +${artifact.insertions}`}
            {artifact.deletions > 0 && ` · −${artifact.deletions}`}
            {artifact.branch && ` · ${artifact.branch}`}
            {artifact.completeness !== "complete" && " · partial capture"}
          </small>
        </span>
      </summary>
      <div>
        {scopes.length > 0 && (
          <p className="turn-changed-file-scopes">
            {scopes.slice(0, 6).map(([scope, count]) => `${scope} · ${count}`).join("   ")}
          </p>
        )}
        {artifact.files.slice(0, 12).map((file) => (
          <span key={file.path} title={file.path}>
            <button
              type="button"
              disabled={!patchAvailable}
              title={patchAvailable ? `Open this turn's diff for ${file.path}` : "The stored patch is unavailable"}
              onClick={() => props.onOpenTurnDiff(artifact.turnId, file.path)}
            >
              <FileCode2 size={13} />
              <code>{file.path}</code>
              <small>{file.status} · +{file.insertions} −{file.deletions}</small>
            </button>
            <button type="button" title={`Open ${file.path}`} onClick={() => props.onOpenTurnFile(file.path)}>
              <ExternalLink size={12} />
            </button>
          </span>
        ))}
        {artifact.files.length > 12 && <p>And {artifact.files.length - 12} more.</p>}
        <div className="turn-changed-files-actions">
          <button type="button" disabled={!patchAvailable} onClick={() => props.onOpenTurnDiff(artifact.turnId)}>
            <GitCompareArrows size={12} />Open exact turn diff
          </button>
          {previousTurnId && (
            <button type="button" onClick={() => props.onCompareTurnArtifacts(previousTurnId, artifact.turnId)}>
              <GitCompareArrows size={12} />Compare with previous turn
            </button>
          )}
        </div>
      </div>
    </details>
  );
}

function exactConfigurationLabel(turn: ResponseTurn): string {
  const { agentTurn } = turn;
  return [
    modelSelectionIdentityLabel(agentTurn.modelSelection),
    `Provider ${agentTurn.providerId}`,
    `Harness ${agentTurn.harnessId}`,
    `Backend ${agentTurn.backendProfileId}`,
    `Model ${agentTurn.model}`,
    ...(agentTurn.modelAlias === null ? [] : [`Requested ${agentTurn.modelAlias}`]),
    `Reasoning ${agentTurn.reasoningEffort || "default"}`,
    `Mode ${agentTurn.interactionMode}`,
    `Access ${agentTurn.accessMode}`,
  ].join(" · ");
}

function TurnMetadata({
  turn,
  terminalAnswer,
}: {
  turn: ResponseTurn;
  terminalAnswer: ChatMessage | null;
}): React.JSX.Element {
  const { agentTurn } = turn;
  return (
    <footer className="turn-meta" aria-label="Historical turn details">
      <span data-turn-status={agentTurn.status}>{turnStatusLabel(agentTurn.status)}</span>
      <span>{turnTimingLabels(turn).join(" · ")}</span>
      <details className="turn-configuration" title={exactConfigurationLabel(turn)}>
        <summary>{modelSelectionIdentityLabel(agentTurn.modelSelection)}</summary>
        <div>
          <span><strong>Provider</strong><code>{agentTurn.providerId}</code></span>
          <span><strong>Harness</strong><code>{agentTurn.harnessId}</code></span>
          <span><strong>Backend</strong><code>{agentTurn.backendProfileId}</code></span>
          <span><strong>Model</strong><code>{agentTurn.model}</code></span>
          {agentTurn.modelAlias !== null && <span><strong>Requested model</strong><code>{agentTurn.modelAlias}</code></span>}
          <span><strong>Reasoning</strong><code>{agentTurn.reasoningEffort || "(default)"}</code></span>
          <span><strong>Mode</strong><code>{agentTurn.interactionMode}</code></span>
          <span><strong>Access</strong><code>{agentTurn.accessMode}</code></span>
        </div>
      </details>
      {agentTurn.association === "inferred" && <span>Recovered legacy metadata</span>}
      {terminalAnswer && <CopyAnswerButton content={terminalAnswer.content} />}
    </footer>
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
  const persistedLast = turn.assistantMessages.at(-1);
  const liveContent = turn.isActive ? props.streamingText || persistedLast?.content || "" : "";
  const reasoningContent = turn.isActive
    ? props.streamingReasoning || turn.reasoning?.content || ""
    : turn.reasoning?.content || "";
  const providerLabel = isKimiThroughClaudeSelection(turn.agentTurn.modelSelection)
    ? modelSelectionIdentityLabel(turn.agentTurn.modelSelection)
    : props.providers.find(({ id }) => id === turn.agentTurn.providerId)?.label
      ?? turn.agentTurn.providerId;
  const hasRunFlow = turn.isActive
    || turn.activities.length > 0
    || turn.commentaryMessages.length > 0
    || turn.plans.length > 0
    || (props.showThinking && Boolean(reasoningContent))
    || turn.approvals.length > 0
    || turn.inputRequests.length > 0;
  const timerStart = turn.startedAt ?? turn.requestedAt;

  return (
    <section
      className={clsx("response-turn", turn.isActive && "is-active")}
      aria-label={`Turn ${turn.index}`}
      data-response-row-id={turn.id}
      data-turn-id={turn.id}
      data-turn-association={turn.agentTurn.association}
      data-turn-git-artifact-slot={turn.id}
      tabIndex={-1}
    >
      <article
        className="message is-user"
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
          <div className="message-attachments">
            {turn.userMessage.attachments.map((attachment) => <span key={attachment.id}><Paperclip size={12} />{attachment.name}</span>)}
          </div>
        )}
      </article>

      {hasRunFlow && (
        <section className="agent-run-flow" aria-label={`${providerLabel} activity`}>
          {turn.isActive && (
            <header className="turn-working-state">
              <span className="turn-working-pulse"><CircleDot size={14} aria-hidden="true" /></span>
              <strong>{turn.agentTurn.status === "queued" ? `${providerLabel} queued` : `${providerLabel} working`}</strong>
              <span aria-live="off"><Clock3 size={12} aria-hidden="true" /><LiveElapsed startedAt={timerStart} /></span>
            </header>
          )}
          {turn.isActive && props.showThinking && reasoningContent && <LiveReasoning content={reasoningContent} />}
          <WorkLog
            turn={turn}
            autoCollapse={props.autoCollapseWorkLog}
            reasoningContent={reasoningContent}
            showThinking={props.showThinking}
            projectRoot={props.projectRoot}
            projectId={props.projectId}
            conversationId={props.conversationId}
            defaultCodeWrap={props.defaultCodeWrap}
            onBeforeToggle={() => onBeforeToggle?.(turn.id)}
            onAfterToggle={() => onAfterToggle?.(turn.id)}
          />
          {turn.approvals.map((request) => <ApprovalCard key={request.id} request={request} onRespond={props.onRespondToApproval} />)}
          {turn.inputRequests.map((request) => <InputRequestCard key={request.id} request={request} onRespond={props.onRespondToInput} />)}
        </section>
      )}

      {turn.systemMessages.map((message) => (
        <article className="message is-system" key={message.id}>
          <div className="message-meta"><span>System</span>{props.showTimestamps && <time dateTime={message.createdAt}>{formatClockTime(message.createdAt)}</time>}</div>
          <div className="message-body">{message.content}</div>
        </article>
      ))}

      {turn.terminalAssistantMessage && (
        <article
          className="message is-assistant is-final-answer"
          data-terminal-answer-id={turn.terminalAssistantMessage.id}
          data-turn-jump-target="final"
          tabIndex={-1}
        >
          <div className="message-meta"><span>{providerLabel}</span>{props.showTimestamps && <time dateTime={turn.terminalAssistantMessage.createdAt}>{formatClockTime(turn.terminalAssistantMessage.createdAt)}</time>}</div>
          <ResponseMarkdown
            content={turn.terminalAssistantMessage.content}
            projectRoot={props.projectRoot}
            projectId={props.projectId}
            conversationId={props.conversationId}
            defaultCodeWrap={props.defaultCodeWrap}
          />
        </article>
      )}

      {turn.isActive && liveContent && (
        <article className="message is-assistant is-streaming" aria-label="Streaming assistant answer">
          <div className="message-meta"><span>{providerLabel}</span><span className="live-label">Live</span></div>
          <ResponseMarkdown
            content={liveContent}
            projectRoot={props.projectRoot}
            projectId={props.projectId}
            conversationId={props.conversationId}
            defaultCodeWrap={props.defaultCodeWrap}
            streaming
          />
          <span className="streaming-caret" aria-hidden="true" />
        </article>
      )}

      <TurnMetadata turn={turn} terminalAnswer={turn.terminalAssistantMessage} />
      {props.showChangedFileSummaries && turn.gitArtifact && (
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
    let previous: TurnGitArtifactSummary | null = null;
    for (const item of timeline) {
      if (item.kind !== "turn") continue;
      const artifact = item.turn.gitArtifact;
      if (
        !artifact
        || artifact.status === "pending"
        || artifact.repositoryIdentity === null
        || artifact.worktreeIdentity === null
      ) continue;
      if (
        previous
        && previous.repositoryIdentity === artifact.repositoryIdentity
        && previous.worktreeIdentity === artifact.worktreeIdentity
      ) result.set(artifact.turnId, previous.turnId);
      previous = artifact;
    }
    return result;
  }, [timeline]);
  const virtualized = shouldVirtualizeTimeline(timeline.length);
  const getItemKey = useCallback(
    (index: number) => timeline[index]?.id ?? `missing-${index}`,
    [timeline],
  );
  const estimateSize = useCallback(
    (index: number) => timeline[index] ? estimateTimelineRowSize(timeline[index]) : 320,
    [timeline],
  );
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
