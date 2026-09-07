import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bug, Check, Copy, ExternalLink, ShieldCheck, Square } from "lucide-react";
import type { ModelBackendProfileView, ModelSelection, Project, ProviderInfo, ServerEvent } from "@shared/contracts";
import { ISSUE_REPOSITORY_URL, reportAllowsAgent, scrubReportText, type IssueReport } from "@shared/issue-report";
import { modelSelectionSchema, providerNativeModelSelection } from "@shared/model-routing";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { buildComposerModelRoutes } from "../utils/modelChooserRoutes";
import "./IssueReportSettings.css";

export interface IssueReportSettingsProps {
  providers: ProviderInfo[];
  backendProfiles: ModelBackendProfileView[];
  projects: Project[];
  disabled: boolean;
  request(command: CommandWithoutId): Promise<ServerEvent>;
  onProviderSetup(): void;
}
export function IssueReportSettings({ providers, backendProfiles, projects, disabled, request, onProviderSetup }: IssueReportSettingsProps): React.JSX.Element {
  const [report, setReport] = useState<IssueReport | null>(null);
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("");
  const [selection, setSelection] = useState<ModelSelection>(() => providerNativeModelSelection({ providerId: "claude" }));
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [editing, setEditing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const requestRef = useRef(request);
  requestRef.current = request;
  const apply = useCallback((next: IssueReport | null) => {
    if (!mounted.current) return;
    setLoaded(true);
    setReport(next);
    if (next) {
      setDescription(next.description); setProjectId(next.projectId ?? ""); setSelection(next.selection);
      setTitle(next.title); setBody(next.body);
    }
  }, []);
  const command = useCallback(async (value: CommandWithoutId): Promise<IssueReport | null> => {
    const event = await requestRef.current(value);
    if (event.type !== "request.result" || event.result.kind !== "support.report") throw new Error("Report response unavailable.");
    apply(event.result.report);
    return event.result.report;
  }, [apply]);
  useEffect(() => {
    mounted.current = true;
    void command({ type: "support.report.get" }).catch(() => { if (mounted.current) setError("Could not load the saved report. Reconnect and reload before continuing."); });
    return () => { mounted.current = false; };
  }, [command]);
  // A reopened report observes the authoritative run while it finishes or cancels on disconnect.
  useEffect(() => {
    if (!report || !["validating", "submitting"].includes(report.status) || busy) return;
    const timer = setInterval(() => { void command({ type: "support.report.get" }).catch(() => undefined); }, 2_000);
    return () => clearInterval(timer);
  }, [report, busy, command]);
  const perform = async (operation: () => Promise<unknown>): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try { await operation(); }
    catch { if (mounted.current) setError("The report request did not finish. Reload saved progress before retrying; nothing is published automatically."); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const routes = useMemo(() => buildComposerModelRoutes(providers, backendProfiles, selection), [providers, backendProfiles, selection]);
  const selectedIndex = routes.findIndex((route) => route.selection.harnessId === selection.harnessId && route.selection.backendProfileId === selection.backendProfileId && route.selection.modelId === selection.modelId);
  const selectedRoute = routes[selectedIndex];
  const supported = reportAllowsAgent(selection.harnessId);
  const ready = supported && selectedRoute?.selectable === true && providers.some((provider) => provider.id === "claude" && provider.canRun);
  const locked = !loaded || busy || disabled || report?.status === "validating" || report?.status === "submitting" || report?.status === "uncertain";
  const submitted = report?.status === "submitted";
  const prepare = async (): Promise<void> => {
    await command({ type: "support.report.prepare", payload: { description, projectId: projectId || null, selection: modelSelectionSchema.parse(selection) } });
    setEditing(false);
  };
  const validate = async (): Promise<void> => {
    if (!report) return;
    setReport({ ...report, status: "validating", notice: "Validating your observations against the safe local evidence…" });
    await command({ type: "support.report.validate", payload: { id: report.id, revision: report.revision } });
  };
  return <section className="settings-card issue-report" aria-labelledby="issue-report-heading">
    <div className="settings-card-heading"><div><Bug size={18} /></div><span><h3 id="issue-report-heading">Report an issue</h3><p>Turn a problem into a useful GitHub issue for eduardtomas1/inertia.</p></span></div>
    <ol className="issue-report-steps" aria-label="Report progress">
      <li aria-current={!report ? "step" : undefined}>1 · Describe</li><li aria-current={report && !["preview", "submitted", "submitting", "uncertain"].includes(report.status) ? "step" : undefined}>2 · Validate</li><li aria-current={report?.status === "preview" ? "step" : undefined}>3 · Review & submit</li>
    </ol>
    <div className="issue-report-safety"><ShieldCheck size={18} aria-hidden="true" /><p>Only Inertia version, platform, lifecycle codes and counts are collected. A selected project adds chat and pending-interaction counts. No logs, files, paths or conversation content are read. Review your description for private information before sending it to your chosen provider or GitHub.</p></div>
    {!report && <div className="issue-report-form">
      <label>What happened?<textarea aria-label="What happened?" rows={5} maxLength={8000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What were you doing? What did you expect, what happened instead, and how can we reproduce it?" disabled={locked} /></label>
      <div className="issue-report-options">
        <label>Agent and model<select aria-label="Report agent and model" value={selectedIndex < 0 ? "" : selectedIndex} disabled={locked} onChange={(event) => { const route = routes[Number(event.target.value)]; if (route) setSelection(route.selection); }}>
          {selectedIndex < 0 && <option value="">Choose a model</option>}
          {routes.map((route, index) => <option key={`${route.selection.backendProfileId}:${route.selection.modelId}`} value={index}>{route.providerLabel} · {route.displayName}</option>)}
        </select></label>
        <label>Reasoning<select aria-label="Report reasoning" disabled={locked || !selectedRoute?.reasoningOptions.length} value={selection.reasoningEffort ?? ""} onChange={(event) => setSelection({ ...selection, reasoningEffort: event.target.value || null })}>
          <option value="">Provider default</option>{selectedRoute?.reasoningOptions.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
        </select></label>
        <label>Diagnostic scope<select aria-label="Diagnostic scope" value={projectId} disabled={locked} onChange={(event) => setProjectId(event.target.value)}><option value="">App only</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name} · counts only</option>)}</select></label>
      </div>
      <p className="settings-card-note">Automatic validation currently supports Claude Agent SDK with tools disabled. Other providers can continue with a manual preview. Your existing model authentication is used.</p>
      {!ready && <button type="button" className="secondary-button" onClick={onProviderSetup}>Open provider setup</button>}
      <button type="button" className="primary-button" disabled={locked || description.trim().length < 10} onClick={() => { void perform(prepare); }}>Create private report chat</button>
    </div>}
    {report && <>
      <div className="issue-report-chat" aria-label="Private report chat">
        <article><strong>You</strong><p>{report.description}</p></article>
        <article><strong>Inertia report assistant</strong><p>{report.answer || "I collected the safe local metadata below. Start validation to compare your observations with this evidence. The model cannot use tools, inspect your project, execute commands or make changes."}</p><small>{selection.modelId} · {selection.reasoningEffort ?? "provider default reasoning"} · tools disabled · 90-second limit</small></article>
      </div>
      <details className="issue-report-evidence"><summary>Safe evidence included · app metadata{report.projectId ? " + selected-project counts" : " only"}</summary><pre>{report.evidence}</pre></details>
      <p role="status" className="issue-report-notice">{report.notice || "Private draft saved on this device. You can leave and return to finish it."}</p>
      {error && <p role="alert">{error}</p>}
      {!submitted && <div className="issue-report-actions">
        {report.status === "validating" ? <button type="button" className="secondary-button" disabled={disabled} onClick={() => { void command({ type: "support.report.cancel", payload: { id: report.id } }).catch(() => setError("Could not cancel. Reconnect and reload saved progress.")); }}><Square size={13} />Cancel validation</button> : !["submitting", "uncertain"].includes(report.status) && <>
          <button type="button" className="secondary-button" disabled={locked || !ready} onClick={() => { void perform(validate); }}>{report.status === "failed" || report.status === "cancelled" ? "Retry validation" : "Validate with selected model"}</button>
          <button type="button" className="secondary-button" disabled={locked} onClick={() => { setEditing(true); }}>Edit issue preview</button>
        </>}
        {!supported && <span>This route supports manual reporting. Choose Claude Agent SDK for automatic validation.</span>}
      </div>}
      <section className="issue-report-preview" aria-labelledby="issue-preview-heading"><div className="issue-report-preview-heading"><h4 id="issue-preview-heading">Public issue preview</h4><span>eduardtomas1/inertia</span></div>
        {editing && !submitted ? <>
          <label>Issue title<input aria-label="Issue title" maxLength={200} value={title} disabled={locked} onChange={(event) => setTitle(event.target.value)} /></label>
          <label>Issue body<textarea aria-label="Issue body" rows={15} maxLength={24000} value={body} disabled={locked} onChange={(event) => setBody(event.target.value)} /></label>
          <button type="button" className="secondary-button" disabled={locked || title.trim().length < 3 || body.trim().length < 10} onClick={() => { void perform(async () => { await command({ type: "support.report.edit", payload: { id: report.id, revision: report.revision, title, body } }); setEditing(false); }); }}>Save and review preview</button>
        </> : <><h4>{report.title}</h4><pre>{report.body}</pre></>}
      </section>
      <div className="issue-report-actions">
        {submitted ? <button type="button" className="primary-button" onClick={() => { void window.inertia.openExternal(report.issueUrl!); }}><Check size={16} />View published issue</button> : <>
          <button type="button" className="primary-button" disabled={locked || editing} onClick={() => { void perform(async () => {
            if (report.status !== "preview") { await command({ type: "support.report.edit", payload: { id: report.id, revision: report.revision, title: report.title, body: report.body } }); return; }
            await command({ type: "support.report.submit", payload: { id: report.id, revision: report.revision } });
          }); }}>{report.status === "submitting" ? "Submitting…" : report.status === "preview" ? "Submit issue to GitHub" : "Confirm preview"}</button>
          {report.status === "uncertain" && <button type="button" className="secondary-button" disabled={busy || disabled} onClick={() => { void perform(() => command({ type: "support.report.reconcile", payload: { id: report.id, revision: report.revision } })); }}>Check submission</button>}
          <button type="button" className="secondary-button" disabled={editing} onClick={() => { void navigator.clipboard.writeText(`${report.title}\n\n${report.body}`).then(() => setCopyStatus("Preview copied."), () => setCopyStatus("Could not copy. Select the preview text manually.")); }}><Copy size={14} />Copy preview</button>
          <button type="button" className="secondary-button" onClick={() => { void window.inertia.openExternal(report.status === "uncertain" ? ISSUE_REPOSITORY_URL : `${ISSUE_REPOSITORY_URL}/new`); }}><ExternalLink size={14} />Open GitHub manually</button>
        </>}
        <button type="button" className="secondary-button" disabled={locked} onClick={() => { setReport(null); setDescription(scrubReportText(description)); setEditing(false); }}>Start another draft</button>
      </div>
      <p role="status">{copyStatus}</p>
    </>}
    {error && !report && <p role="alert">{error}</p>}
    <button type="button" className="secondary-button" disabled={busy || disabled} onClick={() => { void perform(() => command({ type: "support.report.get" })); }}>Reload saved progress</button>
  </section>;
}
