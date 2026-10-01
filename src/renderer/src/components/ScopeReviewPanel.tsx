import { useRef, useState } from "react";
import type { ReviewBrief, ReviewBriefInput, ScopeReview } from "@shared/review-brief";
import "./scope-review.css";

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
    <button type="button" className="scope-review-path" disabled={locked} onClick={() => {
      onSelectFile(target.path);
      if (target.hunkId) window.setTimeout(() => document.getElementById(`review-${target.hunkId}`)?.scrollIntoView({ block: "center" }), 0);
    }}>{target.path}</button>
  );
  return <section className="scope-review" aria-label="Review against request">
    <header><strong>Does this change match your request?</strong>
      <span>Suggestions · complete root repository diff</span></header>
    <p className="scope-review-caveat">Evidence is limited to this diff. Test changes do not mean tests ran or passed.</p>
    <div className="scope-review-columns">
      <div className="scope-review-brief">
        <h3>Review brief</h3>
        {editing ? <form onSubmit={(event) => {
          event.preventDefault();
          const requirements = text.split("\n").map((line) => line.trim()).filter(Boolean);
          if (requirements.length > 20 || requirements.some((line) => line.length > 800)) {
            setError("Use up to 20 requirements, each at most 800 characters."); return;
          }
          setSaving(true);
          void perform(async () => { await onSave(revision, { requirements, sourceMessageIds: linked }); setEditing(false); })
            .finally(() => setSaving(false));
        }}>
          <label htmlFor="review-brief-requirements">Requirements · one per line</label>
          <textarea id="review-brief-requirements" value={text} maxLength={16_020} rows={5}
            placeholder="Retry temporary failures up to three times.&#10;Keep authentication behavior unchanged."
            onChange={(event) => setText(event.target.value)} disabled={saving} />
          <label htmlFor="review-brief-source">Link a user message</label>
          <select id="review-brief-source" value="" disabled={saving || linked.length >= 8} onChange={(event) => {
            if (event.target.value) setLinked((current) => [...current, event.target.value]);
          }}><option value="">Choose from loaded messages…</option>{sourceOptions.filter(({ id }) => !linked.includes(id)).map((source) =>
            <option key={source.id} value={source.id}>{source.content.slice(0, 120)}</option>)}</select>
          {linked.map((id) => <div className="scope-review-source" key={id}>
            <small>{sourceOptions.find((source) => source.id === id)?.content.slice(0, 180) ?? "Linked message"}</small>
            <button type="button" disabled={saving} onClick={() => setLinked((current) => current.filter((item) => item !== id))}>Unlink</button>
          </div>)}
          <div className="scope-review-actions"><button type="submit" disabled={saving}>{saving ? "Saving…" : "Save brief"}</button>
            <button type="button" disabled={saving} onClick={() => { setEditing(false); setError(null); }}>Cancel</button></div>
        </form> : <>
          {brief?.requirements.length ? <ol>{brief.requirements.map((requirement, index) => <li key={index}>{requirement}</li>)}</ol>
            : <p>Add the requested outcome and acceptance criteria to compare them with your changes.</p>}
          {brief?.sources.map((source, index) => <details key={source.messageId} className="scope-review-source">
            <summary>Linked user message {index + 1}</summary><p>{source.excerpt}{source.excerpt.length === 4_000 ? "…" : ""}</p>
          </details>)}
          <div className="scope-review-actions"><button type="button" onClick={() => {
            setText(brief?.requirements.join("\n") ?? ""); setLinked(brief?.sources.map((source) => source.messageId) ?? []);
            setRevision(brief?.revision ?? 0); setEditing(true); setError(null);
          }}>Edit brief</button>
          <button type="button" disabled={loading || locked || !brief?.requirements.length} onClick={() => void perform(onReview)}>
            {loading ? "Reviewing…" : activeReview ? "Refresh review" : "Review request"}</button></div>
        </>}
      </div>
      <div className="scope-review-findings" aria-live="polite">
        <h3>Evidence in changes</h3>
        {!activeReview && <p>{editing ? "Save your brief to review its requirements." : "Run a review against the current brief and diff. Earlier findings are hidden when either changes."}</p>}
        {activeReview?.requirements.map((requirement) => {
          const label = activeReview.brief.requirements[requirement.requirementIndex];
          const missing = [!requirement.evidence.some((item) => item.kind === "implementation") && "implementation",
            !requirement.evidence.some((item) => item.kind === "test") && "test"].filter(Boolean).join(" or ");
          return <article key={requirement.requirementIndex} className="scope-review-requirement">
            <h4>{requirement.requirementIndex + 1}. {label}</h4>
            {missing && <div className="scope-review-missing"><span>No visible {missing} evidence</span>
              <button type="button" onClick={() => prepare(`Requirement: ${label}\nNo visible ${missing} evidence was found in this diff. This does not establish that the behavior is missing elsewhere.`)}>Draft request</button></div>}
            {requirement.evidence.map((evidence) => <div className="scope-review-evidence" key={`${evidence.path}:${evidence.hunkId}`}>
              {evidenceLink(evidence)}<small>{evidence.kind === "test" ? "Test change" : "Implementation"} · {evidence.confidence} confidence</small>
              <p>{evidence.reason}</p></div>)}
          </article>;
        })}
        {activeReview && <div className="scope-review-unexplained"><h3>Needs explanation <span>{activeReview.unexplained.length}</span></h3>
          {activeReview.unexplained.length === 0 && <p>No unconnected changes were identified by this review.</p>}
          {activeReview.unexplained.map((finding) => <article key={`${finding.path}:${finding.hunkId}`}>
            {evidenceLink(finding)}<small>{finding.confidence} confidence · connection unclear</small><p>{finding.reason}</p>
            <button type="button" onClick={() => prepare(`Needs explanation: ${finding.path}${finding.hunkId ? ` (${finding.hunkId})` : ""}\n${finding.reason}\nReviewer confidence: ${finding.confidence}.`)}>Draft request</button>
          </article>)}
        </div>}
      </div>
    </div>
    {draft !== null && <div className="scope-review-draft"><label htmlFor="scope-review-request">Edit request to agent</label>
      <textarea ref={draftRef} id="scope-review-request" rows={5} value={draft} maxLength={24_000} onChange={(event) => setDraft(event.target.value)} />
      <div className="scope-review-actions"><button type="button" disabled={!draft.trim() || locked || editing || !activeReview || draftIdentity !== currentIdentity} onClick={() => { onAddTextToPrompt(draft.trim()); setDraft(null); }}>Add request to prompt</button>
        <button type="button" onClick={() => setDraft(null)}>Dismiss request</button></div>
      {(!activeReview || draftIdentity !== currentIdentity) && <p role="status">The brief or diff changed. Run a new review and select a current finding before adding a request. Your draft is preserved here.</p>}
      <small>The request is added to your next prompt. Review it before sending.</small></div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
