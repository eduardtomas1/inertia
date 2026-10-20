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
import type { ConversationShell } from "@shared/contracts";
import type { WatcherLinkView } from "@shared/watcher";
import { useDocumentVisibility } from "../../hooks/useDocumentPresence";
import { usePersistedSize } from "../../hooks/usePersistedSize";
import { usePrivateConnectState } from "../../hooks/usePrivateConnectState";
import { useWatcherActions } from "../../hooks/useWatcherActions";
import {
  consumeWatcherDockFocus,
  setWatcherDockPresentation,
  subscribeWatcherDock,
  takeWatcherDockError,
  watcherDockErrorToken,
  watcherDockFocusToken,
  type WatcherDockController,
} from "../../hooks/useWatcherDock";
import { useWatcherFeed } from "../../hooks/useWatcherFeed";
import { composerRouteReadiness } from "../../utils/composerReadiness";
import { watcherPauseText } from "../../utils/watcherCopy";
import { watcherAgentLabel } from "@shared/watcher-agent-label";
import { watcherFindingsTotal } from "../../utils/watcherLinks";
import { PaneResizeHandle } from "../PaneResizeHandle";
import { escapeClosedTooltip } from "../Tooltip";
import { WatcherBar } from "./WatcherBar";
import { watcherHandleFor } from "./WatcherDockHandle";
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
/** Below this much room left for the chat, the dock floats over it as a sheet. */
export const WATCHER_DOCK_MIN_CHAT_WIDTH = 360;
/** A sheet keeps this much of the chat visible at its left edge. */
const SHEET_EDGE = 24;
/** Gap between the bottom of a sheet and the composer it never covers. */
const SHEET_COMPOSER_GAP = 8;
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

/**
 * Keeps the dock painted for its closing motion, then hides it. Only a user's
 * open or collapse (a new motion token) animates: switching chats, a sheet
 * collapsing for layout or a remount show the dock in place.
 */
function useDockPresence(open: boolean, motion: number): { presence: Presence; animated: boolean } {
  const [presence, setPresence] = useState<Presence>(open ? "open" : "closed");
  const [animated, setAnimated] = useState(false);
  const handledMotion = useRef(motion);
  useLayoutEffect(() => {
    const user = handledMotion.current !== motion;
    handledMotion.current = motion;
    const animate = user && !prefersReducedMotion();
    setAnimated(animate);
    if (open) {
      setPresence("open");
      return;
    }
    if (!animate) {
      setPresence("closed");
      return;
    }
    setPresence((current) => current === "closed" ? current : "closing");
    const timer = window.setTimeout(() => setPresence("closed"), DOCK_MOTION_MS);
    return () => window.clearTimeout(timer);
  }, [motion, open]);
  return { presence, animated };
}

/** The host's content-box width, like the container query it mirrors. */
function useHostWidth(frameRef: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const host = frameRef.current?.parentElement;
    if (!host) return;
    // An inline tools panel reserves its space with padding on the same host.
    const measure = (): void => {
      const style = window.getComputedStyle(host);
      const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
      setWidth(Math.max(0, host.clientWidth - padding));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [frameRef]);
  return width;
}

/**
 * A sheet stops above the watched chat's composer, so the composer stays
 * usable while the sheet is open. Returns the bottom offset in pixels.
 */
function useComposerClearance(frameRef: RefObject<HTMLDivElement | null>, active: boolean): number {
  const [clearance, setClearance] = useState(0);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const host = frame?.parentElement;
    if (!active || !frame || !host) {
      setClearance(0);
      return;
    }
    const composer = host.querySelector<HTMLElement>(".composer-region");
    if (!composer) return;
    const chat = composer.closest<HTMLElement>(".conversation-pane-chat, .workspace-chat-column") ?? host;
    const measure = (): void => {
      const chatBottom = chat.getBoundingClientRect().bottom;
      const composerTop = composer.getBoundingClientRect().top;
      setClearance(Math.max(0, Math.round(chatBottom - composerTop + SHEET_COMPOSER_GAP)));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(chat);
    observer.observe(composer);
    return () => observer.disconnect();
  }, [active, frameRef]);
  return clearance;
}

/** Why the runtime would refuse Resume now, so the dock can say so instead. */
function resumeBlockedReason(
  link: WatcherLinkView,
  watched: ConversationShell | undefined,
  watcher: ConversationShell | undefined,
  surface: WatcherSurfaceModel,
): string | null {
  if (link.status !== "paused") return null;
  if (watcher && watcher.archivedAt !== null) {
    return link.pauseReason === "watcher-archived"
      ? watcherPauseText(link.pauseReason, link.pauseDetail)
      : "Unarchive the watcher chat to resume it.";
  }
  if (watched && watched.archivedAt !== null) return "Unarchive the watched chat to resume its watcher.";
  if ((link.pauseReason === "usage-limit" || link.pauseReason === "route-unavailable") && watcher) {
    const readiness = composerRouteReadiness({
      provider: surface.providers.find(({ id }) => id === watcher.providerId),
      profile: surface.backendProfiles.find(({ id }) => id === watcher.modelSelection.backendProfileId),
      selection: watcher.modelSelection,
    });
    if (!readiness.ready) return `It can resume once its route is ready. ${readiness.detail}`;
  }
  return null;
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
  const hostWidth = useHostWidth(frameRef);
  // Decided on the committed width, so dragging the handle never flips it.
  const sheet = hostWidth > 0 && hostWidth - persistedWidth < WATCHER_DOCK_MIN_CHAT_WIDTH;
  const measured = hostWidth > 0;
  useLayoutEffect(() => {
    if (measured) setWatcherDockPresentation(watchedId, sheet ? "sheet" : "inline");
  }, [measured, sheet, watchedId]);
  const maxWidth = hostWidth <= 0
    ? WATCHER_DOCK_MAX_WIDTH
    : Math.max(WATCHER_DOCK_MIN_WIDTH, Math.min(
      WATCHER_DOCK_MAX_WIDTH,
      sheet ? hostWidth - SHEET_EDGE : hostWidth - WATCHER_DOCK_MIN_CHAT_WIDTH,
    ));
  const { presence, animated } = useDockPresence(dock.open, dock.motion);
  const clearance = useComposerClearance(frameRef, sheet && presence !== "closed");
  const visible = useDocumentVisibility();
  const actions = useWatcherActions(surface.request, link.id);
  const feed = useWatcherFeed(link.id, link.feedRevision, surface.online ? actions : null, presence !== "closed");
  const privateConnect = usePrivateConnectState();
  const [error, setError] = useState<string | null>(null);
  const [confirmingResume, setConfirmingResume] = useState(false);
  const [resuming, setResuming] = useState(false);
  const mounted = useRef(false);
  const focusHeadingAfterResume = useRef(false);
  // Set in the effect body too: StrictMode runs the cleanup once at mount.
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

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
  const resumeBlocked = resumeBlockedReason(link, watched, watcher, surface);

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

  // An error reported from elsewhere (the command palette) shows here.
  const readErrorToken = useCallback(() => watcherDockErrorToken(watchedId), [watchedId]);
  const errorToken = useSyncExternalStore(subscribeWatcherDock, readErrorToken, readErrorToken);
  useEffect(() => {
    if (errorToken === 0) return;
    const message = takeWatcherDockError(watchedId);
    if (message) setError(message);
  }, [errorToken, watchedId]);

  const latestFindingAt = link.latestFindingAt ?? null;
  const findingsTotal = watcherFindingsTotal(link);
  const { markSeen } = dock;
  useEffect(() => {
    if (dock.open && visible && latestFindingAt) markSeen(latestFindingAt, findingsTotal);
  }, [dock.open, findingsTotal, latestFindingAt, markSeen, visible]);

  useEffect(() => {
    if (link.status !== "paused") setConfirmingResume(false);
  }, [link.status]);

  // After a resume the notice that held focus is gone: focus the heading.
  useLayoutEffect(() => {
    if (link.status === "paused" || !focusHeadingAfterResume.current) return;
    focusHeadingAfterResume.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body || !active.isConnected || frameRef.current?.contains(active)) {
      document.getElementById(headingId)?.focus({ preventScroll: true });
    }
  }, [headingId, link.status]);

  // Stop watching unmounts the dock and the handle: never leave focus on the
  // page body. Layout cleanup runs while the dock is still in the document.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const host = frame?.parentElement ?? null;
    return () => {
      if (!frame?.contains(document.activeElement)) return;
      window.requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && active !== document.body && active.isConnected) return;
        const composer = host?.isConnected
          ? host.querySelector<HTMLElement>(".composer-region textarea")
          : document.querySelector<HTMLElement>(".composer-region textarea");
        composer?.focus({ preventScroll: true });
      });
    };
  }, []);

  const collapse = useCallback((): void => {
    dock.setOpen(false);
    window.requestAnimationFrame(() => watcherHandleFor(watchedId)?.focus({ preventScroll: true }));
  }, [dock, watchedId]);

  // A sheet collapses on any press outside it (the scrim focuses the handle).
  const sheetOpen = sheet && dock.open;
  const { setOpen } = dock;
  useEffect(() => {
    if (!sheetOpen) return;
    const dismiss = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && frameRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest(".watcher-dock-scrim")) return;
      // Menus and dialogs portalled to the body belong to whatever opened them.
      if (target instanceof Element && target.closest('[role="menu"], [role="dialog"]')) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [setOpen, sheetOpen]);

  const resume = (): void => {
    if (!actions || resuming) return;
    const active = document.activeElement;
    focusHeadingAfterResume.current = Boolean(active && frameRef.current?.contains(active));
    setResuming(true);
    void actions.resume().then(
      () => { if (mounted.current) { setError(null); setConfirmingResume(false); } },
      (failure: unknown) => {
        focusHeadingAfterResume.current = false;
        if (mounted.current) setError(failure instanceof Error ? failure.message : "The watcher could not resume.");
      },
    ).finally(() => { if (mounted.current) setResuming(false); });
  };
  const requestResume = (): void => {
    if (resumeBlocked) return;
    if (link.pauseReason === "write-detected") setConfirmingResume(true);
    else resume();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (escapeClosedTooltip(event.nativeEvent)) return;
    event.preventDefault();
    collapse();
  };

  return (
    <>
      {sheet && presence !== "closed" && (
        <div
          className="watcher-dock-scrim"
          data-state={presence}
          data-motion={animated ? "animate" : undefined}
          aria-hidden="true"
          style={{ bottom: `${clearance}px` }}
          onPointerDown={(event) => {
            event.preventDefault();
            collapse();
          }}
        />
      )}
      <div
        ref={frameRef}
        className={clsx("watcher-dock-frame", sheet && "is-sheet")}
        data-state={presence}
        data-motion={animated ? "animate" : undefined}
        data-presentation={sheet ? "sheet" : "inline"}
        hidden={presence === "closed"}
        style={{
          "--watcher-dock-width": `${Math.min(width, maxWidth)}px`,
          ...(sheet ? { bottom: `${clearance}px` } : {}),
        } as CSSProperties}
      >
        <PaneResizeHandle
          label="Resize watcher dock"
          controls={dockId}
          containerRef={frameRef}
          orientation="vertical"
          pane="after"
          value={Math.min(width, maxWidth)}
          min={WATCHER_DOCK_MIN_WIDTH}
          max={maxWidth}
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
            resumeBlocked={resumeBlocked}
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
            resumeBlocked={resumeBlocked}
            onResumeRequest={requestResume}
            onConfirmResume={resume}
            onCancelResume={() => setConfirmingResume(false)}
          />
          <div className="watcher-dock-scroll">
            <WatcherFeed
              feed={feed}
              actions={actions}
              headingId={headingId}
              linkId={link.id}
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
    </>
  );
}
