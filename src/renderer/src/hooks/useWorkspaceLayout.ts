import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

import type { WorkspacePanelTab } from "../components/WorkspacePanel";
import {
  LAST_WORKSPACE_TOOL_KEY,
  type WorkspaceStartupSurface,
  workspacePanelTab,
} from "../utils/workspaceStartup";
import { useMediaQuery } from "./useMediaQuery";
import { usePersistedSize } from "./usePersistedSize";
import type { AppView } from "../appView";

const RESIZE_HANDLE_SIZE = 7;
export const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;
const CHAT_MIN_WIDTH = 340;
const CHAT_MIN_HEIGHT = 320;
export const TOOLS_MIN_WIDTH = 300;
const TOOLS_MAX_WIDTH = 960;
export const ENVIRONMENT_TOOLS_DEFAULT_WIDTH = 320;
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

function initialWorkspaceTool(
  preferred?: WorkspacePanelTab,
): WorkspacePanelTab {
  return preferred
    ?? workspacePanelTab(window.localStorage.getItem(LAST_WORKSPACE_TOOL_KEY))
    ?? "environment";
}

interface PersistedWorkspaceToolState {
  key: string | null;
  activeTool: WorkspacePanelTab | null;
  lastTool: WorkspacePanelTab;
}

function workspaceToolStorageKeys(workspaceId: string | null): {
  tool: string | null;
  open: string | null;
} {
  if (!workspaceId) return { tool: null, open: null };
  const encoded = encodeURIComponent(workspaceId);
  return {
    tool: `inertia:layout:workspace-tool:${encoded}:v1`,
    open: `inertia:layout:workspace-open:${encoded}:v1`,
  };
}

function readWorkspaceToolState(
  workspaceId: string | null,
  surface: WorkspaceStartupSurface,
  preferred?: WorkspacePanelTab,
): PersistedWorkspaceToolState {
  const storageKeys = workspaceToolStorageKeys(workspaceId);
  const storedTool = storageKeys.tool
    ? workspacePanelTab(window.localStorage.getItem(storageKeys.tool))
    : null;
  const fallbackTool = surface === "tools"
    ? initialWorkspaceTool(preferred)
    : "environment";
  const lastTool = storedTool ?? fallbackTool;
  const storedOpen = storageKeys.open
    ? window.localStorage.getItem(storageKeys.open)
    : null;
  return {
    key: workspaceId,
    activeTool: !workspaceId
      ? null
      : storedOpen === "true"
        ? lastTool
        : storedOpen === "false"
          ? null
          : surface === "tools"
            ? lastTool
            : "environment",
    lastTool,
  };
}

export interface WorkspaceLayoutOptions {
  startupSurface?: WorkspaceStartupSurface;
  startupReady?: boolean;
  workspaceId?: string | null;
  initialTool?: WorkspacePanelTab;
  /** Split-chat uses the existing bottom tool layout without persisting it. */
  forceStackedTools?: boolean;
}

export interface WorkspaceLayout {
  sidebarOpen: boolean;
  setSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  activeTool: WorkspacePanelTab | null;
  setActiveTool: React.Dispatch<React.SetStateAction<WorkspacePanelTab | null>>;
  toggleWorkspaceTools: () => void;
  showStartupSurface: (surface: WorkspaceStartupSurface) => void;
  stackedTools: boolean;
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
  const startupSurface = options.startupSurface ?? "summary";
  const { tool: toolStorageKey, open: openStorageKey } =
    workspaceToolStorageKeys(workspaceScope);
  const [persistedToolState, setPersistedToolState] = useState(() =>
    readWorkspaceToolState(
      workspaceScope,
      startupSurface,
      options.initialTool,
    ));
  const toolState = persistedToolState.key === workspaceScope
    ? persistedToolState
    : readWorkspaceToolState(
      workspaceScope,
      startupSurface,
      options.initialTool,
    );
  const activeToolState = toolState.activeTool;
  const lastToolRef = useRef(toolState.lastTool);
  lastToolRef.current = toolState.lastTool;
  const [persistedSidebarWidth, setPersistedSidebarWidth] = usePersistedSize(
    "inertia:layout:sidebar-width:v1",
    276,
    { min: SIDEBAR_MIN_WIDTH, max: SIDEBAR_MAX_WIDTH },
  );
  const [persistedToolsWidth, setPersistedToolsWidth] = usePersistedSize(
    "inertia:layout:workspace-tools-width:v1",
    520,
    { min: TOOLS_MIN_WIDTH, max: TOOLS_MAX_WIDTH },
  );
  const [persistedEnvironmentWidth, setPersistedEnvironmentWidth] = usePersistedSize(
    "inertia:layout:environment-width:v1",
    ENVIRONMENT_TOOLS_DEFAULT_WIDTH,
    { min: TOOLS_MIN_WIDTH, max: TOOLS_MAX_WIDTH },
  );
  const [persistedToolsHeight, setPersistedToolsHeight] = usePersistedSize(
    "inertia:layout:workspace-tools-height:v1",
    320,
    { min: TOOLS_MIN_HEIGHT, max: TOOLS_MAX_HEIGHT },
  );
  const [sidebarWidth, setSidebarWidth] = useState(persistedSidebarWidth);
  const [toolsWidth, setToolsWidth] = useState(persistedToolsWidth);
  const [environmentWidth, setEnvironmentWidth] = useState(
    persistedEnvironmentWidth,
  );
  const [toolsHeight, setToolsHeight] = useState(persistedToolsHeight);
  const [shellWidth, setShellWidth] = useState(() => window.innerWidth);
  const [workspaceBodySize, setWorkspaceBodySize] = useState(() => ({
    width: Math.max(0, window.innerWidth - 300),
    height: Math.max(0, window.innerHeight - 80),
  }));
  const responsiveStackedTools = useMediaQuery("(max-width: 1024px)");
  const stackedTools = Boolean(
    options.forceStackedTools || responsiveStackedTools,
  );
  const mobileNavigation = useMediaQuery("(max-width: 760px)");
  const appShellRef = useRef<HTMLDivElement>(null);
  const workspaceBodyRef = useRef<HTMLDivElement>(null);

  useEffect(
    () => setSidebarWidth(persistedSidebarWidth),
    [persistedSidebarWidth],
  );
  useEffect(() => setToolsWidth(persistedToolsWidth), [persistedToolsWidth]);
  useEffect(
    () => setEnvironmentWidth(persistedEnvironmentWidth),
    [persistedEnvironmentWidth],
  );
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
    if (persistedToolState.key !== workspaceScope) {
      setPersistedToolState(readWorkspaceToolState(
        workspaceScope,
        startupSurface,
        options.initialTool,
      ));
    }
  }, [
    options.initialTool,
    persistedToolState.key,
    startupSurface,
    workspaceScope,
  ]);

  const setActiveTool = useMemo<
    React.Dispatch<React.SetStateAction<WorkspacePanelTab | null>>
  >(() => (update) => {
    setPersistedToolState((current) => {
      const owned = current.key === workspaceScope
        ? current
        : readWorkspaceToolState(
            workspaceScope,
            startupSurface,
            options.initialTool,
          );
      const next = typeof update === "function"
        ? update(owned.activeTool)
        : update;
      if (openStorageKey) {
        window.localStorage.setItem(openStorageKey, String(next !== null));
      }
      if (next) {
        if (toolStorageKey) window.localStorage.setItem(toolStorageKey, next);
        window.localStorage.setItem(LAST_WORKSPACE_TOOL_KEY, next);
      }
      return {
        key: workspaceScope,
        activeTool: next,
        lastTool: next ?? owned.lastTool,
      };
    });
  }, [
    openStorageKey,
    options.initialTool,
    startupSurface,
    toolStorageKey,
    workspaceScope,
  ]);

  const showStartupSurface = useMemo(
    () => (surface: WorkspaceStartupSurface) => {
      if (surface === "summary") {
        setActiveTool("environment");
        return;
      }
      setActiveTool(lastToolRef.current);
    },
    [setActiveTool],
  );

  const toggleWorkspaceTools = useMemo(() => () => {
    setActiveTool((current) => current ? null : lastToolRef.current);
  }, [setActiveTool]);

  useResizeObserverTarget(appShellRef, (entry) => {
    setShellWidth(entry.contentRect.width);
  });

  useResizeObserverTarget(workspaceBodyRef, (entry) => {
    setWorkspaceBodySize({
      width: entry.contentRect.width,
      height: entry.contentRect.height,
    });
  });

  const toolsVisible =
    view === "workspace" && Boolean(activeToolState && hasProject);
  const minimumWorkspaceWidth = !stackedTools && toolsVisible
    ? CHAT_MIN_WIDTH + TOOLS_MIN_WIDTH + RESIZE_HANDLE_SIZE + 18
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
  const environmentActive = activeToolState === "environment";
  const effectiveToolsWidth = clamp(
    environmentActive ? environmentWidth : toolsWidth,
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
    activeTool: activeToolState,
    setActiveTool,
    toggleWorkspaceTools,
    showStartupSurface,
    stackedTools,
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
      onWidthChange: environmentActive ? setEnvironmentWidth : setToolsWidth,
      onWidthCommit: environmentActive
        ? setPersistedEnvironmentWidth
        : setPersistedToolsWidth,
      onHeightCommit: setPersistedToolsHeight,
    },
  }), [
    activeToolState,
    effectiveSidebarWidth,
    effectiveToolsHeight,
    effectiveToolsWidth,
    environmentActive,
    mobileNavigation,
    setPersistedSidebarWidth,
    setPersistedEnvironmentWidth,
    setPersistedToolsHeight,
    setPersistedToolsWidth,
    sidebarCollapsed,
    sidebarDynamicMax,
    sidebarOpen,
    setActiveTool,
    showStartupSurface,
    stackedTools,
    toggleWorkspaceTools,
    toolsDynamicMaxHeight,
    toolsDynamicMaxWidth,
    toolsVisible,
  ]);
}
