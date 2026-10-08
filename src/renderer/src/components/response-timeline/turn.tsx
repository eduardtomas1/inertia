import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import clsx from "clsx";
import type { SubagentTrace } from "@shared/contracts";
import { activeWorkIdentityLabel } from "../../utils/finalAnswerIdentity";
import { sameTurnAgentStatus } from "../../utils/turnAgentStatus";
import {
  answerTailCommentary,
  type ResponseTurn,
  type TurnExecutionStreamEntry,
} from "../../utils/responseTimeline";
import { CommentaryRow } from "./activity";
import {
  AgentExecutionLayer,
  FinalAnswerDocument,
  SupportingLedgerLayer,
  UserRequestLayer,
} from "./layers";
import { TurnHtmlRenders } from "./html-render";
import { turnCompletionAnnouncement } from "./metadata";
import type { ResponseTimelineProps } from "./types";

const TURN_SETTLEMENT_TRANSITION_MS = 160;

type CommentaryEntry = Extract<TurnExecutionStreamEntry, { kind: "commentary" }>;

function TurnAnswerTail({
  entries,
  props,
}: {
  entries: CommentaryEntry[];
  props: ResponseTimelineProps;
}): React.JSX.Element | null {
  if (entries.length === 0) return null;
  return (
    <div className="turn-answer-tail" data-turn-layer="answer-tail">
      {entries.map((entry) => (
        <CommentaryRow
          key={entry.id}
          entry={entry}
          projectRoot={props.projectRoot}
          projectId={props.projectId}
          conversationId={props.conversationId}
          defaultCodeWrap={props.defaultCodeWrap}
          onOpenProjectFile={props.onOpenTurnFile}
        />
      ))}
    </div>
  );
}

function TurnTimelineComponent({
  turn,
  props,
  previousArtifactTurnId,
  subagents,
  onBeforeToggle,
  onAfterToggle,
}: {
  turn: ResponseTurn;
  props: ResponseTimelineProps;
  previousArtifactTurnId: string | null;
  subagents?: SubagentTrace[];
  onBeforeToggle?: (turnId: string) => void;
  onAfterToggle?: (turnId: string) => void;
}): React.JSX.Element {
  const streamedText = turn.isActive && !turn.terminalAssistantMessage
    ? props.streamingText
    : "";
  const streamedTextLive = props.streamingChannel === "text";
  const tailCommentary = useMemo(() => answerTailCommentary(turn), [turn]);
  const railTurn = useMemo(() => tailCommentary?.length
    ? {
        ...turn,
        commentaryMessages: turn.commentaryMessages.filter((message) =>
          !tailCommentary.includes(message)),
      }
    : turn, [tailCommentary, turn]);
  const liveContent = tailCommentary ? "" : streamedText;
  const tailEntries = useMemo<CommentaryEntry[]>(() => {
    if (!tailCommentary) return [];
    const saved = tailCommentary.map((message): CommentaryEntry => ({
      kind: "commentary",
      id: message.id,
      createdAt: message.createdAt,
      message,
      content: message.content,
      streaming: false,
    }));
    return streamedText
      ? [...saved, {
          kind: "commentary",
          id: `live-commentary:${turn.id}`,
          createdAt: turn.agentTurn.updatedAt,
          message: null,
          content: streamedText,
          streaming: streamedTextLive,
        }]
      : saved;
  }, [
    streamedText,
    streamedTextLive,
    tailCommentary,
    turn.agentTurn.updatedAt,
    turn.id,
  ]);
  const answerTailVisible = tailEntries.length > 0;
  const answerTailWasVisible = useRef(false);
  const reasoningContent = turn.isActive
    ? props.streamingReasoning || turn.reasoning?.content || ""
    : turn.reasoning?.content || "";
  const providerLabel = activeWorkIdentityLabel(
    turn.agentTurn.modelSelection,
    props.providerIdentityLabels,
  );
  const timerStart = turn.startedAt ?? turn.requestedAt;
  const omitted = props.omittedTurnIds?.includes(turn.id) ?? false;
  const wasActive = useRef(turn.isActive);
  const [completionAnnouncement, setCompletionAnnouncement] = useState("");
  const [settlingTransition, setSettlingTransition] = useState<{
    revealAnswer: boolean;
  } | null>(null);
  const isSettling = settlingTransition !== null;
  const isRevealingSettledAnswer = settlingTransition?.revealAnswer ?? false;
  const handleBeforeToggle = useCallback(
    () => onBeforeToggle?.(turn.id),
    [onBeforeToggle, turn.id],
  );
  const handleAfterToggle = useCallback(
    () => onAfterToggle?.(turn.id),
    [onAfterToggle, turn.id],
  );

  useLayoutEffect(() => {
    if (turn.isActive) answerTailWasVisible.current = answerTailVisible;
  }, [answerTailVisible, turn.isActive]);
  useLayoutEffect(() => {
    const announcement = turnCompletionAnnouncement(wasActive.current, turn, providerLabel);
    if (announcement) {
      setCompletionAnnouncement(announcement);
      setSettlingTransition({
        // Task 12 deliberately never renders a final document while active.
        // A terminal row already present in the settlement snapshot is still
        // newly visible and receives the restrained document reveal.
        revealAnswer: Boolean(turn.terminalAssistantMessage?.content)
          && !answerTailWasVisible.current,
      });
    } else if (
      settlingTransition
      && !settlingTransition.revealAnswer
      && !answerTailWasVisible.current
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
    const timer = window.setTimeout(
      () => setSettlingTransition(null),
      TURN_SETTLEMENT_TRANSITION_MS,
    );
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
      <UserRequestLayer
        turn={turn}
        props={props}
        onBeforeToggle={handleBeforeToggle}
        onAfterToggle={handleAfterToggle}
      />

      {omitted ? (
        <p className="response-turn-omitted" role="note">
          This turn is too large to display. Your history is saved.
        </p>
      ) : (
        <>
          <AgentExecutionLayer
            turn={railTurn}
            props={props}
            subagents={subagents ?? []}
            providerLabel={providerLabel}
            reasoningContent={reasoningContent}
            liveContent={liveContent}
            timerStart={timerStart}
            completionAnnouncement={completionAnnouncement}
            onBeforeToggle={handleBeforeToggle}
            onAfterToggle={handleAfterToggle}
          />

          <TurnHtmlRenders turn={turn} />

          <TurnAnswerTail entries={tailEntries} props={props} />

          <FinalAnswerDocument
            turn={turn}
            props={props}
          />

          <SupportingLedgerLayer
            turn={turn}
            props={props}
            previousArtifactTurnId={previousArtifactTurnId}
            onBeforeToggle={handleBeforeToggle}
            onAfterToggle={handleAfterToggle}
          />
        </>
      )}
    </section>
  );
}

export function sameTurnTimelineProps(
  previous: {
    turn: ResponseTurn;
    props: ResponseTimelineProps;
    previousArtifactTurnId: string | null;
    subagents?: SubagentTrace[];
    onBeforeToggle?: (turnId: string) => void;
    onAfterToggle?: (turnId: string) => void;
  },
  next: {
    turn: ResponseTurn;
    props: ResponseTimelineProps;
    previousArtifactTurnId: string | null;
    subagents?: SubagentTrace[];
    onBeforeToggle?: (turnId: string) => void;
    onAfterToggle?: (turnId: string) => void;
  },
): boolean {
  const left = previous.props;
  const right = next.props;
  return previous.turn === next.turn
    && previous.previousArtifactTurnId === next.previousArtifactTurnId
    && sameTurnAgentStatus(previous.subagents, next.subagents)
    && previous.onBeforeToggle === next.onBeforeToggle
    && previous.onAfterToggle === next.onAfterToggle
    && left.providerIdentityLabels === right.providerIdentityLabels
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
    && left.onOpenSurface === right.onOpenSurface
    && left.turns === right.turns
    && left.contextPackets === right.contextPackets
    && left.omittedTurnIds === right.omittedTurnIds
    && (!next.turn.isActive || (
      left.streamingText === right.streamingText
      && left.streamingReasoning === right.streamingReasoning
      && left.streamingChannel === right.streamingChannel
    ));
}

export const TurnTimeline = memo(TurnTimelineComponent, sameTurnTimelineProps);
