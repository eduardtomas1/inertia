import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ChevronDown,
} from "lucide-react";
import type {
  AgentTurn,
  ChatMessage,
} from "@shared/contracts";
import { formatFullDateTime, formatMessageTime } from "../../lib/format";
import { useCopiedState } from "../../hooks/useCopiedState";
import { renderedAnswerText } from "../../utils/answerPlainText";
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
import { InertiaMorphIcon } from "../motion/InertiaMorphIcon";
import { checkMorphIcon, copyMorphIcon } from "../motion/lucideMorphData";
import { TooltipButton } from "../TooltipButton";

export function CopyAnswerButton({
  content,
  answerId,
  ariaLabel = "Copy answer",
}: {
  content: string;
  answerId: string;
  ariaLabel?: string;
}): React.JSX.Element {
  const { copied, error, copy } = useCopiedState();
  const copiedAriaLabel = `${ariaLabel.replace(/^Copy\s+/u, "")} copied`;
  const label = error ? "Copy failed" : ariaLabel;
  return (
    <>
      <TooltipButton
        className="turn-action"
        tooltip={copied ? "Answer copied" : label}
        aria-label={copied ? copiedAriaLabel : label}
        onClick={(event) => {
          const article = [...event.currentTarget.closest(".response-turn")
            ?.querySelectorAll<HTMLElement>("article[data-terminal-answer-id]") ?? []]
            .find((candidate) => candidate.dataset.terminalAnswerId === answerId);
          void copy(article ? renderedAnswerText(article, content) : content);
        }}
      >
        <InertiaMorphIcon
          icon={copied ? checkMorphIcon : copyMorphIcon}
          iconState={copied ? "copied" : "copy"}
          size={14}
        />
        {error && <span>Copy failed</span>}
      </TooltipButton>
      <span className="visually-hidden" role="status" aria-live="polite">
        {copied ? "Answer copied." : ""}
      </span>
      {error && <span className="visually-hidden" role="alert">{error}</span>}
    </>
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
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);
  const { agentTurn } = turn;
  const presentation = turnMetadataPresentation(turn);
  const detailsId = `turn-run-details-${turn.id}`;
  const detailsLabelId = `${detailsId}-label`;
  const diagnosticsId = `${detailsId}-diagnostics`;
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
  const toggleDiagnostics = (): void => {
    prepareToggle();
    setDiagnosticsExpanded((current) => !current);
  };
  useLayoutEffect(() => {
    if (!togglePrepared.current) return;
    onAfterToggle?.();
    togglePrepared.current = false;
  }, [detailsExpanded, diagnosticsExpanded, onAfterToggle]);
  useEffect(() => {
    setDetailsExpanded(workDetailsExpandedByDefault === true);
  }, [workDetailsExpandedByDefault]);
  const completed = agentTurn.status === "completed";
  const time = terminalAnswer?.createdAt
    ?? (turn.isActive ? turn.startedAt ?? turn.requestedAt : turn.completedAt ?? turn.requestedAt);
  if (turn.isActive) {
    return (
      <footer className="turn-meta" aria-label="Turn time">
        <div className="turn-meta-primary">
          <time dateTime={time} title={formatFullDateTime(time)}>{formatMessageTime(time)}</time>
        </div>
      </footer>
    );
  }
  return (
    <footer
      className="turn-meta"
      aria-label="Final answer actions and run metadata"
      data-run-details-expanded={detailsExpanded || undefined}
    >
      <div className="turn-meta-primary">
        {terminalAnswer && (
          <CopyAnswerButton content={terminalAnswer.content} answerId={terminalAnswer.id} ariaLabel="Copy final answer" />
        )}
        {showTimestamp && (
          <time dateTime={time} title={formatFullDateTime(time)}>{formatMessageTime(time)}</time>
        )}
        {!completed && <span data-turn-status={agentTurn.status}>{presentation.statusLabel}</span>}
        <span className="turn-duration" data-turn-status={completed ? agentTurn.status : undefined}>{presentation.durationLabel}</span>
        <button
          type="button"
          className="turn-run-details-toggle"
          id={detailsLabelId}
          aria-expanded={detailsExpanded}
          aria-controls={detailsId}
          onClick={toggleDetails}
        >
          <span>Run details</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </div>
      <div
        className="turn-run-details"
        id={detailsId}
        aria-labelledby={detailsLabelId}
        hidden={!detailsExpanded}
        role="group"
      >
        {detailsExpanded && settledWorkDetails && (
          <div className="turn-run-work-details">{settledWorkDetails}</div>
        )}
        {detailsExpanded && (
          <button
            type="button"
            className="turn-run-diagnostics-toggle"
            aria-expanded={diagnosticsExpanded}
            aria-controls={diagnosticsId}
            onClick={toggleDiagnostics}
          >
            <span>Diagnostics</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        )}
        {detailsExpanded && (
          <dl className="turn-run-diagnostics" id={diagnosticsId} hidden={!diagnosticsExpanded}>
            {diagnosticsExpanded && presentation.details.map((detail) => (
              <div key={detail.label}>
                <dt>{detail.label}</dt>
                <dd>{detail.technical ? <code>{detail.value}</code> : detail.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </footer>
  );
}
