import { MessagesSquare, PanelTopOpen } from "lucide-react";
import type { AgentInputRequest } from "@shared/contracts";

import type { ConversationContextSourceOption } from "../conversation-context/types";

const NO_CONTEXT_SOURCES: readonly ConversationContextSourceOption[] = [];

export interface DetachedContextRequests {
  inputRequests: AgentInputRequest[];
  contextSources: readonly ConversationContextSourceOption[];
  mainWindowReviewPending: boolean;
}

export function detachedContextRequests(
  pendingInputs: AgentInputRequest[],
): DetachedContextRequests {
  const contextSources: ConversationContextSourceOption[] = [];
  const inputRequests = pendingInputs.filter((request) => {
    const context = request.conversationContextRequest;
    if (!context) return true;
    const source = context.requestedSource;
    if (
      !source
      || context.requestedSourceConversationId === null
      || source.conversationId !== context.requestedSourceConversationId
    ) return false;
    if (!contextSources.some(({ conversationId }) => conversationId === source.conversationId)) {
      contextSources.push({
        conversationId: source.conversationId,
        conversationTitle: source.conversationTitle,
        projectName: source.projectName,
        workspaceLabel: source.workspaceLabel,
        targetWorkspaceLabel: source.targetWorkspaceLabel,
        workspaceRelation: source.workspaceRelation,
        archived: false,
      });
    }
    return true;
  });
  const mainWindowReviewPending = inputRequests.length !== pendingInputs.length;
  return {
    inputRequests: mainWindowReviewPending ? inputRequests : pendingInputs,
    contextSources: contextSources.length > 0 ? contextSources : NO_CONTEXT_SOURCES,
    mainWindowReviewPending,
  };
}

export function DetachedContextHandoffNotice({
  onReturnToMain,
}: {
  onReturnToMain: () => void;
}): React.JSX.Element {
  return (
    <div
      className="pending-input-notice detached-chat-context-handoff"
      role="status"
      aria-live="polite"
    >
      <MessagesSquare size={14} aria-hidden="true" />
      <span>
        <strong>Agent requested chat context</strong>
        <small>Review this request in the main window.</small>
      </span>
      <button type="button" onClick={onReturnToMain}>
        <PanelTopOpen size={14} aria-hidden="true" />
        Return to main
      </button>
    </div>
  );
}
