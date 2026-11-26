import { Lock, MessageCircleQuestion } from "lucide-react";
import type { AgentInputRequest } from "@shared/contracts";
import { revealAgentInputRequest, revealSecretRequest } from "../utils/agentInputNavigation";
import {
  SECRET_REQUEST_READ_ONLY,
  secretRequestElementId,
  type SecretRequestMessage,
} from "../utils/response-timeline/secretRequests";

function hasSecretBridge(): boolean {
  return typeof (window as Partial<Window>).inertia?.saveAgentSecret === "function";
}

export function PendingRequestNotices({
  inputRequest,
  secretRequest,
  secretRequestAnswerable = hasSecretBridge(),
  onReveal,
}: {
  inputRequest: AgentInputRequest | null;
  secretRequest: SecretRequestMessage | null;
  secretRequestAnswerable?: boolean;
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
        <div
          className="pending-input-notice is-secret"
          role="status"
          aria-live="polite"
          data-secret-request-notice=""
          data-secret-request-mode={secretRequestAnswerable ? undefined : "read-only"}
        >
          <Lock size={14} aria-hidden="true" />
          <span>
            <strong>Agent is asking for a secret</strong>
            <small>{secretRequestAnswerable ? "Enter it in the private card, not here" : SECRET_REQUEST_READ_ONLY}</small>
          </span>
          <button
            type="button"
            aria-controls={secretRequestElementId(secretRequestId)}
            onClick={() => onReveal(() => revealSecretRequest(secretRequestId))}
          >
            {secretRequestAnswerable ? "Enter secret" : "View request"}
          </button>
        </div>
      )}
    </>
  );
}
