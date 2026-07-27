import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import clsx from "clsx";
import { activeWorkIdentityLabel } from "../../utils/finalAnswerIdentity";
import type { ResponseTurn } from "../../utils/responseTimeline";
import {
  AgentExecutionLayer,
  FinalAnswerDocument,
  SupportingLedgerLayer,
  UserRequestLayer,
} from "./layers";
import { turnCompletionAnnouncement } from "./metadata";
import type { ResponseTimelineProps } from "./types";

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

export const TurnTimeline = memo(TurnTimelineComponent, sameTurnTimelineProps);
