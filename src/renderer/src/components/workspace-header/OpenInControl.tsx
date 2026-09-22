import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from "react";
import {
  ChevronDown,
  FolderOpen,
  FolderSearch,
  PanelLeft,
  SquareArrowOutUpRight,
} from "lucide-react";

import { useDismissibleMenu } from "../../hooks/useDismissibleMenu";
import { layoutStorage } from "../../utils/layoutStorage";
import { navigateMenuItems } from "../../utils/menuKeyboard";
import type { OpenInTarget } from "./HeaderActionMenus";
import { HeaderMenuGroup } from "./HeaderMenuGroup";
import { FocusFirstMenuItem } from "./FocusFirstMenuItem";
import {
  loadHeaderActionMenus,
  type HeaderControlPresentation,
} from "./ProjectActionsControl";
import { useFocusOutDismiss } from "./useFocusOutDismiss";

export type { OpenInTarget } from "./HeaderActionMenus";

const OpenInMenuItems = lazy(async () => ({
  default: (await loadHeaderActionMenus()).OpenInMenuItems,
}));

export const OPEN_IN_PREFERENCE_KEY = "inertia:header:open-in:v1";

export function fileManagerLabel(platform: string | undefined): string {
  if (platform === "darwin") return "Finder";
  if (platform === "win32") return "Explorer";
  return "File manager";
}

export function resolveOpenInTarget(value: string | null): OpenInTarget {
  return value === "file-manager" || value === "files" ? value : "folder";
}

interface OpenInControlProps {
  presentation: HeaderControlPresentation;
  checkoutName: string;
  checkoutPath: string | null;
  filesAvailable: boolean;
  onOpenFolder: () => void;
  onRevealFolder: () => void;
  onOpenFiles: () => void;
  onRequestMenuClose?: () => void;
}

const targetIcons = {
  folder: FolderOpen,
  "file-manager": FolderSearch,
  files: PanelLeft,
} as const;

export function OpenInControl({
  presentation,
  checkoutName,
  checkoutPath,
  filesAvailable,
  onOpenFolder,
  onRevealFolder,
  onOpenFiles,
  onRequestMenuClose,
}: OpenInControlProps): React.JSX.Element {
  const menuId = useId();
  const [preferred, setPreferred] = useState<OpenInTarget>(() =>
    resolveOpenInTarget(layoutStorage.getItem(OPEN_IN_PREFERENCE_KEY)));
  const { menu, toggleMenu, dismissMenu, setMenuTrigger, setMenuPopover } =
    useDismissibleMenu<"open">();
  const anchorRef = useRef<HTMLDivElement>(null);
  const dismissOnFocusOut = useCallback(() => dismissMenu("context-change"), [dismissMenu]);
  useFocusOutDismiss(anchorRef, menu !== null && presentation === "toolbar", dismissOnFocusOut);
  useEffect(() => {
    dismissMenu("context-change");
  }, [dismissMenu, presentation]);
  const platform = window.inertia?.getPlatform?.();
  const labels: Record<OpenInTarget, string> = {
    folder: "Folder",
    "file-manager": fileManagerLabel(platform),
    files: "Files in Inertia",
  };
  const effectivePreferred = preferred === "files" && !filesAvailable ? "folder" : preferred;
  const PrimaryIcon = targetIcons[effectivePreferred];
  const open = (target: OpenInTarget): void => {
    if (target === "files" && !filesAvailable) return;
    layoutStorage.setItem(OPEN_IN_PREFERENCE_KEY, target);
    setPreferred(target);
    if (menu) dismissMenu("selection");
    onRequestMenuClose?.();
    if (target === "folder") onOpenFolder();
    else if (target === "file-manager") onRevealFolder();
    else onOpenFiles();
  };
  const renderItems = (focusFirst = false): React.JSX.Element => (
    <Suspense fallback={<p className="header-menu-hint-text" role="status">Loading…</p>}>
      <OpenInMenuItems
        presentation={presentation}
        labels={labels}
        preferred={effectivePreferred}
        filesAvailable={filesAvailable}
        checkoutPath={checkoutPath}
        onOpen={open}
      />
      {focusFirst && <FocusFirstMenuItem menuId={menuId} />}
    </Suspense>
  );

  if (presentation === "menu") {
    return (
      <>
        <button
          type="button"
          role="menuitem"
          className="header-menu-item"
          onClick={() => open(effectivePreferred)}
        >
          <PrimaryIcon size={14} aria-hidden="true" />
          <span>Open in {labels[effectivePreferred]}</span>
        </button>
        <HeaderMenuGroup label="Open in…" icon={<SquareArrowOutUpRight size={14} aria-hidden="true" />}>
          {renderItems()}
        </HeaderMenuGroup>
      </>
    );
  }

  return (
    <div ref={anchorRef} className="header-split-anchor" data-header-menu="open">
      <div className="header-split" role="group" aria-label="Open checkout">
        <button
          type="button"
          className="header-split-primary"
          aria-label={`Open ${checkoutName} in ${labels[effectivePreferred]}`}
          title={`Open ${checkoutName} in ${labels[effectivePreferred]}`}
          onClick={() => open(effectivePreferred)}
        >
          <PrimaryIcon size={14} aria-hidden="true" />
          <span className="header-split-label">Open</span>
        </button>
        <button
          ref={(node) => setMenuTrigger("open", node)}
          type="button"
          className="header-split-chevron"
          aria-label="Choose where to open"
          title="Choose where to open"
          aria-haspopup="menu"
          aria-expanded={menu === "open"}
          aria-controls={menuId}
          onFocus={() => void loadHeaderActionMenus()}
          onPointerEnter={() => void loadHeaderActionMenus()}
          onClick={() => toggleMenu("open")}
        >
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </div>
      {menu === "open" && (
        <div
          ref={(node) => setMenuPopover("open", node)}
          id={menuId}
          className="header-popover header-actions-popover"
          role="menu"
          aria-label="Open checkout"
          onKeyDown={(event) => navigateMenuItems(event, '[role="menuitem"]')}
        >
          {renderItems(true)}
        </div>
      )}
    </div>
  );
}
