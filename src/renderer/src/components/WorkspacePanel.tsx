import { useId, type ReactNode } from "react";
import {
  Boxes,
  Files,
  Flag,
  GitCompareArrows,
  Globe2,
  ListChecks,
  TerminalSquare,
  X,
} from "lucide-react";
import { IconButton } from "./ui";
import { prefetchWorkspaceTool } from "./lazySurfaceLoaders";
import type { WorkspacePanelTab } from "./workspacePanelTypes";

export type { WorkspacePanelTab } from "./workspacePanelTypes";

export type WorkspacePanelProps = {
  activeTab: WorkspacePanelTab;
  onTabChange: (tab: WorkspacePanelTab) => void;
  children: ReactNode;
  tabs?: readonly WorkspacePanelTab[];
  badges?: Partial<Record<WorkspacePanelTab, number>>;
  onClose?: () => void;
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
  visible = true,
}: WorkspacePanelProps): React.JSX.Element {
  const activeMeta = tabMeta[activeTab];
  const panelId = useId();

  return (
    <aside className="workspace-panel" aria-label="Workspace tools" hidden={!visible}>
      <header className="workspace-panel-tabs">
        <div
          className="workspace-panel-tablist"
          role="tablist"
          aria-label="Workspace tools"
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            const tabElements = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
            if (tabElements.length === 0) return;
            event.preventDefault();
            const current = tabElements.indexOf(document.activeElement as HTMLElement);
            const next = event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabElements.length - 1
                : event.key === "ArrowLeft"
                  ? current <= 0 ? tabElements.length - 1 : current - 1
                  : current < 0 || current === tabElements.length - 1 ? 0 : current + 1;
            tabElements[next]?.focus();
            const nextTab = tabs[next];
            if (nextTab) onTabChange(nextTab);
          }}
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
                onClick={() => onTabChange(tab)}
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
