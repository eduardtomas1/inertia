import { useCallback, useEffect, useRef, useState } from "react";
import { Bug, Copy, ExternalLink, TriangleAlert } from "lucide-react";
import type { ProviderId, ProviderInfo, ServerEvent } from "@shared/contracts";
import { ISSUE_REPOSITORY, ISSUE_REPOSITORY_URL, REPORT_BODY_LIMIT, REPORT_TEXT_LIMIT, type IssueGitHubState, type IssueReport } from "@shared/issue-report";
import { ISSUE_GITHUB_MESSAGES, manualIssueUrl } from "@shared/issue-report-github";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { writeClipboardText } from "../utils/clipboard";
import "./IssueReportSettings.css";

export interface IssueReportSettingsProps {
  providers: ProviderInfo[];
  disabled: boolean;
  request(command: CommandWithoutId): Promise<ServerEvent>;
}

type FocusTarget = "description" | "title" | "issue" | "check" | "retire" | "retire-trigger" | "replace" | null;

export function IssueReportSettings({ providers, disabled, request }: IssueReportSettingsProps): React.JSX.Element {
  const [report, setReport] = useState<IssueReport | null>(null);
  const [github, setGithub] = useState<IssueGitHubState | null>(null);
  const [view, setView] = useState<"form" | "preview">("form");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState("");
  const [providerId, setProviderId] = useState<ProviderId | "">("");
  const [attachDiagnostics, setAttachDiagnostics] = useState(true);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [failedNow, setFailedNow] = useState(false);
  const [status, setStatus] = useState("");
  const [formInvalid, setFormInvalid] = useState(false);
  const [previewInvalid, setPreviewInvalid] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [focusTarget, setFocusTarget] = useState<FocusTarget>(null);
  const seeded = useRef("");
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const requestRef = useRef(request);
  requestRef.current = request;
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const issueRef = useRef<HTMLButtonElement>(null);
  const checkRef = useRef<HTMLButtonElement>(null);
  const retireRef = useRef<HTMLDivElement>(null);
  const retireTriggerRef = useRef<HTMLButtonElement>(null);
  const replaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const targets = { description: descriptionRef, title: titleRef, issue: issueRef, check: checkRef, retire: retireRef, "retire-trigger": retireTriggerRef, replace: replaceRef };
    if (!focusTarget) return;
    targets[focusTarget].current?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  const seedForm = useCallback((next: IssueReport) => {
    setDescription(next.description);
    setSteps(next.steps);
    setProviderId(next.providerId ?? "");
    setAttachDiagnostics(next.attachDiagnostics);
  }, []);

  const apply = useCallback((next: IssueReport | null, initial = false) => {
    if (!mounted.current) return;
    setLoaded(true);
    setReport(next);
    if (!next) return;
    const key = `${next.id}:${next.revision}`;
    if (seeded.current === key) return;
    seeded.current = key;
    if (initial && next.status === "submitted") return;
    setTitle(next.title);
    setBody(next.body);
    seedForm(next);
    if (initial) setView("preview");
  }, [seedForm]);

  const command = useCallback(async (value: CommandWithoutId): Promise<IssueReport | null> => {
    const event = await requestRef.current(value);
    if (event.type !== "request.result" || event.result.kind !== "support.report") throw new Error("Report response unavailable.");
    if (event.result.github && mounted.current) setGithub(event.result.github);
    apply(event.result.report, value.type === "support.report.get" && seeded.current === "");
    return event.result.report;
  }, [apply]);

  useEffect(() => {
    mounted.current = true;
    void command({ type: "support.report.get" })
      .then(() => command({ type: "support.report.github" }))
      .catch(() => { if (mounted.current) setLoaded(true); });
    return () => { mounted.current = false; };
  }, [command]);

  useEffect(() => {
    if (report?.status !== "submitting" || busy) return;
    const timer = setInterval(() => { void command({ type: "support.report.get" }).catch(() => undefined); }, 2_000);
    return () => clearInterval(timer);
  }, [report?.status, busy, command]);

  const locked = !loaded || disabled;
  const perform = async (operation: () => Promise<unknown>): Promise<void> => {
    if (busyRef.current || locked) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setStatus("");
    setFailedNow(false);
    try { await operation(); }
    catch { if (mounted.current) setError("The request did not finish. Nothing was published; try again."); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };

  const editable = report?.status === "preview" || report?.status === "failed";
  const unchangedForm = Boolean(report && editable && description.trim() === report.description && steps.trim() === report.steps
    && (providerId || null) === report.providerId && attachDiagnostics === report.attachDiagnostics);
  const edited = Boolean(report && (title !== report.title || body !== report.body));
  const previewEdited = Boolean(report && editable && (edited || report.revision > 0));

  const saveEdits = async (): Promise<IssueReport | null> => {
    if (!report || !edited) return report;
    const saved = await command({ type: "support.report.edit", payload: { id: report.id, revision: report.revision, title, body } });
    return saved && saved.title === title.trim() && saved.body === body.trim() ? saved : null;
  };
  const regenerate = async (): Promise<void> => {
    await command({ type: "support.report.prepare", payload: { description, steps, providerId: providerId || null, attachDiagnostics } });
    setView("preview");
    setFocusTarget("title");
  };
  const preview = (): void => {
    if (busyRef.current || locked) return;
    if (description.trim().length < 10) {
      setFormInvalid(true);
      setFocusTarget("description");
      return;
    }
    if (unchangedForm) {
      setView("preview");
      setFocusTarget("title");
      return;
    }
    if (previewEdited) {
      setReplacing(true);
      setFocusTarget("replace");
      return;
    }
    void perform(regenerate);
  };
  const keepPreview = (): void => {
    if (report) seedForm(report);
    setReplacing(false);
    setView("preview");
    setFocusTarget("title");
  };
  const back = (): void => {
    void perform(async () => {
      if (edited && !await saveEdits()) return;
      setPreviewInvalid(false);
      setView("form");
      setFocusTarget("description");
    });
  };
  const create = (): void => {
    if (busyRef.current || locked || !editable) return;
    if (title.trim().length < 3 || body.trim().length < 10) {
      setPreviewInvalid(true);
      setFocusTarget("title");
      return;
    }
    setPreviewInvalid(false);
    void perform(async () => {
      const saved = await saveEdits();
      if (!saved) return;
      const next = await command({ type: "support.report.submit", payload: { id: saved.id, revision: saved.revision } });
      if (next?.status === "failed") setFailedNow(true);
      if (next?.status === "uncertain") setFocusTarget("check");
      if (next?.status === "submitted") setFocusTarget("issue");
    });
  };
  const withReviewedText = (deliver: (text: { title: string; body: string }) => Promise<void>): void => {
    if (!edited) {
      void deliver({ title, body });
      return;
    }
    if (title.trim().length < 3 || body.trim().length < 10) {
      setPreviewInvalid(true);
      setFocusTarget("title");
      return;
    }
    setPreviewInvalid(false);
    void perform(async () => {
      const saved = await saveEdits();
      if (saved) await deliver({ title: saved.title, body: saved.body });
    });
  };
  const copy = (): void => withReviewedText(async (text) => {
    const copied = await writeClipboardText(`${text.title}\n\n${text.body}`);
    setStatus(copied ? "Copied." : "Could not copy. Select the text and copy it manually.");
  });
  const openManually = (): void => {
    if (report?.status === "uncertain" || report?.status === "retired") {
      void window.inertia.openExternal(ISSUE_REPOSITORY_URL);
      return;
    }
    withReviewedText(async (text) => {
      const url = manualIssueUrl(text.title, text.body);
      if (url) {
        await window.inertia.openExternal(url);
        return;
      }
      const copied = await writeClipboardText(`${text.title}\n\n${text.body}`);
      await window.inertia.openExternal(manualIssueUrl(text.title) ?? `${ISSUE_REPOSITORY_URL}/new`);
      setStatus(copied ? "The issue is too long for a link, so it was copied. Paste it into the body on GitHub." : "The issue is too long for a link. Copy it and paste it into the body on GitHub.");
    });
  };
  const check = (): void => {
    if (!report) return;
    void perform(async () => {
      const next = await command({ type: "support.report.reconcile", payload: { id: report.id, revision: report.revision } });
      if (next?.status === "submitted") setFocusTarget("issue");
    });
  };
  const retire = (): void => {
    if (!report) return;
    void perform(async () => {
      await command({ type: "support.report.retire", payload: { id: report.id, revision: report.revision, acknowledgeUncertainPublication: true } });
      setRetiring(false);
      setFocusTarget("title");
    });
  };
  const startAnother = (): void => {
    setDescription("");
    setSteps("");
    setProviderId("");
    setAttachDiagnostics(true);
    setStatus("");
    setFormInvalid(false);
    setView("form");
    setFocusTarget("description");
  };

  const notice = report?.notice ?? "";
  const githubMessage = github && github !== "ready" ? ISSUE_GITHUB_MESSAGES[github] : "";
  const showPreview = view === "preview" && report;
  const unavailable = busy || locked || undefined;

  return <section className="settings-card issue-report" aria-labelledby="issue-report-heading">
    <div className="settings-card-heading"><div><Bug size={18} /></div><span><h3 id="issue-report-heading">Report an issue</h3><p>Creates a public issue in {ISSUE_REPOSITORY} after you review it.</p></span></div>
    {githubMessage && (!showPreview || editable) && <p className="issue-report-github" role="status"><TriangleAlert size={14} aria-hidden="true" />{githubMessage}</p>}
    {!showPreview && <form className="issue-report-fields" noValidate onSubmit={(event) => { event.preventDefault(); preview(); }}>
      <label className="issue-report-field"><span>What happened</span>
        <textarea ref={descriptionRef} rows={5} maxLength={REPORT_TEXT_LIMIT} value={description} disabled={locked} aria-required="true" aria-invalid={formInvalid || undefined} aria-describedby={formInvalid ? "issue-report-description-error" : undefined} onChange={(event) => { setDescription(event.target.value); if (event.target.value.trim().length >= 10) setFormInvalid(false); }} />
      </label>
      {formInvalid && <small className="issue-report-error" id="issue-report-description-error">Describe what happened in at least 10 characters.</small>}
      <label className="issue-report-field"><span>Steps to reproduce (optional)</span>
        <textarea rows={4} maxLength={REPORT_TEXT_LIMIT} value={steps} disabled={locked} onChange={(event) => setSteps(event.target.value)} />
      </label>
      <label className="issue-report-field issue-report-provider"><span>Provider</span>
        <select value={providerId} disabled={locked} onChange={(event) => setProviderId(event.target.value as ProviderId | "")}>
          <option value="">Not sure</option>
          {providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.label}</option>)}
        </select>
      </label>
      <label className="issue-report-check">
        <input type="checkbox" checked={attachDiagnostics} disabled={locked} aria-describedby="issue-report-diagnostics-help" onChange={(event) => setAttachDiagnostics(event.target.checked)} />
        <span>Attach diagnostics<small id="issue-report-diagnostics-help">Adds the last 24 hours of diagnostics, with names and paths removed.</small></span>
      </label>
      {!replacing && <div className="issue-report-actions">
        <button type="submit" className="primary-button" aria-disabled={unavailable}>{busy ? "Preparing…" : "Preview issue"}</button>
      </div>}
      {replacing && <div className="issue-report-confirm" role="group" aria-labelledby="issue-report-replace-heading" tabIndex={-1} ref={replaceRef}>
        <h4 id="issue-report-replace-heading">Replace your edited preview?</h4>
        <p>Previewing again rebuilds the issue from the form and discards your edits to it.</p>
        <div className="issue-report-actions">
          <button type="button" className="secondary-button" onClick={keepPreview}>Keep</button>
          <button type="button" className="primary-button" aria-disabled={unavailable} onClick={() => { setReplacing(false); void perform(regenerate); }}>Replace</button>
        </div>
      </div>}
    </form>}
    {showPreview && <div className="issue-report-fields">
      <label className="issue-report-field"><span>Title</span>
        <input ref={titleRef} maxLength={200} value={title} readOnly={!editable} disabled={locked} aria-invalid={previewInvalid || undefined} aria-describedby={previewInvalid ? "issue-report-preview-error" : undefined} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="issue-report-field"><span>Body</span>
        <textarea className="issue-report-body" rows={16} maxLength={REPORT_BODY_LIMIT} value={body} readOnly={!editable} disabled={locked} aria-invalid={previewInvalid || undefined} aria-describedby={previewInvalid ? "issue-report-preview-error" : undefined} onChange={(event) => setBody(event.target.value)} />
      </label>
      {previewInvalid && <small className="issue-report-error" id="issue-report-preview-error">Add a title of at least 3 characters and a body of at least 10.</small>}
      <div className="issue-report-actions">
        {editable && <button type="button" className="secondary-button issue-report-back" aria-disabled={unavailable} onClick={back}>Back</button>}
        {report.status === "uncertain" && <>
          <button ref={checkRef} type="button" className="secondary-button" aria-disabled={unavailable} onClick={check}>Check submission</button>
          <button ref={retireTriggerRef} type="button" className="secondary-button" aria-disabled={unavailable} onClick={() => { if (!busyRef.current && !locked) { setRetiring(true); setFocusTarget("retire"); } }}>Retire this report</button>
        </>}
        {report.status !== "submitted" && <>
          <button type="button" className="secondary-button" onClick={copy}><Copy size={14} aria-hidden="true" />Copy</button>
          <button type="button" className="secondary-button" onClick={openManually}><ExternalLink size={14} aria-hidden="true" />Open GitHub manually</button>
        </>}
        {(editable || report.status === "submitting") && <button type="button" className="primary-button" aria-disabled={unavailable || report.status === "submitting" || undefined} onClick={create}>{busy || report.status === "submitting" ? "Creating…" : "Create on GitHub"}</button>}
        {(report.status === "submitted" || report.status === "retired") && <button type="button" className="secondary-button" onClick={startAnother}>Start another report</button>}
        {report.status === "submitted" && report.issueUrl && <button ref={issueRef} type="button" className="primary-button" onClick={() => { void window.inertia.openExternal(report.issueUrl!); }}><ExternalLink size={14} aria-hidden="true" />View issue</button>}
      </div>
      {retiring && report.status === "uncertain" && <div className="issue-report-confirm" role="group" aria-labelledby="issue-report-retire-heading" tabIndex={-1} ref={retireRef}>
        <h4 id="issue-report-retire-heading">Retire uncertain publication?</h4>
        <p>The issue may already exist on GitHub. Retiring stops checking it and blocks resubmission of this report.</p>
        <div className="issue-report-actions">
          <button type="button" className="secondary-button" onClick={() => { setRetiring(false); setFocusTarget("retire-trigger"); }}>Keep checking</button>
          <button type="button" className="primary-button" aria-disabled={unavailable} onClick={retire}>Confirm retirement</button>
        </div>
      </div>}
    </div>}
    <div className="issue-report-messages">
      {showPreview && notice && <p className={report.status === "failed" ? "is-error" : undefined} role={failedNow && report.status === "failed" ? "alert" : "status"}>{notice}</p>}
      {error && <p className="is-error" role="alert">{error}</p>}
      <p role="status">{status}</p>
    </div>
  </section>;
}
