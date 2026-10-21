import { useEffect, useLayoutEffect, useRef } from "react";
import { TriangleAlert } from "lucide-react";

import type { WatcherLinkView } from "@shared/watcher";
import { watcherPauseText } from "../../utils/watcherCopy";

interface WatcherNoticesProps {
  link: WatcherLinkView;
  changedPaths: readonly string[];
  customBackend: boolean;
  confirmingResume: boolean;
  resuming: boolean;
  resumeBlocked: string | null;
  onResumeRequest: () => void;
  onConfirmResume: () => void;
  onCancelResume: () => void;
}

export function WatcherNotices({
  link,
  changedPaths,
  customBackend,
  confirmingResume,
  resuming,
  resumeBlocked,
  onResumeRequest,
  onConfirmResume,
  onCancelResume,
}: WatcherNoticesProps): React.JSX.Element | null {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const requestRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(confirmingResume);
  useEffect(() => {
    if (confirmingResume) cancelRef.current?.focus({ preventScroll: true });
  }, [confirmingResume]);
  useLayoutEffect(() => {
    const ended = wasConfirming.current && !confirmingResume;
    wasConfirming.current = confirmingResume;
    if (!ended) return;
    const active = document.activeElement;
    if (requestRef.current && (active === null || active === document.body || !active.isConnected)) {
      requestRef.current.focus({ preventScroll: true });
    }
  }, [confirmingResume]);
  const reason = link.status === "paused" ? link.pauseReason : null;
  const paused = reason !== null && (reason !== "user" || resumeBlocked !== null);
  const writeDetected = reason === "write-detected";
  if (!paused && !customBackend) return null;
  const pauseText = reason === null ? "" : watcherPauseText(reason, link.pauseDetail);
  const resumeButton = (label: string) => resumeBlocked ? (
    <p className="watcher-notice-blocked">{resumeBlocked}</p>
  ) : (
    <button
      ref={requestRef}
      type="button"
      className="watcher-text-button is-primary"
      aria-disabled={resuming || undefined}
      onClick={() => { if (!resuming) onResumeRequest(); }}
    >
      {label}
    </button>
  );
  return (
    <div className="watcher-notices">
      {writeDetected ? (
        <div className="watcher-notice is-danger" role="alert">
          <p className="watcher-notice-title">
            <TriangleAlert size={14} aria-hidden="true" />
            Files changed that no running agent accounts for
          </p>
          {changedPaths.length > 0 ? (
            <ul className="watcher-notice-paths" aria-label="Changed paths">
              {changedPaths.map((path) => <li key={path}><code>{path}</code></li>)}
            </ul>
          ) : link.pauseDetail && <p>{link.pauseDetail}</p>}
          {confirmingResume ? (
            <div
              className="watcher-confirm"
              role="group"
              aria-label="Confirm resume"
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                onCancelResume();
              }}
            >
              <p>If you edited these files yourself, resume.</p>
              <div className="watcher-confirm-actions">
                <button ref={cancelRef} type="button" className="secondary-button" onClick={onCancelResume}>Cancel</button>
                <button
                  type="button"
                  className="primary-button"
                  aria-disabled={resuming || undefined}
                  onClick={() => { if (!resuming) onConfirmResume(); }}
                >
                  {resuming ? "Resuming…" : "Resume"}
                </button>
              </div>
            </div>
          ) : resumeButton("Resume…")}
        </div>
      ) : paused ? (
        <div className="watcher-notice">
          <p>{pauseText}</p>
          {resumeBlocked && resumeBlocked !== pauseText && <p className="watcher-notice-blocked">{resumeBlocked}</p>}
        </div>
      ) : null}
      {customBackend && (
        <p className="watcher-notice is-quiet">Custom backend: it sees only what each check sends.</p>
      )}
    </div>
  );
}
