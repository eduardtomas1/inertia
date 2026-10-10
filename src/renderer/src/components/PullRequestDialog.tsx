import { GitPullRequest } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { resultEvent } from "../lib/runtimeCommands";
import { captureModalFocus } from "../utils/modalFocus";
import type { GitForge, ServerEvent } from "@shared/contracts";
import { DialogShell } from "./DialogShell";
import { LoadingMark } from "./ui";

export interface PullRequestDialogProps {
  open: boolean;
  initialTitle: string;
  busy: boolean;
  projectId: string;
  conversationId?: string;
  repositoryPath?: string;
  authorityRef?: string;
  forge?: GitForge;
  run: (key: string, command: CommandWithoutId) => Promise<ServerEvent>;
  onClose: () => void;
}

export function PullRequestDialog({
  open,
  initialTitle,
  busy,
  projectId,
  conversationId,
  repositoryPath,
  authorityRef,
  forge = "github",
  run,
  onClose,
}: PullRequestDialogProps): React.JSX.Element | null {
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(true);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [completionNotice, setCompletionNotice] = useState<
    "open-failed" | "copied" | "copy-failed" | null
  >(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const createdUrlRef = useRef<HTMLInputElement>(null);
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  const initialTitleRef = useRef(initialTitle);
  initialTitleRef.current = initialTitle;
  useNativePreviewSuspension(open);
  useEffect(() => {
    if (!open) return;
    setCreatedUrl(null);
    setCompletionNotice(null);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    setTitle(initialTitleRef.current);
    const restoreFocus = captureModalFocus(false);
    const timer = window.setTimeout(() => {
      (titleRef.current ?? primaryActionRef.current)?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      restoreFocus();
    };
  }, [open]);
  if (!open) return null;
  const integrated = forge === "github";
  const forgeLabel = forge === "gitlab" ? "GitLab" : forge === "bitbucket" ? "Bitbucket" : "GitHub";
  const submit = async (): Promise<void> => {
    if (!title.trim() || busy) return;
    try {
      const event = resultEvent(await run("git.pr.create", {
        type: "git.pr.create",
        payload: {
          projectId,
          conversationId,
          repositoryPath,
          authorityRef,
          title: title.trim(),
          body,
          draft,
        },
      }));
      if (event.result.kind !== "external.url") return;
      try {
        await window.inertia.openExternal(event.result.url);
        onClose();
      } catch {
        setCreatedUrl(event.result.url);
        setCompletionNotice("open-failed");
        window.requestAnimationFrame(() => createdUrlRef.current?.focus());
      }
    } catch {
      // The application error toast owns the public failure message.
    }
  };
  const openCreatedPullRequest = async (): Promise<void> => {
    if (!createdUrl) return;
    try {
      await window.inertia.openExternal(createdUrl);
      onClose();
    } catch {
      setCompletionNotice("open-failed");
    }
  };
  const copyCreatedPullRequest = async (): Promise<void> => {
    if (!createdUrl) return;
    try {
      setCompletionNotice(await window.inertia.copyText(createdUrl)
        ? "copied"
        : "copy-failed");
    } catch {
      setCompletionNotice("copy-failed");
    }
  };
  const openBrowser = async (): Promise<void> => {
    try {
      const event = resultEvent(await run("git.pr.open", {
        type: "git.pr.open",
        payload: { projectId, conversationId, repositoryPath, authorityRef },
      }));
      if (event.result.kind !== "external.url") return;
      await window.inertia.openExternal(event.result.url);
      onClose();
    } catch {
      // The application error toast owns the public failure message.
    }
  };
  return (
    <DialogShell
      className="pull-request-shell"
      titleId="pull-request-dialog-title"
      title={integrated ? "Create GitHub pull request" : `Open ${forgeLabel} ${forge === "gitlab" ? "merge" : "pull"} request`}
      description={integrated ? "Uses your local GitHub CLI sign-in. Nothing is sent through Inertia infrastructure." : `Continue in ${forgeLabel} using the current branch and selected Git remote.`}
      closeLabel="Close pull request dialog"
      closeDisabled={busy}
      onClose={onClose}
      onDismiss={() => { if (!busy) onClose(); }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          onClose();
        }
      }}
      footer={createdUrl ? <>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => { void copyCreatedPullRequest(); }}>Copy link</button>
        <button ref={primaryActionRef} type="button" className="primary-button dialog-primary" disabled={busy} onClick={() => { void openCreatedPullRequest(); }}><GitPullRequest size={14} /><span>Try opening GitHub</span></button>
      </> : <>
        {integrated && <button type="button" className="secondary-button" disabled={busy} onClick={() => { void openBrowser(); }}>Open browser flow</button>}
        <button ref={primaryActionRef} type="button" className="primary-button dialog-primary" disabled={(integrated && !title.trim()) || busy} onClick={() => { void (integrated ? submit() : openBrowser()); }}>{busy ? <LoadingMark label={integrated ? "Creating pull request" : "Opening browser flow"} /> : <GitPullRequest size={14} />}<span>{integrated ? "Create pull request" : `Open in ${forgeLabel}`}</span></button>
      </>}
    >
      {createdUrl ? <>
        <p className="commit-review-warning" role="alert">
          The pull request was created, but Inertia could not open it in your browser. Do not create it again; copy the verified link or retry opening it.
        </p>
        <label className="dialog-field">
          <span>Created pull request</span>
          <input ref={createdUrlRef} value={createdUrl} readOnly aria-label="Created pull request link" />
        </label>
        {completionNotice === "copied" && (
          <p className="commit-stage-note" role="status">Pull request link copied.</p>
        )}
        {completionNotice === "copy-failed" && (
          <p className="commit-review-warning" role="alert">
            The link could not be copied automatically. Select it above and copy it manually.
          </p>
        )}
      </> : integrated && <label className="dialog-field">
        <span>Title</span>
        <input
          ref={titleRef}
          value={title}
          maxLength={256}
          placeholder="Describe this pull request"
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>}
      {!createdUrl && integrated && <label className="dialog-field">
        <span>Description</span>
        <textarea
          value={body}
          maxLength={64 * 1024}
          rows={8}
          placeholder="Summary, verification, and review notes"
          disabled={busy}
          onChange={(event) => setBody(event.target.value)}
        />
      </label>}
      {!createdUrl && integrated && <label className="pull-request-draft">
        <input
          type="checkbox"
          checked={draft}
          disabled={busy}
          onChange={(event) => setDraft(event.target.checked)}
        />
        <span><strong>Create as draft</strong><small>Mark it ready on GitHub after review.</small></span>
      </label>}
      {!createdUrl && <p className="commit-stage-note">{integrated ? "The branch must already be pushed. If GitHub CLI is unavailable, continue in your browser." : "Inertia constructs the provider-hosted request URL locally and does not receive hosting credentials."}</p>}
    </DialogShell>
  );
}

export default PullRequestDialog;
