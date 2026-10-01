import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, ExternalLink, GitMerge, GitPullRequest, GitPullRequestClosed, Link2, Plus, RefreshCw, Unlink, X } from "lucide-react";
import { pullRequestIdentity, pullRequestUrl, type LinkedPullRequest } from "@shared/pull-requests";
import { IconButton, LoadingMark } from "./ui";
import { StackMenu } from "./pull-requests/StackMenu";
import { StackReviewDialog } from "./pull-requests/StackReviewDialog";
import { usePullRequests, type PullRequestRunner } from "./pull-requests/usePullRequests";
import "./WorkspaceSurfaces.css";
import "./pull-requests/PullRequestsSurface.css";
export interface PullRequestsSurfaceProps { conversationId: string; run: PullRequestRunner; disabled: boolean; active: boolean }
function PullRequestIcon({ link }: { link: LinkedPullRequest }): React.JSX.Element {
  const Icon = link.snapshot?.state === "merged" ? GitMerge : link.snapshot?.state === "closed" ? GitPullRequestClosed : GitPullRequest;
  return <Icon size={15} className={`pr-state-icon is-${link.snapshot?.draft ? "draft" : link.snapshot?.state ?? "unknown"}`} aria-label={link.snapshot?.draft ? "Draft" : link.snapshot?.state ?? "Not synced"} />;
}
export function PullRequestsSurface(props: PullRequestsSurfaceProps): React.JSX.Element {
  const { conversationId, disabled } = props;
  const { result, review, error, busy, invoke, dismissReview } = usePullRequests(conversationId, props.run, props.active, disabled);
  const [selected, setSelected] = useState<string | null>(null), [linking, setLinking] = useState(false), [url, setUrl] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null), back = useRef<HTMLButtonElement>(null);
  useEffect(() => { setSelected(null); setLinking(false); setUrl(""); setOpenError(null); }, [conversationId]);
  useEffect(() => { if (linking) input.current?.focus(); }, [linking]);
  useEffect(() => { if (selected) back.current?.focus(); }, [selected]);
  const links = result?.links ?? [], link = links.find((entry) => pullRequestIdentity(entry) === selected) ?? null;
  const choose = (entry: LinkedPullRequest): void => { setSelected(pullRequestIdentity(entry)); setLinking(false); };
  const refresh = (): void => { void invoke({ type: "conversation.prs.refresh", payload: { conversationId } }); };
  const openGitHub = async (entry: LinkedPullRequest): Promise<void> => {
    try { await window.inertia.openExternal(pullRequestUrl(entry)); } catch { setOpenError("GitHub could not be opened. Try again."); }
  };
  const pendingStack = link?.stack && result?.operations.some((operation) => operation.key.repository.toLowerCase() === link.repository.toLowerCase()
    && operation.stackNumber === link.stack!.number && ["running", "pending", "unknown"].includes(operation.state));
  return <section className="workspace-surface pr-surface" aria-label="Linked pull requests">
    <div className="pr-surface-toolbar">
      {link ? <><IconButton ref={back} label="Back to linked pull requests" onClick={() => setSelected(null)}><ArrowLeft size={14} /></IconButton><span className="pr-toolbar-repo" title={link.repository}>{link.repository} <b>#{link.number}</b></span></>
        : <span className="pr-toolbar-count">{links.length ? `${links.length} linked` : "Pull requests"}</span>}
      <span className="pr-toolbar-spacer" />
      <IconButton label="Refresh linked pull requests" onClick={refresh} disabled={disabled || busy || !links.length}>{busy ? <LoadingMark label="Loading pull requests" /> : <RefreshCw size={14} />}</IconButton>
      <IconButton label="Link pull request" onClick={() => setLinking(!linking)} disabled={disabled || busy}><Plus size={15} /></IconButton>
    </div>
    {linking && <form className="pr-link-form" onSubmit={(event) => {
      event.preventDefault(); void invoke({ type: "conversation.prs.link", payload: { conversationId, url } }).then((ok) => {
        if (ok) { setUrl(""); setLinking(false); }
      });
    }}><label htmlFor={`pr-url-${conversationId}`}>GitHub pull request URL</label><div><input id={`pr-url-${conversationId}`} ref={input} value={url} onChange={(event) => setUrl(event.target.value)}
      placeholder="https://github.com/owner/repo/pull/123" type="url" required maxLength={4096} disabled={busy} />
      <button type="submit" className="secondary-button" disabled={busy || disabled || !url.trim()}>Link</button>
      <IconButton label="Cancel linking" disabled={busy} onClick={() => setLinking(false)}><X size={14} /></IconButton></div></form>}
    {(error || openError) && <p role="alert" className="pr-error">{error ?? openError}</p>}
    <div className="pr-content-scroll">
      {!result && busy ? <p className="workspace-surface-empty">Loading pull requests…</p> : !links.length && <div className="pr-empty"><Link2 size={22} /><p>Keep related pull requests with this chat.</p><small>Link from any GitHub repository.</small><button type="button" className="secondary-button" disabled={disabled} onClick={() => setLinking(true)}>Link a pull request</button></div>}
      {link ? <article className="pr-detail">
        <div className="pr-detail-actions"><PullRequestIcon link={link} /><span>{link.snapshot?.draft ? "Draft" : link.snapshot?.state ?? "Not synced"}</span>
          <span className="pr-toolbar-spacer" /><StackMenu key={pullRequestIdentity(link)} link={link} links={links} disabled={disabled || busy || Boolean(pendingStack) || Boolean(link.syncError)} onSelect={choose}
            onAction={(action) => { void invoke({ type: "conversation.stack.prepare", payload: { conversationId, key: { host: link.host, repository: link.repository, number: link.number }, action } }); }} />
          <IconButton label={`Open ${link.repository} pull request ${link.number} on GitHub`} onClick={() => { void openGitHub(link); }}><ExternalLink size={14} /></IconButton></div>
        <h3>{link.snapshot?.title ?? `Pull request #${link.number}`}</h3>
        {link.snapshot && <><p className="pr-branches">{link.snapshot.headBranch}<span>→</span>{link.snapshot.baseBranch}</p>
          <div className="pr-detail-stats"><span className="pr-additions">+{link.snapshot.additions}</span><span className="pr-deletions">−{link.snapshot.deletions}</span><span>by {link.snapshot.author}</span></div>
          <div className="pr-detail-readiness"><p><Check size={14} />{link.snapshot.checks.passed} of {link.snapshot.checks.total} checks passing{!link.snapshot.checks.complete ? " · Partial" : ""}</p>
            <p>{link.snapshot.reviewDecision === "APPROVED" ? "Approved" : link.snapshot.reviewDecision === "CHANGES_REQUESTED" ? "Changes requested" : link.snapshot.reviewDecision === "REVIEW_REQUIRED" ? "Review required" : "No review decision"}{link.snapshot.unresolvedReviews ? ` · ${link.snapshot.unresolvedReviews} unresolved` : ""}</p></div></>}
        {link.syncError && <p role="status" className="pr-error">{link.syncError} Saved details are shown.</p>}
        <button type="button" className="pr-unlink" disabled={busy || disabled || Boolean(pendingStack)} onClick={() => {
          void invoke({ type: "conversation.prs.unlink", payload: { conversationId, key: { host: link.host, repository: link.repository, number: link.number } } }).then((ok) => { if (ok) setSelected(null); });
        }}><Unlink size={13} />Unlink from chat</button>
      </article> : <ul className="pr-link-list">{links.map((entry) => <li key={pullRequestIdentity(entry)}>
        <button type="button" className="pr-link-row" onClick={() => choose(entry)}><PullRequestIcon link={entry} /><span><strong>{entry.snapshot?.title ?? `Pull request #${entry.number}`}</strong>
          <small>{entry.repository} <b>#{entry.number}</b>{entry.stack ? ` · Stack ${entry.stack.number}` : ""}{entry.syncError ? " · Sync unavailable" : ""}</small></span>
          {entry.snapshot && <span className="pr-row-diff"><i className="pr-additions">+{entry.snapshot.additions}</i><i className="pr-deletions">−{entry.snapshot.deletions}</i></span>}</button>
      </li>)}</ul>}
      {result?.operations.filter((operation) => !link || (operation.key.repository.toLowerCase() === link.repository.toLowerCase() && operation.stackNumber === link.stack?.number)).slice(0, 3).map((operation) =>
        <div key={operation.id} className="pr-operation" role="status" data-state={operation.state}><strong>{operation.action === "merge" ? "Merge" : "Rebase"} · {operation.key.repository} · Stack #{operation.stackNumber}</strong><p>{operation.message}</p></div>)}
    </div>
    {result && links.length > 0 && <footer className="pr-surface-footer"><span>{links.filter((entry) => entry.snapshot?.state === "open").length} open · {links.length} linked</span><span>Saved with this chat</span></footer>}
    {review && <StackReviewDialog review={review} busy={busy} error={error} onClose={dismissReview} onConfirm={() => {
      void invoke({ type: "conversation.stack.execute", payload: { conversationId, reviewId: review.id } }).then((ok) => { if (ok) dismissReview(); });
    }} />}
  </section>;
}
export default PullRequestsSurface;
