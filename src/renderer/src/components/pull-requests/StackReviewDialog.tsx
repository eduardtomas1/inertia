import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { CircleAlert, GitMerge, RefreshCw, TriangleAlert } from "lucide-react";
import type { StackReview } from "@shared/pull-requests";
import { captureModalFocus, trapModalFocus } from "../../utils/modalFocus";
import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";

export function StackReviewDialog({ review, busy, error, onConfirm, onClose }: {
  review: StackReview; busy: boolean; error: string | null; onConfirm(): void; onClose(): void;
}): React.JSX.Element {
  const cancel = useRef<HTMLButtonElement>(null);
  const ids = useId();
  useNativePreviewSuspension(true);
  useEffect(() => {
    const restore = captureModalFocus(false);
    cancel.current?.focus();
    return restore;
  }, []);
  const merging = review.action === "merge";
  const count = `${review.layers.length} ${review.layers.length === 1 ? "layer" : "layers"}`;
  const blocked = review.blockers.length > 0;
  const Icon = merging ? GitMerge : RefreshCw;
  return createPortal(<div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.currentTarget === event.target && !busy) onClose();
  }}>
    <section className="commit-dialog pr-review" role="dialog" aria-modal="true" aria-labelledby={`${ids}-title`} aria-describedby={`${ids}-consequence`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (!busy) onClose();
        } else trapModalFocus(event, event.currentTarget);
      }}>
      <header>
        <span className="dialog-icon"><Icon size={18} strokeWidth={1.75} aria-hidden="true" /></span>
        <div>
          <h2 id={`${ids}-title`}>{merging ? "Merge" : "Rebase"} stack #{review.stack.number}</h2>
          <p>{review.key.repository} · {count} {merging ? `into ${review.stack.base}` : `on ${review.stack.base}`}</p>
        </div>
      </header>
      <p id={`${ids}-consequence`} className="pr-review-consequence">
        {merging ? `GitHub merges these ${count} through #${review.key.number}. A merge cannot be undone from Inertia.`
          : "GitHub rebases these branches from the bottom layer up. Inertia cannot restore the old branches, and earlier updates stay if a later layer fails."}
      </p>
      <ol className="pr-review-layers" aria-label={merging ? "Layers to merge" : "Layers to rebase"}>
        {review.layers.map((layer) => <li key={layer.number}>
          <strong>#{layer.number} {layer.snapshot.title}</strong>
          <span>{layer.snapshot.headBranch} → {layer.snapshot.baseBranch}</span>
          <small><code>{layer.snapshot.head.slice(0, 8)}</code> · {layer.snapshot.checks.passed} of {layer.snapshot.checks.total} checks passing
            {layer.snapshot.reviewDecision === "APPROVED" ? " · Approved" : ""}</small>
        </li>)}
      </ol>
      {blocked && <div className="pr-notice pr-review-blockers">
        <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
        <div>
          <strong>Resolve these on GitHub, then review the stack again</strong>
          <ul aria-label="Stack blockers">{review.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
        </div>
      </div>}
      {error && <p role="alert" className="pr-error"><CircleAlert size={14} strokeWidth={1.75} aria-hidden="true" />{error}</p>}
      <p className="pr-review-note">{merging ? "GitHub branch rules apply. Revisions and stack order are checked again before merging."
        : "The local checkout stays unchanged. Revisions and branch permissions are checked before updates."}</p>
      <footer>
        <button ref={cancel} type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="primary-button dialog-primary pr-review-confirm" aria-disabled={busy || blocked || undefined}
          onClick={() => { if (!busy && !blocked) onConfirm(); }}>
          <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="pr-review-label">
            <span data-active={!busy} aria-hidden={busy}>{merging ? "Merge" : "Rebase"} {count}</span>
            <span data-active={busy} aria-hidden={!busy}>{merging ? "Merging…" : "Rebasing…"}</span>
          </span>
        </button>
      </footer>
    </section>
  </div>, document.body);
}
