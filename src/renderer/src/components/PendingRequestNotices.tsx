import { Lock, MessageCircleQuestion } from "lucide-react";
import type { AgentInputRequest } from "@shared/contracts";
import { revealAgentInputRequest, revealSecretRequest } from "../utils/agentInputNavigation";
import { secretRequestElementId, type SecretRequestMessage } from "../utils/response-timeline/secretRequests";

export function PendingRequestNotices({
  inputRequest,
  secretRequest,
  onReveal,
}: {
  inputRequest: AgentInputRequest | null;
  secretRequest: SecretRequestMessage | null;
  onReveal: (reveal: () => boolean) => void;
}): React.JSX.Element {
  const secretRequestId = secretRequest?.secretRequest.requestId;
  return (
    <>
      {inputRequest && (
        <div className="pending-input-notice" role="status" aria-live="polite">
          <MessageCircleQuestion size={14} aria-hidden="true" />
          <span>
            <strong>Agent needs your answer</strong>
            <small>{inputRequest.questions.length === 1
              ? "1 question is waiting"
              : `${inputRequest.questions.length} questions are waiting`}</small>
          </span>
          <button
            type="button"
            aria-controls={`agent-input-request-${inputRequest.id}`}
            onClick={() => onReveal(() => revealAgentInputRequest(inputRequest.id))}
          >
            Answer
          </button>
        </div>
      )}
      {secretRequestId && (
        <div className="pending-input-notice is-secret" role="status" aria-live="polite" data-secret-request-notice="">
          <Lock size={14} aria-hidden="true" />
          <span>
            <strong>Agent is asking for a secret</strong>
            <small>Enter it in the private card, not here</small>
          </span>
          <button
            type="button"
            aria-controls={secretRequestElementId(secretRequestId)}
            onClick={() => onReveal(() => revealSecretRequest(secretRequestId))}
          >
            Enter secret
          </button>
        </div>
      )}
    </>
  );
}
