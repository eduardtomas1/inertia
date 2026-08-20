import { GitCommitHorizontal, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DiffReviewState,
  GitDiffSnapshot,
  GitStatusSnapshot,
  ServerEvent,
  StructuredDiff,
} from "@shared/contracts";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { useParsedUnifiedDiff } from "../hooks/useParsedUnifiedDiff";
import {
  resultEvent,
  type CommandWithoutId,
} from "../lib/runtimeCommands";
import { unreviewedCommitHunks } from "../lib/commitReview";
import { trapModalFocus } from "../utils/modalFocus";
import { IconButton, LoadingMark } from "./ui";

export type CommitDialogProps = {
  open: boolean;
  repositoryPath: string;
  status: GitStatusSnapshot | null;
  diff: StructuredDiff;
  diffParsing: boolean;
  diffError: string | null;
  reviewStates: DiffReviewState[];
  busy: boolean;
  onClose: () => void;
  onCommit: (message: string, push: boolean, paths: string[]) => Promise<void>;
};

export type RootCommitDialogProps = {
  owner: string;
  revision: number;
  status: GitStatusSnapshot | null;
  reviewStates: DiffReviewState[];
  busy: boolean;
  loadReview: () => Promise<GitDiffSnapshot | null>;
  discardReview: () => void;
  onClose: () => void;
  onError: (message: string) => void;
  onCommit: CommitDialogProps["onCommit"];
};

export async function requestRootCommitReview(input: {
  projectId: string;
  conversationId: string | undefined;
  ignoreWhitespace: boolean;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
}): Promise<{ status: GitStatusSnapshot; diff: GitDiffSnapshot }> {
  const statusEvent = resultEvent(await input.request({
    type: "git.refresh",
    payload: {
      projectId: input.projectId,
      conversationId: input.conversationId,
    },
  }));
  if (statusEvent.result.kind !== "git.status") {
    throw new Error("Unexpected Git status response.");
  }
  const status = statusEvent.result.status;
  if (!status.isRepository || !status.authorityRef) {
    throw new Error("Refresh repository status before committing changes.");
  }
  const diffEvent = resultEvent(await input.request({
    type: "git.diff",
    payload: {
      projectId: input.projectId,
      conversationId: input.conversationId,
      authorityRef: status.authorityRef,
      ignoreWhitespace: input.ignoreWhitespace,
      commitReview: true,
    },
  }));
  if (diffEvent.result.kind !== "git.diff") {
    throw new Error("Unexpected Git diff response.");
  }
  const diff = diffEvent.result.diff;
  if (diff.truncated || !diff.commitReview) {
    throw new Error(
      "The complete reviewed repository state is unavailable. Refresh and try again.",
    );
  }
  return { status, diff };
}

export function RootCommitDialog({
  owner,
  revision,
  status,
  reviewStates,
  busy,
  loadReview,
  discardReview,
  onClose,
  onError,
  onCommit,
}: RootCommitDialogProps): React.JSX.Element {
  const initialOwnerRef = useRef(owner);
  const initialRevisionRef = useRef(revision);
  const requestRef = useRef(0);
  const onCloseRef = useRef(onClose);
  const onErrorRef = useRef(onError);
  onCloseRef.current = onClose;
  onErrorRef.current = onError;
  const [review, setReview] = useState<GitDiffSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const parsed = useParsedUnifiedDiff(review?.patch ?? "", review);

  useEffect(() => {
    if (
      initialOwnerRef.current !== owner
      || initialRevisionRef.current !== revision
    ) {
      discardReview();
      onCloseRef.current();
      return;
    }
    const request = ++requestRef.current;
    let active = true;
    setLoading(true);
    void loadReview().then((next) => {
      if (!active || request !== requestRef.current) {
        discardReview();
        return;
      }
      if (!next) {
        discardReview();
        onCloseRef.current();
        return;
      }
      setReview(next);
    }).catch((error: unknown) => {
      if (!active || request !== requestRef.current) return;
      discardReview();
      onErrorRef.current(
        error instanceof Error && error.message.trim()
          ? error.message
          : "The complete reviewed repository state could not be loaded.",
      );
      onCloseRef.current();
    }).finally(() => {
      if (active && request === requestRef.current) setLoading(false);
    });
    return () => {
      active = false;
      requestRef.current += 1;
      discardReview();
    };
  }, [discardReview, loadReview, owner, revision]);

  const close = (): void => {
    discardReview();
    onClose();
  };

  const ownsReview = initialOwnerRef.current === owner
    && initialRevisionRef.current === revision;
  const reviewedStatus = ownsReview && review && status
    ? {
        ...status,
        files: review.files,
        insertions: review.files.reduce(
          (total, file) => total + file.insertions,
          0,
        ),
        deletions: review.files.reduce(
          (total, file) => total + file.deletions,
          0,
        ),
      }
    : null;

  return (
    <CommitDialog
      open
      repositoryPath="."
      status={reviewedStatus}
      reviewStates={reviewStates}
      diff={parsed.structured}
      diffParsing={loading || parsed.parsing}
      diffError={review?.truncated
        ? "Diff truncated. Refresh before committing."
        : parsed.error}
      busy={busy}
      onClose={close}
      onCommit={async (...args) => {
        setReview(null);
        try {
          await onCommit(...args);
          onClose();
        } catch (error) {
          discardReview();
          onClose();
          throw error;
        }
      }}
    />
  );
}

export function CommitDialog({ open, repositoryPath, status, diff, diffParsing, diffError, reviewStates, busy, onClose, onCommit }: CommitDialogProps): React.JSX.Element | null {
  const [message, setMessage] = useState("");
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useNativePreviewSuspension(open);
  useEffect(() => {
    if (!open) return;
    setSelectedPaths(status?.files.map((file) => file.path) ?? []);
  }, [open, status?.files]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(focusTimer);
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy || submitting) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose, open, submitting]);
  const unreviewedHunks = useMemo(
    () => unreviewedCommitHunks(
      diff,
      selectedPaths,
      reviewStates,
      repositoryPath,
    ),
    [diff, repositoryPath, reviewStates, selectedPaths],
  );
  if (!open) return null;
  const reviewUnavailable = diffParsing || diffError !== null;
  const locked = busy || submitting;
  const submit = async (push: boolean) => {
    if (!message.trim() || locked || submittingRef.current || reviewUnavailable || selectedPaths.length === 0) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onCommit(message.trim(), push, selectedPaths);
      setMessage("");
    } catch {
      // The application toast keeps the dialog open and presents the Git error.
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !locked) onClose(); }}>
      <section
        className="commit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="commit-dialog-title"
        onKeyDown={(event) => {
          trapModalFocus(event, event.currentTarget);
        }}
      >
        <header><span className="dialog-icon"><GitCommitHorizontal size={18} /></span><div><h2 id="commit-dialog-title">Commit changes</h2><p>{status?.files.length ?? 0} files · <span className="stat-additions">+{status?.insertions ?? 0}</span> <span className="stat-deletions">−{status?.deletions ?? 0}</span></p></div><IconButton label="Close commit dialog" onClick={onClose} disabled={locked}><X size={16} /></IconButton></header>
        <div className="commit-path-heading">
          <span>Paths to stage and commit</span>
          <button type="button" disabled={locked || reviewUnavailable} onClick={() => setSelectedPaths(status?.files.map((file) => file.path) ?? [])}>All</button>
          <button type="button" disabled={locked || reviewUnavailable} onClick={() => setSelectedPaths([])}>None</button>
        </div>
        <div className="commit-path-list">
          {status?.files.map((file) => (
            <label key={file.path}>
              <input
                type="checkbox"
                checked={selectedPaths.includes(file.path)}
                disabled={locked || reviewUnavailable}
                onChange={(event) => setSelectedPaths((current) => event.target.checked
                  ? [...new Set([...current, file.path])]
                  : current.filter((path) => path !== file.path))}
              />
              <span><strong>{file.path}</strong><small>{file.untracked ? "Untracked" : `${file.staged ? "Staged" : ""}${file.staged && file.unstaged ? " + " : ""}${file.unstaged ? "Unstaged" : ""}`}</small></span>
            </label>
          ))}
        </div>
        <p className="commit-stage-note">Only checked paths will be staged and committed. Review marks never stage files.</p>
        {diffParsing && <p className="commit-stage-note" role="status">Preparing the complete diff before commit…</p>}
        {diffError && <p className="commit-review-warning" role="alert">The complete diff could not be prepared: {diffError}</p>}
        {unreviewedHunks.length > 0 && <p className="commit-review-warning">{unreviewedHunks.length} selected {unreviewedHunks.length === 1 ? "hunk is" : "hunks are"} unreviewed.</p>}
        <label><span>Commit message</span><input ref={inputRef} value={message} maxLength={10_000} placeholder="Describe this change" onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submit(false); }} /></label>
        <footer>
          <button type="button" className="secondary-button" disabled={!message.trim() || locked || reviewUnavailable || selectedPaths.length === 0} onClick={() => void submit(false)}>{locked ? <LoadingMark label="Committing" /> : <GitCommitHorizontal size={15} />}<span>Commit</span></button>
          <button type="button" className="primary-button dialog-primary" disabled={!message.trim() || locked || reviewUnavailable || selectedPaths.length === 0} onClick={() => void submit(true)}>{locked ? <LoadingMark label="Committing and pushing" /> : <Upload size={15} />}<span>Commit & push</span></button>
        </footer>
      </section>
    </div>
  );
}
