import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from "react";
import clsx from "clsx";

import { steerAvailable } from "@shared/watcher-feed";
import type { WatcherLinkView } from "@shared/watcher";
import { useDocumentVisibility } from "../../hooks/useDocumentPresence";
import { usePersistedSize } from "../../hooks/usePersistedSize";
import { usePrivateConnectState } from "../../hooks/usePrivateConnectState";
import { useWatcherActions } from "../../hooks/useWatcherActions";
import {
  consumeWatcherDockFocus,
  subscribeWatcherDock,
  watcherDockFocusToken,
  type WatcherDockController,
} from "../../hooks/useWatcherDock";
import { useWatcherFeed } from "../../hooks/useWatcherFeed";
import { watcherAgentLabel } from "../../utils/watcherLinks";
import { PaneResizeHandle } from "../PaneResizeHandle";
import { WatcherBar } from "./WatcherBar";
import {
  watcherDockHeadingId,
  watcherDockId,
  type WatcherSurfaceModel,
} from "./watcherContext";
import { WatcherFeed } from "./WatcherFeed";
import { WatcherNotices } from "./WatcherNotices";
import "./WatcherDock.css";

export const WATCHER_DOCK_WIDTH_KEY = "inertia:layout:watcher-dock-width:v1";
export const WATCHER_DOCK_DEFAULT_WIDTH = 340;
export const WATCHER_DOCK_MIN_WIDTH = 280;
export const WATCHER_DOCK_MAX_WIDTH = 520;
/** At or below this host width the dock floats over the chat as a sheet. */
export const WATCHER_DOCK_SHEET_MAX_HOST_WIDTH = 640;
const DOCK_MOTION_MS = 300;

export interface WatcherDockProps {
  watchedId: string;
  link: WatcherLinkView;
  surface: WatcherSurfaceModel;
  dock: WatcherDockController;
}

type Presence = "open" | "closing" | "closed";

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Keeps the dock painted for its closing motion, then hides it. */
function useDockPresence(open: boolean): Presence {
  const [presence, setPresence] = useState<Presence>(open ? "open" : "closed");
  useEffect(() => {
    if (open) {
      setPresence("open");
      return;
    }
    if (prefersReducedMotion()) {
      setPresence("closed");
      return;
    }
    setPresence((current) => current === "closed" ? current : "closing");
    const timer = window.setTimeout(() => setPresence("closed"), DOCK_MOTION_MS);
    return () => window.clearTimeout(timer);
  }, [open]);
  return presence;
}

/** Narrow hosts present the dock as an overlay sheet (mirrors the CSS query). */
function useSheetPresentation(frameRef: RefObject<HTMLDivElement | null>): boolean {
  const [sheet, setSheet] = useState(false);
  useLayoutEffect(() => {
    const host = frameRef.current?.parentElement;
    if (!host) return;
    // Content-box width, like the container query: an inline tools panel
    // reserves its space with padding on the same host.
    const measure = (): void => {
      const style = window.getComputedStyle(host);
      const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
      const width = host.clientWidth - padding;
      setSheet(width > 0 && width <= WATCHER_DOCK_SHEET_MAX_HOST_WIDTH);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [frameRef]);
  return sheet;
}

function focusChip(watchedId: string): void {
  const chip = [...document.querySelectorAll<HTMLElement>("[data-watcher-chip]")]
    .find((candidate) => candidate.dataset.watcherChip === watchedId);
  chip?.focus({ preventScroll: true });
}

/**
 * The watcher's face: a collapsible side dock beside the watched chat. It
 * reads the link from the shell and its feed by request, so opening it never
 * takes one of the four conversation detail subscriptions.
 */
export function WatcherDock({ watchedId, link, surface, dock }: WatcherDockProps): React.JSX.Element {
  const dockId = watcherDockId(watchedId);
  const headingId = watcherDockHeadingId(watchedId);
  const frameRef = useRef<HTMLDivElement>(null);
  const [persistedWidth, setPersistedWidth] = usePersistedSize(
    WATCHER_DOCK_WIDTH_KEY,
    WATCHER_DOCK_DEFAULT_WIDTH,
    { min: WATCHER_DOCK_MIN_WIDTH, max: WATCHER_DOCK_MAX_WIDTH },
  );
  const [width, setWidth] = useState(persistedWidth);
  useEffect(() => setWidth(persistedWidth), [persistedWidth]);
  const presence = useDockPresence(dock.open);
  const sheet = useSheetPresentation(frameRef);
  const visible = useDocumentVisibility();
  const actions = useWatcherActions(surface.request, link.id);
  const feed = useWatcherFeed(link.id, link.feedRevision, actions, presence !== "closed");
  const privateConnect = usePrivateConnectState();
  const [error, setError] = useState<string | null>(null);
  const [confirmingResume, setConfirmingResume] = useState(false);
  const [resuming, setResuming] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const watched = surface.conversations.find(({ id }) => id === watchedId);
  const watcher = surface.conversations.find(({ id }) => id === link.watcherConversationId);
  const project = watched ? surface.projects.find(({ id }) => id === watched.projectId) : undefined;
  const watchedRunning = watched?.status === "running" || watched?.status === "needs-input";
  const steerable = steerAvailable(watched?.latestTurn?.harnessId, watched?.status === "running");
  const customBackend = surface.backendProfiles
    .find(({ id }) => id === watcher?.modelSelection.backendProfileId)?.source === "custom";
  const changedPaths = feed.items.find(({ guardState }) => guardState === "changed")?.guardPaths ?? [];
  const privateConnectConfigured = Boolean(
    privateConnect.state?.enabled || (privateConnect.state?.devices.length ?? 0) > 0,
  );

  const readFocusToken = useCallback(() => watcherDockFocusToken(watchedId), [watchedId]);
  const focusToken = useSyncExternalStore(subscribeWatcherDock, readFocusToken, readFocusToken);
  // Waits for the frame to lose `hidden` on reopen: a hidden heading can't take focus.
  useEffect(() => {
    if (!dock.open || presence !== "open" || focusToken === 0 || !consumeWatcherDockFocus(watchedId)) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(headingId)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [dock.open, focusToken, headingId, presence, watchedId]);

  const latestFindingAt = link.latest?.outcome === "finding" ? link.latest.at : null;
  const { markSeen } = dock;
  useEffect(() => {
    if (dock.open && visible && latestFindingAt) markSeen(latestFindingAt);
  }, [dock.open, latestFindingAt, markSeen, visible]);

  useEffect(() => {
    if (link.status !== "paused") setConfirmingResume(false);
  }, [link.status]);

  const collapse = useCallback((): void => {
    dock.setOpen(false);
    focusChip(watchedId);
  }, [dock, watchedId]);

  const resume = (): void => {
    if (!actions || resuming) return;
    setResuming(true);
    void actions.resume().then(
      () => { if (mounted.current) { setError(null); setConfirmingResume(false); } },
      (failure: unknown) => {
        if (mounted.current) setError(failure instanceof Error ? failure.message : "The watcher could not resume.");
      },
    ).finally(() => { if (mounted.current) setResuming(false); });
  };
  const requestResume = (): void => {
    if (link.pauseReason === "write-detected") setConfirmingResume(true);
    else resume();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    event.preventDefault();
    collapse();
  };

  return (
    <div
      ref={frameRef}
      className={clsx("watcher-dock-frame", sheet && "is-sheet")}
      data-state={presence}
      data-presentation={sheet ? "sheet" : "inline"}
      hidden={presence === "closed"}
      style={{ "--watcher-dock-width": `${width}px` } as CSSProperties}
    >
      <PaneResizeHandle
        label="Resize watcher dock"
        controls={dockId}
        containerRef={frameRef}
        orientation="vertical"
        pane="after"
        value={width}
        min={WATCHER_DOCK_MIN_WIDTH}
        max={WATCHER_DOCK_MAX_WIDTH}
        defaultValue={WATCHER_DOCK_DEFAULT_WIDTH}
        onChange={setWidth}
        onCommit={setPersistedWidth}
        className="watcher-dock-resize-handle"
      />
      <aside
        id={dockId}
        className="watcher-dock"
        aria-labelledby={headingId}
        onKeyDown={onKeyDown}
      >
        <WatcherBar
          link={link}
          watched={watched}
          watcher={watcher}
          agentLabel={watcherAgentLabel(watcher, surface.providerLabels)}
          headingId={headingId}
          actions={surface.online ? actions : null}
          privateConnectConfigured={privateConnectConfigured}
          onCollapse={collapse}
          onOpenWatcherChat={surface.openWatcherChat
            ? () => surface.openWatcherChat?.(link.watcherConversationId)
            : null}
          onResumeRequest={requestResume}
          onError={setError}
        />
        {error && <p className="watcher-dock-error" role="alert">{error}</p>}
        <WatcherNotices
          link={link}
          changedPaths={changedPaths}
          customBackend={customBackend}
          confirmingResume={confirmingResume}
          resuming={resuming || !surface.online}
          onResumeRequest={requestResume}
          onConfirmResume={resume}
          onCancelResume={() => setConfirmingResume(false)}
        />
        <div className="watcher-dock-scroll">
          <WatcherFeed
            feed={feed}
            actions={actions}
            headingId={`${dockId}-findings`}
            projectRoot={project?.path ?? ""}
            projectId={watched?.projectId ?? link.projectId}
            watchedConversationId={watchedId}
            watchedRunning={watchedRunning}
            steerable={steerable}
            online={surface.online}
          />
        </div>
      </aside>
    </div>
  );
}
