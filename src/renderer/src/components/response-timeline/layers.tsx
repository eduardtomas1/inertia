import { useLayoutEffect, useMemo, useState } from "react";
import { MessagesSquare, RotateCcw } from "lucide-react";
import { isOwnConversationContext } from "@shared/conversation-context";
import clsx from "clsx";
import { agentRunStateForTurn } from "@shared/run-state";
import type { ChatMessage, SubagentTrace } from "@shared/contracts";
import { MessageOrigin } from "./MessageOrigin";
import { formatClockTime } from "../../lib/format";
import { finalAnswerIdentityLabel } from "../../utils/finalAnswerIdentity";
import { sessionRecoveryDetail } from "../../utils/sessionRecovery";
import { markTestStreamingStage } from "../../utils/testStreamingTrace";
import {
  collapsedUserRequestPreview,
  shouldCollapseUserRequest,
} from "../../utils/userRequestPresentation";
import {
  activeAgentPresentation,
  buildTurnExecutionStream,
  shouldConsolidateSettledWorkIntoRunDetails,
  type ActiveAgentPhase,
  type ResponseTurn,
} from "../../utils/responseTimeline";
import { ApprovalCard, InputRequestCard } from "../AgentRequestCard";
import { ResponseMarkdown } from "../ResponseMarkdown";
import { ContextCompactionIcon } from "../ContextCompactionIcon";
import { AgentPixelGrid } from "../AgentPixelGrid";
import { WorkingOrb } from "../working-indicator/WorkingOrb";
import { useWorkingIndicator } from "../working-indicator/WorkingIndicatorContext";
import {
  orbMotionForPhase,
  resolveOrbMotion,
  usesOrbs,
  workingOrbSyncKey,
} from "../working-indicator/orbMotion";
import { usePublishLiveAgentPhase } from "../working-indicator/liveAgentPhases";
import { SubagentDisclosure } from "../SubagentDisclosure";
import { SentMessageAttachmentList } from "../SentMessageAttachmentList";
import {
  LiveElapsed,
  SettledWorkDetails,
  WorkLog,
} from "./activity";
import { ContextCompactionActivityMarker } from "./ContextCompactionRow";
import {
  ChangedFilesSummary,
  shouldShowChangedFilesSummary,
} from "./changedFiles";
import { TurnMetadata } from "./metadata";
import { RememberProjectMessage, SentProjectMemoryButton } from "../project-memory/ProjectMemoryHost";
import type { ResponseTimelineProps } from "./types";
import "./ConversationContextProvenance.css";

export function AgentPixelLoader({
  animated,
  phase,
  conversationId,
}: {
  animated: boolean;
  phase: ActiveAgentPhase;
  conversationId: string;
}): React.JSX.Element {
  const indicator = useWorkingIndicator();
  if (usesOrbs(indicator)) {
    const motion = resolveOrbMotion(indicator, orbMotionForPhase(phase));
    return (
      <WorkingOrb
        size={18}
        design={motion.design}
        pace={motion.pace}
        syncKey={workingOrbSyncKey(conversationId)}
      />
    );
  }
  if (phase === "compacting") return <ContextCompactionIcon />;
  return <AgentPixelGrid animated={animated} phase={phase} />;
}

export function UserRequestLayer({
  turn,
  props,
  onBeforeToggle,
  onAfterToggle,
}: {
  turn: ResponseTurn;
  props: ResponseTimelineProps;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}): React.JSX.Element {
  const isDocumentLike = turn.userMessage.content.length >= 280;
  const collapsible = shouldCollapseUserRequest(turn.userMessage.content);
  const [expanded, setExpanded] = useState(false);
  const content = collapsible && !expanded
    ? collapsedUserRequestPreview(turn.userMessage.content)
    : turn.userMessage.content;
  const toggleExpanded = (): void => {
    onBeforeToggle?.();
    setExpanded((current) => !current);
    window.requestAnimationFrame(() => onAfterToggle?.());
  };
  const contextPackets = props.contextPackets?.filter(
    ({ consumedMessageId }) => consumedMessageId === turn.userMessage.id,
  ) ?? [];
  const sessionRecovery = sessionRecoveryDetail(turn.agentTurn);
  return (
    <article
      className={clsx("message is-user turn-user-request", isDocumentLike && "is-document-like")}
      aria-label="Your request"
      data-request-layout={isDocumentLike ? "document" : "content"}
      data-turn-layer="user-request"
      data-turn-request-context={turn.id}
      data-turn-jump-target="request"
      data-message-search-id={turn.userMessage.id}
      tabIndex={-1}
    >
      <div className="message-meta">
        <span>You</span>
        <MessageOrigin message={turn.userMessage} />
        <RememberProjectMessage message={turn.userMessage} className="message-revert" />
        <SentProjectMemoryButton turnId={turn.id} />
        {props.showTimestamps && <time dateTime={turn.userMessage.createdAt}>{formatClockTime(turn.userMessage.createdAt)}</time>}
        {turn.checkpoint && <button type="button" className="message-revert" title={props.checkpointRestoreDisabled ? "Stop the active run before restoring a checkpoint" : "Restore the project to before this turn"} disabled={props.checkpointRestoreDisabled} onClick={() => props.onRevertCheckpoint(turn.checkpoint!)}><RotateCcw size={11} />Revert</button>}
      </div>
      <div
        className={clsx("message-body", collapsible && !expanded && "is-collapsed")}
        data-request-content={collapsible ? "collapsible" : "complete"}
      >
        {content}
      </div>
      {collapsible && (
        <button
          type="button"
          className="turn-user-request-expand"
          aria-expanded={expanded}
          onClick={toggleExpanded}
        >
          {expanded ? "Show less" : "Show full message"}
        </button>
      )}
      <SentMessageAttachmentList
        attachments={turn.userMessage.attachments}
        label="Request attachments"
      />
      {sessionRecovery && (
        <div className="sent-context" aria-label="Provider session">
          <span data-session-recovery="">
            <MessagesSquare size={13} aria-hidden="true" />
            <span>
              <strong>New provider session</strong>
              <small title={sessionRecovery}>{sessionRecovery}</small>
            </span>
          </span>
        </div>
      )}
      {contextPackets.length > 0 && (
        <div className="sent-context" aria-label="Shared chat context">
          {contextPackets.map((packet) => {
            const own = isOwnConversationContext(packet);
            const count = `${packet.messageCount} ${packet.messageCount === 1 ? "message" : "messages"}${packet.droppedMessageCount > 0 ? ` · ${packet.droppedMessageCount} omitted` : ""}`;
            return (
              <span key={packet.id} data-source-state={packet.sourceState}>
                <MessagesSquare size={13} aria-hidden="true" />
                <span>
                  <strong>
                    {own ? "Earlier messages from this chat" : `Context from ${packet.sourceConversationTitle}`}
                  </strong>
                  <small>
                    {packet.sourceState === "deleted"
                      ? "Source deleted · immutable sent excerpt"
                      : own
                        ? count
                        : `${packet.sourceProjectName} · ${count}${packet.workspaceRelation === "different-workspace" ? " · different workspace" : ""}`}
                  </small>
                </span>
              </span>
            );
          })}
        </div>
      )}
    </article>
  );
}

export function AgentExecutionLayer({
  turn,
  props,
  subagents,
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
  subagents: SubagentTrace[];
  providerLabel: string;
  reasoningContent: string;
  liveContent: string;
  timerStart: string;
  completionAnnouncement: string;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}): React.JSX.Element {
  const runState = agentRunStateForTurn(turn.agentTurn);
  const stopping = runState === "cancelling";
  const consolidatesSettledWork = shouldConsolidateSettledWorkIntoRunDetails(turn);
  const settledCompactions = useMemo(
    () => turn.isActive
      ? []
      : buildTurnExecutionStream(turn, { includeCompactions: true })
        .flatMap((entry) => entry.kind === "compaction" ? [entry] : []),
    [turn],
  );
  const activePresentation = activeAgentPresentation({
    turn,
    providerLabel,
    streamingChannel: props.streamingChannel ?? null,
  });
  usePublishLiveAgentPhase(turn.isActive
    ? { conversationId: props.conversationId, turnId: turn.id, phase: activePresentation.phase }
    : null);
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
          data-active-work-state={runState}
          data-active-agent-phase={activePresentation.phase}
          data-work-identity-source="persisted-model-selection"
        >
          <header className="turn-working-state" title={providerLabel}>
            <span className="turn-working-status" role="status" aria-live="polite" aria-atomic="true">
              <AgentPixelLoader
                animated={activePresentation.animated}
                phase={activePresentation.phase}
                conversationId={props.conversationId}
              />
              <span className="turn-working-copy">
                <strong>{activePresentation.label}</strong>
                {activePresentation.detail && (
                  <small className="turn-working-detail-chip" aria-hidden="true">
                    {activePresentation.detail}
                  </small>
                )}
              </span>
            </span>
            <span className="turn-working-elapsed" aria-live="off">
              <span className="turn-working-separator" aria-hidden="true">·</span>
              <LiveElapsed
                startedAt={timerStart}
                excludedMs={turn.agentTurn.suspendedDurationMs}
              />
            </span>
            <button
              type="button"
              className="turn-stop-action"
              aria-label={`Stop ${providerLabel} run`}
              disabled={stopping}
              onClick={props.onStop}
            >
              <span>{stopping ? "Stopping" : "Stop"}</span>
            </button>
          </header>
          <WorkLog
            turn={turn}
            autoCollapse={props.autoCollapseWorkLog}
            reasoningContent={reasoningContent}
            reasoningStreaming={props.streamingChannel === "reasoning"}
            liveContent={liveContent}
            liveContentStreaming={props.streamingChannel === "text"}
            showThinking={props.showThinking}
            projectRoot={props.projectRoot}
            projectId={props.projectId}
            conversationId={props.conversationId}
            defaultCodeWrap={props.defaultCodeWrap}
            onOpenProjectFile={props.onOpenTurnFile}
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
            reasoningStreaming={false}
            liveContent=""
            liveContentStreaming={false}
            showThinking={props.showThinking}
            projectRoot={props.projectRoot}
            projectId={props.projectId}
            conversationId={props.conversationId}
            defaultCodeWrap={props.defaultCodeWrap}
            onOpenProjectFile={props.onOpenTurnFile}
            onBeforeToggle={onBeforeToggle}
            onAfterToggle={onAfterToggle}
          />
        </div>
      ) : null}
      {settledCompactions.map((entry) => (
        <ContextCompactionActivityMarker key={entry.id} activities={entry.activities} />
      ))}
      <SubagentDisclosure
        key={`${props.conversationId}:${turn.id}`}
        conversationId={props.conversationId}
        turnId={turn.id}
        subagents={subagents}
        turns={props.turns}
        onFollowUpSubagent={props.onFollowUpSubagent}
        onStopSubagent={props.onStopSubagent}
        onBeforeToggle={onBeforeToggle}
        onAfterToggle={onAfterToggle}
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
  terminalAnswer: ChatMessage;
}

export function resolveFinalAnswerPresentation(
  turn: Pick<ResponseTurn, "isActive" | "terminalAssistantMessage">,
): FinalAnswerPresentation | null {
  if (turn.isActive) return null;
  const terminalAnswer = turn.terminalAssistantMessage;
  if (!terminalAnswer?.content) return null;
  return {
    content: terminalAnswer.content,
    terminalAnswer,
  };
}

export function FinalAnswerDocument({
  turn,
  props,
}: {
  turn: ResponseTurn;
  props: ResponseTimelineProps;
}): React.JSX.Element | null {
  const presentation = resolveFinalAnswerPresentation(turn);
  useLayoutEffect(() => {
    if (presentation?.content.includes("STREAM_PROVIDER_COMPLETE_")) {
      const sampleNumber = presentation.content.match(
        /STREAM_PROVIDER_COMPLETE_(\d+)_/u,
      )?.[1];
      if (sampleNumber) {
        markTestStreamingStage(`final-markdown-commit:${sampleNumber}`);
      }
    }
  }, [presentation?.content]);
  if (!presentation) return null;

  return (
    <article
      className="message is-assistant turn-final-answer-document is-final-answer"
      aria-label="Final assistant answer"
      data-answer-phase="persisted"
      data-terminal-answer-id={presentation.terminalAnswer.id}
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
      </header>
      <ResponseMarkdown
        content={presentation.content}
        projectRoot={props.projectRoot}
        projectId={props.projectId}
        conversationId={props.conversationId}
        defaultCodeWrap={props.defaultCodeWrap}
        onOpenProjectFile={props.onOpenTurnFile}
      />
    </article>
  );
}

export function SupportingLedgerLayer({
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
  const consolidatesSettledWork = !turn.isActive
    && shouldConsolidateSettledWorkIntoRunDetails(turn);
  const settledWorkStream = useMemo(
    () => consolidatesSettledWork ? buildTurnExecutionStream(turn) : [],
    [consolidatesSettledWork, turn],
  );
  if (turn.isActive) return null;
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
                  onOpenProjectFile={props.onOpenTurnFile}
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
