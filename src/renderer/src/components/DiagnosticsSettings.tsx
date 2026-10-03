import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, FolderOpen, Search, Trash2 } from "lucide-react";
import {
  DIAGNOSTIC_LIMITS,
  compareDiagnosticEntries,
  type DiagnosticPage,
  type DiagnosticQuery,
  type DiagnosticRecord,
} from "@shared/application-diagnostics";
import type { Conversation, Project, ProviderInfo, RuntimeLifecycleDiagnosticSnapshot } from "@shared/contracts";
import type { AppUpdateStatus } from "@shared/desktop";
import type { DiagnosticSelection } from "../utils/diagnosticNavigation";
import { Switch } from "./ui";
import { DiagnosticsClearDialog } from "./DiagnosticsClearDialog";
import { DiagnosticsEventRow, SOURCE_NAMES, formatDiagnosticTime, type DiagnosticsListEntry } from "./DiagnosticsEventRow";
import { DiagnosticsHealth } from "./DiagnosticsHealth";
import "./DiagnosticsSettings.css";

interface Props {
  projects: readonly Project[];
  conversations: readonly Conversation[];
  providers: readonly ProviderInfo[];
  selection?: DiagnosticSelection;
  lifecycleDiagnostics?: RuntimeLifecycleDiagnosticSnapshot;
  appUpdateStatus: AppUpdateStatus | null;
  onRevealRuntimeLogs: () => Promise<string>;
  onCopyRuntimeDiagnosticReport: () => Promise<{ copied: boolean; eventCount: number }>;
}

const SOURCES = ["application", "runtime", "provider", "git", "terminal", "discord"] as const;
type Busy = "export" | "summary" | "logs" | null;

export function DiagnosticsSettings(props: Props): React.JSX.Element {
  const { selection } = props;
  const [filters, setFilters] = useState<DiagnosticQuery>({ severity: "all" });
  const [timeRange, setTimeRange] = useState("all");
  const [offset, setOffset] = useState(0);
  const [selectionDismissed, setSelectionDismissed] = useState(false);
  const [page, setPage] = useState<DiagnosticPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [readFailed, setReadFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(selection?.incidentId ?? null);
  const [copying, setCopying] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [capture, setCapture] = useState<{ enabled: boolean; since: string | null } | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const savingCapture = useRef(false);
  const activeSelection = selectionDismissed ? undefined : selection;
  const query = useMemo<DiagnosticQuery>(() => ({
    ...(activeSelection ? { ...activeSelection, severity: "all" } : filters), offset,
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
        if (active) {
          setPage(result);
          setCapture({ enabled: result.capture, since: result.since });
          setReadFailed(false);
        }
      } catch {
        if (active) setReadFailed(true);
      } finally {
        pending = false;
        if (active) {
          setLoading(false);
          if (dirty) { dirty = false; timer = setTimeout(() => void read(), 1_000); }
        }
      }
    };
    timer = setTimeout(() => void read(), 200);
    const unsubscribe = window.inertia.onDiagnosticsChanged?.(() => {
      if (!timer) timer = setTimeout(() => void read(), 1_000);
    });
    return () => { active = false; if (timer) clearTimeout(timer); unsubscribe?.(); };
  }, [queryKey, refresh]);

  const entries = useMemo<DiagnosticsListEntry[]>(() => page ? [
    ...page.records.map((record): DiagnosticsListEntry => ({ kind: "incident", id: record.id, at: record.at, record })),
    ...page.events.map((entry): DiagnosticsListEntry => ({ kind: "event", id: entry.id, at: entry.at, entry })),
  ].sort(compareDiagnosticEntries) : [], [page]);

  useEffect(() => {
    if (activeSelection && !activeSelection.incidentId && entries.length === 1) setExpanded(entries[0]!.id);
  }, [activeSelection, entries]);

  const update = (value: Partial<DiagnosticQuery>): void => {
    setFilters((current) => ({ ...current, ...value }));
    setOffset(0);
  };
  const report = (message: string): void => { setFailure(null); setNotice(message); };
  const fail = (message: string): void => { setNotice(null); setFailure(message); };
  const projectById = new Map(props.projects.map((project) => [project.id, project]));
  const conversationById = new Map(props.conversations.map((conversation) => [conversation.id, conversation]));
  const providerById = new Map(props.providers.map((provider) => [provider.id, provider]));

  const toggleCapture = async (enabled: boolean): Promise<void> => {
    if (savingCapture.current) return;
    savingCapture.current = true;
    try {
      setCapture(await window.inertia.setDiagnosticsCapture(enabled));
      setFailure(null);
      setRefresh((value) => value + 1);
    } catch {
      fail("Capture could not be changed. Try again.");
    } finally {
      savingCapture.current = false;
    }
  };
  const run = async (kind: Exclude<Busy, null>, action: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(kind);
    try { await action(); } finally { setBusy(null); }
  };
  const exportEvents = (): Promise<void> => run("export", async () => {
    try {
      const result = await window.inertia.exportDiagnostics(JSON.parse(queryKey) as DiagnosticQuery);
      report(result.status === "exported" ? "Diagnostics exported." : "Export cancelled.");
    } catch { fail("The export could not be prepared. Choose a shorter time range and try again."); }
  });
  const copySummary = (): Promise<void> => run("summary", async () => {
    try {
      const result = await props.onCopyRuntimeDiagnosticReport();
      if (result.copied) report(`Support summary copied · ${result.eventCount} ${result.eventCount === 1 ? "event" : "events"}.`);
      else fail("The support summary could not be copied.");
    } catch { fail("The support summary could not be copied."); }
  });
  const revealLogs = (): Promise<void> => run("logs", async () => {
    try {
      if (await props.onRevealRuntimeLogs()) fail("The log folder could not be opened.");
      else report("Log folder opened.");
    } catch { fail("The log folder could not be opened."); }
  });
  const clearHistory = async (): Promise<boolean> => {
    try {
      await window.inertia.clearDiagnostics();
      setExpanded(null);
      setOffset(0);
      setRefresh((value) => value + 1);
      report("Diagnostics history cleared.");
      return true;
    } catch {
      return false;
    }
  };
  const copyIncident = async (record: DiagnosticRecord): Promise<void> => {
    setCopying(record.id);
    try {
      await window.inertia.copyDiagnostics({ incidentId: record.id, severity: "all" });
      report("Incident copied.");
    } catch { fail("The incident could not be copied. Try again."); }
    finally { setCopying(null); }
  };

  const captureOn = capture?.enabled ?? true;
  const missingMessage = !captureOn
    ? "Diagnostics capture is off, so this was not recorded."
    : capture?.since ? "This event is no longer in the retained history, or capture was off when it happened."
      : "This event is no longer in the retained history.";
  const emptyMessage = activeSelection ? missingMessage
    : filters.search || filters.subsystem || filters.after || filters.severity !== "all" ? "No events match these filters." : "No events recorded.";

  return <div className="diagnostics">
    <section className="settings-card diagnostics-overview" aria-labelledby="diagnostics-heading">
      <div className="settings-card-heading"><span><h3 id="diagnostics-heading">Diagnostics</h3></span></div>
      <div className="setting-row diagnostics-capture">
        <span className="setting-copy"><strong>Capture diagnostics</strong>
          <small>{captureOn
            ? "Failures and app events are kept on this device for 7 days."
            : `Off since ${capture?.since ? formatDiagnosticTime(capture.since) : "an earlier session"}. App start, quit and failures are still kept.`}</small>
        </span>
        <Switch label="Capture diagnostics" checked={captureOn} disabled={!capture} onChange={(enabled) => void toggleCapture(enabled)} />
      </div>
      <div className="diagnostics-actions">
        <button type="button" className="secondary-button" disabled={!page || page.total === 0} aria-disabled={busy === "export"} onClick={() => void exportEvents()}>
          <Download size={14} aria-hidden="true" />Export…
        </button>
        <button type="button" className="secondary-button" aria-disabled={busy === "summary"} onClick={() => void copySummary()}>
          <Copy size={14} aria-hidden="true" />Copy support summary
        </button>
        <button type="button" className="secondary-button" aria-disabled={busy === "logs"} onClick={() => void revealLogs()}>
          <FolderOpen size={14} aria-hidden="true" />Reveal log folder
        </button>
        <button type="button" className="secondary-button" onClick={() => setConfirmingClear(true)}>
          <Trash2 size={14} aria-hidden="true" />Clear history…
        </button>
      </div>
      <p className="diagnostics-status" role="status">{notice ?? ""}</p>
      {failure && <p className="diagnostics-status is-error" role="alert">{failure}</p>}
      {page?.persistence === "unavailable" && <p className="diagnostics-status is-error">Diagnostics cannot be saved to disk right now. New events are kept until you quit.</p>}
      {page && page.dropped > 0 && <p className="diagnostics-status">{page.dropped} {page.dropped === 1 ? "event" : "events"} could not be saved.</p>}
      <DiagnosticsHealth runtime={page?.runtime ?? null} lifecycleDiagnostics={props.lifecycleDiagnostics} appUpdateStatus={props.appUpdateStatus} />
    </section>

    <section className="settings-card diagnostics-events" aria-labelledby="diagnostics-events-heading">
      <div className="settings-card-heading"><span><h3 id="diagnostics-events-heading">Recent events</h3></span></div>
      <div className="diagnostics-filters" role="search" aria-label="Filter diagnostics">
        <label className="diagnostics-search"><span className="visually-hidden">Search diagnostics</span><Search size={14} aria-hidden="true" />
          <input type="search" maxLength={160} disabled={Boolean(activeSelection)} placeholder="Search events" value={filters.search ?? ""}
            onChange={(event) => update({ search: event.target.value || undefined })} />
        </label>
        <label><span className="visually-hidden">Level</span>
          <select disabled={Boolean(activeSelection)} value={filters.severity ?? "all"} onChange={(event) => update({ severity: event.target.value as DiagnosticQuery["severity"] })}>
            <option value="all">All levels</option><option value="attention">Warnings and errors</option>
            <option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Info</option>
          </select>
        </label>
        <label><span className="visually-hidden">Source</span>
          <select disabled={Boolean(activeSelection)} value={filters.subsystem ?? ""} onChange={(event) => update({ subsystem: (event.target.value || undefined) as DiagnosticQuery["subsystem"] })}>
            <option value="">All sources</option>{SOURCES.map((source) => <option key={source} value={source}>{SOURCE_NAMES[source]}</option>)}
          </select>
        </label>
        <label><span className="visually-hidden">Time</span>
          <select disabled={Boolean(activeSelection)} value={timeRange} onChange={(event) => {
            const value = event.target.value;
            setTimeRange(value);
            update({ after: value === "all" ? undefined : new Date(Date.now() - Number(value)).toISOString() });
          }}>
            <option value="all">Any time</option><option value="3600000">Last hour</option>
            <option value="86400000">Last 24 hours</option><option value="604800000">Last 7 days</option>
          </select>
        </label>
      </div>
      {activeSelection && <p className="diagnostics-linked">Showing the linked event · <button type="button" className="diagnostics-link"
        onClick={() => { setSelectionDismissed(true); setOffset(0); }}>Show all</button></p>}
      {readFailed && <p className="diagnostics-status is-error" role="alert">Diagnostics could not be read. Try again in a moment.</p>}
      {page && entries.length === 0 ? <p className="diagnostics-empty">{emptyMessage}</p>
        : <ul className="diagnostics-list" aria-label="Recent events" aria-busy={loading}>
          {entries.map((item) => <DiagnosticsEventRow key={item.id} item={item} expanded={expanded === item.id}
            onToggle={() => setExpanded(expanded === item.id ? null : item.id)}
            runtimeReady={page?.runtime === "ready"}
            currentIncident={page?.runtime === "ready" && page.currentIncidentIds.includes(item.id)}
            copying={copying === item.id} onCopy={(record) => void copyIncident(record)}
            providerLabel={(providerId) => providerById.get(providerId as ProviderInfo["id"])?.label ?? providerId}
            projectLabel={(projectId) => projectById.get(projectId)?.name ?? "Unavailable project"}
            conversationTitle={(conversationId) => conversationById.get(conversationId)?.title} />)}
        </ul>}
      {page && (offset > 0 || page.nextOffset !== null) && <div className="diagnostics-pages">
        <button type="button" className="secondary-button" disabled={!offset || loading} onClick={() => setOffset(Math.max(0, offset - DIAGNOSTIC_LIMITS.pageSize))}>Previous</button>
        <button type="button" className="secondary-button" disabled={page.nextOffset === null || loading} onClick={() => setOffset(page.nextOffset ?? 0)}>Next</button>
      </div>}
    </section>
    {confirmingClear && <DiagnosticsClearDialog onClear={clearHistory} onClose={() => setConfirmingClear(false)} />}
  </div>;
}

export default DiagnosticsSettings;
