import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import type { WorkspacePanelTab } from "../components/workspacePanelTypes";
import {
  activeRightPanelSurface,
  activateRightPanelSurface,
  applyRightPanelTool,
  closeAllRightPanelSurfaces,
  closeOtherRightPanelSurfaces,
  closeRightPanelSurface,
  legacyRightPanelState,
  openRightPanelSurface,
  parseRightPanelState,
  serializeRightPanelState,
  toggleRightPanelSurface,
  toggleRightPanelVisibility,
  type RightPanelState,
} from "../utils/rightPanelSurfaces";
import type { WorkspacePanelActions } from "./useWorkspaceLayout";
import { usePersistedSize } from "./usePersistedSize";

const PANE_TOOL_MIN_HEIGHT = 150;
const PANE_TOOL_MAX_HEIGHT = 520;

export interface ConversationPaneLayout extends WorkspacePanelActions {
  stackedTools: true;
  panelPresentation: "inline";
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
}

interface PersistedPanePanelState {
  key: string;
  panel: RightPanelState;
}

function storedPanePanelState(
  key: string,
  panelStorageKey: string,
  legacyToolStorageKey: string,
  legacyOpenStorageKey: string,
): PersistedPanePanelState {
  const stored = parseRightPanelState(window.localStorage.getItem(panelStorageKey));
  if (stored) return { key, panel: stored };
  return {
    key,
    panel: legacyRightPanelState(
      window.localStorage.getItem(legacyToolStorageKey),
      window.localStorage.getItem(legacyOpenStorageKey) === "true",
    ),
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
  const ownerKey = conversationId ?? "empty";
  const panelStorageKey = `inertia:layout:split-pane-panel:${ownerKey}:v1`;
  const legacyToolStorageKey = `inertia:layout:split-pane-tool:${ownerKey}:v1`;
  const legacyOpenStorageKey = `inertia:layout:split-pane-open:${ownerKey}:v1`;
  const heightStorageKey = `inertia:layout:split-pane-height:${ownerKey}:v1`;
  const [persistedPanelState, setPersistedPanelState] = useState(() =>
    storedPanePanelState(
      ownerKey,
      panelStorageKey,
      legacyToolStorageKey,
      legacyOpenStorageKey,
    ));
  const panelState = persistedPanelState.key === ownerKey
    ? persistedPanelState.panel
    : storedPanePanelState(
      ownerKey,
      panelStorageKey,
      legacyToolStorageKey,
      legacyOpenStorageKey,
    ).panel;
  const activeTool = activeRightPanelSurface(panelState);
  const workspaceBodyRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = usePersistedSize(
    heightStorageKey,
    260,
    { min: PANE_TOOL_MIN_HEIGHT, max: PANE_TOOL_MAX_HEIGHT },
  );

  useEffect(() => {
    if (persistedPanelState.key !== ownerKey) {
      setPersistedPanelState(storedPanePanelState(
        ownerKey,
        panelStorageKey,
        legacyToolStorageKey,
        legacyOpenStorageKey,
      ));
    }
  }, [
    legacyOpenStorageKey,
    legacyToolStorageKey,
    ownerKey,
    panelStorageKey,
    persistedPanelState.key,
  ]);

  const updatePanel = useCallback((
    update: (current: RightPanelState) => RightPanelState,
  ): void => {
    setPersistedPanelState((current) => {
      const owned = current.key === ownerKey
        ? current.panel
        : storedPanePanelState(
          ownerKey,
          panelStorageKey,
          legacyToolStorageKey,
          legacyOpenStorageKey,
        ).panel;
      const next = update(owned);
      window.localStorage.setItem(panelStorageKey, serializeRightPanelState(next));
      return { key: ownerKey, panel: next };
    });
  }, [legacyOpenStorageKey, legacyToolStorageKey, ownerKey, panelStorageKey]);

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
    toggleTerminal: () =>
      updatePanel((current) => toggleRightPanelSurface(current, "terminal")),
  }), [updatePanel]);

  return useMemo(() => ({
    panel: panelState,
    activeTool,
    ...panelActions,
    stackedTools: true as const,
    panelPresentation: "inline" as const,
    toolsVisible: panelState.isOpen && conversationId !== null,
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
  }), [
    activeTool,
    conversationId,
    height,
    panelActions,
    panelState,
    setHeight,
  ]);
}
