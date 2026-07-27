import { useRef } from "react";
import {
  Paperclip,
  RotateCcw,
} from "lucide-react";
import clsx from "clsx";
import type { ChatMessage } from "@shared/contracts";
import { formatClockTime } from "../../lib/format";
import { finalAnswerIdentityLabel } from "../../utils/finalAnswerIdentity";
import {
  buildTurnExecutionStream,
  shouldConsolidateSettledWorkIntoRunDetails,
  type ResponseTurn,
} from "../../utils/responseTimeline";
import { ApprovalCard, InputRequestCard } from "../AgentRequestCard";
import { ResponseMarkdown } from "../ResponseMarkdown";
import { SubagentDisclosure } from "../SubagentDisclosure";
import {
  LiveElapsed,
  SettledWorkDetails,
  WorkLog,
} from "./activity";
import {
  ChangedFilesSummary,
  shouldShowChangedFilesSummary,
} from "./changedFiles";
import { TurnMetadata } from "./metadata";
import type { ResponseTimelineProps } from "./types";

export function UserRequestLayer({
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

export function AgentExecutionLayer({
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

export function FinalAnswerDocument({
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
