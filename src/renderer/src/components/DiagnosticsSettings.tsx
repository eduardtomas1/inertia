import { useEffect, useMemo, useState } from "react";
import { Activity, ArrowUpRight, Check, ChevronDown, Copy, Download, RefreshCw, Search, ShieldCheck, TriangleAlert } from "lucide-react";
import {
  DIAGNOSTIC_CATALOG, DIAGNOSTIC_LIMITS, diagnosticDefinition,
  type DiagnosticPage, type DiagnosticQuery, type DiagnosticRecord,
} from "@shared/application-diagnostics";
import type { Conversation, Project, ProviderInfo } from "@shared/contracts";
import { navigateDiagnosticContext, type DiagnosticSelection } from "../utils/diagnosticNavigation";
import "./DiagnosticsSettings.css";

interface Props {
  projects: readonly Project[];
  conversations: readonly Conversation[];
  providers: readonly ProviderInfo[];
  selection?: DiagnosticSelection;
}
const subsystemNames = { application: "Application", discord: "Discord", provider: "Providers", runtime: "Runtime", git: "Git", terminal: "Terminal" };
const subsystems = [...new Set(Object.values(DIAGNOSTIC_CATALOG).map(({ subsystem }) => subsystem))];
const outcomeNames: Record<DiagnosticRecord["outcome"], string> = {
  "not-started": "Not started", failed: "Historical failure", unknown: "Outcome unknown",
  observing: "Observing", recovered: "Recovered", ended: "Observation ended",
};
const dateTime = (at: string): string => new Date(at).toLocaleString(undefined, {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

export function DiagnosticsSettings({ projects, conversations, providers, selection }: Props): React.JSX.Element {
  const [filters, setFilters] = useState<DiagnosticQuery>({ severity: "attention" });
  const [timeRange, setTimeRange] = useState("all");
  const [offset, setOffset] = useState(0);
  const [selectionDismissed, setSelectionDismissed] = useState(false);
  const [page, setPage] = useState<DiagnosticPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(selection?.incidentId ?? null);
  const [copying, setCopying] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const activeSelection = selectionDismissed ? undefined : selection;
  const query = useMemo<DiagnosticQuery>(() => ({ ...(activeSelection ? { ...activeSelection, severity: "all" } : filters), offset,
  }), [filters, activeSelection, offset]);
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    setSelectionDismissed(false);
    setOffset(0);
    setExpanded(selection?.incidentId ?? null);
  }, [selection]);

  useEffect(() => {
    let active = true;
    let pending = false;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async (): Promise<void> => {
      timer = null;
      if (!active) return;
      if (pending) { dirty = true; return; }
      pending = true;
      setLoading(true);
      try {
        const result = await window.inertia.queryDiagnostics(JSON.parse(queryKey) as DiagnosticQuery);
        if (active) { setPage(result); setError(null); }
      } catch {
        if (active) setError("Diagnostics could not be read from the desktop app. Your work has not been retried. Try refreshing this list.");
      } finally {
        pending = false;
        if (active) {
          setLoading(false);
          if (dirty) { dirty = false; timer = setTimeout(() => void read(), 1_000); }
        }
      }
    };
    // Debounce typing and coalesce bounded main-process change notifications.
    timer = setTimeout(() => void read(), 200);
    const unsubscribe = window.inertia.onDiagnosticsChanged?.(() => {
      if (!timer) timer = setTimeout(() => void read(), 1_000);
    });
    return () => { active = false; if (timer) clearTimeout(timer); unsubscribe?.(); };
  }, [queryKey, refresh]);

  const update = (value: Partial<DiagnosticQuery>): void => {
    setFilters((current) => ({ ...current, ...value })); setOffset(0);
  };
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const conversationById = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const projectIds = [...new Set([...projects.map(({ id }) => id), ...(page?.facets.projectIds ?? [])])];
  const providerIds = [...new Set([...providers.map(({ id }) => id), ...(page?.facets.providerIds ?? [])])];
  const projectLabel = (id: string): string => projectById.get(id)?.name ?? `Unavailable project · ${id.slice(0, 8)}`;

  const copy = async (record: DiagnosticRecord): Promise<void> => {
    setCopying(record.id); setNotice(null);
    try {
      await window.inertia.copyDiagnostics({ incidentId: record.id, severity: "all" });
      setNotice("Incident copied. Private context identifiers and all user/provider content are omitted.");
    } catch { setNotice("The incident could not be copied. Try again from this list."); }
    finally { setCopying(null); }
  };
  const exportFiltered = async (): Promise<void> => {
    if (exporting) return;
    setExporting(true);
    setNotice(null);
    try {
      const result = await window.inertia.exportDiagnostics(query);
      setNotice(result.status === "exported" ? "Filtered diagnostics saved with private context identifiers omitted." : "Export cancelled. No file was saved.");
    } catch { setNotice("The export could not be prepared. Select a smaller time range or refresh and try again."); }
    finally { setExporting(false); }
  };

  return <section className="diagnostics-center" aria-labelledby="diagnostics-heading">
    <header className="diagnostics-header">
      <div className="diagnostics-heading-icon"><Activity size={20} aria-hidden="true" /></div>
      <div><h3 id="diagnostics-heading">Diagnostics</h3><p>Understand what happened. Decide what happens next.</p></div>
      <button type="button" className="secondary-button" disabled={!page || !page.total || loading || exporting} onClick={() => void exportFiltered()}>
        <Download size={14} aria-hidden="true" />Export filtered
      </button>
    </header>

    <div className="diagnostics-local-strip">
      <ShieldCheck size={16} aria-hidden="true" /><span>Stored on this device. No telemetry or automatic uploads.</span>
      <span className="diagnostics-runtime-state">{page ? page.runtime === "ready" ? "Runtime connected" : "Runtime offline · diagnostics available" : "Reading local diagnostics…"}</span>
    </div>
    {page?.persistence === "unavailable" && <p className="diagnostics-notice is-warning" role="status">
      Persistence unavailable. New incidents are kept in bounded memory and may be lost when you quit. Copy or export important incidents now.
    </p>}
    {page && page.dropped > 0 && <p className="diagnostics-notice" role="status">
      {page.dropped} journal updates could not be retained. This is a bounded history, not a complete audit trail.
    </p>}

    <div className="diagnostics-filters" role="search" aria-label="Filter diagnostics">
      <label className="diagnostics-search"><span className="visually-hidden">Search diagnostics</span><Search size={15} aria-hidden="true" />
        <input type="search" maxLength={160} disabled={Boolean(activeSelection)} placeholder="Search explanation, code or correlation…" value={filters.search ?? ""}
          onChange={(event) => update({ search: event.target.value })} />
      </label>
      <label><span>Severity</span><select value={query.severity ?? "attention"} disabled={Boolean(activeSelection)} onChange={(event) => update({ severity: event.target.value as DiagnosticQuery["severity"] })}>
        <option value="attention">Warnings &amp; errors</option><option value="all">All severities</option>
        <option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Information</option>
      </select></label>
      <label><span>Subsystem</span><select disabled={Boolean(activeSelection)} value={filters.subsystem ?? ""} onChange={(event) => update({ subsystem: event.target.value as DiagnosticQuery["subsystem"] || undefined })}>
        <option value="">All subsystems</option>{subsystems.map((subsystem) => <option key={subsystem} value={subsystem}>{subsystemNames[subsystem]}</option>)}
      </select></label>
      <label><span>Provider</span><select disabled={Boolean(activeSelection)} value={filters.providerId ?? ""} onChange={(event) => update({ providerId: event.target.value as DiagnosticQuery["providerId"] || undefined })}>
        <option value="">All providers</option>{providerIds.map((id) => <option key={id} value={id}>{providerById.get(id)?.label ?? id}</option>)}
      </select></label>
      <label><span>Project</span><select disabled={Boolean(activeSelection)} value={filters.projectId ?? ""} onChange={(event) => update({ projectId: event.target.value || undefined })}>
        <option value="">All projects</option>{projectIds.map((id) => <option key={id} value={id}>{projectLabel(id)}</option>)}
      </select></label>
      <label><span>Time</span><select disabled={Boolean(activeSelection)} value={timeRange} onChange={(event) => {
        const value = event.target.value; setTimeRange(value);
        update({ after: value === "all" ? undefined : new Date(Date.now() - Number(value)).toISOString() });
      }}><option value="all">All retained history</option><option value="3600000">Last hour</option><option value="86400000">Last 24 hours</option><option value="604800000">Last 7 days</option></select></label>
    </div>
    {activeSelection && <div className="diagnostics-context-filter"><span>Showing the referenced operation</span>
      <button className="text-button" type="button" onClick={() => { setSelectionDismissed(true); setOffset(0); }}>Show all incidents</button>
    </div>}
    <div className="diagnostics-list-heading"><span aria-live="polite">{page ? `${page.total} matching ${page.total === 1 ? "incident" : "incidents"}` : "Local incident history"}</span>
      <span>Newest first</span><button type="button" className="icon-button" aria-label="Refresh diagnostics" disabled={loading} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={14} /></button>
    </div>
    {error && <p role="alert" className="diagnostics-notice is-warning">{error}</p>}
    {notice && <p role="status" className="diagnostics-notice">{notice}</p>}
    <div className="diagnostics-list" aria-label="Diagnostic incidents" aria-busy={loading}>
      {!page && loading ? <p className="diagnostics-empty">Reading bounded local history…</p>
        : page?.records.length === 0 ? <div className="diagnostics-empty"><Check size={22} aria-hidden="true" />
          <h4>No incidents match these filters</h4><p>{activeSelection ? "This operation may be outside the retained history or predate structured diagnostics." : "Try another filter or time range. An empty history does not certify every operation as healthy."}</p>
        </div> : page?.records.map((record) => {
          const definition = diagnosticDefinition(record.code);
          const conversation = record.context.conversationId ? conversationById.get(record.context.conversationId) : undefined;
          const current = page.runtime === "ready" && page.currentIncidentIds.includes(record.id);
          const state = current && record.outcome === "failed" && record.operation === "provider-connect" && !record.context.turnId
            ? "Needs attention" : record.outcome === "observing" && !current ? "Historical observation" : outcomeNames[record.outcome];
          return <details className={`diagnostics-incident severity-${record.severity}`} key={record.id} open={expanded === record.id}>
            <summary onClick={(event) => { event.preventDefault(); setExpanded(expanded === record.id ? null : record.id); }}>
              <span className="diagnostics-incident-icon" aria-hidden="true">{record.outcome === "recovered" ? <Check size={16} /> : <TriangleAlert size={16} />}</span>
              <span className="diagnostics-incident-heading"><strong>{definition.title}</strong><span>{subsystemNames[record.subsystem]}{record.context.providerId ? ` · ${providerById.get(record.context.providerId)?.label ?? record.context.providerId}` : ""}{record.context.projectId ? ` · ${projectLabel(record.context.projectId)}` : ""}</span></span>
              <span className={`diagnostics-outcome outcome-${record.outcome}`}>{state}</span>
              <time dateTime={record.at}>{dateTime(record.at)}</time><ChevronDown size={14} aria-hidden="true" />
            </summary>
            <div className="diagnostics-incident-detail">
              <div className="diagnostics-explanation"><div><h4>{definition.causeKnown ? "Observed cause" : "What is known"}</h4><p>{definition.cause}</p>
                {record.code === "turn.inactivity" && <p>{record.outcome === "recovered" ? "Provider activity resumed. " : record.outcome === "ended" ? "The observation ended; activity recovery was not established. " : ""}{record.metadata.silenceMs !== undefined ? `Observed silence: ${Math.round(record.metadata.silenceMs / 1_000)} seconds. Silence alone does not establish a hang.` : ""}</p>}
              </div><div><h4>Next step</h4><p>{record.outcome === "recovered" ? "This condition recovered. Earlier failed or uncertain operations remain separate; nothing was replayed automatically." : definition.nextStep}</p></div></div>
              <dl className="diagnostics-facts"><div><dt>Code</dt><dd><code>{record.code}</code></dd></div><div><dt>Correlation reference</dt><dd><code>{record.correlationId}</code></dd></div>
                <div><dt>First / last observed</dt><dd>{dateTime(record.firstAt)} / {dateTime(record.at)}</dd></div><div><dt>Occurrences</dt><dd>{record.occurrences}</dd></div>
                {record.metadata.httpStatus !== undefined && <div><dt>HTTP status</dt><dd>{record.metadata.httpStatus}</dd></div>}
                {record.metadata.exitCode !== undefined && <div><dt>Exit code</dt><dd>{record.metadata.exitCode}</dd></div>}
                {record.context.conversationId && <div><dt>Conversation</dt><dd>{conversation?.title ?? "Unavailable or deleted conversation"}</dd></div>}
              </dl>
              <div className="diagnostics-actions">
                {definition.action === "providers" || definition.action === "discord" ? <button type="button" className="secondary-button" onClick={() => navigateDiagnosticContext({ section: definition.action as "providers" | "discord" })}>
                  Open {definition.action === "providers" ? "provider" : "Discord"} settings<ArrowUpRight size={13} aria-hidden="true" />
                </button> : null}
                {record.context.conversationId && <button type="button" className="secondary-button" disabled={!conversation || page.runtime !== "ready"}
                  title={!conversation ? "Conversation is unavailable or deleted" : page.runtime !== "ready" ? "Reconnect the runtime to open this conversation" : undefined}
                  onClick={() => navigateDiagnosticContext({ conversationId: record.context.conversationId! })}>Open affected conversation<ArrowUpRight size={13} aria-hidden="true" /></button>}
                <button type="button" className="secondary-button" disabled={copying === record.id} onClick={() => void copy(record)}><Copy size={13} aria-hidden="true" />Copy incident</button>
              </div>
            </div>
          </details>;
        })}
    </div>
    <footer className="diagnostics-footer"><span>Bounded, rotating local history. Exports omit context identifiers.</span>
      <div><button type="button" className="secondary-button" disabled={!offset || loading} onClick={() => setOffset(Math.max(0, offset - DIAGNOSTIC_LIMITS.pageSize))}>Previous</button>
        <button type="button" className="secondary-button" disabled={page?.nextOffset == null || loading} onClick={() => setOffset(page?.nextOffset ?? 0)}>Next</button></div>
    </footer>
  </section>;
}
