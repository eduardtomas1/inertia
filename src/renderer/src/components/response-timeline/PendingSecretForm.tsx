import { useEffect, useId, useRef, useState } from "react";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";
import type { SecretRequestReference } from "@shared/agent-secrets";
import { composerFocusRestorer } from "../../utils/composerFocusRestore";
import {
  SECRET_REQUEST_PLACEHOLDER,
  secretRequestFootnote,
  secretSaveFailureMessage,
  secretValueIssue,
} from "../../utils/response-timeline/secretRequestForm";
import { claimSecretRequestAutoFocus } from "./secretRequestContext";

const COMPOSER_TEXTAREA = 'section[aria-label="Message composer"] textarea';
const DECLINE_FAILED = "Couldn't decline. Try again.";

type SaveAgentSecret = typeof window.inertia.saveAgentSecret;

export function PendingSecretForm({
  reference,
  conversationId,
  titleId,
  save,
  onDecline,
}: {
  reference: SecretRequestReference;
  conversationId: string;
  titleId: string;
  save: SaveAgentSecret;
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
