import {
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  Boxes,
  ChevronDown,
  Files,
  Flag,
  GitCompareArrows,
  Globe2,
  ListChecks,
  Settings,
  TerminalSquare,
  X,
} from "lucide-react";
import { IconButton } from "./ui";
import { prefetchWorkspaceTool } from "./lazySurfaceLoaders";
import type { WorkspacePanelTab } from "./workspacePanelTypes";
import {
  nextSidebarNavigationIndex,
  type SidebarNavigationKey,
} from "../utils/sidebarModel";

export type { WorkspacePanelTab } from "./workspacePanelTypes";

export type WorkspacePanelProps = {
  activeTab: WorkspacePanelTab;
  onTabChange: (tab: WorkspacePanelTab) => void;
  children: ReactNode;
  tabs?: readonly WorkspacePanelTab[];
  badges?: Partial<Record<WorkspacePanelTab, number>>;
  onClose?: () => void;
  onOpenSettings?: () => void;
  visible?: boolean;
};

const tabMeta: Record<WorkspacePanelTab, { label: string; icon: React.JSX.Element }> = {
  environment: { label: "Environment", icon: <Boxes size={15} aria-hidden="true" /> },
  changes: { label: "Changes", icon: <GitCompareArrows size={15} aria-hidden="true" /> },
  files: { label: "Files", icon: <Files size={15} aria-hidden="true" /> },
  terminal: { label: "Terminal", icon: <TerminalSquare size={15} aria-hidden="true" /> },
  goal: { label: "Goal", icon: <Flag size={15} aria-hidden="true" /> },
  plan: { label: "Plan", icon: <ListChecks size={15} aria-hidden="true" /> },
  preview: { label: "Preview", icon: <Globe2 size={15} aria-hidden="true" /> },
};

const defaultTabs: readonly WorkspacePanelTab[] = [
  "environment",
  "changes",
  "files",
  "terminal",
  "goal",
  "plan",
  "preview",
];

export function WorkspacePanel({
  activeTab,
  onTabChange,
  children,
  tabs = defaultTabs,
  badges,
  onClose,
  onOpenSettings,
  visible = true,
}: WorkspacePanelProps): React.JSX.Element {
  const activeMeta = tabMeta[activeTab];
  const panelId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const environmentToolMenuRef = useRef<HTMLDetailsElement>(null);

  const selectWorkspaceTool = (
    tab: WorkspacePanelTab,
    keyboardActivated: boolean,
  ): void => {
    environmentToolMenuRef.current?.removeAttribute("open");
    onTabChange(tab);
    if (!keyboardActivated) return;
    window.requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector<HTMLElement>(`[data-workspace-tab="${tab}"]`)
        ?.focus();
    });
  };

  const handleTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentTab: WorkspacePanelTab,
  ): void => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const currentIndex = tabs.indexOf(currentTab);
    if (currentIndex < 0 || tabs.length === 0) return;
    event.preventDefault();
    const key = (event.key === "ArrowLeft"
      ? "ArrowUp"
      : event.key === "ArrowRight" ? "ArrowDown" : event.key
    ) as SidebarNavigationKey;
    const nextIndex = nextSidebarNavigationIndex(
      currentIndex,
      key,
      tabs.length,
    );
    const nextTab = tabs[nextIndex];
    if (nextTab) selectWorkspaceTool(nextTab, true);
  };

  return (
    <aside
      ref={panelRef}
      className="workspace-panel"
      aria-label="Workspace tools"
      data-active-workspace-tool={activeTab}
      hidden={!visible}
    >
      {activeTab === "environment" ? (
        <header className="workspace-panel-environment-header">
          <div className="workspace-panel-environment-title">
            <div className="workspace-panel-environment-tablist" role="tablist" aria-label="Workspace tools">
              <button
                type="button"
                role="tab"
                id={`${panelId}-tab-environment`}
                aria-selected="true"
                aria-controls={`${panelId}-content`}
                data-workspace-tab="environment"
                onFocus={() => prefetchWorkspaceTool("environment")}
                onKeyDown={(event) => handleTabKeyDown(event, "environment")}
              >
                Environment
              </button>
            </div>
            {tabs.some((tab) => tab !== "environment") && (
              <details
                ref={environmentToolMenuRef}
                className="workspace-panel-tool-chooser"
                onBlur={(event) => {
                  if (event.currentTarget.contains(event.relatedTarget)) return;
                  environmentToolMenuRef.current?.removeAttribute("open");
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  environmentToolMenuRef.current?.removeAttribute("open");
                  environmentToolMenuRef.current?.querySelector("summary")?.focus();
                }}
              >
                <summary aria-label="Choose workspace tool" title="Choose workspace tool">
                  <ChevronDown size={11} aria-hidden="true" />
                </summary>
                <div role="group" aria-label="Other workspace tools">
                  {tabs.filter((tab) => tab !== "environment").map((tab) => {
                    const meta = tabMeta[tab];
                    return (
                      <button
                        type="button"
                        onFocus={() => prefetchWorkspaceTool(tab)}
                        onPointerEnter={() => prefetchWorkspaceTool(tab)}
                        onClick={(event) => selectWorkspaceTool(tab, event.detail === 0)}
                        key={tab}
                      >
                        {meta.icon}<span>{meta.label}</span>
                      </button>
                    );
                  })}
                </div>
              </details>
            )}
          </div>
          <div className="workspace-panel-environment-actions">
            {onOpenSettings && (
              <IconButton label="Environment settings" onClick={onOpenSettings}>
                <Settings size={14} />
              </IconButton>
            )}
          </div>
        </header>
      ) : (
        <header className="workspace-panel-tabs">
        <div
          className="workspace-panel-tablist"
          role="tablist"
          aria-label="Workspace tools"
        >
          {tabs.map((tab) => {
            const meta = tabMeta[tab];
            const active = tab === activeTab;
            const badge = badges?.[tab];
            const hasBadge = typeof badge === "number" && badge > 0;
            return (
              <button
                type="button"
                role="tab"
                id={`${panelId}-tab-${tab}`}
                aria-label={hasBadge ? `${meta.label} ${badge}` : meta.label}
                aria-selected={active}
                aria-controls={`${panelId}-content`}
                data-workspace-tab={tab}
                tabIndex={active ? 0 : -1}
                className={active ? "workspace-panel-tab is-active" : "workspace-panel-tab"}
                onFocus={() => prefetchWorkspaceTool(tab)}
                onPointerDown={() => prefetchWorkspaceTool(tab)}
                onPointerEnter={() => prefetchWorkspaceTool(tab)}
                onKeyDown={(event) => handleTabKeyDown(event, tab)}
                onClick={(event) => selectWorkspaceTool(tab, event.detail === 0)}
                key={tab}
              >
                {meta.icon}
                <span>{meta.label}</span>
                {hasBadge && <span className="workspace-panel-badge">{badge}</span>}
              </button>
            );
          })}
        </div>
        {onClose && (
          <IconButton label="Close workspace tools" onClick={onClose}>
            <X size={16} />
          </IconButton>
        )}
        </header>
      )}
      <div
        className="workspace-panel-content"
        id={`${panelId}-content`}
        role="tabpanel"
        aria-labelledby={`${panelId}-tab-${activeTab}`}
        aria-label={`${activeMeta.label} panel`}
      >
        {children}
      </div>
    </aside>
  );
}
