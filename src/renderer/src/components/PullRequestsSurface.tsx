import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, CircleAlert, ExternalLink, Plus, RefreshCw, TriangleAlert } from "lucide-react";
import { pullRequestIdentity, pullRequestUrl, type LinkedPullRequest } from "@shared/pull-requests";
import { IconButton, LoadingMark } from "./ui";
import { DiffCount, PullRequestIcon, Readiness, StackActions, pullRequestState } from "./pull-requests/PullRequestParts";
import { StackMenu } from "./pull-requests/StackMenu";
import { StackReviewDialog } from "./pull-requests/StackReviewDialog";
import { usePullRequests, type PullRequestRunner } from "./pull-requests/usePullRequests";
import "./WorkspaceSurfaces.css";
import "./pull-requests/PullRequestsSurface.css";

export interface PullRequestsSurfaceProps { conversationId: string; run: PullRequestRunner; disabled: boolean; active: boolean }

const withoutIncident = (message: string): string => message.replace(/ \[incident:[0-9a-f-]{36}\]$/iu, "");

function rowMeta(entry: LinkedPullRequest): string {
  const state = pullRequestState(entry);
  return [`${entry.repository} #${entry.number}`, entry.stack ? `Stack #${entry.stack.number}` : null,
    state.key === "open" || entry.syncError ? null : state.label].filter(Boolean).join(" · ");
}

export function PullRequestsSurface(props: PullRequestsSurfaceProps): React.JSX.Element {
  const { conversationId, disabled } = props;
  const { result, review, error, busy, invoke, dismissReview } = usePullRequests(conversationId, props.run, props.active, disabled);
  const [selected, setSelected] = useState<string | null>(null), [linking, setLinking] = useState(false), [url, setUrl] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null), back = useRef<HTMLButtonElement>(null), linkButton = useRef<HTMLButtonElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>()), returnTo = useRef<string | null>(null);
  const ids = useId();
  useEffect(() => { returnTo.current = null; setSelected(null); setLinking(false); setUrl(""); setOpenError(null); }, [conversationId]);
  useEffect(() => { if (linking) input.current?.focus(); }, [linking]);
  useEffect(() => {
    if (selected) { back.current?.focus(); return; }
    if (returnTo.current === null) return;
    (rows.current.get(returnTo.current) ?? linkButton.current)?.focus();
    returnTo.current = null;
  }, [selected]);
  const links = result?.links ?? [], link = links.find((entry) => pullRequestIdentity(entry) === selected) ?? null;
  const unavailable = disabled || busy;
  const choose = (entry: LinkedPullRequest): void => { setSelected(pullRequestIdentity(entry)); setLinking(false); };
  const leave = (): void => { returnTo.current = selected; setSelected(null); };
  const closeForm = (): void => { setLinking(false); linkButton.current?.focus(); };
  const refresh = (): void => { if (!unavailable) void invoke({ type: "conversation.prs.refresh", payload: { conversationId } }); };
  const openGitHub = async (entry: LinkedPullRequest): Promise<void> => {
    try { await window.inertia.openExternal(pullRequestUrl(entry)); } catch { setOpenError("GitHub could not be opened. Try again."); }
  };
  const pendingStack = link?.stack && result?.operations.some((operation) => operation.key.repository.toLowerCase() === link.repository.toLowerCase()
    && operation.stackNumber === link.stack!.number && ["running", "pending", "unknown"].includes(operation.state));
  const operations = (result?.operations ?? []).filter((operation) => !link
    || (operation.key.repository.toLowerCase() === link.repository.toLowerCase() && operation.stackNumber === link.stack?.number)).slice(0, 3);
  const failure = review ? null : error ? withoutIncident(error) : openError;
  const failureNode = failure && <p role="alert" className="pr-error"><CircleAlert size={14} strokeWidth={1.75} aria-hidden="true" />{failure}</p>;
  const refreshButton = links.length > 0 && <IconButton label="Refresh linked pull requests" aria-disabled={unavailable || undefined} onClick={refresh}>
    {busy ? <LoadingMark label="Loading pull requests" /> : <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />}
  </IconButton>;
  const stackReason = pendingStack ? "Check the last stack action first." : link?.syncError ? "Refresh this pull request first."
    : disabled ? "Unavailable while this chat is offline or archived." : busy ? "Updating pull requests…" : null;
  return <section className="workspace-surface pr-surface" aria-label="Linked pull requests">
    <div className="workspace-surface-scroll">
      {link ? <div className="pr-surface-toolbar is-detail">
        <IconButton ref={back} className="pr-back" label="Back to linked pull requests" onClick={leave}><ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" /></IconButton>
        <p className="pr-surface-label" title={`${link.repository} #${link.number}`}>{link.repository} <span className="pr-surface-count">#{link.number}</span></p>
        <div className="pr-surface-actions">
          {refreshButton}
          <IconButton label={`Open ${link.repository} pull request ${link.number} on GitHub`} onClick={() => { void openGitHub(link); }}>
            <ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" />
          </IconButton>
        </div>
      </div> : <div className="pr-surface-toolbar">
        <h2 id={`${ids}-label`} className="pr-surface-label">Linked{links.length > 0 && <> <span className="pr-surface-count">{links.length}</span></>}</h2>
        <div className="pr-surface-actions">
          {refreshButton}
          <button ref={linkButton} type="button" className="workspace-surface-button pr-link-open" aria-expanded={linking} aria-controls={`${ids}-form`}
            aria-disabled={unavailable || undefined} onClick={() => { if (linking) closeForm(); else if (!unavailable) setLinking(true); }}>
            <Plus size={14} strokeWidth={1.75} aria-hidden="true" />Link pull request
          </button>
        </div>
      </div>}
      {linking && !link ? <form id={`${ids}-form`} className="pr-link-form" onSubmit={(event) => {
        event.preventDefault();
        if (unavailable || !url.trim()) return;
        void invoke({ type: "conversation.prs.link", payload: { conversationId, url } }).then((ok) => {
          if (ok) { setUrl(""); closeForm(); }
        });
      }}>
        <label htmlFor={`${ids}-url`}>GitHub pull request URL</label>
        <input id={`${ids}-url`} ref={input} value={url} onChange={(event) => setUrl(event.target.value)} aria-describedby={`${ids}-url-help`}
          placeholder="https://github.com/owner/repo/pull/123" type="url" required maxLength={4096} readOnly={busy} />
        <p id={`${ids}-url-help`} className="pr-link-help">Any GitHub repository. Stacked pull requests are linked with it.</p>
        {failureNode}
        <div className="pr-link-actions">
          <button type="button" className="workspace-surface-button" onClick={closeForm}>Cancel</button>
          <button type="submit" className="pr-link-submit" aria-disabled={unavailable || !url.trim() || undefined}>
            <span data-active={!busy} aria-hidden={busy}>Link</span><span data-active={busy} aria-hidden={!busy}>Linking…</span>
          </button>
        </div>
      </form> : failureNode}
      {!result && busy && <p className="workspace-surface-empty pr-empty">Loading pull requests…</p>}
      {result && !links.length && !linking && <p className="workspace-surface-empty pr-empty">
        No pull requests are linked to this chat. Link one from any GitHub repository to follow its checks and reviews here.
      </p>}
      {!link && <StackActions operations={operations} />}
      {link ? <article className="pr-detail" aria-labelledby={`${ids}-title`}>
        <div className="pr-card">
          <h3 id={`${ids}-title`} className="pr-detail-title">{link.snapshot?.title ?? `Pull request #${link.number}`}</h3>
          <p className={`pr-state is-${pullRequestState(link).key}`}><PullRequestIcon link={link} /><span aria-hidden="true">{pullRequestState(link).label}</span></p>
          {link.snapshot && <>
            <p className="pr-detail-meta pr-branches" title={`${link.snapshot.headBranch} into ${link.snapshot.baseBranch}`}>
              <span>{link.snapshot.headBranch}</span><span aria-hidden="true">→</span><span>{link.snapshot.baseBranch}</span>
            </p>
            <p className="pr-detail-meta"><DiffCount snapshot={link.snapshot} /><span>by {link.snapshot.author}</span></p>
            <Readiness snapshot={link.snapshot} />
          </>}
          {link.stack && <StackMenu key={pullRequestIdentity(link)} link={link} links={links} reason={stackReason} onSelect={choose}
            onAction={(action) => { void invoke({ type: "conversation.stack.prepare", payload: { conversationId, key: { host: link.host, repository: link.repository, number: link.number }, action } }); }} />}
        </div>
        {link.syncError && <div role="status" className="pr-notice">
          <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
          <div><strong>Sync unavailable</strong><p>{link.syncError} Saved details are shown.</p></div>
        </div>}
        <StackActions operations={operations} />
        <button type="button" className="pr-text-link" aria-disabled={unavailable || Boolean(pendingStack) || undefined}
          title={pendingStack ? "Check the last stack action first." : undefined} onClick={() => {
            if (unavailable || pendingStack) return;
            returnTo.current = selected;
            void invoke({ type: "conversation.prs.unlink", payload: { conversationId, key: { host: link.host, repository: link.repository, number: link.number } } }).then((ok) => {
              if (ok) setSelected(null); else returnTo.current = null;
            });
          }}>Unlink from chat</button>
      </article> : links.length > 0 && <ul className="pr-list" aria-labelledby={`${ids}-label`}>
        {links.map((entry) => {
          const identity = pullRequestIdentity(entry), meta = rowMeta(entry);
          return <li key={identity}>
            <button type="button" className="pr-row" onClick={() => choose(entry)} ref={(element) => {
              if (element) rows.current.set(identity, element); else rows.current.delete(identity);
            }}>
              <PullRequestIcon link={entry} />
              <span className="pr-row-body">
                <span className="pr-row-title">{entry.snapshot?.title ?? `Pull request #${entry.number}`}</span>
                <span className="pr-row-meta" title={meta}>{meta}{entry.syncError && <> · <span className="pr-row-warning">Sync unavailable</span></>}</span>
              </span>
              {entry.snapshot && <DiffCount snapshot={entry.snapshot} />}
            </button>
          </li>;
        })}
      </ul>}
    </div>
    {review && <StackReviewDialog review={review} busy={busy} error={error ? withoutIncident(error) : null} onClose={dismissReview} onConfirm={() => {
      void invoke({ type: "conversation.stack.execute", payload: { conversationId, reviewId: review.id } }).then((ok) => { if (ok) dismissReview(); });
    }} />}
  </section>;
}
export default PullRequestsSurface;
