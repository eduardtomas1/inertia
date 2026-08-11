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
export const TOOLS_MIN_HEIGHT = 180;
const TOOLS_MAX_HEIGHT = 720;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function initialWorkspaceTool(
  preferred?: WorkspacePanelTab,
): WorkspacePanelTab {
  return preferred
    ?? workspacePanelTab(window.localStorage.getItem(LAST_WORKSPACE_TOOL_KEY))
    ?? "terminal";
}

export interface WorkspaceLayoutOptions {
  startupSurface?: WorkspaceStartupSurface;
  startupReady?: boolean;
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
  environmentOpen: boolean;
  setEnvironmentOpen: React.Dispatch<React.SetStateAction<boolean>>;
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
  const lastToolRef = useRef<WorkspacePanelTab>(
    initialWorkspaceTool(options.initialTool),
  );
  const activeToolRef = useRef<WorkspacePanelTab | null>(null);
  const [activeToolState, setActiveToolState] =
    useState<WorkspacePanelTab | null>(null);
  const environmentOpenRef = useRef(false);
  const [environmentOpenState, setEnvironmentOpenState] = useState(false);
  const startupAppliedRef = useRef(false);
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
    () => setToolsHeight(persistedToolsHeight),
    [persistedToolsHeight],
  );
  useEffect(() => {
    window.localStorage.setItem(
      "inertia:layout:sidebar-collapsed:v1",
      String(sidebarCollapsed),
    );
  }, [sidebarCollapsed]);
  const setActiveTool = useMemo<
    React.Dispatch<React.SetStateAction<WorkspacePanelTab | null>>
  >(() => (update) => {
    const next = typeof update === "function"
      ? update(activeToolRef.current)
      : update;
    activeToolRef.current = next;
    setActiveToolState(next);
    if (next) {
      lastToolRef.current = next;
      window.localStorage.setItem(LAST_WORKSPACE_TOOL_KEY, next);
      environmentOpenRef.current = false;
      setEnvironmentOpenState(false);
    }
  }, []);

  const setEnvironmentOpen = useMemo<
    React.Dispatch<React.SetStateAction<boolean>>
  >(() => (update) => {
    const next = typeof update === "function"
      ? update(environmentOpenRef.current)
      : update;
    environmentOpenRef.current = next;
    setEnvironmentOpenState(next);
    if (next) {
      activeToolRef.current = null;
      setActiveToolState(null);
    }
  }, []);

  const showStartupSurface = useMemo(
    () => (surface: WorkspaceStartupSurface) => {
      if (surface === "summary") {
        setEnvironmentOpen(true);
        return;
      }
      setActiveTool(lastToolRef.current);
    },
    [setActiveTool, setEnvironmentOpen],
  );

  useEffect(() => {
    if (startupAppliedRef.current || !options.startupReady) return;
    startupAppliedRef.current = true;
    showStartupSurface(options.startupSurface ?? "summary");
  }, [
    options.startupReady,
    options.startupSurface,
    showStartupSurface,
  ]);

  const toggleWorkspaceTools = useMemo(() => () => {
    if (activeToolRef.current) {
      setActiveTool(null);
      return;
    }
    setActiveTool(lastToolRef.current);
  }, [setActiveTool]);

  useEffect(() => {
    const shell = appShellRef.current;
    if (!shell) return;
    const observer = new ResizeObserver(([entry]) =>
      setShellWidth(entry.contentRect.width));
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const body = workspaceBodyRef.current;
    if (!body) return;
    const observer = new ResizeObserver(([entry]) =>
      setWorkspaceBodySize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }));
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

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
    activeTool: activeToolState,
    setActiveTool,
    environmentOpen: environmentOpenState,
    setEnvironmentOpen,
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
      onWidthChange: setToolsWidth,
      onHeightChange: setToolsHeight,
      onWidthCommit: setPersistedToolsWidth,
      onHeightCommit: setPersistedToolsHeight,
    },
  }), [
    activeToolState,
    effectiveSidebarWidth,
    effectiveToolsHeight,
    effectiveToolsWidth,
    mobileNavigation,
    environmentOpenState,
    setPersistedSidebarWidth,
    setPersistedToolsHeight,
    setPersistedToolsWidth,
    sidebarCollapsed,
    sidebarDynamicMax,
    sidebarOpen,
    setActiveTool,
    setEnvironmentOpen,
    showStartupSurface,
    stackedTools,
    toggleWorkspaceTools,
    toolsDynamicMaxHeight,
    toolsDynamicMaxWidth,
    toolsVisible,
  ]);
}
