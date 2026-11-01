import { CloudUpload, GitCommitHorizontal, Pencil, RotateCcw } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  DiffReviewState,
  DiffReviewSummary,
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
import {
  COMMIT_MESSAGE_MAX_LENGTH,
  COMMIT_SUBJECT_SOFT_LIMIT,
  commitSubject,
  draftCommitMessage,
} from "../lib/commitMessageDraft";
import { captureModalFocus } from "../utils/modalFocus";
import { DialogShell } from "./DialogShell";
import { LoadingMark } from "./ui";

export type CommitDialogProps = {
  open: boolean;
  repositoryPath: string;
  status: GitStatusSnapshot | null;
  diff: StructuredDiff;
  diffParsing: boolean;
  diffError: string | null;
  reviewStates: DiffReviewState[];
  busy: boolean;
  /**
   * The chat's review summary; used only to draft locally, and only when its
   * fingerprint is the fingerprint of the diff this dialog commits.
   */
  reviewSummary?: CommitDraftSummary | null;
  onClose: () => void;
  onCommit: (message: string, push: boolean, paths: string[]) => Promise<void>;
};

export type CommitDraftSummary = Pick<DiffReviewSummary, "overall" | "fingerprint">;

const submitShortcutLabel = typeof navigator !== "undefined" && navigator.platform.includes("Mac")
  ? "⌘Enter"
  : "Ctrl+Enter";

export type RootCommitDialogProps = {
  owner: string;
  revision: number;
  status: GitStatusSnapshot | null;
  reviewStates: DiffReviewState[];
  busy: boolean;
  reviewSummary?: CommitDraftSummary | null;
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
  reviewSummary = null,
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
      reviewSummary={reviewSummary}
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

export function CommitDialog({ open, repositoryPath, status, diff, diffParsing, diffError, reviewStates, busy, reviewSummary = null, onClose, onCommit }: CommitDialogProps): React.JSX.Element | null {
  const [message, setMessage] = useState("");
  const [replacedMessage, setReplacedMessage] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messageId = useId();
  const messageHintId = useId();
  useNativePreviewSuspension(open);
  useEffect(() => {
    if (!open) return;
    setSelectedPaths(status?.files.map((file) => file.path) ?? []);
  }, [open, status?.files]);
  useEffect(() => {
    if (!open) return;
    const restoreFocus = captureModalFocus(false);
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(focusTimer);
      restoreFocus();
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
  const draft = draftCommitMessage({
    summary: reviewSummary && reviewSummary.fingerprint === diff.fingerprint ? reviewSummary.overall : null,
    files: status?.files ?? [],
    selectedPaths,
  });
  const subjectLength = commitSubject(message).length;
  const subjectTooLong = subjectLength > COMMIT_SUBJECT_SOFT_LIMIT;
  const reviewUnavailable = diffParsing || diffError !== null;
  const locked = busy || submitting;
  const submit = async (push: boolean) => {
    if (!message.trim() || locked || submittingRef.current || reviewUnavailable || selectedPaths.length === 0) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onCommit(message.trim(), push, selectedPaths);
      setMessage("");
      setReplacedMessage(null);
    } catch {
      // The application toast keeps the dialog open and presents the Git error.
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };
  return (
    <DialogShell
      className="commit-shell"
      titleId="commit-dialog-title"
      title="Commit changes"
      description={<><span>{status?.branch ?? (diffParsing ? "Preparing review…" : "Detached HEAD")}</span> · {status?.files.length ?? 0} {status?.files.length === 1 ? "file" : "files"} · <span className="stat-additions">+{status?.insertions ?? 0}</span> <span className="stat-deletions">−{status?.deletions ?? 0}</span></>}
      closeLabel="Close commit dialog"
      closeDisabled={locked}
      onClose={onClose}
      onDismiss={() => { if (!locked) onClose(); }}
      onKeyDown={(event) => { if (event.key === "Escape") event.preventDefault(); }}
      footer={<>
        <button type="button" className="secondary-button" disabled={!message.trim() || locked || reviewUnavailable || selectedPaths.length === 0} onClick={() => void submit(false)}>{locked ? <LoadingMark label="Committing" /> : <GitCommitHorizontal size={14} />}<span>Commit</span></button>
        <button type="button" className="primary-button dialog-primary" disabled={!message.trim() || locked || reviewUnavailable || selectedPaths.length === 0} onClick={() => void submit(true)}>{locked ? <LoadingMark label="Committing and pushing" /> : <CloudUpload size={14} />}<span>Commit & push</span></button>
      </>}
    >
      <div className="commit-path-heading">
        <span>Paths to stage and commit</span>
        <button type="button" className="text-button" disabled={locked || reviewUnavailable} onClick={() => setSelectedPaths(status?.files.map((file) => file.path) ?? [])}>All</button>
        <button type="button" className="text-button" disabled={locked || reviewUnavailable} onClick={() => setSelectedPaths([])}>None</button>
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
            <span className="commit-path-name" title={file.path}>{file.path}</span><span className="commit-path-state">{file.untracked ? "Untracked" : `${file.staged ? "Staged" : ""}${file.staged && file.unstaged ? " + " : ""}${file.unstaged ? "Unstaged" : ""}`}</span>
          </label>
        ))}
      </div>
      <p className="commit-stage-note">Only checked paths will be staged and committed. Review marks never stage files.</p>
      {diffParsing && <p className="commit-stage-note" role="status">Preparing the complete diff before commit…</p>}
      {diffError && <p className="commit-review-warning" role="alert">The complete diff could not be prepared: {diffError}</p>}
      {unreviewedHunks.length > 0 && <p className="commit-review-warning">{unreviewedHunks.length} selected {unreviewedHunks.length === 1 ? "hunk is" : "hunks are"} unreviewed.</p>}
      <div className="dialog-field commit-message-field">
        <div className="commit-message-heading">
          <label htmlFor={messageId}>Commit message</label>
          <button
            type="button"
            className="text-button"
            disabled={locked || !draft}
            title={message.trim()
              ? "Replace the current message with a draft from the review summary or selected files"
              : "Draft a message from the review summary or selected files"}
            onClick={() => {
              setReplacedMessage(message.trim() && message !== draft ? message : null);
              setMessage(draft);
              inputRef.current?.focus();
            }}
          >
            <Pencil size={14} aria-hidden="true" />{message.trim() ? "Replace with draft" : "Draft message"}
          </button>
        </div>
        {replacedMessage !== null && (
          <p className="commit-stage-note commit-message-restore" role="status">
            <span>The draft replaced your text.</span>
            <button
              type="button"
              className="text-button"
              disabled={locked}
              onClick={() => {
                setMessage(replacedMessage);
                setReplacedMessage(null);
                inputRef.current?.focus();
              }}
            >
              <RotateCcw size={14} aria-hidden="true" />Restore your text
            </button>
          </p>
        )}
        <textarea
          id={messageId}
          ref={inputRef}
          value={message}
          rows={5}
          maxLength={COMMIT_MESSAGE_MAX_LENGTH}
          placeholder={"Summary line\n\nOptional details"}
          aria-describedby={messageHintId}
          onChange={(event) => {
            setMessage(event.target.value);
            setReplacedMessage(null);
          }}
          onKeyDown={(event) => {
            if (
              event.key !== "Enter"
              || !(event.metaKey || event.ctrlKey)
              || event.nativeEvent.isComposing
            ) return;
            event.preventDefault();
            void submit(false);
          }}
        />
        <p id={messageHintId} className="commit-message-hint">
          <span className={subjectTooLong ? "commit-subject-length is-over" : "commit-subject-length"}>
            Subject {subjectLength}/{COMMIT_SUBJECT_SOFT_LIMIT}
            {subjectTooLong && <span className="visually-hidden"> characters, longer than recommended</span>}
          </span>
          <span>First line is the subject; leave a blank line before details. {submitShortcutLabel} commits.</span>
        </p>
      </div>
    </DialogShell>
  );
}
