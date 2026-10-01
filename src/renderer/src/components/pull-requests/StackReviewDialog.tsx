import { useEffect, useRef } from "react";
import { GitMerge, RefreshCw, X } from "lucide-react";
import type { StackReview } from "@shared/pull-requests";
import { captureModalFocus, trapModalFocus } from "../../utils/modalFocus";
import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import { IconButton, LoadingMark } from "../ui";

export function StackReviewDialog({ review, busy, error, onConfirm, onClose }: {
  review: StackReview; busy: boolean; error: string | null; onConfirm(): void; onClose(): void;
}): React.JSX.Element {
  const cancel = useRef<HTMLButtonElement>(null);
  useNativePreviewSuspension(true);
  useEffect(() => {
    const restore = captureModalFocus(false);
    cancel.current?.focus();
    return restore;
  }, []);
  const merging = review.action === "merge";
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.currentTarget === event.target && !busy) onClose();
  }}>
    <section className="commit-dialog pr-stack-review" role="dialog" aria-modal="true" aria-labelledby="pr-stack-review-title"
      onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.preventDefault(); onClose(); } else trapModalFocus(event, event.currentTarget); }}>
      <header>
        <span className="dialog-icon">{merging ? <GitMerge size={18} /> : <RefreshCw size={18} />}</span>
        <div><h2 id="pr-stack-review-title">{merging ? "Merge stack" : "Rebase stack"}</h2><p>{review.key.repository} · Stack #{review.stack.number}</p></div>
        <IconButton label="Close stack review" disabled={busy} onClick={onClose}><X size={16} /></IconButton>
      </header>
      <p className="pr-review-description">{merging ? `Merge ${review.layers.length} ${review.layers.length === 1 ? "layer" : "layers"} through #${review.key.number} on GitHub.`
        : "Rebase these branches from bottom to top on GitHub. Earlier updates remain if a later layer fails."}</p>
      <ol className="pr-review-layers">{review.layers.map((layer) => <li key={layer.number}>
        <strong>#{layer.number} {layer.snapshot.title}</strong>
        <span>{layer.snapshot.headBranch} → {layer.snapshot.baseBranch}</span>
        <small>{layer.snapshot.head.slice(0, 8)} · {layer.snapshot.checks.passed}/{layer.snapshot.checks.total} checks passing
          {layer.snapshot.reviewDecision === "APPROVED" ? " · Approved" : ""}</small>
      </li>)}</ol>
      {review.blockers.length > 0 && <ul className="pr-review-blockers" aria-label="Stack blockers">{review.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}
      {error && <p role="alert" className="pr-error">{error}</p>}
      <p className="commit-stage-note">{merging ? "GitHub branch rules apply. Revisions and stack order are checked again before merging." : "The local checkout stays unchanged. Revisions and branch permissions are checked before updates."}</p>
      <footer><button ref={cancel} type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="primary-button dialog-primary" disabled={busy || review.blockers.length > 0} onClick={onConfirm}>
          {busy ? <LoadingMark label="Updating stack" /> : merging ? <GitMerge size={15} /> : <RefreshCw size={15} />}
          <span>{merging ? "Merge reviewed layers" : "Rebase reviewed stack"}</span>
        </button></footer>
    </section>
  </div>;
}
