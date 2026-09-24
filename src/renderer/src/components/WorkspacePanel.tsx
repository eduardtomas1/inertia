import {
  lazy,
  Suspense,
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  Bot,
  Files,
  Flag,
  Gauge,
  GitCompareArrows,
  Globe2,
  ListChecks,
  Plus,
  X,
} from "lucide-react";
import { prefetchWorkspaceTool } from "./lazySurfaceLoaders";
import type { WorkspacePanelTab } from "./workspacePanelTypes";
import {
  RIGHT_PANEL_SURFACE_META,
  RIGHT_PANEL_SURFACES,
  surfaceShortcutActionForKey,
} from "../utils/rightPanelSurfaces";
import type { SurfaceAction } from "./WorkspacePanelLauncher";
import { FocusFirstMenuItem } from "./workspace-header/FocusFirstMenuItem";
import { useDismissibleMenu } from "../hooks/useDismissibleMenu";
import { navigateMenuItems } from "../utils/menuKeyboard";
import {
  nextSidebarNavigationIndex,
  type SidebarNavigationKey,
} from "../utils/sidebarModel";

export type { WorkspacePanelTab } from "./workspacePanelTypes";

export type WorkspacePanelPresentation = "inline" | "sheet" | "stacked";

export type WorkspacePanelProps = {
  surfaces: readonly WorkspacePanelTab[];
  activeSurface: WorkspacePanelTab | null;
  unavailable?: Partial<Record<WorkspacePanelTab, string>>;
  badges?: Partial<Record<WorkspacePanelTab, number>>;
  liveAgentCount?: number;
  presentation?: WorkspacePanelPresentation;
  visible?: boolean;
  children: ReactNode;
  onActivateSurface: (surface: WorkspacePanelTab) => void;
  onOpenSurface: (surface: WorkspacePanelTab) => void;
  onCloseSurface: (surface: WorkspacePanelTab) => void;
  onClosePanel?: () => void;
};

const surfaceIcons: Record<WorkspacePanelTab, React.JSX.Element> = {
  changes: <GitCompareArrows size={14} aria-hidden="true" />,
  files: <Files size={14} aria-hidden="true" />,
  preview: <Globe2 size={14} aria-hidden="true" />,
  agents: <Bot size={14} aria-hidden="true" />,
  usage: <Gauge size={14} aria-hidden="true" />,
  goal: <Flag size={14} aria-hidden="true" />,
  plan: <ListChecks size={14} aria-hidden="true" />,
};

const loadWorkspacePanelLauncher = () => import("./WorkspacePanelLauncher");
const RightPanelLauncher = lazy(async () => ({
  default: (await loadWorkspacePanelLauncher()).RightPanelLauncher,
}));
const AddSurfaceMenuItems = lazy(async () => ({
  default: (await loadWorkspacePanelLauncher()).AddSurfaceMenuItems,
}));

function surfaceActions(
  unavailable: Partial<Record<WorkspacePanelTab, string>>,
  badges: Partial<Record<WorkspacePanelTab, number>>,
  liveAgentCount: number,
): SurfaceAction[] {
  return RIGHT_PANEL_SURFACES.map((surface) => ({
    surface,
    ...RIGHT_PANEL_SURFACE_META[surface],
    available: !unavailable[surface],
    ...(unavailable[surface] ? { reason: unavailable[surface] } : {}),
    badge: surface === "agents" ? liveAgentCount : badges[surface] ?? 0,
  }));
}

export function WorkspacePanel({
  surfaces,
  activeSurface,
  unavailable = {},
  badges = {},
  liveAgentCount = 0,
  presentation = "inline",
  visible = true,
  children,
  onActivateSurface,
  onOpenSurface,
  onCloseSurface,
  onClosePanel,
}: WorkspacePanelProps): React.JSX.Element {
  const panelId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const visibleSurfaces = surfaces.filter((surface) => !unavailable[surface]);
  const selected = activeSurface && visibleSurfaces.includes(activeSurface)
    ? activeSurface
    : null;
  const actions = surfaceActions(unavailable, badges, liveAgentCount);
  const { menu, toggleMenu, dismissMenu, setMenuTrigger, setMenuPopover } =
    useDismissibleMenu<"add">();
  const wasVisibleRef = useRef(visible);
  useLayoutEffect(() => {
    const opened = visible && !wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (!opened || selected) return;
    const frame = window.requestAnimationFrame(() => {
      document.removeEventListener("focusin", cancelOpeningFocus);
      const active = document.activeElement;
      if (active && active !== document.body && !active.closest("[data-panel-layout-controls]")) return;
      panelRef.current
        ?.querySelector<HTMLElement>(".workspace-panel-launcher")
        ?.focus({ preventScroll: true });
    });
    // A newer focus choice supersedes opening focus, even if it returns to the opener.
    const cancelOpeningFocus = () => window.cancelAnimationFrame(frame);
    document.addEventListener("focusin", cancelOpeningFocus, { once: true });
    return () => {
      document.removeEventListener("focusin", cancelOpeningFocus);
      window.cancelAnimationFrame(frame);
    };
  }, [selected, visible]);

  const focusTab = (surface: WorkspacePanelTab): void => {
    window.requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector<HTMLElement>(`[data-workspace-tab="${surface}"]`)
        ?.focus();
    });
  };

  const openSurface = (surface: WorkspacePanelTab): void => {
    dismissMenu("context-change");
    onOpenSurface(surface);
    focusTab(surface);
  };

  const closeSurface = (surface: WorkspacePanelTab, keyboard: boolean): void => {
    const index = visibleSurfaces.indexOf(surface);
    onCloseSurface(surface);
    if (!keyboard) return;
    const remaining = visibleSurfaces.filter((entry) => entry !== surface);
    const fallback = remaining[Math.min(index, remaining.length - 1)];
    if (fallback) focusTab(fallback);
    else {
      window.requestAnimationFrame(() => {
        panelRef.current?.querySelector<HTMLElement>(".workspace-panel-launcher")?.focus();
      });
    }
  };

  const handleTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    surface: WorkspacePanelTab,
  ): void => {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      closeSurface(surface, true);
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const currentIndex = visibleSurfaces.indexOf(surface);
    if (currentIndex < 0) return;
    event.preventDefault();
    const key = (event.key === "ArrowLeft"
      ? "ArrowUp"
      : event.key === "ArrowRight" ? "ArrowDown" : event.key
    ) as SidebarNavigationKey;
    const nextSurface = visibleSurfaces[
      nextSidebarNavigationIndex(currentIndex, key, visibleSurfaces.length)
    ];
    if (nextSurface) {
      onActivateSurface(nextSurface);
      focusTab(nextSurface);
    }
  };

  const handleAddMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const action = surfaceShortcutActionForKey(actions, event.nativeEvent);
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      openSurface(action.surface);
      return;
    }
    navigateMenuItems(event, '[role="menuitem"]:not([aria-disabled="true"])');
  };

  return (
    <aside
      ref={panelRef}
      className={`workspace-panel is-${presentation}`}
      aria-label="Workspace tools"
      data-active-workspace-tool={selected ?? "launcher"}
      hidden={!visible}
      onKeyDown={(event) => {
        if (
          presentation === "sheet"
          && event.key === "Escape"
          && !event.defaultPrevented
          && onClosePanel
        ) {
          event.preventDefault();
          onClosePanel();
          window.requestAnimationFrame(() => {
            document.querySelector<HTMLElement>('[data-panel-layout-controls] [data-right-panel-toggle]')?.focus();
          });
        }
      }}
    >
      <header className="workspace-panel-tabs drag-region">
        {visibleSurfaces.length > 0 && (
          <div className="workspace-panel-tablist no-drag" role="tablist" aria-label="Panel surfaces">
            {visibleSurfaces.map((surface) => {
              const meta = RIGHT_PANEL_SURFACE_META[surface];
              const active = surface === selected;
              const badge = surface === "agents" ? liveAgentCount : badges[surface] ?? 0;
              return (
                <div
                  key={surface}
                  className={active ? "workspace-panel-tab is-active" : "workspace-panel-tab"}
                  onMouseDown={(event) => {
                    if (event.button === 1) event.preventDefault();
                  }}
                  onAuxClick={(event) => {
                    if (event.button !== 1) return;
                    event.preventDefault();
                    closeSurface(surface, false);
                  }}
                >
                  <button
                    type="button"
                    role="tab"
                    id={`${panelId}-tab-${surface}`}
                    aria-label={badge > 0 ? `${meta.label} ${badge}` : meta.label}
                    aria-selected={active}
                    aria-controls={`${panelId}-content`}
                    aria-keyshortcuts="Delete"
                    data-workspace-tab={surface}
                    tabIndex={active || (!selected && surface === visibleSurfaces[0]) ? 0 : -1}
                    title={meta.label}
                    onFocus={() => prefetchWorkspaceTool(surface)}
                    onPointerEnter={() => prefetchWorkspaceTool(surface)}
                    onKeyDown={(event) => handleTabKeyDown(event, surface)}
                    onClick={() => onActivateSurface(surface)}
                  >
                    {surfaceIcons[surface]}
                    <span>{meta.label}</span>
                    {badge > 0 && <span className="workspace-panel-badge" aria-hidden="true">{badge}</span>}
                  </button>
                  <button
                    type="button"
                    className="workspace-panel-tab-close"
                    aria-label={`Close ${meta.label}`}
                    title={`Close ${meta.label}`}
                    tabIndex={-1}
                    onClick={() => closeSurface(surface, false)}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {visibleSurfaces.length > 0 && (
          <div className="workspace-panel-add-anchor no-drag">
            <button
              ref={(node) => setMenuTrigger("add", node)}
              type="button"
              className="workspace-panel-add"
              aria-label="Add panel surface"
              title="Add panel surface"
              aria-haspopup="menu"
              aria-expanded={menu === "add"}
              aria-controls={`${panelId}-add-menu`}
              onFocus={() => void loadWorkspacePanelLauncher()}
              onPointerEnter={() => void loadWorkspacePanelLauncher()}
              onClick={() => toggleMenu("add")}
            >
              <Plus size={14} aria-hidden="true" />
            </button>
            {menu === "add" && (
              <div
                ref={(node) => setMenuPopover("add", node)}
                id={`${panelId}-add-menu`}
                className="header-popover workspace-panel-add-menu"
                role="menu"
                aria-label="Add panel surface"
                onKeyDownCapture={handleAddMenuKeyDown}
              >
                <Suspense fallback={<p className="header-menu-hint-text" role="status">Loading…</p>}>
                  <AddSurfaceMenuItems actions={actions} onOpen={openSurface} />
                  <FocusFirstMenuItem menuId={`${panelId}-add-menu`} />
                </Suspense>
              </div>
            )}
          </div>
        )}
      </header>
      {!selected && (
        <Suspense fallback={<div className="workspace-panel-launcher" aria-busy="true" />}>
          <RightPanelLauncher actions={actions} onOpen={openSurface} active={visible} />
        </Suspense>
      )}
      <div
        className="workspace-panel-content"
        id={`${panelId}-content`}
        role="tabpanel"
        hidden={!selected}
        aria-labelledby={selected ? `${panelId}-tab-${selected}` : undefined}
        aria-label={selected ? `${RIGHT_PANEL_SURFACE_META[selected].label} panel` : undefined}
      >
        {children}
      </div>
    </aside>
  );
}
