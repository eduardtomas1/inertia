import { createHash } from "node:crypto";
import {
  DIAGNOSTIC_LIMITS,
  compareDiagnosticEntries,
  diagnosticDefinition,
  diagnosticEventMatches,
  diagnosticMatches,
  diagnosticQuerySchema,
  diagnosticRecordSchema,
  parseDiagnosticIncident,
  type DiagnosticEventEntry,
  type DiagnosticIncident,
  type DiagnosticPage,
  type DiagnosticQuery,
  type DiagnosticRecord,
} from "../shared/application-diagnostics.js";

type DiagnosticFilter = ReturnType<typeof diagnosticQuerySchema.parse>;
type ExportItem =
  | { kind: "incident"; at: string; id: string; record: DiagnosticRecord }
  | { kind: "event"; at: string; id: string; entry: DiagnosticEventEntry };

interface IncidentIndexOptions {
  now: () => number;
  retentionMs: number;
  load: () => unknown[];
  append: (record: DiagnosticRecord) => void;
}

/** Main-owned bounded view over the existing runtime journal, never over SQLite. */
function sameIncidentSubject(
  previous: DiagnosticIncident["context"],
  incident: DiagnosticIncident["context"],
): boolean {
  const { requestId: _previousRequest, ...previousSubject } = previous;
  const { requestId: _incidentRequest, ...incidentSubject } = incident;
  return JSON.stringify(previousSubject) === JSON.stringify(incidentSubject);
}

export class ApplicationIncidentIndex {
  private readonly records = new Map<string, DiagnosticRecord>();
  private readonly pending = new Map<string, DiagnosticRecord>();
  private loaded = false;
  private persistence: DiagnosticPage["persistence"] = "available";
  private revision = 0;
  private dropped = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private notify: (() => void) | undefined;
  private runtime: DiagnosticPage["runtime"] = "unavailable";
  private generationHash: string | null = null;

  constructor(private readonly options: IncidentIndexOptions) {}

  onChange(notify: () => void): void { this.notify = notify; }

  setRuntime(ready: boolean, generationHash: string | null = null): void {
    const next = ready ? "ready" : "unavailable";
    if (next === this.runtime && generationHash === this.generationHash) return;
    this.runtime = next;
    this.generationHash = generationHash;
    this.revision += 1;
    this.schedule();
  }

  record(value: unknown): DiagnosticRecord | null {
    const incident = parseDiagnosticIncident(value);
    if (!incident) return null;
    this.load();
    const now = this.options.now();
    const at = Date.parse(incident.at);
    if (at < now - this.options.retentionMs || at > now + 60_000) return null;
    this.prune();
    const previous = this.records.get(incident.id);
    // Propagated observations may not relabel the original operation or revive
    // an already recovered episode. Identity belongs to the producer, not UI
    // focus. A producer that reuses one identity for repeats of the same
    // failing operation (command incidents) may name a new request each time;
    // the record then carries the latest request and counts the occurrence.
    if (previous && (
      previous.code !== incident.code
      || previous.runtimeGeneration !== incident.runtimeGeneration
      || !sameIncidentSubject(previous.context, incident.context)
      || Date.parse(previous.at) > at
      || (previous.outcome === "recovered" && incident.outcome !== "recovered")
    )) return null;
    const definition = diagnosticDefinition(incident.code);
    const record: DiagnosticRecord = {
      ...incident,
      severity: definition.severity,
      subsystem: definition.subsystem,
      operation: definition.operation,
      firstAt: previous?.firstAt ?? incident.at,
      occurrences: previous
        ? Math.min(1_000_000, previous.occurrences + (previous.outcome === incident.outcome ? 1 : 0))
        : 1,
    };
    this.records.set(record.id, record);
    if (this.pending.size >= DIAGNOSTIC_LIMITS.pendingWrites && !this.pending.has(record.id)) {
      this.pending.delete(this.pending.keys().next().value!);
      this.dropped = Math.min(1_000_000, this.dropped + 1);
    }
    this.pending.set(record.id, record);
    this.prune();
    this.revision += 1;
    this.schedule();
    return record;
  }

  query(value: DiagnosticQuery, events: readonly DiagnosticEventEntry[] = []): DiagnosticPage {
    const query = diagnosticQuerySchema.parse(value);
    this.load();
    this.prune();
    const matching = this.merged(query, events);
    const window = matching.slice(query.offset, query.offset + query.limit);
    const records = window.flatMap((item) => item.kind === "incident" ? [item.record] : []);
    return {
      records, events: window.flatMap((item) => item.kind === "event" ? [item.entry] : []),
      capture: true, since: null, total: matching.length,
      nextOffset: query.offset + window.length < matching.length ? query.offset + window.length : null,
      persistence: this.persistence, runtime: this.runtime,
      revision: this.revision, dropped: this.dropped,
      currentIncidentIds: records.filter((record) => record.runtimeGeneration && this.generationHash
        && createHash("sha256").update(record.runtimeGeneration).digest("hex").slice(0, 12) === this.generationHash)
        .map(({ id }) => id),
      facets: {
        providerIds: [...new Set([...this.records.values()].flatMap(({ context }) => context.providerId ? [context.providerId] : []))].sort(),
        projectIds: [...new Set([...this.records.values()].flatMap(({ context }) => context.projectId ? [context.projectId] : []))].sort(),
      },
    };
  }

  export(value: DiagnosticQuery, events: readonly DiagnosticEventEntry[] = []): string {
    const report = this.render(this.matching(value, events));
    if (Buffer.byteLength(report) > DIAGNOSTIC_LIMITS.exportBytes) {
      throw new Error("Select a smaller diagnostics time range before exporting.");
    }
    return report;
  }

  exportWithin(value: DiagnosticQuery, maxBytes: number, events: readonly DiagnosticEventEntry[] = []): string {
    const items = this.matching(value, events);
    const fits = (count: number): boolean => Buffer.byteLength(this.render(items.slice(0, count))) <= maxBytes;
    if (items.length === 0 || !fits(1)) return "";
    let low = 1;
    let high = items.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(middle)) low = middle;
      else high = middle - 1;
    }
    return this.render(items.slice(0, low));
  }

  clear(): void {
    this.load();
    this.records.clear();
    this.pending.clear();
    this.dropped = 0;
    this.persistence = "available";
    this.touch();
  }

  touch(): void {
    this.revision += 1;
    this.schedule();
  }

  private matching(value: DiagnosticQuery, events: readonly DiagnosticEventEntry[]): ExportItem[] {
    const query = diagnosticQuerySchema.parse(value);
    this.load();
    this.prune();
    return this.merged(query, events);
  }

  private merged(query: DiagnosticFilter, events: readonly DiagnosticEventEntry[]): ExportItem[] {
    const records = [...this.records.values()].filter((record) => diagnosticMatches(record, query));
    if (events.length === 0) {
      return records
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id, "en"))
        .map((record) => ({ kind: "incident", at: record.at, id: record.id, record }));
    }
    return [
      ...records.map((record): ExportItem => ({ kind: "incident", at: record.at, id: record.id, record })),
      ...events.filter((entry) => diagnosticEventMatches(entry, query))
        .map((entry): ExportItem => ({ kind: "event", at: entry.at, id: entry.id, entry })),
    ].sort(compareDiagnosticEntries);
  }

  private render(items: readonly ExportItem[]): string {
    // Per-export pseudonyms preserve correlation within this report without
    // exporting project/chat/turn/request IDs or stable cross-report identifiers.
    const references = new Map<string, string>();
    const reference = (id: string): string => {
      const current = references.get(id) ?? `incident-${references.size + 1}`;
      references.set(id, current);
      return current;
    };
    const safe = items.flatMap((item) => item.kind === "incident" ? [item.record] : [])
      .map(({ id, correlationId, context, runtimeGeneration: _generation, ...record }) => ({
        ...record,
        id: reference(id), correlation: reference(correlationId),
        ...(context.providerId ? { provider: context.providerId } : {}),
        explanation: diagnosticDefinition(record.code),
      }));
    const events = items.flatMap((item) => item.kind === "event" ? [item.entry] : [])
      .map(({ id: _id, ...entry }) => entry);
    return JSON.stringify({
      schemaVersion: 1, generatedAt: new Date(this.options.now()).toISOString(),
      privacy: "Context identifiers, names, paths, URLs, credentials and all user/provider content are omitted. Correlation references are local to this export.",
      persistence: this.persistence, records: safe, events,
    }, null, 2);
  }

  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const [index, record] of entries.entries()) {
      try {
        this.options.append(record);
        this.persistence = "available";
      } catch {
        this.persistence = "unavailable";
        this.dropped = Math.min(1_000_000, this.dropped + entries.length - index);
        // Keep bounded in-memory evidence; do not recursively log an I/O failure
        // or spin retrying a full/unwritable disk.
        break;
      }
    }
    try { this.notify?.(); } catch { /* Observers cannot break the app. */ }
  }

  private schedule(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), DIAGNOSTIC_LIMITS.changeIntervalMs);
    this.flushTimer.unref?.();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      for (const value of this.options.load()) {
        const parsed = diagnosticRecordSchema.safeParse(value);
        if (!parsed.success) continue;
        const record = parsed.data;
        const definition = diagnosticDefinition(record.code);
        if (Date.parse(record.at) > this.options.now() + 60_000 || Date.parse(record.firstAt) > Date.parse(record.at) || record.severity !== definition.severity
          || record.subsystem !== definition.subsystem || record.operation !== definition.operation) continue;
        const previous = this.records.get(record.id);
        if (!previous || Date.parse(previous.at) <= Date.parse(record.at)) this.records.set(record.id, record);
        this.prune();
      }
    } catch { this.persistence = "unavailable"; }
  }

  private prune(): void {
    const cutoff = this.options.now() - this.options.retentionMs;
    for (const [id, record] of this.records) {
      if (Date.parse(record.at) < cutoff) this.records.delete(id);
    }
    if (this.records.size <= DIAGNOSTIC_LIMITS.incidents) return;
    const oldest = [...this.records.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (const record of oldest.slice(0, this.records.size - DIAGNOSTIC_LIMITS.incidents)) {
      this.records.delete(record.id);
    }
  }
}
