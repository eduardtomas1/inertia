import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

import type { WorkspacePanelTab } from "../components/WorkspacePanel";
import {
  LAST_WORKSPACE_TOOL_KEY,
  workspacePanelTab,
} from "../utils/workspaceStartup";
import { usePersistedSize } from "./usePersistedSize";

const PANE_TOOL_MIN_HEIGHT = 150;
const PANE_TOOL_MAX_HEIGHT = 520;

export interface ConversationPaneLayout {
  activeTool: WorkspacePanelTab | null;
  setActiveTool: Dispatch<SetStateAction<WorkspacePanelTab | null>>;
  stackedTools: true;
  toolsVisible: boolean;
  workspaceBodyRef: RefObject<HTMLDivElement | null>;
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
  toggleWorkspaceTools: () => void;
}

function initialTool(storageKey: string): WorkspacePanelTab {
  return workspacePanelTab(window.localStorage.getItem(storageKey))
    ?? workspacePanelTab(window.localStorage.getItem(LAST_WORKSPACE_TOOL_KEY))
    ?? "terminal";
}

interface PersistedPaneToolState {
  key: string;
  activeTool: WorkspacePanelTab | null;
  lastTool: WorkspacePanelTab;
}

function storedPaneToolState(
  key: string,
  toolStorageKey: string,
  openStorageKey: string,
): PersistedPaneToolState {
  const lastTool = initialTool(toolStorageKey);
  return {
    key,
    activeTool: window.localStorage.getItem(openStorageKey) === "true"
      ? lastTool
      : null,
    lastTool,
  };
}

/**
 * Owns the tool surface inside one split pane. Pane state is intentionally
 * scoped by conversation so swapping or reopening a split never transfers a
 * terminal/files selection to a different chat.
 */
export function useConversationPaneLayout(
  conversationId: string | null,
): ConversationPaneLayout {
  const toolStorageKey =
    `inertia:layout:split-pane-tool:${conversationId ?? "empty"}:v1`;
  const openStorageKey =
    `inertia:layout:split-pane-open:${conversationId ?? "empty"}:v1`;
  const heightStorageKey =
    `inertia:layout:split-pane-height:${conversationId ?? "empty"}:v1`;
  const ownerKey = conversationId ?? "empty";
  const [persistedToolState, setPersistedToolState] = useState(() =>
    storedPaneToolState(ownerKey, toolStorageKey, openStorageKey));
  const toolState = persistedToolState.key === ownerKey
    ? persistedToolState
    : storedPaneToolState(ownerKey, toolStorageKey, openStorageKey);
  const activeTool = toolState.activeTool;
  const workspaceBodyRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = usePersistedSize(
    heightStorageKey,
    260,
    { min: PANE_TOOL_MIN_HEIGHT, max: PANE_TOOL_MAX_HEIGHT },
  );

  useEffect(() => {
    if (persistedToolState.key !== ownerKey) {
      setPersistedToolState(
        storedPaneToolState(ownerKey, toolStorageKey, openStorageKey),
      );
    }
  }, [
    openStorageKey,
    ownerKey,
    persistedToolState.key,
    toolStorageKey,
  ]);

  const setActiveTool = useCallback<Dispatch<
    SetStateAction<WorkspacePanelTab | null>
  >>((update) => {
    setPersistedToolState((current) => {
      const owned = current.key === ownerKey
        ? current
        : storedPaneToolState(ownerKey, toolStorageKey, openStorageKey);
      const next = typeof update === "function"
        ? update(owned.activeTool)
        : update;
      window.localStorage.setItem(openStorageKey, String(next !== null));
      if (next) window.localStorage.setItem(toolStorageKey, next);
      return {
        key: ownerKey,
        activeTool: next,
        lastTool: next ?? owned.lastTool,
      };
    });
  }, [openStorageKey, ownerKey, toolStorageKey]);

  const toggleWorkspaceTools = useCallback(() => {
    setActiveTool(
      activeTool ? null : toolState.lastTool,
    );
  }, [activeTool, setActiveTool, toolState.lastTool]);

  return useMemo(() => ({
    activeTool,
    setActiveTool,
    stackedTools: true as const,
    toolsVisible: activeTool !== null && conversationId !== null,
    workspaceBodyRef,
    tools: {
      width: 0,
      height,
      maxWidth: 0,
      maxHeight: PANE_TOOL_MAX_HEIGHT,
      onWidthChange: () => undefined,
      onHeightChange: setHeight,
      onWidthCommit: () => undefined,
      onHeightCommit: setHeight,
    },
    toggleWorkspaceTools,
  }), [
    activeTool,
    conversationId,
    height,
    setActiveTool,
    setHeight,
    toggleWorkspaceTools,
  ]);
}
