import { useRef, useState } from "react";
import { ChevronRight, CircleAlert, TriangleAlert } from "lucide-react";
import type { ReviewBrief, ReviewBriefInput, ScopeReview } from "@shared/review-brief";

export interface ScopeReviewPanelProps {
  brief: ReviewBrief | null;
  sources: Array<{ id: string; content: string }>;
  review?: ScopeReview;
  fingerprint?: string;
  loading: boolean;
  locked: boolean;
  onSave: (expectedRevision: number, input: ReviewBriefInput) => Promise<void>;
  onReview: () => Promise<void>;
  onSelectFile: (path: string) => void;
  onAddTextToPrompt: (text: string) => void;
}

export default function ScopeReviewPanel({ brief, sources, review, fingerprint, loading, locked,
  onSave, onReview, onSelectFile, onAddTextToPrompt }: ScopeReviewPanelProps) {
  const [editing, setEditing] = useState(!brief?.requirements.length);
  const [text, setText] = useState(brief?.requirements.join("\n") ?? "");
  const [linked, setLinked] = useState(brief?.sources.map((source) => source.messageId) ?? []);
  const [revision, setRevision] = useState(brief?.revision ?? 0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftIdentity, setDraftIdentity] = useState("");
  const currentIdentity = `${brief?.revision}:${fingerprint}`;
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const activeReview = !editing && review?.brief.revision === brief?.revision ? review : undefined;
  const sourceOptions = [...sources, ...(brief?.sources ?? [])
    .filter((source) => !sources.some(({ id }) => id === source.messageId))
    .map((source) => ({ id: source.messageId, content: source.excerpt }))];
  const reviewUnavailable = loading || locked || !brief?.requirements.length;
  const draftStale = !activeReview || draftIdentity !== currentIdentity;
  const addUnavailable = !draft?.trim() || locked || editing || draftStale;
  const perform = async (action: () => Promise<void>) => {
    setError(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Review could not be completed."); }
  };
  const prepare = (finding: string) => {
    setDraftIdentity(currentIdentity);
    setDraft(`Please review this finding against my request:\n${brief?.requirements.map((item) => `- ${item}`).join("\n")}\n\n${finding}\n\nExplain the connection or make the smallest correction needed. Report what you verified and any remaining uncertainty.`);
    window.setTimeout(() => draftRef.current?.focus(), 0);
  };
  const evidenceLink = (target: { path: string; hunkId: string | null }) => (
    <button type="button" className="scope-review-path" title={target.path} aria-disabled={locked || undefined} onClick={() => {
      if (locked) return;
      onSelectFile(target.path);
      if (target.hunkId) window.setTimeout(() => document.getElementById(`review-${target.hunkId}`)?.scrollIntoView({ block: "center" }), 0);
    }}>{target.path}</button>
  );
  const draftLink = (finding: string) => (
    <button type="button" className="scope-review-link" onClick={() => prepare(finding)}>Draft request</button>
  );
  const errorNotice = error && <p className="scope-review-error" role="alert">{error}</p>;
  return <section className="scope-review" aria-label="Review against request">
    <p className="scope-review-note">Suggestions from the complete root repository diff only. Test changes do not mean tests ran or passed.</p>
    <div className="scope-review-columns">
      <div className="scope-review-brief">
        <h3 className="scope-review-label">Review brief</h3>
        {editing ? <form className="scope-review-form" onSubmit={(event) => {
          event.preventDefault();
          if (saving) return;
          const requirements = text.split("\n").map((line) => line.trim()).filter(Boolean);
          if (requirements.length > 20 || requirements.some((line) => line.length > 800)) {
            setError("Use up to 20 requirements, each at most 800 characters."); return;
          }
          setSaving(true);
          void perform(async () => { await onSave(revision, { requirements, sourceMessageIds: linked }); setEditing(false); })
            .finally(() => setSaving(false));
        }}>
          <div className="scope-review-field">
            <label htmlFor="review-brief-requirements">Requirements</label>
            <textarea id="review-brief-requirements" aria-describedby="review-brief-requirements-help" value={text} maxLength={16_020} rows={4}
              placeholder="Retry temporary failures up to three times.&#10;Keep authentication behavior unchanged."
              onChange={(event) => setText(event.target.value)} readOnly={saving} />
            <small id="review-brief-requirements-help">One per line, up to 20.</small>
          </div>
          <div className="scope-review-field">
            <label htmlFor="review-brief-source">Link a user message</label>
            <select id="review-brief-source" value="" disabled={saving || linked.length >= 8} onChange={(event) => {
              if (event.target.value) setLinked((current) => [...current, event.target.value]);
            }}><option value="">Choose from loaded messages…</option>{sourceOptions.filter(({ id }) => !linked.includes(id)).map((source) =>
              <option key={source.id} value={source.id}>{source.content.slice(0, 120)}</option>)}</select>
          </div>
          {linked.length > 0 && <ul className="scope-review-sources" aria-label="Linked user messages">{linked.map((id) => <li key={id}>
            <span>{sourceOptions.find((source) => source.id === id)?.content.slice(0, 180) ?? "Linked message"}</span>
            <button type="button" className="scope-review-link" aria-disabled={saving || undefined}
              onClick={() => { if (!saving) setLinked((current) => current.filter((item) => item !== id)); }}>Unlink</button>
          </li>)}</ul>}
          {errorNotice}
          <div className="scope-review-actions">
            <button type="button" className="secondary-button" onClick={() => { if (!saving) { setEditing(false); setError(null); } }}
              aria-disabled={saving || undefined}>Cancel</button>
            <button type="submit" className="primary-button" aria-disabled={saving || undefined}>{saving ? "Saving…" : "Save brief"}</button>
          </div>
        </form> : <>
          {brief?.requirements.length ? <ol className="scope-review-requirements">{brief.requirements.map((requirement, index) =>
            <li key={index}>{requirement}</li>)}</ol>
            : <p className="scope-review-empty">Add the requested outcome and acceptance criteria to compare them with your changes.</p>}
          {brief?.sources.map((source, index) => <details key={source.messageId} className="scope-review-source">
            <summary><ChevronRight size={13} />Linked user message {index + 1}</summary>
            <p>{source.excerpt}{source.excerpt.length === 4_000 ? "…" : ""}</p>
          </details>)}
          {errorNotice}
          <div className="scope-review-actions">
            <button type="button" className="secondary-button" onClick={() => {
              setText(brief?.requirements.join("\n") ?? ""); setLinked(brief?.sources.map((source) => source.messageId) ?? []);
              setRevision(brief?.revision ?? 0); setEditing(true); setError(null);
            }}>Edit brief</button>
            <button type="button" className={activeReview || draft !== null ? "secondary-button" : "primary-button"}
              aria-disabled={reviewUnavailable || undefined} onClick={() => { if (!reviewUnavailable) void perform(onReview); }}>
              {loading ? "Reviewing…" : activeReview ? "Refresh review" : "Review request"}</button>
          </div>
        </>}
      </div>
      <div className="scope-review-findings" aria-live="polite">
        <h3 className="scope-review-label">Evidence in changes</h3>
        {!activeReview && <p className="scope-review-empty">{editing ? "Save your brief to review its requirements." : loading ? "Reviewing the changes against your brief…" : "Run a review against the current brief and diff. Earlier findings are hidden when either changes."}</p>}
        {activeReview && <ol className="scope-review-cards">{activeReview.requirements.map((requirement) => {
          const label = activeReview.brief.requirements[requirement.requirementIndex];
          const missing = requirement.evidence.length === 0;
          return <li key={requirement.requirementIndex} className="scope-review-card">
            <h4><span>{requirement.requirementIndex + 1}.</span> {label}</h4>
            {missing && <div className="scope-review-gap">
              <p className="scope-review-status"><CircleAlert size={13} />No visible implementation or test evidence</p>
              {draftLink(`Requirement: ${label}\nNo visible implementation or test evidence was found in this diff. This does not establish that the behavior is missing elsewhere.`)}
            </div>}
            {requirement.evidence.map((evidence) => <div className="scope-review-evidence" key={`${evidence.path}:${evidence.hunkId}`}>
              {evidenceLink(evidence)}
              <small>{evidence.kind === "test" ? "Test change" : "Implementation"} · {evidence.confidence} confidence</small>
              <p>{evidence.reason}</p>
            </div>)}
          </li>;
        })}</ol>}
        {activeReview && <div className="scope-review-unexplained">
          <h3 className="scope-review-label">Needs explanation <span>{activeReview.unexplained.length}</span></h3>
          {activeReview.unexplained.length === 0 && <p className="scope-review-empty">No unconnected changes were identified by this review.</p>}
          {activeReview.unexplained.length > 0 && <ul className="scope-review-cards">{activeReview.unexplained.map((finding) =>
            <li key={`${finding.path}:${finding.hunkId}`} className="scope-review-card">
              {evidenceLink(finding)}
              <small className="scope-review-status"><TriangleAlert size={13} />Connection unclear · {finding.confidence} confidence</small>
              <p>{finding.reason}</p>
              {draftLink(`Needs explanation: ${finding.path}${finding.hunkId ? ` (${finding.hunkId})` : ""}\n${finding.reason}\nReviewer confidence: ${finding.confidence}.`)}
            </li>)}</ul>}
        </div>}
      </div>
    </div>
    {draft !== null && <div className="scope-review-draft">
      <div className="scope-review-field">
        <label htmlFor="scope-review-request">Edit request to agent</label>
        <textarea ref={draftRef} id="scope-review-request" aria-describedby="scope-review-request-help" rows={5} value={draft} maxLength={24_000}
          onChange={(event) => setDraft(event.target.value)} />
        <small id="scope-review-request-help">The request is added to your next prompt. Review it before sending.</small>
      </div>
      {draftStale && <p className="scope-review-notice" role="status"><TriangleAlert size={14} />
        <span>The brief or diff changed. Run a new review and select a current finding before adding a request. Your draft is kept here.</span></p>}
      <div className="scope-review-actions">
        <button type="button" className="secondary-button" onClick={() => setDraft(null)}>Dismiss request</button>
        <button type="button" className="primary-button" aria-disabled={addUnavailable || undefined} onClick={() => {
          if (addUnavailable) return;
          onAddTextToPrompt(draft.trim()); setDraft(null);
        }}>Add request to prompt</button>
      </div>
    </div>}
  </section>;
}
