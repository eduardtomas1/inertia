import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

import type { WorkspacePanelTab } from "../components/workspacePanelTypes";
import { useTerminalDock, type TerminalDockActions } from "./useTerminalDock";
import {
  activeRightPanelSurface,
  activateRightPanelSurface,
  applyRightPanelTool,
  closeAllRightPanelSurfaces,
  closeOtherRightPanelSurfaces,
  closeRightPanelSurface,
  EMPTY_RIGHT_PANEL_STATE,
  legacyRightPanelState,
  openRightPanelSurface,
  parseRightPanelState,
  RIGHT_PANEL_SIBLING_MIN_WIDTH,
  rightPanelPresentation,
  serializeRightPanelState,
  toggleRightPanelSurface,
  toggleRightPanelVisibility,
  type RightPanelPresentation,
  type RightPanelState,
} from "../utils/rightPanelSurfaces";
import { useMediaQuery } from "./useMediaQuery";
import { usePersistedSize } from "./usePersistedSize";
import type { AppView } from "../appView";

const RESIZE_HANDLE_SIZE = 7;
export const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;
const CHAT_MIN_WIDTH = RIGHT_PANEL_SIBLING_MIN_WIDTH;
const CHAT_MIN_HEIGHT = 320;
export const TOOLS_MIN_WIDTH = 300;
const TOOLS_MAX_WIDTH = 960;
export const TOOLS_DEFAULT_WIDTH = 520;
export const TOOLS_MIN_HEIGHT = 180;
const TOOLS_MAX_HEIGHT = 720;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function useResizeObserverTarget<T extends Element>(
  ref: RefObject<T | null>,
  onResize: (entry: ResizeObserverEntry) => void,
): void {
  const observerRef = useRef<ResizeObserver | null>(null);
  const observedTargetRef = useRef<T | null>(null);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  useEffect(() => {
    const target = ref.current;
    if (target === observedTargetRef.current) return;
    observerRef.current?.disconnect();
    observerRef.current = null;
    observedTargetRef.current = target;
    if (!target) return;

    const observer = new ResizeObserver(([entry]) => {
      if (entry) onResizeRef.current(entry);
    });
    observer.observe(target);
    observerRef.current = observer;
  });

  useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    observedTargetRef.current = null;
  }, []);
}

interface PersistedWorkspacePanelState {
  key: string | null;
  panel: RightPanelState;
}

function workspacePanelStorageKeys(workspaceId: string | null): {
  panel: string | null;
  legacyTool: string | null;
  legacyOpen: string | null;
} {
  if (!workspaceId) return { panel: null, legacyTool: null, legacyOpen: null };
  const encoded = encodeURIComponent(workspaceId);
  return {
    panel: `inertia:layout:workspace-panel:${encoded}:v1`,
    legacyTool: `inertia:layout:workspace-tool:${encoded}:v1`,
    legacyOpen: `inertia:layout:workspace-open:${encoded}:v1`,
  };
}

function readWorkspacePanelState(
  workspaceId: string | null,
): PersistedWorkspacePanelState {
  const keys = workspacePanelStorageKeys(workspaceId);
  if (!keys.panel || !keys.legacyTool || !keys.legacyOpen) {
    return { key: workspaceId, panel: EMPTY_RIGHT_PANEL_STATE };
  }
  const stored = parseRightPanelState(window.localStorage.getItem(keys.panel));
  if (stored) return { key: workspaceId, panel: stored };
  const legacyOpen = window.localStorage.getItem(keys.legacyOpen);
  const legacyTool = window.localStorage.getItem(keys.legacyTool);
  if (legacyOpen !== null || legacyTool !== null) {
    return {
      key: workspaceId,
      panel: legacyRightPanelState(legacyTool, legacyOpen === "true"),
    };
  }
  return { key: workspaceId, panel: EMPTY_RIGHT_PANEL_STATE };
}

/** Carry an explicit draft choice into its confirmed saved chat identity. */
export function transferDraftWorkspacePanel(
  projectId: string,
  draftConversationId: string,
  conversationId: string,
): void {
  const source = workspacePanelStorageKeys(`${projectId}:${draftConversationId}`).panel!;
  const target = workspacePanelStorageKeys(`${projectId}:${conversationId}`).panel!;
  if (source === target) return;
  try {
    const panel = parseRightPanelState(window.localStorage.getItem(source));
    if (!panel) return;
    if (window.localStorage.getItem(target) === null) {
      window.localStorage.setItem(target, serializeRightPanelState(panel));
    }
    window.localStorage.removeItem(source);
  } catch {
    // Presentation persistence must never interrupt an acknowledged chat creation.
  }
}

export interface WorkspaceLayoutOptions {
  startupReady?: boolean;
  workspaceId?: string | null;
  /** Split-chat uses the existing bottom tool layout without persisting it. */
  forceStackedTools?: boolean;
}

export interface WorkspacePanelActions extends TerminalDockActions {
  panel: RightPanelState;
  activeTool: WorkspacePanelTab | null;
  setActiveTool: React.Dispatch<React.SetStateAction<WorkspacePanelTab | null>>;
  openSurface: (surface: WorkspacePanelTab) => void;
  toggleSurface: (surface: WorkspacePanelTab) => void;
  activateSurface: (surface: WorkspacePanelTab) => void;
  closeSurface: (surface: WorkspacePanelTab) => void;
  closeOtherSurfaces: (surface: WorkspacePanelTab) => void;
  closeAllSurfaces: () => void;
  toggleWorkspaceTools: () => void;
}

export interface WorkspaceLayout extends WorkspacePanelActions {
  sidebarOpen: boolean;
  setSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  stackedTools: boolean;
  panelPresentation: RightPanelPresentation;
  mobileNavigation: boolean;
  toolsVisible: boolean;
  appShellRef: RefObject<HTMLDivElement | null>;
  workspaceBodyRef: RefObject<HTMLDivElement | null>;
  appShellStyle: CSSProperties;
  workspaceBodyStyle: CSSProperties;
  sidebar: {
    value: number;
    max: number;
    onChange: (value: number) => void;
    onCommit: (value: number) => void;
  };
  tools: {
    width: number;
    height: number;
    maxWidth: number;
    maxHeight: number;
    onWidthChange: (value: number) => void;
    onHeightChange: (value: number) => void;
    onWidthCommit: (value: number) => void;
    onHeightCommit: (value: number) => void;
  };
}

export function useWorkspaceLayout(
  view: AppView,
  hasProject: boolean,
  options: WorkspaceLayoutOptions = {},
): WorkspaceLayout {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    window.localStorage.getItem(
      "inertia:layout:sidebar-collapsed:v1",
    ) === "true");
  const workspaceScope = options.startupReady && options.workspaceId
    ? options.workspaceId
    : null;
  const panelStorageKey = workspacePanelStorageKeys(workspaceScope).panel;
  const [persistedPanelState, setPersistedPanelState] = useState(() =>
    readWorkspacePanelState(workspaceScope));
  const panelState = persistedPanelState.key === workspaceScope
    ? persistedPanelState.panel
    : readWorkspacePanelState(workspaceScope).panel;
  const activeToolState = workspaceScope
    ? activeRightPanelSurface(panelState)
    : null;
  const [persistedSidebarWidth, setPersistedSidebarWidth] = usePersistedSize(
    "inertia:layout:sidebar-width:v1",
    276,
    { min: SIDEBAR_MIN_WIDTH, max: SIDEBAR_MAX_WIDTH },
  );
  const [persistedToolsWidth, setPersistedToolsWidth] = usePersistedSize(
    "inertia:layout:workspace-tools-width:v1",
    TOOLS_DEFAULT_WIDTH,
    { min: TOOLS_MIN_WIDTH, max: TOOLS_MAX_WIDTH },
  );
  const [persistedToolsHeight, setPersistedToolsHeight] = usePersistedSize(
    "inertia:layout:workspace-tools-height:v1",
    320,
    { min: TOOLS_MIN_HEIGHT, max: TOOLS_MAX_HEIGHT },
  );
  const [sidebarWidth, setSidebarWidth] = useState(persistedSidebarWidth);
  const [toolsWidth, setToolsWidth] = useState(persistedToolsWidth);
  const [toolsHeight, setToolsHeight] = useState(persistedToolsHeight);
  const [shellWidth, setShellWidth] = useState(() => window.innerWidth);
  const [workspaceBodySize, setWorkspaceBodySize] = useState(() => ({
    width: Math.max(0, window.innerWidth - 300),
    height: Math.max(0, window.innerHeight - 80),
  }));
  const stackedTools = Boolean(options.forceStackedTools);
  const mobileNavigation = useMediaQuery("(max-width: 760px)");
  const renderedSidebarWidthRef = useRef(0);
  const appShellRef = useRef<HTMLDivElement>(null);
  const workspaceBodyRef = useRef<HTMLDivElement>(null);

  useEffect(
    () => setSidebarWidth(persistedSidebarWidth),
    [persistedSidebarWidth],
  );
  useEffect(() => setToolsWidth(persistedToolsWidth), [persistedToolsWidth]);
  useEffect(
    () => setToolsHeight(persistedToolsHeight),
    [persistedToolsHeight],
  );
  useEffect(() => {
    window.localStorage.setItem(
      "inertia:layout:sidebar-collapsed:v1",
      String(sidebarCollapsed),
    );
  }, [sidebarCollapsed]);
  useEffect(() => {
    if (persistedPanelState.key !== workspaceScope) {
      setPersistedPanelState(readWorkspacePanelState(workspaceScope));
    }
  }, [
    persistedPanelState.key,
    workspaceScope,
  ]);

  const updatePanel = useMemo(() => (
    update: (current: RightPanelState) => RightPanelState,
  ): void => {
    setPersistedPanelState((current) => {
      const owned = current.key === workspaceScope
        ? current.panel
        : readWorkspacePanelState(workspaceScope).panel;
      const next = update(owned);
      if (panelStorageKey) {
        window.localStorage.setItem(panelStorageKey, serializeRightPanelState(next));
      }
      return { key: workspaceScope, panel: next };
    });
  }, [panelStorageKey, workspaceScope]);

  const panelActions = useMemo(() => ({
    setActiveTool: ((update) => {
      updatePanel((current) => applyRightPanelTool(
        current,
        typeof update === "function"
          ? update(activeRightPanelSurface(current))
          : update,
      ));
    }) as React.Dispatch<React.SetStateAction<WorkspacePanelTab | null>>,
    openSurface: (surface: WorkspacePanelTab) =>
      updatePanel((current) => openRightPanelSurface(current, surface)),
    toggleSurface: (surface: WorkspacePanelTab) =>
      updatePanel((current) => toggleRightPanelSurface(current, surface)),
    activateSurface: (surface: WorkspacePanelTab) =>
      updatePanel((current) => activateRightPanelSurface(current, surface)),
    closeSurface: (surface: WorkspacePanelTab) =>
      updatePanel((current) => closeRightPanelSurface(current, surface)),
    closeOtherSurfaces: (surface: WorkspacePanelTab) =>
      updatePanel((current) => closeOtherRightPanelSurfaces(current, surface)),
    closeAllSurfaces: () => updatePanel(closeAllRightPanelSurfaces),
    toggleWorkspaceTools: () => updatePanel(toggleRightPanelVisibility),
  }), [updatePanel]);
  const terminalDock = useTerminalDock(workspaceScope, activeRightPanelSurface(panelState) === "terminal", panelActions.setActiveTool);

  useResizeObserverTarget(appShellRef, (entry) => {
    setShellWidth(entry.contentRect.width);
  });

  useResizeObserverTarget(workspaceBodyRef, (entry) => {
    const box = entry.borderBoxSize?.[0];
    setWorkspaceBodySize({
      width: box?.inlineSize ?? entry.contentRect.width,
      height: box?.blockSize ?? entry.contentRect.height,
    });
  });

  const toolsVisible =
    view === "workspace" && Boolean(workspaceScope && panelState.isOpen && hasProject);
  const inlineMinimumWorkspaceWidth = CHAT_MIN_WIDTH + TOOLS_MIN_WIDTH + RESIZE_HANDLE_SIZE + 18;
  const inlineSidebarMax = Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, shellWidth - inlineMinimumWorkspaceWidth - RESIZE_HANDLE_SIZE),
  );
  const inlineSidebarWidth = !mobileNavigation && sidebarCollapsed
    ? 0
    : clamp(sidebarWidth, SIDEBAR_MIN_WIDTH, inlineSidebarMax);
  // The measured body width reflects the sidebar width of the last commit. In
  // sheet mode that sidebar may be wider than the inline layout would allow, so
  // judge the presentation by the width the body would have once the sidebar
  // yields to its inline clamp. Deciding from the raw measurement fed back into
  // the sidebar clamp and left the panel stuck as a sheet after a window grew.
  const inlineBodyWidth = workspaceBodySize.width + (mobileNavigation
    ? 0
    : Math.max(0, renderedSidebarWidthRef.current - inlineSidebarWidth));
  const panelPresentation = stackedTools
    ? "inline"
    : rightPanelPresentation({
        containerWidth: inlineBodyWidth,
        panelMinWidth: TOOLS_MIN_WIDTH,
        handleWidth: RESIZE_HANDLE_SIZE,
      });
  const minimumWorkspaceWidth = !stackedTools
    && toolsVisible
    && panelPresentation === "inline"
    ? inlineMinimumWorkspaceWidth
    : 440;
  const sidebarDynamicMax = Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(
      SIDEBAR_MAX_WIDTH,
      shellWidth - minimumWorkspaceWidth - RESIZE_HANDLE_SIZE,
    ),
  );
  const toolsDynamicMaxWidth = Math.max(
    TOOLS_MIN_WIDTH,
    Math.min(
      TOOLS_MAX_WIDTH,
      workspaceBodySize.width - CHAT_MIN_WIDTH - RESIZE_HANDLE_SIZE,
    ),
  );
  const toolsDynamicMaxHeight = Math.max(
    TOOLS_MIN_HEIGHT,
    Math.min(
      TOOLS_MAX_HEIGHT,
      workspaceBodySize.height - CHAT_MIN_HEIGHT - RESIZE_HANDLE_SIZE,
    ),
  );
  const effectiveSidebarWidth = !mobileNavigation && sidebarCollapsed
    ? 0
    : clamp(sidebarWidth, SIDEBAR_MIN_WIDTH, sidebarDynamicMax);
  useLayoutEffect(() => {
    renderedSidebarWidthRef.current = effectiveSidebarWidth;
  }, [effectiveSidebarWidth]);
  const effectiveToolsWidth = clamp(
    toolsWidth,
    TOOLS_MIN_WIDTH,
    toolsDynamicMaxWidth,
  );
  const effectiveToolsHeight = clamp(
    toolsHeight,
    TOOLS_MIN_HEIGHT,
    toolsDynamicMaxHeight,
  );

  return useMemo(() => ({
    sidebarOpen,
    setSidebarOpen,
    sidebarCollapsed,
    setSidebarCollapsed,
    panel: panelState,
    activeTool: activeToolState,
    ...panelActions,
    ...terminalDock,
    stackedTools,
    panelPresentation,
    mobileNavigation,
    toolsVisible,
    appShellRef,
    workspaceBodyRef,
    appShellStyle: {
      "--sidebar-width": `${effectiveSidebarWidth}px`,
    } as CSSProperties,
    workspaceBodyStyle: {
      "--workspace-tools-width": `${effectiveToolsWidth}px`,
      "--workspace-tools-height": `${effectiveToolsHeight}px`,
    } as CSSProperties,
    sidebar: {
      value: effectiveSidebarWidth,
      max: sidebarDynamicMax,
      onChange: setSidebarWidth,
      onCommit: setPersistedSidebarWidth,
    },
    tools: {
      width: effectiveToolsWidth,
      height: effectiveToolsHeight,
      maxWidth: toolsDynamicMaxWidth,
      maxHeight: toolsDynamicMaxHeight,
      onHeightChange: setToolsHeight,
      onWidthChange: setToolsWidth,
      onWidthCommit: setPersistedToolsWidth,
      onHeightCommit: setPersistedToolsHeight,
    },
  }), [
    activeToolState,
    effectiveSidebarWidth,
    effectiveToolsHeight,
    effectiveToolsWidth,
    mobileNavigation,
    panelActions,
    panelPresentation,
    panelState,
    setPersistedSidebarWidth,
    setPersistedToolsHeight,
    setPersistedToolsWidth,
    sidebarCollapsed,
    sidebarDynamicMax,
    terminalDock,
    sidebarOpen,
    stackedTools,
    toolsDynamicMaxHeight,
    toolsDynamicMaxWidth,
    toolsVisible,
  ]);
}
