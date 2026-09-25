import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { surfaceIcons } from "./workspacePanelIcons";

import { prefetchWorkspaceTool } from "./lazySurfaceLoaders";
import type { WorkspacePanelTab } from "./workspacePanelTypes";
import {
  surfaceShortcutActionForKey,
  surfaceShortcutTargetsTypingContext,
} from "../utils/rightPanelSurfaces";

export interface SurfaceAction {
  surface: WorkspacePanelTab;
  label: string;
  shortcut: string;
  available: boolean;
  reason?: string;
  badge: number;
}

const LAUNCHER_SHORTCUT_BLOCKING_LAYERS = [
  '[role="dialog"][aria-modal="true"]',
  '[role="menu"]:not([hidden])',
  ".composer-popover",
].join(",");

export function RightPanelLauncher({
  actions,
  onOpen,
  active = true,
}: {
  actions: readonly SurfaceAction[];
  onOpen: (surface: WorkspacePanelTab) => void;
  /** False while the host panel is hidden; the shortcuts then stay disarmed. */
  active?: boolean;
}): React.JSX.Element {
  const [highlight, setHighlight] = useState(-1);
  const availableActions = actions.filter((action) => action.available);
  const highlightIndex = availableActions.length === 0
    ? -1
    : Math.min(highlight, availableActions.length - 1);
  const shortcutActionsRef = useRef(availableActions);
  const onOpenRef = useRef(onOpen);
  useEffect(() => {
    shortcutActionsRef.current = availableActions;
    onOpenRef.current = onOpen;
  });
  useEffect(() => {
    if (!active) return;
    const handler = (event: KeyboardEvent): void => {
      const action = surfaceShortcutActionForKey(shortcutActionsRef.current, event);
      if (!action) return;
      if (document.querySelector(LAUNCHER_SHORTCUT_BLOCKING_LAYERS)) return;
      const target = event.target;
      if (target instanceof Element && surfaceShortcutTargetsTypingContext(target)) return;
      event.preventDefault();
      event.stopPropagation();
      onOpenRef.current(action.surface);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [active]);
  const focusOnMount = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const active = document.activeElement;
    if (
      !active
      || active === document.body
      || active.closest("[data-panel-layout-controls]")
      || node.closest(".workspace-panel")?.contains(active)
    ) {
      node.focus({ preventScroll: true });
    }
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (availableActions.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      setHighlight((highlightIndex + 1) % availableActions.length);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      setHighlight(highlightIndex === -1
        ? availableActions.length - 1
        : (highlightIndex - 1 + availableActions.length) % availableActions.length);
      return;
    }
    if (event.key === "Enter") {
      if (event.target !== event.currentTarget) return;
      const action = availableActions[highlightIndex];
      if (!action) return;
      event.preventDefault();
      onOpen(action.surface);
    }
  };
  const highlighted = availableActions[highlightIndex] ?? null;

  return (
    <div
      ref={focusOnMount}
      className="workspace-panel-launcher"
      tabIndex={0}
      role="group"
      aria-label="Open a surface"
      aria-keyshortcuts={availableActions.map((action) => action.shortcut).join(" ")}
      data-surface-launcher-keys={availableActions.map((action) => action.shortcut).join("")}
      onKeyDown={handleKeyDown}
    >
      <div className="workspace-panel-launcher-list">
        <h3>Open a surface</h3>
        {actions.map((action) => action.available ? (
          <button
            type="button"
            key={action.surface}
            className={highlighted === action ? "is-highlighted" : undefined}
            aria-keyshortcuts={action.shortcut}
            onPointerEnter={() => {
              prefetchWorkspaceTool(action.surface);
              setHighlight(availableActions.indexOf(action));
            }}
            onPointerLeave={() => setHighlight((current) =>
              current === availableActions.indexOf(action) ? -1 : current)}
            onFocus={() => prefetchWorkspaceTool(action.surface)}
            onClick={() => onOpen(action.surface)}
          >
            {surfaceIcons[action.surface]}
            <span>{action.label}</span>
            {action.badge > 0 && (
              <small>{action.surface === "agents" ? `${action.badge} running` : action.badge}</small>
            )}
            <kbd>{action.shortcut}</kbd>
          </button>
        ) : (
          <div
            key={action.surface}
            className="is-unavailable"
            aria-disabled="true"
            title={action.reason}
          >
            {surfaceIcons[action.surface]}
            <span>{action.label}<small>{action.reason}</small></span>
            <kbd>{action.shortcut}</kbd>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AddSurfaceMenuItems({
  actions,
  onOpen,
}: {
  actions: readonly SurfaceAction[];
  onOpen: (surface: WorkspacePanelTab) => void;
}): React.JSX.Element {
  return (
    <>
      {actions.map((action) => (
        <button
          type="button"
          role="menuitem"
          key={action.surface}
          aria-disabled={!action.available || undefined}
          aria-keyshortcuts={action.shortcut}
          title={action.reason}
          onPointerEnter={() => {
            if (action.available) prefetchWorkspaceTool(action.surface);
          }}
          onClick={() => {
            if (action.available) onOpen(action.surface);
          }}
        >
          {surfaceIcons[action.surface]}
          <span>{action.label}</span>
          <kbd>{action.shortcut}</kbd>
        </button>
      ))}
    </>
  );
}
