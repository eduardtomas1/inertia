import { useCallback, useEffect, useRef, useState } from "react";
import { Bug, Copy, ExternalLink, TriangleAlert } from "lucide-react";
import type { ProviderId, ProviderInfo, ServerEvent } from "@shared/contracts";
import { ISSUE_GITHUB_MESSAGES, ISSUE_REPOSITORY, ISSUE_REPOSITORY_URL, manualIssueUrl, REPORT_BODY_LIMIT, REPORT_TEXT_LIMIT, type IssueGitHubState, type IssueReport } from "@shared/issue-report";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { writeClipboardText } from "../utils/clipboard";
import "./IssueReportSettings.css";

export interface IssueReportSettingsProps {
  providers: ProviderInfo[];
  disabled: boolean;
  request(command: CommandWithoutId): Promise<ServerEvent>;
}

type FocusTarget = "description" | "title" | "issue" | "retire" | "retire-trigger" | null;

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
  const retireRef = useRef<HTMLDivElement>(null);
  const retireTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const targets = { description: descriptionRef, title: titleRef, issue: issueRef, retire: retireRef, "retire-trigger": retireTriggerRef };
    if (!focusTarget) return;
    targets[focusTarget].current?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

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
    setDescription(next.description);
    setSteps(next.steps);
    setProviderId(next.providerId ?? "");
    setAttachDiagnostics(next.attachDiagnostics);
    if (initial) setView("preview");
  }, []);

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

  const perform = async (operation: () => Promise<unknown>): Promise<void> => {
    if (busyRef.current) return;
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
  const locked = !loaded || disabled;
  const unchangedForm = Boolean(report && editable && description.trim() === report.description && steps.trim() === report.steps
    && (providerId || null) === report.providerId && attachDiagnostics === report.attachDiagnostics);
  const edited = Boolean(report && (title !== report.title || body !== report.body));

  const saveEdits = async (): Promise<IssueReport | null> => {
    if (!report || !edited) return report;
    const saved = await command({ type: "support.report.edit", payload: { id: report.id, revision: report.revision, title, body } });
    return saved && saved.title === title.trim() && saved.body === body.trim() ? saved : null;
  };
  const preview = (): void => {
    void perform(async () => {
      if (!unchangedForm) await command({ type: "support.report.prepare", payload: { description, steps, providerId: providerId || null, attachDiagnostics } });
      setView("preview");
      setFocusTarget("title");
    });
  };
  const back = (): void => {
    void perform(async () => {
      if (edited && !await saveEdits()) return;
      setView("form");
      setFocusTarget("description");
    });
  };
  const create = (): void => {
    void perform(async () => {
      const saved = await saveEdits();
      if (!saved) return;
      const next = await command({ type: "support.report.submit", payload: { id: saved.id, revision: saved.revision } });
      if (next?.status === "failed") setFailedNow(true);
      if (next?.status === "submitted") setFocusTarget("issue");
    });
  };
  const copy = async (): Promise<boolean> => {
    const copied = await writeClipboardText(`${title}\n\n${body}`);
    setStatus(copied ? "Copied." : "Could not copy. Select the text and copy it manually.");
    return copied;
  };
  const openManually = async (): Promise<void> => {
    if (report?.status === "uncertain" || report?.status === "retired") {
      await window.inertia.openExternal(ISSUE_REPOSITORY_URL);
      return;
    }
    const url = manualIssueUrl(title, body);
    if (url) {
      await window.inertia.openExternal(url);
      return;
    }
    const copied = await writeClipboardText(`${title}\n\n${body}`);
    await window.inertia.openExternal(manualIssueUrl(title) ?? `${ISSUE_REPOSITORY_URL}/new`);
    setStatus(copied ? "The issue is too long for a link, so it was copied. Paste it into the body on GitHub." : "The issue is too long for a link. Copy it and paste it into the body on GitHub.");
  };
  const startAnother = (): void => {
    setDescription("");
    setSteps("");
    setProviderId("");
    setAttachDiagnostics(true);
    setStatus("");
    setView("form");
    setFocusTarget("description");
  };

  const notice = report?.notice ?? "";
  const githubMessage = github && github !== "ready" ? ISSUE_GITHUB_MESSAGES[github] : "";
  const showPreview = view === "preview" && report;

  return <section className="settings-card issue-report" aria-labelledby="issue-report-heading">
    <div className="settings-card-heading"><div><Bug size={18} /></div><span><h3 id="issue-report-heading">Report an issue</h3><p>Creates a public issue in {ISSUE_REPOSITORY} after you review it.</p></span></div>
    {!showPreview && <form className="issue-report-fields" onSubmit={(event) => { event.preventDefault(); if (description.trim().length >= 10) preview(); }}>
      <label className="issue-report-field"><span>What happened</span>
        <textarea ref={descriptionRef} rows={5} maxLength={REPORT_TEXT_LIMIT} value={description} disabled={locked} onChange={(event) => setDescription(event.target.value)} />
      </label>
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
      <div className="issue-report-actions">
        <button type="submit" className="primary-button" disabled={locked || description.trim().length < 10} aria-disabled={busy || undefined}>{busy ? "Preparing…" : "Preview issue"}</button>
      </div>
    </form>}
    {showPreview && <div className="issue-report-fields">
      <label className="issue-report-field"><span>Title</span>
        <input ref={titleRef} maxLength={200} value={title} readOnly={!editable} disabled={locked} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="issue-report-field"><span>Body</span>
        <textarea className="issue-report-body" rows={16} maxLength={REPORT_BODY_LIMIT} value={body} readOnly={!editable} disabled={locked} onChange={(event) => setBody(event.target.value)} />
      </label>
      <div className="issue-report-actions">
        {editable && <button type="button" className="secondary-button issue-report-back" aria-disabled={busy || undefined} disabled={locked} onClick={back}>Back</button>}
        {report.status === "uncertain" && <>
          <button type="button" className="secondary-button" aria-disabled={busy || undefined} disabled={locked} onClick={() => { void perform(() => command({ type: "support.report.reconcile", payload: { id: report.id, revision: report.revision } })); }}>Check submission</button>
          <button ref={retireTriggerRef} type="button" className="secondary-button" aria-disabled={busy || undefined} disabled={locked} onClick={() => { if (!busyRef.current) { setRetiring(true); setFocusTarget("retire"); } }}>Retire this report</button>
        </>}
        {report.status !== "submitted" && <>
          <button type="button" className="secondary-button" onClick={() => { void copy(); }}><Copy size={14} aria-hidden="true" />Copy</button>
          <button type="button" className="secondary-button" onClick={() => { void openManually(); }}><ExternalLink size={14} aria-hidden="true" />Open GitHub manually</button>
        </>}
        {(editable || report.status === "submitting") && <button type="button" className="primary-button" aria-disabled={busy || report.status === "submitting" || undefined} disabled={locked || title.trim().length < 3 || body.trim().length < 10} onClick={() => { if (editable) create(); }}>{busy || report.status === "submitting" ? "Creating…" : "Create on GitHub"}</button>}
        {(report.status === "submitted" || report.status === "retired") && <button type="button" className="secondary-button" onClick={startAnother}>Start another report</button>}
        {report.status === "submitted" && report.issueUrl && <button ref={issueRef} type="button" className="primary-button" onClick={() => { void window.inertia.openExternal(report.issueUrl!); }}><ExternalLink size={14} aria-hidden="true" />View issue</button>}
      </div>
      {retiring && report.status === "uncertain" && <div className="issue-report-retire" role="group" aria-labelledby="issue-report-retire-heading" tabIndex={-1} ref={retireRef}>
        <h4 id="issue-report-retire-heading">Retire uncertain publication?</h4>
        <p>The issue may already exist on GitHub. Retiring stops checking it and blocks resubmission of this report.</p>
        <div className="issue-report-actions">
          <button type="button" className="secondary-button" onClick={() => { setRetiring(false); setFocusTarget("retire-trigger"); }}>Keep checking</button>
          <button type="button" className="primary-button" aria-disabled={busy || undefined} disabled={locked} onClick={() => { void perform(async () => { await command({ type: "support.report.retire", payload: { id: report.id, revision: report.revision, acknowledgeUncertainPublication: true } }); setRetiring(false); }); }}>Confirm retirement</button>
        </div>
      </div>}
    </div>}
    <div className="issue-report-messages">
      {showPreview && notice && <p className={report.status === "failed" ? "is-error" : undefined} role={failedNow && report.status === "failed" ? "alert" : "status"}>{notice}</p>}
      {githubMessage && (!showPreview || editable) && <p className="issue-report-github" role="status"><TriangleAlert size={14} aria-hidden="true" />{githubMessage}</p>}
      {error && <p className="is-error" role="alert">{error}</p>}
      <p role="status">{status}</p>
    </div>
  </section>;
}
