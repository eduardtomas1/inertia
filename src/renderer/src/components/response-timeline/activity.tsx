import {
  Fragment,
  memo,
  lazy,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock,
  Code2,
  FileText,
  Search,
  Terminal,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import "./ActivityGroup.css";
import { PlanDetail } from "./PlanDetail";
import { markTestStreamingStage } from "../../utils/testStreamingTrace";
import { useDocumentVisibility } from "../../hooks/useDocumentPresence";
import { usePhaseLockedAnimations } from "../../hooks/usePhaseLockedAnimations";
import clsx from "clsx";
import type {
  AgentActivity,
  AgentTurn,
} from "@shared/contracts";
import {
  activityAttentionSeverity,
  activityCommandLine,
  activityDetailPresentation,
  activityExecutionCategory,
  activityNeedsAttention,
  activitySummarySentence,
  activitySummarySentenceLabel,
  activityWorkKind,
  buildTurnExecutionStream,
  formatElapsed,
  hostToolActivityTitle,
  isInterruptedActivity,
  needsStaticFoldRow,
  resolveActivityGroupWindow,
  summarizeActivities,
  turnStatusLabel,
  workStatusLabel,
  workSummaryLabel,
  type ActivityAttentionSeverity,
  type ActivityWorkKind,
  type ResponseTurn,
  type TurnExecutionStreamEntry,
} from "../../utils/responseTimeline";
import {
  withHtmlRenders,
  withLiveCommentary,
  type TurnWorkStreamEntry,
} from "../../utils/response-timeline/execution";
import { layeredHtmlRenders } from "../../utils/response-timeline/model";
import { ResponseMarkdown } from "../ResponseMarkdown";
import { Tooltip, useTooltip } from "../Tooltip";
import { LoadingMark } from "../ui";
import { WorkingOrb } from "../working-indicator/WorkingOrb";
import { useWorkingIndicator } from "../working-indicator/WorkingIndicatorContext";
import {
  orbMotionForActivity,
  resolveOrbMotion,
  usesActivityOrbs,
} from "../working-indicator/orbMotion";
import { messageContextMenu } from "./messageContextMenu";
import { SentMessageAttachmentList } from "../SentMessageAttachmentList";
import { MessageOrigin } from "./MessageOrigin";
import { WATCHER_NOTE_TITLE } from "../../utils/watcherLinks";
import { ContextCompactionActivityMarker } from "./ContextCompactionRow";
import { stabilizeTurnExecutionStream } from "./execution-stream";
import { HtmlRenderFrame } from "./html-render";
import { StreamingMarkdownText } from "./StreamingMarkdownText";
import {
  ReasoningSummary,
  useReadableThinkingLine,
  useReasoningSpan,
  type ReasoningSpan,
  type ThinkingLineView,
} from "./thinking";
import { TurnBlockTime, TurnFoldRow, type TurnFoldControl } from "./TurnFold";

export { ReasoningSummary } from "./thinking";

const FailureDiagnostics = lazy(() => import("./failurePanel"));

export function LiveElapsed({
  startedAt,
  excludedMs = 0,
}: {
  startedAt: string;
  excludedMs?: number;
}): React.JSX.Element {
  const elapsedRef = useRef<HTMLSpanElement>(null);
  const documentVisible = useDocumentVisibility();
  useEffect(() => {
    if (!documentVisible) return;
    const started = Date.parse(startedAt);
    const write = (): void => {
      const element = elapsedRef.current;
      if (element) {
        element.textContent = formatElapsed(Math.max(0, Date.now() - started - excludedMs), true);
      }
    };
    write();
    const timer = window.setInterval(write, 1_000);
    return () => window.clearInterval(timer);
  }, [documentVisible, excludedMs, startedAt]);
  return (
    <span ref={elapsedRef}>
      {formatElapsed(Math.max(0, Date.now() - Date.parse(startedAt) - excludedMs), true)}
    </span>
  );
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

const WORK_KIND_ICONS: Record<ActivityWorkKind, typeof Terminal> = {
  command: Terminal,
  read: FileText,
  search: Search,
  edit: Code2,
  tool: Wrench,
  event: CircleDot,
};

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
  const outputId = useId();
  const rowRef = useRef<HTMLDivElement>(null);
  const tooltip = useTooltip(rowRef, {});
  const anchorToggleHandlers = useAnchoredDetailsToggle(onBeforeToggle, onAfterToggle);
  const interrupted = isInterruptedActivity(activity);
  const attentionSeverity = activityAttentionSeverity(activity);
  const needsAttention = attentionSeverity !== null;
  const severity: ActivityLineSeverity = attentionSeverity ?? "neutral";
  const detailPresentation = activityDetailPresentation(activity);
  const executionCategory = activityExecutionCategory(activity);
  const workKind = activityWorkKind(activity);
  const commandLine = activityCommandLine(activity);
  const showDisclosure = Boolean(
    detailPresentation.full
    && (detailPresentation.expandable || needsAttention),
  );
  const showInlineDetail = Boolean(
    detailPresentation.full && !showDisclosure && !needsAttention,
  );
  const Icon = severity !== "neutral" ? TriangleAlert : WORK_KIND_ICONS[workKind];
  const indicator = useWorkingIndicator();
  const runningOrb = activity.status === "running"
    && severity === "neutral"
    && usesActivityOrbs(indicator)
    ? resolveOrbMotion(indicator, orbMotionForActivity(activity, executionCategory))
    : null;
  const readableTitle = hostToolActivityTitle(activity) ?? activity.title;
  const { leadingTarget, verb, trailingTarget } = commandLine
    ? { leadingTarget: "", verb: commandLine.verb, trailingTarget: commandLine.target }
    : splitActivityTitle(readableTitle, severity);
  const visibleTitle = commandLine
    ? `${commandLine.verb} ${commandLine.target}`
    : readableTitle;
  const spokenState = interrupted
    ? "Interrupted"
    : severity === "failure"
      ? "Failed"
      : severity === "warning"
        ? "Warning"
        : turnStatusLabel(activity.status);
  const visibleState = attentionSeverity
    && !activityTitleConveysSeverity(visibleTitle, attentionSeverity)
    ? spokenState
    : null;
  const disclosureLabel = activity.kind === "error" || interrupted
    ? "Details"
    : "Output";
  return (
    <div
      className={clsx(
        "agent-activity",
        `is-${activity.status}`,
        needsAttention && "is-important",
        showDisclosure && "has-technical-detail",
        detailExpanded && "is-detail-open",
      )}
      data-activity-kind={activity.kind}
      data-activity-category={executionCategory}
      data-activity-work={workKind}
      data-activity-severity={severity}
      data-activity-visibility={visibility}
      ref={rowRef}
      onPointerEnter={tooltip.handlers.onPointerEnter}
      onPointerLeave={tooltip.handlers.onPointerLeave}
      onPointerDown={tooltip.handlers.onPointerDown}
    >
      <span
        className="agent-activity-icon"
        aria-hidden="true"
        data-activity-indicator={runningOrb ? "orb" : undefined}
      >
        {runningOrb
          ? <WorkingOrb size={14} design={runningOrb.design} pace={runningOrb.pace} />
          : <Icon size={14} />}
      </span>
      <span className={clsx(
        "agent-activity-copy",
        showInlineDetail && "has-detail",
      )}>
        <span className="visually-hidden">{spokenState}: </span>
        <strong className="agent-activity-title">
          {leadingTarget && (
            <span className="agent-activity-target">{`${leadingTarget} `}</span>
          )}
          <span className="agent-activity-verb">{verb}</span>
          {trailingTarget && (
            <span className={clsx(
              "agent-activity-target",
              commandLine && "is-command",
            )}>
              {` ${trailingTarget}`}
            </span>
          )}
        </strong>
        {showInlineDetail && (
          <small className="agent-activity-detail">
            <span className="visually-hidden"> — </span>
            {detailPresentation.full}
          </small>
        )}
      </span>
      {visibleState && (
        <span className="agent-activity-state" aria-hidden="true">{visibleState}</span>
      )}
      {showDisclosure && (
        <button
          type="button"
          className="agent-activity-disclosure"
          aria-expanded={detailExpanded}
          aria-controls={detailExpanded ? outputId : undefined}
          aria-label={`${disclosureLabel}: ${visibleTitle}`}
          {...anchorToggleHandlers}
          onClick={() => {
            setDetailExpanded((current) => !current);
            anchorToggleHandlers.onClick();
          }}
        >
          <span>{disclosureLabel}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      )}
      {showDisclosure && detailExpanded && (
        <pre className="agent-activity-output" id={outputId}>
          {detailPresentation.full}
        </pre>
      )}
      {tooltip.layer && <Tooltip anchor={rowRef} layer={tooltip.layer} label={visibleTitle} />}
    </div>
  );
});

export const CommentaryRow = memo(function CommentaryRow({
  entry,
  projectRoot,
  projectId,
  conversationId,
  defaultCodeWrap,
  onOpenProjectFile,
  showTime = false,
}: {
  entry: Extract<TurnExecutionStreamEntry, { kind: "commentary" }>;
  projectRoot: string;
  projectId: string;
  conversationId: string;
  defaultCodeWrap: boolean;
  onOpenProjectFile: (path: string) => void;
  showTime?: boolean;
}): React.JSX.Element {
  useLayoutEffect(() => {
    if (entry.streaming && entry.content) {
      markTestStreamingStage("renderer-live-text-commit");
    }
  }, [entry.content, entry.streaming]);
  const timed = showTime && !entry.streaming && entry.message !== null;
  return (
    <article
      className={clsx(
        "turn-commentary-row",
        entry.streaming && "is-streaming",
        entry.answer && "is-answer",
        timed && "has-block-time",
      )}
      aria-label={entry.streaming ? "Live agent update" : entry.answer ? "Agent answer" : "Agent update"}
      data-assistant-commentary-id={entry.message?.id ?? entry.id}
      {...(entry.message && !entry.streaming ? messageContextMenu(entry.message, entry.content) : undefined)}
      tabIndex={entry.message && !entry.streaming ? -1 : undefined}
    >
      {entry.streaming
        ? (
            <div
              className="response-markdown is-streaming is-plain-stream"
              data-stream-renderer="plain-text"
              data-stream-motion="block-fade"
            >
              <StreamingMarkdownText
                content={entry.content}
                projectRoot={projectRoot}
                projectId={projectId}
                conversationId={conversationId}
                defaultCodeWrap={defaultCodeWrap}
                onOpenProjectFile={onOpenProjectFile}
              />
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
      {timed && <TurnBlockTime createdAt={entry.createdAt} />}
    </article>
  );
});

export function FollowUpRow({
  entry,
}: {
  entry: Extract<TurnExecutionStreamEntry, { kind: "follow-up" }>;
}): React.JSX.Element {
  return (
    <article
      className="turn-follow-up-row"
      aria-label={entry.message.watcherNote ? WATCHER_NOTE_TITLE : "Your follow-up"}
      data-follow-up-message-id={entry.message.id}
      tabIndex={-1}
      {...messageContextMenu(entry.message, entry.message.content)}
    >
      {entry.message.watcherNote && <div className="message-meta"><MessageOrigin message={entry.message} /></div>}
      <p>{entry.message.content}</p>
      <SentMessageAttachmentList
        attachments={entry.message.attachments}
        label="Follow-up attachments"
      />
    </article>
  );
}

export function useAnchoredDetailsToggle(
  onBeforeToggle?: () => void,
  onAfterToggle?: () => void,
): {
  onClickCapture: () => void;
  onClick: () => void;
} {
  return {
    // Claim navigation before the native toggle, but after pointer release.
    // Doing this on press can move the summary out from under the pointer.
    onClickCapture: () => onBeforeToggle?.(),
    onClick: () => {
      window.requestAnimationFrame(() => {
        onAfterToggle?.();
      });
    },
  };
}

export const ActivityGroup = memo(function ActivityGroup({
  entry,
  settled = false,
  revealLatestFailure = false,
  onBeforeToggle,
  onAfterToggle,
}: {
  entry: Extract<TurnExecutionStreamEntry, { kind: "activity-group" }>;
  settled?: boolean;
  revealLatestFailure?: boolean;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [expandRunning, setExpandRunning] = useState(false);
  const rowsId = useId();
  const summary = useMemo(
    () => summarizeActivities(entry.activities),
    [entry.activities],
  );
  const containsAttention = summary.failed + summary.warnings > 0;
  const folded = settled && summary.running === 0;
  const indicator = useWorkingIndicator();
  const latestRunning = summary.running > 0 && usesActivityOrbs(indicator)
    ? [...entry.activities].reverse().find((activity) => activity.status === "running")
    : undefined;
  const groupOrb = latestRunning
    ? resolveOrbMotion(
        indicator,
        orbMotionForActivity(latestRunning, activityExecutionCategory(latestRunning)),
      )
    : null;
  const mode = containsAttention ? "attention" : "calls";
  if (entry.activities.length === 1) {
    const [activity] = entry.activities;
    return (
      <div
        className="turn-activity-group"
        data-activity-group={entry.id}
        data-activity-group-mode={mode}
        data-activity-group-state="single"
      >
        <ActivityRow
          activity={activity!}
          visibility={activityNeedsAttention(activity!) ? "important" : "recent"}
          onBeforeToggle={onBeforeToggle}
          onAfterToggle={onAfterToggle}
        />
      </div>
    );
  }
  const sentence = activitySummarySentence(summary);
  const rows = resolveActivityGroupWindow(entry.activities, {
    expanded,
    settled: folded,
    revealLatestFailure,
    expandRunning,
  });
  const hiddenRunning = summary.running - rows.filter(({ activity, folded: hidden }) => !hidden && activity.status === "running").length;
  const toggle = (): void => {
    onBeforeToggle?.();
    setExpanded((current) => !current);
    window.requestAnimationFrame(() => onAfterToggle?.());
  };
  const MarkIcon = !folded ? CircleDot : summary.failed > 0 ? TriangleAlert : Check;
  return (
    <div
      className="turn-activity-group"
      data-activity-group={entry.id}
      data-activity-group-expanded={expanded}
      data-activity-group-mode={mode}
      data-activity-group-state={expanded ? "expanded" : folded ? "folded" : "live"}
    >
      <button
        type="button"
        className="turn-activity-group-summary"
        aria-expanded={expanded}
        aria-controls={rowsId}
        aria-label={activitySummarySentenceLabel(summary)}
        onClick={toggle}
      >
        <span
          className="turn-activity-group-mark"
          data-running={summary.running > 0}
          data-tone={folded && summary.failed > 0 ? "failure" : undefined}
          data-group-indicator={groupOrb ? "orb" : undefined}
          aria-hidden="true"
        >
          {groupOrb
            ? <WorkingOrb size={14} design={groupOrb.design} pace={groupOrb.pace} />
            : summary.running > 0
              ? <LoadingMark size={14} aria-hidden="true" />
              : <MarkIcon size={14} />}
        </span>
        <span className="turn-activity-group-parts">
          {sentence.length > 0 && (
            <span className="turn-activity-group-part turn-activity-group-sentence" data-tone="neutral">
              {sentence.map((phrase) => (
                <Fragment key={phrase.key}>
                  {`${phrase.joiner}${phrase.lead ? `${phrase.lead} ` : ""}`}
                  <span className="turn-activity-group-count" key={phrase.count}>
                    {phrase.count}
                  </span>
                  {` ${phrase.noun}`}
                </Fragment>
              ))}
            </span>
          )}
          {summary.failed > 0 && (
            <span className="turn-activity-group-part" data-tone="failure">
              <span className="turn-activity-group-count" key={summary.failed}>{summary.failed}</span>
              {" failed"}
            </span>
          )}
          {summary.warnings > 0 && (
            <span className="turn-activity-group-part" data-tone="warning">
              <span className="turn-activity-group-count" key={summary.warnings}>{summary.warnings}</span>
              {summary.warnings === 1 ? " warning" : " warnings"}
            </span>
          )}
        </span>
        <ChevronDown
          size={14}
          className="turn-activity-group-chevron"
          aria-hidden="true"
        />
      </button>
      {!expanded && (hiddenRunning > 0 || (expandRunning && summary.running > 0)) && (
        <button
          type="button"
          className="turn-activity-group-summary"
          aria-expanded={expandRunning}
          aria-controls={rowsId}
          onClick={() => {
            onBeforeToggle?.();
            setExpandRunning((current) => !current);
            window.requestAnimationFrame(() => onAfterToggle?.());
          }}
        >
          {expandRunning ? "Show fewer running operations" : `Show ${hiddenRunning} more running ${hiddenRunning === 1 ? "operation" : "operations"}`}
        </button>
      )}
      <div className="turn-activity-group-rows" id={rowsId}>
        {rows.map(({ activity, folded: rowFolded }) => (
          <div
            className="turn-activity-group-row"
            data-folded={rowFolded}
            aria-hidden={rowFolded || undefined}
            inert={rowFolded || undefined}
            key={activity.id}
          >
            <div>
              <ActivityRow
                activity={activity}
                visibility={activityNeedsAttention(activity) ? "important" : "recent"}
                onBeforeToggle={onBeforeToggle}
                onAfterToggle={onAfterToggle}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

function ExecutionStream({
  entries,
  live = false,
  showTimes = false,
  label = "Agent work transcript",
  projectRoot,
  projectId,
  conversationId,
  defaultCodeWrap,
  onOpenProjectFile,
  onBeforeToggle,
  onAfterToggle,
}: {
  entries: TurnWorkStreamEntry[];
  live?: boolean;
  showTimes?: boolean;
  label?: string;
  projectRoot: string;
  projectId: string;
  conversationId: string;
  defaultCodeWrap: boolean;
  onOpenProjectFile: (path: string) => void;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}): React.JSX.Element | null {
  if (entries.length === 0) return null;
  const lastIndex = entries.length - 1;
  return (
    <div className="turn-execution-stream" role="list" aria-label={label}>
      {entries.map((entry, index) => {
        if (entry.kind === "html-render") {
          return entry.message.htmlRender && (
            <div role="listitem" key={entry.id}>
              <HtmlRenderFrame
                key={entry.message.htmlRender.renderId}
                reference={entry.message.htmlRender}
              />
            </div>
          );
        }
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
                showTime={showTimes}
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
        if (entry.kind === "compaction") {
          return (
            <div role="listitem" key={entry.id}>
              <ContextCompactionActivityMarker
                activities={entry.activities}
                elapsed={<LiveElapsed startedAt={entry.createdAt} />}
              />
            </div>
          );
        }
        return (
          <div role="listitem" key={entry.id}>
            <ActivityGroup
              entry={entry}
              settled={!live || index < lastIndex}
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

function ThinkingSummary({
  live,
  line,
  span,
  count,
}: {
  live: boolean;
  line: ThinkingLineView;
  span: ReasoningSpan;
  count: string;
}): React.JSX.Element {
  const pulseRef = usePhaseLockedAnimations<HTMLSpanElement>(`${live}:${line.current?.offset}`);
  return (
    <>
      <span className="turn-thinking-pulse" ref={pulseRef}>
        <Brain size={14} className="turn-thinking-icon" aria-hidden="true" />
        <span className="turn-thinking-label" key={live ? "live" : "folded"}>
          {live
            ? "Thinking"
            : span.durationMs === null
              ? "Thought"
              : `Thought for ${formatElapsed(Math.max(1_000, span.durationMs))}`}
        </span>
        {live && (
          <small className="turn-thinking-elapsed">
            <span className="turn-thinking-separator" aria-hidden="true">·</span>
            {line.holding
              ? <span>{formatElapsed(span.durationMs ?? 0, true)}</span>
              : <LiveElapsed startedAt={span.startedAt} />}
          </small>
        )}
      </span>
      {live
        ? (
            <span className="turn-thinking-line" aria-hidden="true">
              {line.previous && (
                <span className="is-leaving" key={`previous:${line.previous.offset}`}>
                  {line.previous.text}
                </span>
              )}
              {line.current && (
                <span className="is-entering" key={`current:${line.current.offset}`}>
                  {line.current.text}
                </span>
              )}
            </span>
          )
        : <small>{count}</small>}
    </>
  );
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
  entries: TurnWorkStreamEntry[];
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
          <span>Reasoning summary</span>
          <ReasoningSummary content={reasoningContent} />
        </div>
      )}
      {turn.plans.map((plan) => <PlanDetail key={`${plan.runId}:${plan.turnId ?? "legacy"}`} plan={plan} />)}
    </div>
  );
}

const NO_HELD_FOLLOW_UPS: string[] = [];

export function WorkLog({
  turn,
  autoCollapse,
  reasoningContent,
  reasoningStreaming,
  liveContent,
  liveContentStreaming,
  heldFollowUpIds = NO_HELD_FOLLOW_UPS,
  showThinking,
  projectRoot,
  projectId,
  conversationId,
  defaultCodeWrap,
  onOpenProjectFile,
  onBeforeToggle,
  onAfterToggle,
  fold = null,
  foldedWork = null,
}: {
  turn: ResponseTurn;
  autoCollapse: boolean;
  reasoningContent: string;
  reasoningStreaming: boolean;
  liveContent: string;
  liveContentStreaming: boolean;
  heldFollowUpIds?: string[];
  showThinking: boolean;
  projectRoot: string;
  projectId: string;
  conversationId: string;
  defaultCodeWrap: boolean;
  onOpenProjectFile: (path: string) => void;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
  fold?: TurnFoldControl | null;
  foldedWork?: React.ReactNode;
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(!autoCollapse);
  const [failureExpanded, setFailureExpanded] = useState(!autoCollapse);
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
  const previousDurableStream = useRef<TurnExecutionStreamEntry[]>([]);
  const durableStream = useMemo(() => {
    const next = stabilizeTurnExecutionStream(buildTurnExecutionStream(turn, {
      includeImportantActivities: turn.isActive,
      includeCompactions: turn.isActive,
    }), previousDurableStream.current);
    previousDurableStream.current = next;
    const layered = layeredHtmlRenders(turn);
    return withHtmlRenders(next, turn.htmlRenders.filter((message) => !layered.includes(message)));
  }, [turn]);
  // Transient text is the final visible execution entry unless follow-ups
  // were saved while it streamed; then it sits just above them. Inserting that
  // one row keeps settled commentary and activity-group identities stable
  // instead of sorting the complete workstream for every provider token. A
  // reconnect may retain the text while deliberately closing its live channel,
  // so only the current text channel gets live semantics and animation.
  const stream = useMemo<TurnWorkStreamEntry[]>(() => {
    if (!turn.isActive || !liveContent) return durableStream;
    return withLiveCommentary(durableStream, {
      kind: "commentary",
      id: `live-commentary:${turn.id}`,
      createdAt: turn.agentTurn.updatedAt,
      message: null,
      content: liveContent,
      streaming: liveContentStreaming,
    }, heldFollowUpIds);
  }, [
    durableStream,
    heldFollowUpIds,
    liveContent,
    liveContentStreaming,
    turn.agentTurn.updatedAt,
    turn.id,
    turn.isActive,
  ]);
  const supplementalCount = turn.plans.length
    + (includesReasoning ? 1 : 0);
  const planStepCount = turn.plans.reduce(
    (total, plan) => total + plan.steps.length,
    0,
  );
  const activeReasoning = includesReasoning && reasoningStreaming;
  const { attentionGroup, failureDiagnostics } = useMemo(() => {
    const diagnostics: AgentActivity[] = [];
    const pinned: AgentActivity[] = [];
    for (const activity of turn.importantActivities) {
      (activity.kind === "error" && activity.status === "failed"
        ? diagnostics
        : pinned).push(activity);
    }
    return {
      failureDiagnostics: diagnostics,
      attentionGroup: pinned.length > 0
        ? {
            kind: "activity-group" as const,
            id: `activity-group:attention:${turn.id}`,
            createdAt: pinned[0]!.createdAt,
            activities: pinned,
          }
        : null,
    };
  }, [turn.id, turn.importantActivities]);
  const thinkingLine = useReadableThinkingLine(reasoningContent, activeReasoning);
  const thinkingLive = activeReasoning || (includesReasoning && thinkingLine.holding);
  const reasoningSpan = useReasoningSpan(activeReasoning);
  const activeTraceCount = [
    includesReasoning ? "reasoning summary" : null,
    planStepCount > 0
      ? `${planStepCount} ${planStepCount === 1 ? "step" : "steps"}`
      : null,
  ].filter(Boolean).join(" · ") || `${supplementalCount} update`;
  const traceDetails = supplementalCount > 0 && (
    <details
      className={includesReasoning ? "turn-thinking" : undefined}
      data-thinking-state={includesReasoning
        ? thinkingLive ? "live" : "folded"
        : undefined}
      data-thinking-hold={thinkingLive && !activeReasoning ? "" : undefined}
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
        {includesReasoning
          ? (
              <ThinkingSummary
                live={thinkingLive}
                line={thinkingLine}
                span={reasoningSpan}
                count={activeTraceCount}
              />
            )
          : (
              <>
                <span>Plan</span>
                <small>{activeTraceCount}</small>
              </>
            )}
        <ChevronDown size={14} className="turn-work-chevron" aria-hidden="true" />
      </summary>
      <div className="turn-work-details" id={detailsId} hidden={!expanded}>
        {expanded && includesReasoning && (
          <div className="turn-reasoning-detail">
            <span>Reasoning summary</span>
            <ReasoningSummary
              content={reasoningContent}
              streaming={activeReasoning}
            />
          </div>
        )}
        {expanded && turn.plans.map((plan) => <PlanDetail key={`${plan.runId}:${plan.turnId ?? "legacy"}`} plan={plan} />)}
      </div>
    </details>
  );
  if (turn.isActive) {
    if (stream.length === 0 && supplementalCount === 0) return null;
    return (
      <div className="turn-work-log is-live">
        <ExecutionStream
          key="stream"
          entries={stream}
          live
          projectRoot={projectRoot}
          projectId={projectId}
          conversationId={conversationId}
          defaultCodeWrap={defaultCodeWrap}
          onOpenProjectFile={onOpenProjectFile}
          onBeforeToggle={onBeforeToggle}
          onAfterToggle={onAfterToggle}
        />
        {traceDetails}
      </div>
    );
  }

  const exchange = stream.filter((entry) =>
    entry.kind === "follow-up"
    || entry.kind === "html-render"
    || (entry.kind === "commentary" && entry.answer));
  const workStream = exchange.length > 0
    ? stream.filter((entry) => !exchange.includes(entry))
    : stream;
  const status = turn.agentTurn.status === "failed" && turn.agentTurn.usageLimited
    ? "limited"
    : turn.agentTurn.status === "failed"
    ? "failed"
    : turn.agentTurn.status === "cancelled" || turn.agentTurn.status === "interrupted"
      ? "stopped"
      : "completed";
  const failureRow = status === "failed"
    || status === "limited"
    || failureDiagnostics.length > 0;
  const latestFailure = failureDiagnostics.at(-1);
  if (fold) {
    const foldId = `turn-fold-${turn.id}`;
    const failureTitle = latestFailure
      ? activityTitleConveysSeverity(latestFailure.title, "failure")
        ? latestFailure.title
        : `Failed · ${latestFailure.title}`
      : null;
    const staticFold = needsStaticFoldRow(turn, fold.visible);
    if (!fold.visible && !staticFold && !failureTitle && !attentionGroup && exchange.length === 0) return null;
    return (
      <div
        className="turn-work-log is-settled is-folded"
        data-settled-work-status={status}
        data-settled-work-visibility={fold.visible ? fold.open ? "expanded" : "collapsed" : "static"}
      >
        {fold.visible && <TurnFoldRow fold={fold} controlsId={foldId} />}
        {staticFold && (
          <div className="turn-fold-row" data-turn-fold-row="static">
            <span className="turn-fold-label">{fold.label}</span>
          </div>
        )}
        {fold.visible && (
          <div className="turn-work-log turn-fold-body" id={foldId} hidden={!fold.open}>
            {fold.open && (
              <>
                <ExecutionStream
                  key="work-stream"
                  entries={workStream}
                  showTimes={fold.showTimes}
                  projectRoot={projectRoot}
                  projectId={projectId}
                  conversationId={conversationId}
                  defaultCodeWrap={defaultCodeWrap}
                  onOpenProjectFile={onOpenProjectFile}
                  onBeforeToggle={onBeforeToggle}
                  onAfterToggle={onAfterToggle}
                />
                {foldedWork}
                {traceDetails}
              </>
            )}
          </div>
        )}
        {failureTitle && (
          <details
            className="turn-fold-failure"
            open={failureExpanded}
            onToggle={(event) => setFailureExpanded(event.currentTarget.open)}
          >
            <summary
              className="turn-settled-summary"
              aria-expanded={failureExpanded}
              aria-controls={`${detailsId}-failure`}
              {...anchorToggleHandlers}
            >
              <TriangleAlert size={14} aria-hidden="true" />
              <span>{failureTitle}</span>
              <small>Details</small>
              <ChevronRight size={14} className="turn-work-chevron" aria-hidden="true" />
            </summary>
            <div id={`${detailsId}-failure`} hidden={!failureExpanded}>
              {failureExpanded && failureDiagnostics.map((activity) => (
                <Suspense fallback={null} key={activity.id}>
                  <FailureDiagnostics turn={turn.agentTurn} activity={activity} />
                </Suspense>
              ))}
            </div>
          </details>
        )}
        {attentionGroup && (
          <ActivityGroup
            entry={attentionGroup}
            settled
            onBeforeToggle={onBeforeToggle}
            onAfterToggle={onAfterToggle}
          />
        )}
        <ExecutionStream
          key="stream"
          entries={exchange}
          label="Follow-up messages"
          projectRoot={projectRoot}
          projectId={projectId}
          conversationId={conversationId}
          defaultCodeWrap={defaultCodeWrap}
          onOpenProjectFile={onOpenProjectFile}
          onBeforeToggle={onBeforeToggle}
          onAfterToggle={onAfterToggle}
        />
      </div>
    );
  }
  const hasFoldableDetails = workStream.length > 0
    || supplementalCount > 0
    || failureDiagnostics.length > 0
    || (failureRow && attentionGroup !== null);
  const summaryContent = (
    <>
      {status === "failed"
        ? <TriangleAlert size={14} aria-hidden="true" />
        : status === "limited"
          ? <Clock size={14} aria-hidden="true" />
          : null}
      <span>
        {latestFailure
          ? `${workStatusLabel(turn)} · ${latestFailure.title}`
          : workSummaryLabel(turn)}
      </span>
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
            {failureRow && <small>Details</small>}
            <ChevronRight size={14} className="turn-work-chevron" aria-hidden="true" />
          </summary>
          <div id={detailsId} hidden={!expanded}>
            {expanded && (
              <SettledWorkDetails
                entries={workStream}
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
            {expanded && failureRow && attentionGroup && (
              <ActivityGroup
                entry={attentionGroup}
                settled
                revealLatestFailure
                onBeforeToggle={onBeforeToggle}
                onAfterToggle={onAfterToggle}
              />
            )}
            {expanded && failureDiagnostics.map((activity) => (
              <Suspense fallback={null} key={activity.id}>
                <FailureDiagnostics
                  turn={turn.agentTurn}
                  activity={activity}
                />
              </Suspense>
            ))}
          </div>
        </details>
      )}
      {!hasFoldableDetails && (
        <div className="turn-settled-summary" data-settled-work-summary="static">
          {summaryContent}
        </div>
      )}
      {!failureRow && attentionGroup && (
        <ActivityGroup
          entry={attentionGroup}
          settled
          onBeforeToggle={onBeforeToggle}
          onAfterToggle={onAfterToggle}
        />
      )}
      <ExecutionStream
        key="stream"
        entries={exchange}
        label="Follow-up messages"
        projectRoot={projectRoot}
        projectId={projectId}
        conversationId={conversationId}
        defaultCodeWrap={defaultCodeWrap}
        onOpenProjectFile={onOpenProjectFile}
        onBeforeToggle={onBeforeToggle}
        onAfterToggle={onAfterToggle}
      />
    </div>
  );
}
