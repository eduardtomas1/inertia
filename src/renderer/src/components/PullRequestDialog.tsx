import { GitPullRequest, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { resultEvent } from "../lib/runtimeCommands";
import type { GitForge, ServerEvent } from "@shared/contracts";
import { IconButton, LoadingMark } from "./ui";

export interface PullRequestDialogProps {
  open: boolean;
  initialTitle: string;
  busy: boolean;
  projectId: string;
  conversationId?: string;
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
  forge = "github",
  run,
  onClose,
}: PullRequestDialogProps): React.JSX.Element | null {
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(true);
  const titleRef = useRef<HTMLInputElement>(null);
  useNativePreviewSuspension(open);
  useEffect(() => {
    if (!open) return;
    setTitle(initialTitle);
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const timer = window.setTimeout(() => titleRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      if (previous?.isConnected) previous.focus();
    };
  }, [initialTitle, open]);
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
          title: title.trim(),
          body,
          draft,
        },
      }));
      if (event.result.kind !== "external.url") return;
      await window.inertia.openExternal(event.result.url);
      onClose();
    } catch {
      // The application error toast owns the public failure message.
    }
  };
  const openBrowser = async (): Promise<void> => {
    try {
      const event = resultEvent(await run("git.pr.open", {
        type: "git.pr.open",
        payload: { projectId, conversationId },
      }));
      if (event.result.kind !== "external.url") return;
      await window.inertia.openExternal(event.result.url);
      onClose();
    } catch {
      // The application error toast owns the public failure message.
    }
  };
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="commit-dialog pull-request-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pull-request-dialog-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
          )];
          const first = focusable[0];
          const last = focusable.at(-1);
          if (!first || !last) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header>
          <span className="dialog-icon"><GitPullRequest size={18} /></span>
          <div>
            <h2 id="pull-request-dialog-title">{integrated ? "Create GitHub pull request" : `Open ${forgeLabel} ${forge === "gitlab" ? "merge" : "pull"} request`}</h2>
            <p>{integrated ? "Uses your local GitHub CLI sign-in. Nothing is sent through Inertia infrastructure." : `Continue in ${forgeLabel} using the current branch and selected Git remote.`}</p>
          </div>
          <IconButton label="Close pull request dialog" onClick={onClose} disabled={busy}><X size={16} /></IconButton>
        </header>
        {integrated && <label>
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
        {integrated && <label>
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
        {integrated && <label className="pull-request-draft">
          <input
            type="checkbox"
            checked={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.checked)}
          />
          <span><strong>Create as draft</strong><small>Mark it ready on GitHub after review.</small></span>
        </label>}
        <p className="commit-stage-note">{integrated ? "The branch must already be pushed. If GitHub CLI is unavailable, continue in your browser." : "Inertia constructs the provider-hosted request URL locally and does not receive hosting credentials."}</p>
        <footer>
          {integrated && <button type="button" className="secondary-button" disabled={busy} onClick={() => { void openBrowser(); }}>Open browser flow</button>}
          <button type="button" className="primary-button dialog-primary" disabled={(integrated && !title.trim()) || busy} onClick={() => { void (integrated ? submit() : openBrowser()); }}>{busy ? <LoadingMark label={integrated ? "Creating pull request" : "Opening browser flow"} /> : <GitPullRequest size={15} />}<span>{integrated ? "Create pull request" : `Open in ${forgeLabel}`}</span></button>
        </footer>
      </section>
    </div>
  );
}

export default PullRequestDialog;
