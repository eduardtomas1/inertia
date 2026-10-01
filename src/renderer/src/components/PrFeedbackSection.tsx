import { FileCheck2, MessageSquarePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { GitPreMergeConfidence, ServerEvent } from "@shared/contracts";
import { buildPrFeedbackTask, MAX_PR_FEEDBACK_THREADS } from "@shared/pr-feedback";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { resultEvent } from "../lib/runtimeCommands";
import { requestComposerPrefill } from "../utils/composerPrefill";
import "./PrFeedbackSection.css";

interface Props {
  confidence: GitPreMergeConfidence;
  projectId: string;
  conversationId?: string;
  repositoryPath: string;
  authorityRef: string;
  disabled: boolean;
  run: (key: string, command: CommandWithoutId) => Promise<ServerEvent>;
  onOpenUrl: (url: string) => void;
  onClose: () => void;
}

export function PrFeedbackSection({ confidence, projectId, conversationId, repositoryPath,
  authorityRef, disabled, run, onOpenUrl, onClose }: Props): React.JSX.Element {
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  const inFlight = useRef(false);
  const scope = `${projectId}/${conversationId}/${repositoryPath}/${authorityRef}/${confidence.generatedAt}`;
  useEffect(() => {
    revision.current += 1;
    setSelected([]); setError(null); setBusy(false); inFlight.current = false;
    return () => { revision.current += 1; };
  }, [scope]);
  const threads = confidence.reviewThreads;
  const codexCount = threads.filter(({ codex }) => codex).length;
  const eligible = Boolean(conversationId && confidence.github?.state === "OPEN"
    && confidence.identity.state === "exact" && !disabled);
  const canDraft = eligible && !busy;
  const createDraft = async (): Promise<void> => {
    if (!canDraft || !conversationId || !confidence.github || !selected.length || inFlight.current) return;
    const requestRevision = revision.current;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const event = resultEvent(await run("git.pr.feedback", {
        type: "git.pr.confidence",
        payload: { projectId, conversationId, repositoryPath, authorityRef, reviewThreadIds: selected },
      }));
      if (requestRevision !== revision.current) return;
      if (event.result.kind !== "git.pr.confidence") throw new Error("Review discussions could not be loaded.");
      const text = buildPrFeedbackTask(event.result.confidence, selected, confidence.github);
      requestComposerPrefill({ conversationId, text });
      onClose();
    } catch (failure) {
      if (requestRevision === revision.current) {
        setError(failure instanceof Error ? failure.message : "Review discussions could not be loaded.");
      }
    } finally {
      if (requestRevision === revision.current) { inFlight.current = false; setBusy(false); }
    }
  };
  return <section className="pre-merge-section" aria-labelledby="pre-merge-reviews-title" aria-busy={busy}>
    <div className="pre-merge-section-heading">
      <FileCheck2 size={15} />
      <div><h3 id="pre-merge-reviews-title">Actionable review threads</h3>
        <span>{codexCount} Codex · {threads.length - codexCount} other unresolved</span></div>
      <span className="pre-merge-source is-github">GitHub</span>
    </div>
    {threads.length === 0 ? <p className="pre-merge-empty">{confidence.state === "ready"
      ? "No unresolved, current review threads." : "Review-thread cleanliness was not proven."}</p> : <>
      <div className="pr-feedback-actions">
        <label><input type="checkbox" aria-label="Select all review feedback" disabled={!canDraft}
          checked={selected.length > 0 && threads.slice(0, MAX_PR_FEEDBACK_THREADS).every(({ id }) => selected.includes(id))}
          onChange={(event) => setSelected(event.target.checked ? threads.slice(0, MAX_PR_FEEDBACK_THREADS).map(({ id }) => id) : [])} />
          {selected.length} selected{threads.length > MAX_PR_FEEDBACK_THREADS ? ` · up to ${MAX_PR_FEEDBACK_THREADS} at a time` : ""}</label>
        <button type="button" disabled={!eligible || selected.length === 0} aria-disabled={busy || undefined} onClick={() => void createDraft()}>
          <MessageSquarePlus size={14} aria-hidden="true" />{busy ? "Loading discussions…" : "Address selected feedback"}
        </button>
      </div>
      <p className="pr-feedback-hint">{!conversationId ? "Open a chat to prepare a feedback task." : "Adds the selected discussions to your draft. Review the task before sending."}</p>
      {error && <p role="alert" className="pr-feedback-error">{error}</p>}
      <ul className="pre-merge-thread-list">
        {threads.map((thread) => <li key={thread.id}>
          <div><input type="checkbox" aria-label={`Select feedback on ${thread.path}${thread.line ? `:${thread.line}` : ""}`}
            checked={selected.includes(thread.id)} disabled={!canDraft || !selected.includes(thread.id) && selected.length >= MAX_PR_FEEDBACK_THREADS}
            onChange={(event) => setSelected((current) => event.target.checked ? [...current, thread.id] : current.filter((id) => id !== thread.id))} />
            <strong>{thread.codex ? "Codex" : thread.author}</strong>
            <code>{thread.path}{thread.line ? `:${thread.line}` : ""}</code>
            {thread.outdated && <em>Outdated position</em>}</div>
          <p>{thread.body}</p>
          {thread.url && <button type="button" onClick={() => onOpenUrl(thread.url!)}>Open thread</button>}
        </li>)}
      </ul>
    </>}
    {confidence.reviewThreadsTruncated && <p className="pre-merge-caution">More than 100 review threads exist; this view is incomplete and cannot be green.</p>}
  </section>;
}
