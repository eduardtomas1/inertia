import { memo, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Lock, ShieldCheck } from "lucide-react";
import type { SecretRequestReference } from "@shared/agent-secrets";
import {
  SECRET_REQUEST_LABEL,
  secretRequestAnnouncement,
  secretRequestElementId,
  secretRequestStatusText,
  secretRevokeFailure,
  type SecretRequestMessage,
} from "../../utils/response-timeline/secretRequests";
import { SecretRequestContext } from "./secretRequestContext";
import { PendingSecretForm } from "./PendingSecretForm";
import "./SecretRequestCard.css";

function useMinuteClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function useTransitionAnnouncement(reference: SecretRequestReference): string {
  const previous = useRef(reference.status);
  const [announcement, setAnnouncement] = useState("");
  useLayoutEffect(() => {
    if (previous.current === reference.status) return;
    previous.current = reference.status;
    setAnnouncement(secretRequestAnnouncement(reference.status));
  }, [reference.status]);
  return announcement;
}

function bridgeSave(): typeof window.inertia.saveAgentSecret | null {
  const save = (window as Partial<Window>).inertia?.saveAgentSecret;
  return typeof save === "function" ? save : null;
}

function SettledSecretRow({
  reference,
  onRevoke,
}: {
  reference: SecretRequestReference;
  onRevoke?: () => Promise<void>;
}): React.JSX.Element {
  const [revoking, setRevoking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const saved = reference.status === "saved";
  const now = useMinuteClock(saved);
  const revoke = (): void => {
    if (!onRevoke || revoking) return;
    setRevoking(true);
    setFailure(null);
    void onRevoke().catch((error: unknown) => setFailure(secretRevokeFailure(error))).finally(() => setRevoking(false));
  };
  return (
    <>
      {saved
        ? <ShieldCheck className="secret-request-row-icon" size={14} aria-hidden="true" />
        : <Lock className="secret-request-row-icon" size={14} aria-hidden="true" />}
      <span className="secret-request-row-copy">
        <strong>{reference.title}</strong>
        <span aria-hidden="true">·</span>
        <span className="secret-request-row-status">{secretRequestStatusText(reference, now)}</span>
      </span>
      {saved && onRevoke && (
        <button
          type="button"
          className="secret-request-revoke"
          aria-label={`Revoke ${reference.title}`}
          aria-busy={revoking || undefined}
          disabled={revoking}
          onClick={revoke}
        >
          {revoking ? "Revoking…" : "Revoke"}
        </button>
      )}
      {saved && failure && <p className="secret-request-row-error" role="alert">{failure}</p>}
    </>
  );
}

function SecretRequestCardComponent({ message }: { message: SecretRequestMessage }): React.JSX.Element {
  const context = useContext(SecretRequestContext);
  const reference = message.secretRequest;
  const announcement = useTransitionAnnouncement(reference);
  const titleId = useId();
  const save = bridgeSave();
  const onCommand = context.onCommand;
  const conversationId = context.conversationId || message.conversationId;
  const answerable = Boolean(onCommand && save);
  const interactive = reference.status === "pending" && answerable;
  const decline = async (): Promise<void> => {
    if (!onCommand) return;
    await onCommand("secret-request.decline", {
      type: "secret-request.decline",
      payload: { conversationId, requestId: reference.requestId },
    });
  };
  const revoke = onCommand
    ? async (): Promise<void> => {
        await onCommand("secret-request.revoke", {
          type: "secret-request.revoke",
          payload: { requestId: reference.requestId },
        });
      }
    : undefined;
  return (
    <section
      id={secretRequestElementId(reference.requestId)}
      className={interactive ? "secret-request-card is-pending" : "secret-request-card is-settled"}
      role={reference.status === "pending" ? "region" : undefined}
      aria-labelledby={reference.status === "pending" ? titleId : undefined}
      data-secret-request-state={reference.status}
      data-secret-request-mode={reference.status === "pending" && !answerable ? "read-only" : undefined}
    >
      <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
      {interactive && save ? (
        <>
          <div className="secret-request-heading">
            <span className="secret-request-mark" aria-hidden="true"><Lock size={16} /></span>
            <span className="secret-request-titles">
              <small>{SECRET_REQUEST_LABEL}</small>
              <h3 id={titleId}>{reference.title}</h3>
            </span>
          </div>
          <PendingSecretForm
            key={reference.requestId}
            reference={reference}
            conversationId={conversationId}
            titleId={titleId}
            save={save}
            onDecline={decline}
          />
        </>
      ) : (
        <>
          <span id={titleId} className="visually-hidden">{`${SECRET_REQUEST_LABEL}: ${reference.title}`}</span>
          <SettledSecretRow reference={reference} onRevoke={answerable ? revoke : undefined} />
        </>
      )}
    </section>
  );
}

export const SecretRequestCard = memo(SecretRequestCardComponent);

export function SecretRequestList({ messages }: { messages: readonly SecretRequestMessage[] }): React.JSX.Element | null {
  if (messages.length === 0) return null;
  return (
    <div className="secret-request-list" role="list" aria-label="Secret requests">
      {messages.map((message) => (
        <div role="listitem" key={message.secretRequest.requestId}>
          <SecretRequestCard message={message} />
        </div>
      ))}
    </div>
  );
}
