import type {
  AppUnderTestEvidence,
  AppUnderTestEvidenceWithThumbnail,
  AppUnderTestLaunch,
  AppUnderTestLogLine,
  AppUnderTestWindow,
} from "@shared/app-under-test";

/**
 * Renderer projection of one chat's App session. Everything here is bounded:
 * the runtime owns the authoritative launches, logs and evidence, and the
 * surface rereads them on mount and after every reconnect.
 */

/** Lines kept in memory per launch; matches the runtime's own line bound. */
export const MAX_APP_SURFACE_LOG_LINES = 2_000;
export const MAX_APP_SURFACE_EVIDENCE = 100;
export const MAX_APP_SURFACE_LAUNCHES = 8;

export interface AppSessionState {
  launches: readonly AppUnderTestLaunch[];
  windows: Readonly<Record<string, readonly AppUnderTestWindow[]>>;
  evidence: readonly AppUnderTestEvidenceWithThumbnail[];
  logs: Readonly<Record<string, readonly AppUnderTestLogLine[]>>;
  /** True once the first launch list of this mount arrived. */
  loaded: boolean;
}

export type AppSessionAction =
  | { type: "launches"; launches: readonly AppUnderTestLaunch[] }
  | { type: "launch"; launch: AppUnderTestLaunch }
  | { type: "windows"; launchId: string; windows: readonly AppUnderTestWindow[] }
  | { type: "evidence"; evidence: readonly AppUnderTestEvidenceWithThumbnail[] }
  | { type: "evidence.appended"; evidence: AppUnderTestEvidence }
  | { type: "logs"; launchId: string; lines: readonly AppUnderTestLogLine[] }
  | { type: "cleared" };

export function emptyAppSession(): AppSessionState {
  return { launches: [], windows: {}, evidence: [], logs: {}, loaded: false };
}

export function isLiveLaunch(launch: Pick<AppUnderTestLaunch, "state">): boolean {
  return launch.state !== "exited";
}

function byStart(left: AppUnderTestLaunch, right: AppUnderTestLaunch): number {
  return Date.parse(left.startedAt) - Date.parse(right.startedAt);
}

/** Each live launch's windows as its record reported them; exited launches have none. */
function launchWindows(launches: readonly AppUnderTestLaunch[]): Record<string, readonly AppUnderTestWindow[]> {
  return Object.fromEntries(launches.filter(isLiveLaunch).map((launch) => [launch.launchId, launch.windows]));
}

function pick<T>(record: Readonly<Record<string, T>>, keep: ReadonlySet<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => keep.has(key)));
}

/** Union by cursor, oldest first, keeping only the newest bounded lines. */
export function mergeLogLines(
  current: readonly AppUnderTestLogLine[],
  incoming: readonly AppUnderTestLogLine[],
): readonly AppUnderTestLogLine[] {
  if (incoming.length === 0) return current;
  const last = current.at(-1)?.cursor ?? 0;
  // The common live case appends strictly newer lines in order.
  const appended = incoming[0]!.cursor > last
    && incoming.every((line, index) => index === 0 || line.cursor > incoming[index - 1]!.cursor);
  const merged = appended
    ? [...current, ...incoming]
    : [...new Map([...current, ...incoming].map((line) => [line.cursor, line])).values()]
      .sort((left, right) => left.cursor - right.cursor);
  return merged.length > MAX_APP_SURFACE_LOG_LINES ? merged.slice(-MAX_APP_SURFACE_LOG_LINES) : merged;
}

function mergeEvidenceSnapshot(
  current: readonly AppUnderTestEvidenceWithThumbnail[],
  snapshot: readonly AppUnderTestEvidenceWithThumbnail[],
): AppUnderTestEvidenceWithThumbnail[] {
  const listed = new Set(snapshot.map(({ evidenceId }) => evidenceId));
  const newestListed = Math.max(0, ...snapshot.map(({ at }) => Date.parse(at)));
  // Keep only descriptors that arrived after the list was taken; anything
  // older that the list omits was evicted or cleared by the runtime.
  const later = current.filter((entry) => !listed.has(entry.evidenceId) && Date.parse(entry.at) > newestListed);
  return [...snapshot, ...later]
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
    .slice(-MAX_APP_SURFACE_EVIDENCE);
}

export function appSessionReducer(state: AppSessionState, action: AppSessionAction): AppSessionState {
  switch (action.type) {
    case "launches": {
      const launches = [...action.launches].sort(byStart).slice(-MAX_APP_SURFACE_LAUNCHES);
      const known = new Set(launches.map(({ launchId }) => launchId));
      // The list is authoritative when it is read, so a surface opened after
      // the app started shows its windows without waiting for a change.
      return { ...state, launches, logs: pick(state.logs, known), windows: launchWindows(launches), loaded: true };
    }
    case "launch": {
      const exists = state.launches.some(({ launchId }) => launchId === action.launch.launchId);
      const launches = exists
        ? state.launches.map((launch) => launch.launchId === action.launch.launchId ? action.launch : launch)
        : [...state.launches, action.launch].sort(byStart).slice(-MAX_APP_SURFACE_LAUNCHES);
      // A launch pushed out of the bounded list takes its logs and windows with it.
      const known = new Set(launches.map(({ launchId }) => launchId));
      const windows = isLiveLaunch(action.launch) && known.has(action.launch.launchId)
        ? { ...state.windows, [action.launch.launchId]: action.launch.windows }
        : pick(state.windows, new Set(Object.keys(state.windows).filter((id) => id !== action.launch.launchId)));
      return { ...state, launches, windows: pick(windows, known), logs: pick(state.logs, known) };
    }
    case "windows": {
      // A live window report can race ahead of its launch, but never outlives
      // it; launches.list on mount and reconnect restores anything missed.
      const launch = state.launches.find(({ launchId }) => launchId === action.launchId);
      if (launch && !isLiveLaunch(launch)) return state;
      return { ...state, windows: { ...state.windows, [action.launchId]: action.windows } };
    }
    case "evidence":
      return { ...state, evidence: mergeEvidenceSnapshot(state.evidence, action.evidence) };
    case "evidence.appended": {
      if (state.evidence.some(({ evidenceId }) => evidenceId === action.evidence.evidenceId)) return state;
      const entry: AppUnderTestEvidenceWithThumbnail = { ...action.evidence, thumbnail: null };
      return { ...state, evidence: [...state.evidence, entry].slice(-MAX_APP_SURFACE_EVIDENCE) };
    }
    case "logs": {
      const current = state.logs[action.launchId] ?? [];
      const lines = mergeLogLines(current, action.lines);
      return lines === current ? state : { ...state, logs: { ...state.logs, [action.launchId]: lines } };
    }
    case "cleared":
      return { ...emptyAppSession(), loaded: state.loaded };
  }
}

export type AppLogRow =
  | { kind: "line"; key: string; line: AppUnderTestLogLine }
  | { kind: "skipped"; key: string; count: number }
  | { kind: "earlier"; key: string };

/**
 * Cursors grow by one per line and are never reused, so every gap between two
 * known lines is exactly the number of lines the live stream skipped or the
 * runtime evicted before this surface could read them.
 */
export function appLogRows(lines: readonly AppUnderTestLogLine[]): AppLogRow[] {
  const rows: AppLogRow[] = [];
  let previous: number | null = null;
  for (const line of lines) {
    if (previous === null && line.cursor > 1) rows.push({ kind: "earlier", key: "earlier" });
    if (previous !== null && line.cursor - previous > 1) {
      rows.push({ kind: "skipped", key: `skipped-${line.cursor}`, count: line.cursor - previous - 1 });
    }
    rows.push({ kind: "line", key: String(line.cursor), line });
    previous = line.cursor;
  }
  return rows;
}

export function filterLogLines(
  lines: readonly AppUnderTestLogLine[],
  filter: string,
): readonly AppUnderTestLogLine[] {
  const needle = filter.trim().toLocaleLowerCase();
  if (!needle) return lines;
  return lines.filter(({ text, stream }) => text.toLocaleLowerCase().includes(needle) || stream === needle);
}

export function formatAppUptime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function appLaunchStateLabel(launch: AppUnderTestLaunch): string {
  switch (launch.state) {
    case "starting": return "Starting";
    case "running": return "Running";
    case "stopping": return "Stopping";
    case "exited": return "Exited";
  }
}

/**
 * How an exited launch ended. A requested stop reads "Stopped" whatever code
 * or signal the app then chose (143 after SIGTERM, for example), matching the
 * "Stopped" evidence entry; only an unrequested exit reports its code.
 */
export function appLaunchExitLabel(launch: AppUnderTestLaunch): string | null {
  if (launch.state !== "exited") return null;
  if (launch.stopRequested) return "Stopped";
  if (launch.exitCode !== null) return `Exit code ${launch.exitCode}`;
  if (launch.signal !== null) return `Signal ${launch.signal}`;
  return "Ended";
}

/** Secondary detail for a requested stop: how the process tree actually ended. */
export function appLaunchStopDetail(launch: AppUnderTestLaunch): string | null {
  if (launch.state !== "exited" || !launch.stopRequested) return null;
  if (launch.signal !== null) return `signal ${launch.signal}`;
  if (launch.exitCode !== null) return `exit code ${launch.exitCode}`;
  return null;
}
