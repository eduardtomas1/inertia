import { memo } from "react";
import type { SentToUserMessage } from "@shared/send-to-user";
import type { WorkspaceMediaPreviewTarget } from "@shared/workspace-media-preview";
import type { WorkspaceFileLocation } from "../../utils/workspaceFileReference";
import { ResponseMarkdown } from "../ResponseMarkdown";
import { useTaskCreator } from "../tasks/taskCreation";
import { messageContextMenu } from "./messageContextMenu";
import { TurnBlockTime } from "./TurnFold";

/**
 * Markdown the agent showed the user mid-turn with `inertia_send_to_user`,
 * drawn as the agent's own words at its place in the turn. It is never the
 * turn's final answer, so it carries no answer anchor.
 */
export const SentMessageRow = memo(function SentMessageRow({
  message,
  projectRoot,
  projectBaseRoot,
  projectId,
  conversationId,
  defaultCodeWrap,
  onOpenProjectFile,
  onPreviewMedia,
  showTime = false,
}: {
  message: SentToUserMessage;
  projectRoot: string;
  projectBaseRoot?: string;
  projectId: string;
  conversationId: string;
  defaultCodeWrap: boolean;
  onOpenProjectFile: (
    path: string,
    location?: WorkspaceFileLocation,
    literalPath?: boolean,
    headingId?: string,
  ) => void;
  onPreviewMedia?: (target: WorkspaceMediaPreviewTarget) => void;
  showTime?: boolean;
}): React.JSX.Element {
  const taskCreator = useTaskCreator();
  return (
    <article
      className={`turn-commentary-row is-answer turn-sent-message-row${showTime ? " has-block-time" : ""}`}
      aria-label="Agent message"
      data-sent-message-id={message.id}
      data-message-search-id={message.id}
      tabIndex={-1}
      {...messageContextMenu({ conversationId: message.conversationId, role: "assistant" }, message.content, taskCreator)}
    >
      <p className="turn-sent-message-label">Sent mid-turn</p>
      <ResponseMarkdown
        content={message.content}
        projectRoot={projectRoot}
        projectBaseRoot={projectBaseRoot}
        projectId={projectId}
        conversationId={conversationId}
        defaultCodeWrap={defaultCodeWrap}
        onOpenProjectFile={onOpenProjectFile}
        onPreviewMedia={onPreviewMedia}
      />
      {showTime && <TurnBlockTime createdAt={message.createdAt} />}
    </article>
  );
});
