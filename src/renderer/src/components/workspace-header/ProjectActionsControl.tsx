import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, Play, Plus } from "lucide-react";
import type { ProjectAction } from "@shared/contracts";

import { useDismissibleMenu } from "../../hooks/useDismissibleMenu";
import { layoutStorage } from "../../utils/layoutStorage";
import { navigateMenuItems } from "../../utils/menuKeyboard";
import {
  liveWorkspaceRunCount,
  type WorkspaceRunsModel,
} from "../../utils/workspaceRuns";
import { FocusFirstMenuItem } from "./FocusFirstMenuItem";
import { HeaderMenuGroup } from "./HeaderMenuGroup";
import { useFocusOutDismiss } from "./useFocusOutDismiss";

export type HeaderControlPresentation = "toolbar" | "menu";

export const loadHeaderActionMenus = () => import("./HeaderActionMenus");
const ProjectActionMenuItems = lazy(async () => ({
  default: (await loadHeaderActionMenus()).ProjectActionMenuItems,
}));

export function preferredActionStorageKey(projectId: string): string {
  return `inertia:header:preferred-action:${encodeURIComponent(projectId)}:v1`;
}

export function primaryProjectAction(
  actions: readonly ProjectAction[],
  preferredActionId: string | null,
): ProjectAction | null {
  if (preferredActionId) {
    const preferred = actions.find((action) => action.id === preferredActionId);
    if (preferred) return preferred;
  }
  return actions[0] ?? null;
}

interface ProjectActionsControlProps {
  presentation: HeaderControlPresentation;
  projectId: string;
  actions: readonly ProjectAction[];
  runs: WorkspaceRunsModel | null;
  onRunAction: (action: ProjectAction) => void;
  onAddAction?: () => void;
  onRequestMenuClose?: () => void;
}

export function ProjectActionsControl({
  presentation,
  projectId,
  actions,
  runs,
  onRunAction,
  onAddAction,
  onRequestMenuClose,
}: ProjectActionsControlProps): React.JSX.Element | null {
  const menuId = useId();
  const storageKey = preferredActionStorageKey(projectId);
  const [preferred, setPreferred] = useState(() => ({
    key: storageKey,
    id: layoutStorage.getItem(storageKey),
  }));
  const preferredId = preferred.key === storageKey
    ? preferred.id
    : layoutStorage.getItem(storageKey);
  const primaryAction = useMemo(
    () => primaryProjectAction(actions, preferredId),
    [actions, preferredId],
  );
  const { menu, toggleMenu, dismissMenu, setMenuTrigger, setMenuPopover } =
    useDismissibleMenu<"actions">();
  const anchorRef = useRef<HTMLDivElement>(null);
  const dismissOnFocusOut = useCallback(() => dismissMenu("context-change"), [dismissMenu]);
  useFocusOutDismiss(anchorRef, menu !== null && presentation === "toolbar", dismissOnFocusOut);
  useEffect(() => {
    dismissMenu("context-change");
  }, [dismissMenu, presentation, projectId]);
  const runCount = runs ? runs.localServers.length + runs.checks.length : 0;
  const liveRuns = liveWorkspaceRunCount(runs);

  const run = (action: ProjectAction): void => {
    layoutStorage.setItem(storageKey, action.id);
    setPreferred({ key: storageKey, id: action.id });
    if (menu) dismissMenu("selection");
    onRequestMenuClose?.();
    onRunAction(action);
  };
  const addAction = (): void => {
    if (menu) dismissMenu("context-change");
    onRequestMenuClose?.();
    onAddAction?.();
  };
  const renderMenuItems = (focusFirst = false): React.JSX.Element => (
    <Suspense fallback={<p className="header-menu-hint-text" role="status">Loading actions…</p>}>
      <ProjectActionMenuItems
        presentation={presentation}
        actions={actions}
        runs={runs}
        onRun={run}
        {...(onAddAction ? { onAdd: addAction } : {})}
        onDone={() => {
          if (menu) dismissMenu("context-change");
          onRequestMenuClose?.();
        }}
      />
      {focusFirst && <FocusFirstMenuItem menuId={menuId} />}
    </Suspense>
  );

  if (presentation === "menu") {
    return (
      <>
        {primaryAction && (
          <button
            type="button"
            role="menuitem"
            className="header-menu-item"
            onClick={() => run(primaryAction)}
          >
            <Play size={14} aria-hidden="true" />
            <span>Run {primaryAction.label}</span>
          </button>
        )}
        {primaryAction || runCount > 0 ? (
          <HeaderMenuGroup label="Project actions" icon={<Play size={14} aria-hidden="true" />}>
            {renderMenuItems()}
          </HeaderMenuGroup>
        ) : onAddAction ? (
          <button
            type="button"
            role="menuitem"
            className="header-menu-item"
            onClick={addAction}
          >
            <Plus size={14} aria-hidden="true" />
            <span>Add project action…</span>
          </button>
        ) : null}
      </>
    );
  }

  if (!primaryAction && runCount === 0) {
    if (!onAddAction) return null;
    return (
      <div className="header-split" role="group" aria-label="Project actions">
        <button
          type="button"
          className="header-split-primary"
          aria-label="Add action"
          title="Add action"
          onClick={addAction}
        >
          <Plus size={14} aria-hidden="true" />
          <span className="header-split-label">Add action</span>
        </button>
      </div>
    );
  }

  const primaryLabel = primaryAction ? `Run ${primaryAction.label}` : "Add action";
  return (
    <div ref={anchorRef} className="header-split-anchor" data-header-menu="actions">
      <div className="header-split" role="group" aria-label="Project actions">
        <button
          type="button"
          className="header-split-primary"
          aria-label={liveRuns > 0 ? `${primaryLabel}, ${liveRuns} running` : primaryLabel}
          title={primaryAction ? `${primaryLabel} · ${primaryAction.command}` : primaryLabel}
          onClick={() => {
            if (primaryAction) run(primaryAction);
            else addAction();
          }}
        >
          {primaryAction ? <Play size={14} aria-hidden="true" className="header-run-icon" /> : <Plus size={14} aria-hidden="true" />}
          <span className="header-split-label">{primaryAction ? primaryAction.label : "Add action"}</span>
        </button>
        <button
          ref={(node) => setMenuTrigger("actions", node)}
          type="button"
          className="header-split-chevron"
          aria-label="Project action options"
          title="Project action options"
          aria-haspopup="menu"
          aria-expanded={menu === "actions"}
          aria-controls={menuId}
          onFocus={() => void loadHeaderActionMenus()}
          onPointerEnter={() => void loadHeaderActionMenus()}
          onClick={() => toggleMenu("actions")}
        >
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </div>
      {menu === "actions" && (
        <div
          ref={(node) => setMenuPopover("actions", node)}
          id={menuId}
          className="header-popover header-actions-popover"
          role="menu"
          aria-label="Project actions"
          onKeyDown={(event) => navigateMenuItems(event, '[role="menuitem"]')}
        >
          {renderMenuItems(true)}
        </div>
      )}
    </div>
  );
}
