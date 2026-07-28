import { AlertCircle, MessageSquareX, RefreshCw } from "lucide-react";

type ConversationDetailStateProps = {
  embedded?: boolean;
  state: "missing" | "deleted" | "failed";
  message?: string;
  onRetry: () => void;
};

export function ConversationDetailState({
  embedded = false,
  state,
  message,
  onRetry,
}: ConversationDetailStateProps): React.JSX.Element {
  const deleted = state === "deleted";
  const failed = state === "failed";
  const Root = embedded ? "section" : "main";
  return (
    <Root className="chat-workspace centered-state" role={failed ? "alert" : "status"}>
      {failed ? <AlertCircle size={24} /> : <MessageSquareX size={24} />}
      <h2>{deleted ? "This chat was deleted." : failed ? "This chat could not be loaded." : "This chat is no longer available."}</h2>
      <p>{message ?? (deleted
        ? "Choose another chat from the project navigation."
        : failed
          ? "The local runtime kept the rest of your workspace available."
          : "It may have been removed from this workspace.")}</p>
      {failed && (
        <button type="button" className="secondary-button" onClick={onRetry}>
          <RefreshCw size={15} />
          <span>Try again</span>
        </button>
      )}
    </Root>
  );
}
