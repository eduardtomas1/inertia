import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

import type { WorkspacePanelTab } from "../components/WorkspacePanel";
import { useMediaQuery } from "./useMediaQuery";
import { usePersistedSize } from "./usePersistedSize";

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

function initialActiveTool(): WorkspacePanelTab | null {
  const saved = window.localStorage.getItem(
    "inertia:layout:active-tool:v1",
  );
  if (saved === "collapsed") return null;
  return saved === "changes"
    || saved === "files"
    || saved === "terminal"
    || saved === "plan"
    || saved === "preview"
    ? saved
    : "terminal";
}

export interface WorkspaceLayout {
  sidebarOpen: boolean;
  setSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  activeTool: WorkspacePanelTab | null;
  setActiveTool: React.Dispatch<React.SetStateAction<WorkspacePanelTab | null>>;
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
  view: "workspace" | "settings",
  hasProject: boolean,
): WorkspaceLayout {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    window.localStorage.getItem(
      "inertia:layout:sidebar-collapsed:v1",
    ) === "true");
  const [activeTool, setActiveTool] = useState<WorkspacePanelTab | null>(
    initialActiveTool,
  );
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
  const stackedTools = useMediaQuery("(max-width: 1024px)");
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
  useEffect(() => {
    window.localStorage.setItem(
      "inertia:layout:active-tool:v1",
      activeTool ?? "collapsed",
    );
  }, [activeTool]);

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
    view === "workspace" && Boolean(activeTool && hasProject);
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

  return {
    sidebarOpen,
    setSidebarOpen,
    sidebarCollapsed,
    setSidebarCollapsed,
    activeTool,
    setActiveTool,
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
  };
}
