import { useId, type ReactNode } from "react";
import { Files, GitCompareArrows, Globe2, ListChecks, TerminalSquare, X } from "lucide-react";
import { IconButton } from "./ui";

export type WorkspacePanelTab = "changes" | "files" | "terminal" | "plan" | "preview";

export type WorkspacePanelProps = {
  activeTab: WorkspacePanelTab;
  onTabChange: (tab: WorkspacePanelTab) => void;
  children: ReactNode;
  tabs?: readonly WorkspacePanelTab[];
  badges?: Partial<Record<WorkspacePanelTab, number>>;
  onClose?: () => void;
};

const tabMeta: Record<WorkspacePanelTab, { label: string; icon: React.JSX.Element }> = {
  changes: { label: "Changes", icon: <GitCompareArrows size={15} aria-hidden="true" /> },
  files: { label: "Files", icon: <Files size={15} aria-hidden="true" /> },
  terminal: { label: "Terminal", icon: <TerminalSquare size={15} aria-hidden="true" /> },
  plan: { label: "Plan", icon: <ListChecks size={15} aria-hidden="true" /> },
  preview: { label: "Preview", icon: <Globe2 size={15} aria-hidden="true" /> },
};

const defaultTabs: readonly WorkspacePanelTab[] = ["changes", "files", "terminal", "plan", "preview"];

export function WorkspacePanel({
  activeTab,
  onTabChange,
  children,
  tabs = defaultTabs,
  badges,
  onClose,
}: WorkspacePanelProps): React.JSX.Element {
  const activeMeta = tabMeta[activeTab];
  const panelId = useId();

  return (
    <aside className="workspace-panel" aria-label="Workspace tools">
      <header className="workspace-panel-tabs">
        <div className="workspace-panel-tablist" role="tablist" aria-label="Workspace tools">
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
                className={active ? "workspace-panel-tab is-active" : "workspace-panel-tab"}
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
