import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  FolderOpen,
  FolderSearch,
  PanelLeft,
  Play,
  Plus,
  Square,
  Trash2,
} from "lucide-react";
import type { ProjectAction } from "@shared/contracts";

import type { EnvironmentRunItem } from "../../utils/environmentSummary";
import {
  workspaceRunStatusLabel,
  type WorkspaceRunsModel,
} from "../../utils/workspaceRuns";

const COPY_FEEDBACK_MS = 1_500;

export type HeaderMenuPresentation = "toolbar" | "menu";

function RunRow({
  run,
  runs,
  onDone,
  onBeforeRowAction,
}: {
  run: EnvironmentRunItem & { url?: string };
  runs: WorkspaceRunsModel;
  onDone: () => void;
  onBeforeRowAction: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}): React.JSX.Element {
  const owner = run.contextLabel ? ` · ${run.contextLabel}` : "";
  const status = workspaceRunStatusLabel(run.status);
  const detail = run.url ? `${status} · ${run.url}` : status;
  return (
    <div className="header-run-row" role="group" aria-label={`${run.label}${owner}`}>
      <span className="header-run-copy">
        <strong>{run.label}</strong>
        <small title={`${detail}${owner}`}>{detail}{owner}</small>
      </span>
      {run.canOpenPreview && (
        <button
          type="button"
          role="menuitem"
          className="header-run-action"
          aria-label={`Open preview for ${run.label}${owner}`}
          title="Open preview"
          onClick={() => { onDone(); runs.onOpenRunPreview(run); }}
        >
          <ExternalLink size={12} aria-hidden="true" />
        </button>
      )}
      {run.canAcknowledge && (
        <button
          type="button"
          role="menuitem"
          className="header-run-action"
          aria-label={`Acknowledge ${run.label}${owner}`}
          title="Acknowledge"
          onClick={(event) => {
            onBeforeRowAction(event);
            runs.onAcknowledgeRun(run);
          }}
        >
          <Check size={12} aria-hidden="true" />
        </button>
      )}
      {run.canDismiss && (
        <button
          type="button"
          role="menuitem"
          className="header-run-action"
          aria-label={`Dismiss ${run.label}${owner}`}
          title="Dismiss"
          onClick={(event) => {
            onBeforeRowAction(event);
            runs.onDismissRun(run);
          }}
        >
          <Trash2 size={12} aria-hidden="true" />
        </button>
      )}
      {run.canStop && (
        <button
          type="button"
          role="menuitem"
          className="header-run-action"
          aria-label={`Stop ${run.label}${owner}`}
          title="Stop"
          onClick={(event) => {
            onBeforeRowAction(event);
            runs.onStopRun(run);
          }}
        >
          <Square size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function ProjectActionMenuItems({
  presentation,
  actions,
  runs,
  onRun,
  onAdd,
  onDone,
}: {
  presentation: HeaderMenuPresentation;
  actions: readonly ProjectAction[];
  runs: WorkspaceRunsModel | null;
  onRun: (action: ProjectAction) => void;
  onAdd?: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const runItems = runs ? [...runs.localServers, ...runs.checks] : [];
  const itemClass = presentation === "menu" ? "header-menu-item" : "header-action-item";
  const anchorRef = useRef<HTMLSpanElement>(null);
  const pendingFocusRef = useRef<{ index: number; trigger: HTMLElement } | null>(null);
  const rememberFocus = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    const menu = event.currentTarget.closest<HTMLElement>('[role="menu"]');
    if (!menu) return;
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    pendingFocusRef.current = {
      index: items.indexOf(event.currentTarget),
      trigger: event.currentTarget,
    };
  };
  useLayoutEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending || pending.trigger.isConnected) return;
    pendingFocusRef.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const menu = anchorRef.current?.closest<HTMLElement>('[role="menu"]');
    const items = menu
      ? [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')]
      : [];
    items[Math.min(Math.max(pending.index, 0), items.length - 1)]?.focus();
  });
  return (
    <>
      <span ref={anchorRef} hidden />
      {runs && runItems.length > 0 && (
        <div className="header-run-list" role="group" aria-label="Running">
          <div className="header-popover-title">Running</div>
          {runItems.map((item) => (
            <RunRow
              key={item.id}
              run={item}
              runs={runs}
              onDone={onDone}
              onBeforeRowAction={rememberFocus}
            />
          ))}
        </div>
      )}
      {actions.length > 0 && runItems.length > 0 && (
        <div role="separator" className="header-menu-separator" />
      )}
      {actions.map((action) => (
        <button
          type="button"
          role="menuitem"
          key={action.id}
          className={itemClass}
          title={action.command}
          onClick={() => onRun(action)}
        >
          <Play size={13} aria-hidden="true" />
          <span><strong>{action.label}</strong><small>{action.command}</small></span>
        </button>
      ))}
      {onAdd && (
        <button
          type="button"
          role="menuitem"
          className={itemClass}
          onClick={onAdd}
        >
          <Plus size={13} aria-hidden="true" />
          <span><strong>Add action…</strong></span>
        </button>
      )}
    </>
  );
}

export type OpenInTarget = "folder" | "file-manager" | "files";

const openInIcons = {
  folder: FolderOpen,
  "file-manager": FolderSearch,
  files: PanelLeft,
} as const;

export function OpenInMenuItems({
  presentation,
  labels,
  preferred,
  filesAvailable,
  checkoutPath,
  onOpen,
}: {
  presentation: HeaderMenuPresentation;
  labels: Record<OpenInTarget, string>;
  preferred: OpenInTarget;
  filesAvailable: boolean;
  checkoutPath: string | null;
  onOpen: (target: OpenInTarget) => void;
}): React.JSX.Element {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  const itemClass = presentation === "menu" ? "header-menu-item" : "header-action-item";
  const copyPath = async (): Promise<void> => {
    if (!checkoutPath) return;
    try {
      if (!await window.inertia.copyText(checkoutPath)) throw new Error("Clipboard unavailable");
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };
  return (
    <>
      {(Object.keys(labels) as OpenInTarget[]).map((target) => {
        const Icon = openInIcons[target];
        const disabled = target === "files" && !filesAvailable;
        return (
          <button
            type="button"
            role="menuitem"
            key={target}
            className={itemClass}
            aria-disabled={disabled || undefined}
            title={disabled ? "Files become available after the first message creates this isolated worktree." : undefined}
            onClick={() => onOpen(target)}
          >
            <Icon size={13} aria-hidden="true" />
            <span><strong>{labels[target]}</strong></span>
            {target === preferred && <small className="header-menu-hint">Default</small>}
          </button>
        );
      })}
      <div role="separator" className="header-menu-separator" />
      <button
        type="button"
        role="menuitem"
        className={itemClass}
        aria-disabled={!checkoutPath || undefined}
        title={checkoutPath ?? undefined}
        onClick={() => void copyPath()}
      >
        <Copy size={13} aria-hidden="true" />
        <span>
          <strong>{copyState === "copied" ? "Path copied" : "Copy path"}</strong>
          {checkoutPath && <small>{checkoutPath}</small>}
        </span>
      </button>
      {copyState === "failed" && (
        <p className="header-menu-error" role="alert">Could not copy. Please try again.</p>
      )}
    </>
  );
}
