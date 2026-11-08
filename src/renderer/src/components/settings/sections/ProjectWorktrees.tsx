import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { TriangleAlert, RefreshCw } from "lucide-react";
import type { ServerEvent } from "@shared/contracts";
import type { WorktreeEntry, WorktreeList as WorktreeListResult } from "@shared/worktrees";
import type { CommandWithoutId } from "../../../lib/runtimeCommands";
import { WorktreeList } from "../../WorktreeList";

interface Props {
  projectId: string;
  /** Folder name of the repository's main checkout (never its full path). */
  mainFolderName: string;
  disabled: boolean;
  request?: (command: CommandWithoutId) => Promise<ServerEvent>;
  onOpenConversation?: (conversationId: string) => boolean;
}

function failureMessage(failure: unknown): string {
  return failure instanceof Error && failure.message
    ? failure.message
    : "The worktree request could not be finished. Try again.";
}

function result(event: ServerEvent): Extract<ServerEvent, { type: "request.result" }>["result"] {
  if (event.type === "request.error") throw new Error(event.message);
  if (event.type !== "request.result") throw new Error("The local service returned an unexpected response.");
  return event.result;
}

/** Settings → Projects → Worktrees: list, guarded removal and prune for one project. */
export function ProjectWorktrees({ projectId, mainFolderName, disabled, request, onOpenConversation }: Props): React.JSX.Element {
  const [list, setList] = useState<WorktreeListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ message: string; partial: boolean } | null>(null);
  const [confirming, setConfirming] = useState<WorktreeEntry | null>(null);
  // Listing runs Git, so it waits until the person asks for it.
  const [open, setOpen] = useState(false);
  const requestRef = useRef(request);
  const generation = useRef(0);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const refresh = useRef<HTMLButtonElement>(null);
  const pruneHelpId = useId();
  const restoreFocus = useRef(false);
  const unavailable = disabled || !request;

  useLayoutEffect(() => {
    requestRef.current = request;
  });

  const load = useCallback(async (): Promise<void> => {
    const send = requestRef.current;
    if (!send) return;
    const current = ++generation.current;
    setLoading(true);
    try {
      const value = result(await send({ type: "worktree.list", payload: { projectId } }));
      if (current !== generation.current) return;
      if (value.kind !== "worktree.list") throw new Error("The worktree list is unavailable.");
      setList(value.list);
    } catch (failure) {
      if (current === generation.current) setError(failureMessage(failure));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (open && !disabled) void load();
  }, [disabled, load, open]);

  useEffect(() => () => { generation.current += 1; }, []);

  // The Show button disappears when the list opens; move focus to its controls.
  useLayoutEffect(() => {
    if (open) refresh.current?.focus();
  }, [open]);

  useLayoutEffect(() => {
    if (confirming) cancel.current?.focus();
  }, [confirming]);

  // A removed row takes its Remove button with it; keep focus in the section.
  useEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    if (trigger.current && !trigger.current.isConnected) refresh.current?.focus();
  }, [list]);

  const closeConfirmation = (): void => {
    setConfirming(null);
    trigger.current?.focus();
  };

  const act = async (command: CommandWithoutId): Promise<void> => {
    const send = requestRef.current;
    if (!send || busy || unavailable) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const value = result(await send(command));
      if (value.kind !== "worktree.action") throw new Error("The worktree response is unavailable.");
      setNotice({ message: value.outcome.message, partial: value.outcome.partial === true });
    } catch (failure) {
      setError(failureMessage(failure));
    } finally {
      setBusy(false);
    }
    restoreFocus.current = true;
    await load();
  };

  const remove = (): void => {
    const entry = confirming;
    if (!entry) return;
    setConfirming(null);
    void act({ type: "worktree.remove", payload: { projectId, path: entry.path } });
  };

  const inactive = unavailable || busy || loading;
  const stale = list?.worktrees.filter(({ prunable }) => prunable).length ?? 0;
  if (!open) {
    return <div className="project-worktrees">
      <div className="project-worktrees-actions">
        <button type="button" className="secondary-button" disabled={unavailable} aria-expanded={false}
          onClick={() => { if (!unavailable) setOpen(true); }}>Show worktrees</button>
      </div>
    </div>;
  }
  return <div className="project-worktrees">
    <div className="project-worktrees-actions">
      <button ref={refresh} type="button" className="secondary-button" disabled={unavailable} aria-disabled={busy || loading || undefined}
        onClick={() => { if (!inactive) { setError(null); setNotice(null); void load(); } }}>
        <RefreshCw size={14} aria-hidden="true" />Refresh
      </button>
      <button type="button" className="secondary-button" disabled={unavailable} aria-disabled={busy || loading || undefined}
        aria-describedby={pruneHelpId}
        onClick={() => { if (!inactive) void act({ type: "worktree.prune", payload: { projectId } }); }}>
        Prune stale entries{stale > 0 ? ` (${stale})` : ""}
      </button>
    </div>
    <small id={pruneHelpId} className="project-worktrees-help">
      Prune clears Git's records of worktrees whose folders are already gone. It never deletes files.
    </small>
    {error && <p className="project-worktrees-error" role="alert">{error}</p>}
    {list && list.worktrees.length > 0 && <WorktreeList worktrees={list.worktrees} mainFolderName={mainFolderName} disabled={inactive}
      onOpenConversation={onOpenConversation}
      onRemove={(entry, button) => { trigger.current = button; setConfirming(entry); }} />}
    {list?.truncated && <small className="project-worktrees-help">Only the first {list.worktrees.length} worktrees are shown.</small>}
    {!list && loading && <p className="project-worktrees-help">Loading worktrees…</p>}
    {confirming && <div className="project-remove-confirm" role="group" aria-label="Confirm removing the worktree"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        closeConfirmation();
      }}>
      <strong>Remove the worktree {confirming.path}?</strong>
      <small>
        Git removes the folder only while it is clean. Branch {confirming.branch ?? "(detached)"} is deleted only if
        Inertia created it and it is fully merged; otherwise it is kept.
      </small>
      <div>
        <button ref={cancel} type="button" className="secondary-button" onClick={closeConfirmation}>Cancel</button>
        <button type="button" className="secondary-button is-danger" disabled={unavailable} aria-disabled={busy || undefined} onClick={remove}>
          Remove worktree
        </button>
      </div>
    </div>}
    <span className="visually-hidden" role="status">{busy ? "Updating worktrees" : notice?.message ?? ""}</span>
    {notice && !busy && <p className={notice.partial ? "project-worktrees-warning" : "project-worktrees-notice"} aria-hidden="true">
      {notice.partial && <TriangleAlert size={14} aria-hidden="true" />}{notice.message}
    </p>}
  </div>;
}
