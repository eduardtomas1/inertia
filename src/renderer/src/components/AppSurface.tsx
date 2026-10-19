import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { AppWindow, ArrowDownToLine, ChevronDown, Copy, Play, Square } from "lucide-react";

import type {
  AppUnderTestEvidenceWithThumbnail,
  AppUnderTestLaunch,
  AppUnderTestLogLine,
  AppUnderTestWindow,
} from "@shared/app-under-test";
import type { ClientCommand, ServerEvent } from "@shared/contracts";
import { INTERFACE_LOCALE } from "../lib/locale";
import { useCopiedState } from "../hooks/useCopiedState";
import {
  appUnderTestErrorMessage,
  useAppUnderTestSession,
  type AppLaunchRequest,
} from "../hooks/useAppUnderTestSession";
import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import {
  appLaunchExitLabel,
  appLaunchStateLabel,
  appLaunchStopDetail,
  appLogRows,
  filterLogLines,
  formatAppUptime,
  isLiveLaunch,
} from "../utils/appUnderTestSession";
import { navigateMenuItems } from "../utils/menuKeyboard";
import "./WorkspaceSurfaces.css";
import "./BrowserEvidenceTimeline.css";
import "./AppSurface.css";

export interface AppSurfaceAction {
  id: string;
  name: string;
}

export interface AppSurfaceProps {
  conversationId: string | null;
  status: ConnectionStatus;
  /** The project's reviewed actions, by name only. Empty for project-free chats. */
  actions: readonly AppSurfaceAction[];
  sendCommand: (command: ClientCommand) => Promise<ServerEvent>;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
}

/** Live launches one chat may run at once; the runtime enforces the same bound. */
const MAX_LIVE_LAUNCHES = 2;
const FOLLOW_THRESHOLD_PX = 4;
const ANNOUNCE_INTERVAL_MS = 2_000;
const ANNOUNCED_TEXT_CHARS = 120;
const THUMBNAIL_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u;

function kindLabel(launch: AppUnderTestLaunch): string {
  return launch.kind === "electron" ? "Electron app" : "Action";
}

function evidenceKindLabel(kind: AppUnderTestEvidenceWithThumbnail["kind"]): string {
  switch (kind) {
    case "launch": return "Launch";
    case "ready": return "Ready";
    case "exit": return "Exit";
    case "action": return "Action";
    case "screenshot": return "Screenshot";
  }
}

function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function truncate(text: string, chars: number): string {
  const points = [...text];
  return points.length > chars ? `${points.slice(0, chars).join("")}…` : text;
}

/**
 * Speaks a bounded summary of new lines at most every two seconds instead of
 * every line, so a noisy app cannot flood a screen reader.
 */
function useLogAnnouncement(lines: readonly AppUnderTestLogLine[], launchId: string | null, enabled: boolean): string {
  const [announcement, setAnnouncement] = useState("");
  const linesRef = useRef(lines);
  const announcedRef = useRef<{ launchId: string | null; cursor: number | null }>({ launchId, cursor: null });
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    linesRef.current = lines;
  });
  useEffect(() => {
    if (announcedRef.current.launchId !== launchId) {
      announcedRef.current = { launchId, cursor: lines.at(-1)?.cursor ?? null };
      setAnnouncement("");
      return;
    }
    const latest = lines.at(-1);
    if (!latest) return;
    if (announcedRef.current.cursor === null || !enabled) {
      announcedRef.current.cursor = latest.cursor;
      return;
    }
    if (latest.cursor <= announcedRef.current.cursor || timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const since = announcedRef.current.cursor ?? 0;
      const fresh = linesRef.current.filter(({ cursor }) => cursor > since);
      const last = fresh.at(-1);
      if (!last) return;
      announcedRef.current.cursor = last.cursor;
      setAnnouncement(`${fresh.length} new log line${fresh.length === 1 ? "" : "s"}. Latest ${last.stream}: ${truncate(last.text, ANNOUNCED_TEXT_CHARS)}`);
    }, ANNOUNCE_INTERVAL_MS);
  }, [enabled, launchId, lines]);
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);
  return announcement;
}

function ActionMenu({
  actions,
  disabled,
  onLaunch,
}: {
  actions: readonly AppSurfaceAction[];
  disabled: boolean;
  onLaunch: (actionId: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const close = (restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };
  return (
    <div
      className="app-surface-menu-anchor"
      onBlur={(event) => {
        if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="workspace-surface-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" || open) return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        Launch action…
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          className="app-surface-menu"
          role="menu"
          aria-label="Project actions"
          onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close(true);
              return;
            }
            if (event.key === "Tab") {
              setOpen(false);
              return;
            }
            navigateMenuItems(event, '[role="menuitem"]');
          }}
        >
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              onClick={() => {
                close(true);
                onLaunch(action.id);
              }}
            >
              <Play size={14} aria-hidden="true" />
              <span>{action.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LaunchRow({
  launch,
  now,
  confirming,
  stopping,
  disabled,
  onStop,
  onConfirm,
  onCancelConfirm,
}: {
  launch: AppUnderTestLaunch;
  now: number;
  confirming: boolean;
  stopping: boolean;
  disabled: boolean;
  onStop: () => void;
  onConfirm: () => void;
  onCancelConfirm: () => void;
}): React.JSX.Element {
  const live = isLiveLaunch(launch);
  const started = Date.parse(launch.startedAt);
  const ended = launch.exitedAt ? Date.parse(launch.exitedAt) : now;
  const exit = appLaunchExitLabel(launch);
  const stopDetail = appLaunchStopDetail(launch);
  const stopRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const confirmingRef = useRef(confirming);
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
    else if (confirmingRef.current && live) stopRef.current?.focus();
    confirmingRef.current = confirming;
  }, [confirming, live]);
  return (
    <li className="app-surface-launch" data-state={launch.state} data-launch-id={launch.launchId}>
      <div className="app-surface-launch-main">
        <strong>{launch.label}</strong>
        <span className="app-surface-launch-state">{appLaunchStateLabel(launch)}</span>
      </div>
      <dl className="app-surface-launch-meta">
        <div><dt>Kind</dt><dd>{kindLabel(launch)}</dd></div>
        <div><dt>Started by</dt><dd>{launch.startedBy === "user" ? "You" : "Agent"}</dd></div>
        {launch.pid !== null && <div><dt>PID</dt><dd>{launch.pid}</dd></div>}
        {Number.isFinite(started) && (
          <div><dt>{live ? "Uptime" : "Ran for"}</dt><dd>{formatAppUptime(ended - started)}</dd></div>
        )}
        {exit && (
          <div>
            <dt>Result</dt>
            <dd>{exit}{stopDetail && <small className="app-surface-launch-detail">{` · ${stopDetail}`}</small>}</dd>
          </div>
        )}
      </dl>
      {launch.failure && <p className="app-surface-launch-failure">{launch.failure}</p>}
      {launch.cleanupConfirmed === false && (
        <p className="app-surface-launch-failure">Inertia could not confirm that every process of this launch ended.</p>
      )}
      {live && !confirming && (
        <div className="workspace-surface-actions">
          <button
            ref={stopRef}
            type="button"
            className="workspace-surface-button"
            disabled={disabled || stopping || launch.state === "stopping"}
            aria-label={`Stop ${launch.label}`}
            onClick={onStop}
          >
            <Square size={14} aria-hidden="true" />
            {stopping || launch.state === "stopping" ? "Stopping…" : "Stop"}
          </button>
        </div>
      )}
      {live && confirming && (
        <div
          className="app-surface-confirm"
          role="group"
          aria-label={`Confirm stopping ${launch.label}`}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            onCancelConfirm();
          }}
        >
          <span>You started this launch. Stop it and end its processes?</span>
          <div className="workspace-surface-actions">
            <button ref={confirmRef} type="button" className="workspace-surface-button is-danger" disabled={disabled} onClick={onConfirm}>
              Stop the app
            </button>
            <button type="button" className="workspace-surface-button" onClick={onCancelConfirm}>Keep running</button>
          </div>
        </div>
      )}
    </li>
  );
}

function LogPane({
  launches,
  selected,
  lines,
  onSelect,
}: {
  launches: readonly AppUnderTestLaunch[];
  selected: AppUnderTestLaunch | null;
  lines: readonly AppUnderTestLogLine[];
  onSelect: (launchId: string) => void;
}): React.JSX.Element {
  const headingId = useId();
  const filterId = useId();
  const paneRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");
  const [following, setFollowing] = useState(true);
  const [hasSelection, setHasSelection] = useState(false);
  const copy = useCopiedState();
  const shown = useMemo(() => filterLogLines(lines, filter), [filter, lines]);
  const filtering = filter.trim() !== "";
  const rows = useMemo(() => filtering
    ? shown.map((line) => ({ kind: "line" as const, key: String(line.cursor), line }))
    : appLogRows(shown), [filtering, shown]);
  const announcement = useLogAnnouncement(shown, selected?.launchId ?? null, following);

  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (pane && following) pane.scrollTop = pane.scrollHeight;
  }, [following, rows]);

  useEffect(() => {
    setFollowing(true);
  }, [selected?.launchId]);

  useEffect(() => {
    const update = (): void => {
      const selection = document.getSelection();
      const pane = paneRef.current;
      setHasSelection(Boolean(selection && !selection.isCollapsed && pane
        && selection.anchorNode && pane.contains(selection.anchorNode)));
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);

  const jumpToLatest = (): void => {
    setFollowing(true);
    const pane = paneRef.current;
    if (!pane) return;
    pane.scrollTop = pane.scrollHeight;
    pane.focus({ preventScroll: true });
  };

  const copyLines = (): void => {
    const selection = document.getSelection();
    const pane = paneRef.current;
    const selectedText = hasSelection && selection && pane && selection.anchorNode && pane.contains(selection.anchorNode)
      ? selection.toString()
      : "";
    void copy.copy(selectedText || shown.map(({ stream, text }) => `[${stream}] ${text}`).join("\n"));
  };

  return (
    <section className="workspace-surface-section app-surface-logs" aria-labelledby={headingId}>
      <div className="app-surface-section-header">
        <h3 id={headingId}>Logs</h3>
        {launches.length > 1 && selected && (
          <select
            className="app-surface-select"
            aria-label="Show logs for"
            value={selected.launchId}
            onChange={(event) => onSelect(event.target.value)}
          >
            {[...launches].reverse().map((launch) => (
              <option key={launch.launchId} value={launch.launchId}>
                {`${launch.label} · ${appLaunchStateLabel(launch)}`}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="app-surface-log-tools">
        <label className="visually-hidden" htmlFor={filterId}>Filter log lines</label>
        <input
          id={filterId}
          className="app-surface-input"
          type="search"
          placeholder="Filter lines"
          autoComplete="off"
          spellCheck={false}
          maxLength={200}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <button type="button" className="workspace-surface-button" disabled={copy.pending || (!hasSelection && shown.length === 0)} onClick={copyLines}>
          <Copy size={14} aria-hidden="true" />
          {copy.copied ? "Copied" : hasSelection ? "Copy selection" : "Copy lines"}
        </button>
        {!following && (
          <button type="button" className="workspace-surface-button" onClick={jumpToLatest}>
            <ArrowDownToLine size={14} aria-hidden="true" />
            Jump to latest
          </button>
        )}
      </div>
      {copy.error && <p className="app-surface-error" role="alert">{copy.error}</p>}
      <div
        ref={paneRef}
        className="app-surface-log"
        role="log"
        aria-live="polite"
        aria-label={selected ? `Log for ${selected.label}` : "App log"}
        tabIndex={0}
        onScroll={(event) => {
          const pane = event.currentTarget;
          setFollowing(pane.scrollHeight - pane.scrollTop - pane.clientHeight <= FOLLOW_THRESHOLD_PX);
        }}
      >
        {rows.length === 0 ? (
          <p className="app-surface-log-empty">
            {!selected ? "Launch the app to see its output here." : filtering ? "No lines match the filter." : "No output yet."}
          </p>
        ) : (
          <ol aria-live="off">
            {rows.map((row) => row.kind === "line" ? (
              <li key={row.key} className="app-surface-log-line" data-stream={row.line.stream}>
                <span className="app-surface-log-stream">{row.line.stream}</span>
                <span className="app-surface-log-text">{row.line.text}</span>
              </li>
            ) : (
              <li key={row.key} className="app-surface-log-marker">
                {row.kind === "skipped"
                  ? `${row.count.toLocaleString(INTERFACE_LOCALE)} line${row.count === 1 ? "" : "s"} skipped`
                  : "Earlier lines are not shown"}
              </li>
            ))}
          </ol>
        )}
        <span className="visually-hidden">{announcement}</span>
      </div>
      {filtering && (
        <small className="app-surface-log-count" role="status">
          {`${shown.length.toLocaleString(INTERFACE_LOCALE)} of ${lines.length.toLocaleString(INTERFACE_LOCALE)} lines match`}
        </small>
      )}
    </section>
  );
}

function WindowList({
  launches,
  windows,
}: {
  launches: readonly AppUnderTestLaunch[];
  windows: Readonly<Record<string, readonly AppUnderTestWindow[]>>;
}): React.JSX.Element {
  const headingId = useId();
  const live = launches.filter(isLiveLaunch);
  const labels = new Map(launches.map((launch) => [launch.launchId, launch.label]));
  const entries = live.flatMap((launch) => windows[launch.launchId] ?? []);
  return (
    <section className="workspace-surface-section app-surface-windows" aria-labelledby={headingId}>
      <h3 id={headingId}>Windows</h3>
      {entries.length === 0 ? (
        <p className="workspace-surface-empty">No windows open.</p>
      ) : (
        <ul className="app-surface-window-list" aria-label="App windows">
          {entries.map((entry) => (
            <li key={entry.windowId}>
              <AppWindow size={14} aria-hidden="true" />
              <span className="app-surface-window-copy">
                {/* Titles and origins come from the app: plain text only. */}
                <strong>{entry.title || "Untitled window"}</strong>
                <small>
                  {entry.origin ?? "No origin"}
                  {live.length > 1 && ` · ${labels.get(entry.launchId) ?? "App"}`}
                </small>
              </span>
              <span className="app-surface-window-flags">
                {entry.active && <small>Active</small>}
                {entry.loading && <small>Loading</small>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EvidenceList({
  launches,
  evidence,
}: {
  launches: readonly AppUnderTestLaunch[];
  evidence: readonly AppUnderTestEvidenceWithThumbnail[];
}): React.JSX.Element {
  const headingId = useId();
  const labels = new Map(launches.map((launch) => [launch.launchId, launch.label]));
  const entries = [...evidence].reverse();
  return (
    <section className="workspace-surface-section app-surface-evidence" aria-labelledby={headingId}>
      <div className="app-surface-section-header">
        <h3 id={headingId}>Evidence</h3>
        <small>Stays on this device and clears with this chat's App session</small>
      </div>
      {entries.length === 0 ? (
        <p className="workspace-surface-empty">No evidence yet. Launches, exits, agent actions and screenshots appear here.</p>
      ) : (
        <ol className="browser-evidence-list" aria-label="App evidence timeline">
          {entries.map((entry) => {
            const thumbnail = entry.thumbnail && THUMBNAIL_DATA_URL.test(entry.thumbnail) ? entry.thumbnail : null;
            const size = entry.width && entry.height ? `${entry.width} × ${entry.height}` : null;
            return (
              <li key={entry.evidenceId} className={`browser-evidence-entry is-${entry.kind}`}>
                <span className="browser-evidence-entry-copy">
                  <span className="browser-evidence-entry-meta">
                    <span className="browser-evidence-entry-kind">{evidenceKindLabel(entry.kind)}</span>
                    {labels.has(entry.launchId) && <span>{labels.get(entry.launchId)}</span>}
                    <time dateTime={entry.at}>{new Date(entry.at).toLocaleTimeString(INTERFACE_LOCALE)}</time>
                  </span>
                  <strong>{entry.label}</strong>
                  {thumbnail ? (
                    <figure className="app-surface-thumbnail">
                      <img
                        src={thumbnail}
                        alt={size ? `Screenshot of the app, ${size} pixels` : "Screenshot of the app"}
                        {...(entry.width && entry.height ? { width: entry.width, height: entry.height } : {})}
                        draggable={false}
                      />
                      <figcaption>{size ? `Local screenshot · ${size}` : "Local screenshot"}</figcaption>
                    </figure>
                  ) : entry.hasThumbnail ? (
                    <small className="browser-evidence-capture-expired">Thumbnail is no longer kept</small>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export function AppSurface({
  conversationId,
  status,
  actions,
  sendCommand,
  subscribe,
}: AppSurfaceProps): React.JSX.Element {
  const headingId = useId();
  const [error, setError] = useState<string | null>(null);
  const [selectedLaunchId, setSelectedLaunchId] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [stoppingIds, setStoppingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const launchesHeadingRef = useRef<HTMLHeadingElement>(null);
  const session = useAppUnderTestSession({
    conversationId,
    status,
    focusLaunchId: selectedLaunchId,
    sendCommand,
    subscribe,
    onError: setError,
  });
  const { launches, logs, windows, evidence, loaded } = session.state;
  const online = status === "online";
  const liveCount = launches.filter(isLiveLaunch).length;
  const now = useClock(liveCount > 0);
  const selected = launches.find(({ launchId }) => launchId === selectedLaunchId) ?? launches.at(-1) ?? null;
  const atLimit = liveCount >= MAX_LIVE_LAUNCHES;
  const launchDisabled = !conversationId || !online || launching || atLimit;

  const returnFocusToLauncher = useCallback((): void => {
    window.requestAnimationFrame(() => {
      const launcher = launcherRef.current;
      if (launcher && !launcher.disabled) launcher.focus();
      else launchesHeadingRef.current?.focus();
    });
  }, []);

  const startLaunch = (input: AppLaunchRequest): void => {
    if (launchDisabled) return;
    setLaunching(true);
    setError(null);
    void session.launch(input).then((launch) => {
      if (launch) setSelectedLaunchId(launch.launchId);
    }, (failure: unknown) => {
      setError(appUnderTestErrorMessage(failure, "The app could not be launched."));
    }).finally(() => setLaunching(false));
  };

  const stopLaunch = (launch: AppUnderTestLaunch): void => {
    setConfirmingId(null);
    setError(null);
    setStoppingIds((current) => new Set([...current, launch.launchId]));
    void session.stop(launch.launchId).catch((failure: unknown) => {
      setError(appUnderTestErrorMessage(failure, "The app could not be stopped."));
    }).finally(() => {
      setStoppingIds((current) => new Set([...current].filter((id) => id !== launch.launchId)));
      returnFocusToLauncher();
    });
  };

  if (!conversationId) {
    return (
      <section className="workspace-surface app-surface" aria-label="App">
        <div className="workspace-surface-scroll">
          <p className="workspace-surface-empty">Available after the first message creates this chat's workspace.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="workspace-surface app-surface" aria-label="App">
      <div className="workspace-surface-scroll">
        <div className="app-surface-toolbar" role="group" aria-label="Launch the app">
          <button
            ref={launcherRef}
            type="button"
            className="workspace-surface-button"
            disabled={launchDisabled}
            aria-busy={launching || undefined}
            onClick={() => startLaunch({ kind: "electron" })}
          >
            <Play size={14} aria-hidden="true" />
            {launching ? "Launching…" : "Launch Electron app"}
          </button>
          {actions.length > 0 && (
            <ActionMenu
              actions={actions}
              disabled={launchDisabled}
              onLaunch={(actionId) => startLaunch({ kind: "action", actionId })}
            />
          )}
        </div>
        {!online && <p className="app-surface-notice" role="status">Reconnecting to Inertia's local service…</p>}
        {online && atLimit && (
          <p className="app-surface-notice">{`This chat already runs ${MAX_LIVE_LAUNCHES} launches. Stop one to launch another.`}</p>
        )}
        {error && <p className="app-surface-error" role="alert">{error}</p>}

        <section className="workspace-surface-section app-surface-launches" aria-labelledby={headingId}>
          <h3 id={headingId} ref={launchesHeadingRef} tabIndex={-1}>Launches</h3>
          {launches.length === 0 ? (
            <div className="app-surface-empty">
              <strong>{loaded ? "Run the app you are building" : "Loading the App session…"}</strong>
              <span>
                Launch your project's Electron app or one of its reviewed actions. Its logs, windows and
                screenshots for this chat appear here and stay on this device. The agent uses the same App
                tools when it tests your app, and asks before it acts in supervised chats.
              </span>
            </div>
          ) : (
            <ul className="app-surface-launch-list" aria-label="App launches">
              {[...launches].reverse().map((launch) => (
                <LaunchRow
                  key={launch.launchId}
                  launch={launch}
                  now={now}
                  confirming={confirmingId === launch.launchId}
                  stopping={stoppingIds.has(launch.launchId)}
                  disabled={!online}
                  onStop={() => {
                    if (launch.startedBy === "user") setConfirmingId(launch.launchId);
                    else stopLaunch(launch);
                  }}
                  onConfirm={() => stopLaunch(launch)}
                  onCancelConfirm={() => setConfirmingId(null)}
                />
              ))}
            </ul>
          )}
        </section>

        <LogPane
          launches={launches}
          selected={selected}
          lines={selected ? logs[selected.launchId] ?? [] : []}
          onSelect={setSelectedLaunchId}
        />
        <WindowList launches={launches} windows={windows} />
        <EvidenceList launches={launches} evidence={evidence} />
      </div>
    </section>
  );
}

export default AppSurface;
