import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Check,
  ChevronDown,
  Copy,
} from "lucide-react";
import type {
  AgentTurn,
  ChatMessage,
} from "@shared/contracts";
import { formatClockTime } from "../../lib/format";
import {
  formatElapsed,
  turnExecutionElapsedMs,
  turnQueueElapsedMs,
  turnStatusLabel,
  workSummaryLabel,
  type ResponseTurn,
  type TurnGitArtifactSummary,
} from "../../utils/responseTimeline";
import { shouldShowChangedFilesSummary } from "./changedFiles";

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

export function TurnMetadata({
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
        {detailsExpanded && presentation.details.map((detail) => (
            <div key={detail.label}>
              <dt>{detail.label}</dt>
              <dd>{detail.technical ? <code>{detail.value}</code> : detail.value}</dd>
            </div>
        ))}
          {detailsExpanded && settledWorkDetails && (
            <div className="turn-run-work-details">
              <dt>Execution transcript</dt>
              <dd>{settledWorkDetails}</dd>
            </div>
          )}
      </dl>
    </footer>
  );
}
