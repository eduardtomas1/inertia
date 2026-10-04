import { ArrowUpRight, Check, ChevronDown, CircleAlert, Copy, Info, TriangleAlert } from "lucide-react";
import { INTERFACE_LOCALE } from "../lib/locale";
import {
  diagnosticDefinition,
  type DiagnosticEventEntry,
  type DiagnosticRecord,
  type DiagnosticSeverity,
  type DiagnosticSubsystem,
} from "@shared/application-diagnostics";
import { navigateDiagnosticContext } from "../utils/diagnosticNavigation";

export type DiagnosticsListEntry =
  | { kind: "incident"; id: string; at: string; record: DiagnosticRecord }
  | { kind: "event"; id: string; at: string; entry: DiagnosticEventEntry };

export const SOURCE_NAMES: Readonly<Record<DiagnosticSubsystem, string>> = {
  application: "Application", runtime: "Runtime", provider: "Providers", git: "Git", terminal: "Terminal", discord: "Discord",
};
const LEVEL_NAMES: Readonly<Record<DiagnosticSeverity, string>> = { info: "Info", warning: "Warning", error: "Error" };
const OUTCOME_NAMES: Readonly<Record<DiagnosticRecord["outcome"], string>> = {
  "not-started": "Not started", failed: "Failed", unknown: "Outcome unknown",
  observing: "Observing", recovered: "Recovered", ended: "Observation ended",
};

export function formatDiagnosticTime(at: string): string {
  return new Date(at).toLocaleString(INTERFACE_LOCALE, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit",
  });
}

function LevelIcon({ severity, recovered }: { severity: DiagnosticSeverity; recovered: boolean }): React.JSX.Element {
  if (recovered) return <Check size={15} aria-hidden="true" />;
  if (severity === "error") return <CircleAlert size={15} aria-hidden="true" />;
  if (severity === "warning") return <TriangleAlert size={15} aria-hidden="true" />;
  return <Info size={15} aria-hidden="true" />;
}

interface RowProps {
  item: DiagnosticsListEntry;
  expanded: boolean;
  onToggle(): void;
  runtimeReady: boolean;
  currentIncident: boolean;
  copying: boolean;
  onCopy(record: DiagnosticRecord): void;
  providerLabel(id: string): string;
  projectLabel(id: string): string;
  conversationTitle(id: string): string | undefined;
}

export function DiagnosticsEventRow(props: RowProps): React.JSX.Element {
  const { item, expanded } = props;
  const severity = item.kind === "incident" ? item.record.severity : item.entry.severity;
  const subsystem = item.kind === "incident" ? item.record.subsystem : item.entry.subsystem;
  const title = item.kind === "incident" ? diagnosticDefinition(item.record.code).title : item.entry.title;
  const recovered = item.kind === "incident" && item.record.outcome === "recovered";
  const context = item.kind === "incident" ? item.record.context : null;
  const meta = [
    SOURCE_NAMES[subsystem],
    context?.providerId ? props.providerLabel(context.providerId) : null,
    context?.projectId ? props.projectLabel(context.projectId) : null,
    LEVEL_NAMES[severity],
  ].filter(Boolean).join(" · ");
  const detailId = `diagnostics-detail-${item.id}`;
  return <li className={`diagnostics-event severity-${severity}${recovered ? " is-recovered" : ""}`}>
    <button type="button" className="diagnostics-event-row" aria-expanded={expanded} aria-controls={detailId} onClick={props.onToggle}>
      <span className="diagnostics-event-icon"><LevelIcon severity={severity} recovered={recovered} /></span>
      <span className="diagnostics-event-copy"><strong>{title}</strong><span>{meta}</span></span>
      <time dateTime={item.at}>{formatDiagnosticTime(item.at)}</time>
      <ChevronDown className="diagnostics-event-chevron" size={13} aria-hidden="true" />
    </button>
    {expanded && <div className="diagnostics-event-detail" id={detailId}>
      {item.kind === "incident" ? <IncidentDetail {...props} record={item.record} /> : <EventDetail entry={item.entry} />}
    </div>}
  </li>;
}

function EventDetail({ entry }: { entry: DiagnosticEventEntry }): React.JSX.Element {
  return <dl className="diagnostics-facts">
    <div><dt>Event</dt><dd><code>{entry.event}</code></dd></div>
    {entry.detail.length > 0 && <div className="is-wide"><dt>Details</dt><dd><code className="diagnostics-detail-code" role="region" aria-label="Event details" tabIndex={0}>{entry.detail.join("\n")}</code></dd></div>}
  </dl>;
}

function IncidentDetail(props: RowProps & { record: DiagnosticRecord }): React.JSX.Element {
  const { record } = props;
  const definition = diagnosticDefinition(record.code);
  const conversation = record.context.conversationId ? props.conversationTitle(record.context.conversationId) : undefined;
  const outcome = props.currentIncident && record.outcome === "failed" && record.operation === "provider-connect" && !record.context.turnId
    ? "Needs attention"
    : record.outcome === "observing" && !props.currentIncident ? "Historical observation" : OUTCOME_NAMES[record.outcome];
  const inactivity = record.code === "turn.inactivity" && record.metadata.silenceMs !== undefined
    ? ` Observed silence: ${Math.round(record.metadata.silenceMs / 1_000)} seconds.`
    : "";
  return <>
    <p>{definition.cause}{inactivity}</p>
    <p>{record.outcome === "recovered"
      ? "This condition recovered. Earlier failed or uncertain operations remain separate; nothing was replayed automatically."
      : definition.nextStep}</p>
    <dl className="diagnostics-facts">
      <div><dt>Outcome</dt><dd>{outcome}</dd></div>
      <div><dt>Occurrences</dt><dd>{record.occurrences}</dd></div>
      <div><dt>Code</dt><dd><code>{record.code}</code></dd></div>
      <div><dt>Correlation</dt><dd><code>{record.correlationId}</code></dd></div>
      <div><dt>First seen</dt><dd>{formatDiagnosticTime(record.firstAt)}</dd></div>
      <div><dt>Last seen</dt><dd>{formatDiagnosticTime(record.at)}</dd></div>
      {record.metadata.httpStatus !== undefined && <div><dt>HTTP status</dt><dd>{record.metadata.httpStatus}</dd></div>}
      {record.metadata.exitCode !== undefined && <div><dt>Exit code</dt><dd>{record.metadata.exitCode}</dd></div>}
      {record.context.conversationId && <div><dt>Conversation</dt><dd>{conversation ?? "Unavailable or deleted conversation"}</dd></div>}
    </dl>
    <div className="diagnostics-event-actions">
      {definition.action === "providers" || definition.action === "discord" ? <button type="button" className="secondary-button"
        onClick={() => navigateDiagnosticContext({ section: definition.action as "providers" | "discord" })}>
        Open {definition.action === "providers" ? "provider" : "Discord"} settings<ArrowUpRight size={13} aria-hidden="true" />
      </button> : null}
      {record.context.conversationId && <button type="button" className="secondary-button" disabled={!conversation || !props.runtimeReady}
        title={!conversation ? "Conversation is unavailable or deleted" : !props.runtimeReady ? "Reconnect the runtime to open this conversation" : undefined}
        onClick={() => navigateDiagnosticContext({ conversationId: record.context.conversationId! })}>
        Open affected conversation<ArrowUpRight size={13} aria-hidden="true" />
      </button>}
      <button type="button" className="secondary-button" aria-disabled={props.copying} onClick={() => { if (!props.copying) props.onCopy(record); }}>
        <Copy size={13} aria-hidden="true" />Copy incident
      </button>
    </div>
  </>;
}
