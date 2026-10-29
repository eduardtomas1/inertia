import { memo, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Eye, EyeOff, Lock, ShieldCheck } from "lucide-react";
import type { SecretRequestReference } from "@shared/agent-secrets";
import { composerFocusRestorer } from "../../utils/composerFocusRestore";
import {
  SECRET_REQUEST_LABEL,
  SECRET_REQUEST_PLACEHOLDER,
  secretRequestAnnouncement,
  secretRequestElementId,
  secretRequestFootnote,
  secretRequestStatusText,
  secretSaveFailureMessage,
  secretValueIssue,
  type SecretRequestMessage,
} from "../../utils/response-timeline/secretRequests";
import { claimSecretRequestAutoFocus, SecretRequestContext } from "./secretRequestContext";
import "./SecretRequestCard.css";

const COMPOSER_TEXTAREA = 'section[aria-label="Message composer"] textarea';
const DECLINE_FAILED = "Couldn't decline. Try again.";
const REVOKE_FAILED = "Couldn't revoke. Try again.";

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

function PendingSecretForm({
  reference,
  conversationId,
  titleId,
  save,
  onDecline,
}: {
  reference: SecretRequestReference;
  conversationId: string;
  titleId: string;
  save: NonNullable<ReturnType<typeof bridgeSave>>;
  onDecline: () => Promise<void>;
}): React.JSX.Element {
  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState<"saving" | "declining" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const descriptionId = useId();
  const footnoteId = useId();
  const errorId = useId();
  const { requestId } = reference;

  useEffect(() => {
    const input = inputRef.current;
    if (!input || !claimSecretRequestAutoFocus(requestId)) return;
    const composer = input.closest(".chat-workspace")?.querySelector<HTMLTextAreaElement>(COMPOSER_TEXTAREA);
    const active = document.activeElement;
    const idle = !active || active === document.body || active === composer;
    if (composer && composer.value.trim() === "" && idle) input.focus({ preventScroll: true });
  }, [requestId]);

  const run = async (kind: "saving" | "declining", operation: () => Promise<void>, failure: (error: unknown) => string): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(kind);
    setError(null);
    try {
      await operation();
      return true;
    } catch (caught) {
      setError(failure(caught));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const secret = value.trim();
    if (!secret || busyRef.current) return;
    const issue = secretValueIssue(secret);
    if (issue) {
      setError(issue);
      return;
    }
    const restoreFocus = composerFocusRestorer(formRef.current);
    const saved = await run("saving", async () => {
      await save({ conversationId, requestId, secret });
    }, secretSaveFailureMessage);
    if (!saved) return;
    setValue("");
    setRevealed(false);
    restoreFocus();
  };

  const decline = async (): Promise<void> => {
    const restoreFocus = composerFocusRestorer(formRef.current);
    if (await run("declining", onDecline, () => DECLINE_FAILED)) restoreFocus();
  };

  const focusInput = (event: React.MouseEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement;
    if (target.closest("input, button, a, textarea, select")) return;
    if (window.getSelection()?.isCollapsed === false) return;
    inputRef.current?.focus();
  };

  return (
    <div className="secret-request-body" onClick={focusInput}>
      <p id={descriptionId} className="secret-request-description">{reference.description}</p>
      <form
        ref={formRef}
        className="secret-request-form"
        autoComplete="off"
        noValidate
        aria-busy={busy !== null}
        onSubmit={(event) => void submit(event)}
      >
        <div className="secret-request-field" data-invalid={error ? "true" : undefined}>
          <input
            ref={inputRef}
            type={revealed ? "text" : "password"}
            name="agent-secret"
            value={value}
            placeholder={SECRET_REQUEST_PLACEHOLDER}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            readOnly={busy !== null}
            aria-labelledby={titleId}
            aria-describedby={[descriptionId, error ? errorId : null, footnoteId].filter(Boolean).join(" ")}
            aria-invalid={error ? true : undefined}
            data-1p-ignore=""
            data-lpignore="true"
            data-bwignore=""
            onChange={(event) => {
              setValue(event.currentTarget.value);
              if (error) setError(null);
            }}
          />
          <button
            type="button"
            className="secret-request-reveal"
            aria-pressed={revealed}
            aria-label={revealed ? "Hide secret" : "Show secret"}
            onClick={() => setRevealed((current) => !current)}
          >
            {revealed ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
          </button>
        </div>
        {error && <p id={errorId} className="secret-request-error" role="alert">{error}</p>}
        <div className="secret-request-actions">
          <button type="submit" className="primary-button" disabled={busy !== null || !value.trim()}>
            {busy === "saving" ? "Saving…" : "Save securely"}
          </button>
          <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void decline()}>
            Decline
          </button>
        </div>
        <p id={footnoteId} className="secret-request-footnote">
          <ShieldCheck size={14} aria-hidden="true" />
          <span>{secretRequestFootnote(reference.ttlHours)}</span>
        </p>
      </form>
    </div>
  );
}

function SettledSecretRow({
  reference,
  onRevoke,
}: {
  reference: SecretRequestReference;
  onRevoke?: () => Promise<void>;
}): React.JSX.Element {
  const [revoking, setRevoking] = useState(false);
  const [failed, setFailed] = useState(false);
  const saved = reference.status === "saved";
  const now = useMinuteClock(saved);
  const revoke = (): void => {
    if (!onRevoke || revoking) return;
    setRevoking(true);
    setFailed(false);
    void onRevoke().catch(() => setFailed(true)).finally(() => setRevoking(false));
  };
  return (
    <>
      {saved
        ? <ShieldCheck className="secret-request-row-icon" size={14} aria-hidden="true" />
        : <Lock className="secret-request-row-icon" size={14} aria-hidden="true" />}
      <span className="secret-request-row-copy">
        <strong>{reference.title}</strong>
        <span aria-hidden="true">·</span>
        <span className="secret-request-row-status">{failed ? REVOKE_FAILED : secretRequestStatusText(reference, now)}</span>
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

export const SecretRequestCard = memo(
  SecretRequestCardComponent,
  (previous, next) => previous.message === next.message,
);

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
