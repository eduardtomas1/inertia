import { memo } from "react";
import type { SentToUserMessage } from "@shared/send-to-user";
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
  projectId,
  conversationId,
  defaultCodeWrap,
  onOpenProjectFile,
  showTime = false,
}: {
  message: SentToUserMessage;
  projectRoot: string;
  projectId: string;
  conversationId: string;
  defaultCodeWrap: boolean;
  onOpenProjectFile: (path: string) => void;
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
        projectId={projectId}
        conversationId={conversationId}
        defaultCodeWrap={defaultCodeWrap}
        onOpenProjectFile={onOpenProjectFile}
      />
      {showTime && <TurnBlockTime createdAt={message.createdAt} />}
    </article>
  );
});
