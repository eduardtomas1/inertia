import { useEffect, useRef } from "react";
import { TriangleAlert } from "lucide-react";

import type { WatcherLinkView } from "@shared/watcher";
import { watcherPauseText } from "../../utils/watcherCopy";

export interface WatcherNoticesProps {
  link: WatcherLinkView;
  changedPaths: readonly string[];
  customBackend: boolean;
  confirmingResume: boolean;
  resuming: boolean;
  onResumeRequest: () => void;
  onConfirmResume: () => void;
  onCancelResume: () => void;
}

/**
 * Pause and guard notices under the bar. Only the write-detected banner is an
 * alert: it lists the unexplained paths and asks before resuming, because a
 * resume there means "these were my edits".
 */
export function WatcherNotices({
  link,
  changedPaths,
  customBackend,
  confirmingResume,
  resuming,
  onResumeRequest,
  onConfirmResume,
  onCancelResume,
}: WatcherNoticesProps): React.JSX.Element | null {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmingResume) confirmRef.current?.focus({ preventScroll: true });
  }, [confirmingResume]);
  const paused = link.status === "paused";
  const writeDetected = paused && link.pauseReason === "write-detected";
  if (!paused && !customBackend) return null;
  return (
    <div className="watcher-notices">
      {writeDetected ? (
        <div className="watcher-notice is-danger" role="alert">
          <p className="watcher-notice-title">
            <TriangleAlert size={14} aria-hidden="true" />
            Files changed that no running agent accounts for
          </p>
          {changedPaths.length > 0 && (
            <ul className="watcher-notice-paths" aria-label="Changed paths">
              {changedPaths.map((path) => <li key={path}><code>{path}</code></li>)}
            </ul>
          )}
          {link.pauseDetail && <p>{link.pauseDetail}</p>}
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
                <button type="button" className="secondary-button" onClick={onCancelResume}>Cancel</button>
                <button ref={confirmRef} type="button" className="primary-button" disabled={resuming} onClick={onConfirmResume}>
                  Resume
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="secondary-button" disabled={resuming} onClick={onResumeRequest}>
              Resume…
            </button>
          )}
        </div>
      ) : paused ? (
        <div className="watcher-notice">
          <p className="watcher-notice-title">Paused</p>
          <p>{watcherPauseText(link.pauseReason, link.pauseDetail)}</p>
          <button type="button" className="secondary-button" disabled={resuming} onClick={onResumeRequest}>
            Resume
          </button>
        </div>
      ) : null}
      {customBackend && (
        <p className="watcher-notice is-quiet">
          Can read the watched chat: no (custom backend). It reviews only what each check sends.
        </p>
      )}
    </div>
  );
}
