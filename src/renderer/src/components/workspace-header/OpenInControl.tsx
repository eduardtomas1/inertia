import { lazy, Suspense, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Code2,
  ExternalLink,
  Folder,
  FolderOpen,
} from "lucide-react";
import {
  editorLabel,
  isEditorId,
  type DetectedEditor,
  type EditorId,
  type PreferredEditor,
} from "@shared/editor-ids";

import { useDismissibleMenu } from "../../hooks/useDismissibleMenu";
import { layoutStorage } from "../../utils/layoutStorage";
import { navigateMenuItems } from "../../utils/menuKeyboard";
import type { OpenInTarget, OpenInTargetOption } from "./HeaderActionMenus";
import { HeaderMenuGroup } from "./HeaderMenuGroup";
import { FocusFirstMenuItem } from "./FocusFirstMenuItem";
import {
  loadHeaderActionMenus,
  type HeaderControlPresentation,
} from "./ProjectActionsControl";
import { useFocusOutDismiss } from "./useFocusOutDismiss";
import { TooltipButton } from "../TooltipButton";

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

function editorIdFromTarget(target: OpenInTarget): EditorId | null {
  if (!target.startsWith("editor:")) return null;
  const candidate = target.slice("editor:".length);
  return isEditorId(candidate) ? candidate : null;
}

export function resolveOpenInTarget(value: string | null): OpenInTarget | null {
  if (value === "folder" || value === "file-manager" || value === "files") return value;
  if (value && value.startsWith("editor:") && isEditorId(value.slice("editor:".length))) {
    return value as OpenInTarget;
  }
  return null;
}

interface OpenInControlProps {
  presentation: HeaderControlPresentation;
  checkoutName: string;
  checkoutPath: string | null;
  filesAvailable: boolean;
  preferredEditor?: PreferredEditor;
  detectedEditors?: readonly DetectedEditor[];
  onOpenFolder: () => void;
  onRevealFolder: () => void;
  onOpenFiles: () => void;
  onOpenInEditor?: (editor: EditorId) => void;
  onRequestMenuClose?: () => void;
}

function targetIcon(target: OpenInTarget) {
  if (target.startsWith("editor:")) return Code2;
  if (target === "file-manager") return FolderOpen;
  if (target === "files") return Folder;
  return ExternalLink;
}

export function OpenInControl({
  presentation,
  checkoutName,
  checkoutPath,
  filesAvailable,
  preferredEditor = "system",
  detectedEditors = [],
  onOpenFolder,
  onRevealFolder,
  onOpenFiles,
  onOpenInEditor,
  onRequestMenuClose,
}: OpenInControlProps): React.JSX.Element {
  const menuId = useId();
  const [storedPreferred, setStoredPreferred] = useState<OpenInTarget | null>(() =>
    resolveOpenInTarget(layoutStorage.getItem(OPEN_IN_PREFERENCE_KEY)));
  const { menu, toggleMenu, dismissMenu, setMenuTrigger, setMenuPopover } =
    useDismissibleMenu<"open">();
  const anchorRef = useRef<HTMLDivElement>(null);
  const dismissOnFocusOut = useCallback(() => dismissMenu("context-change"), [dismissMenu]);
  useFocusOutDismiss(anchorRef, menu !== null && presentation === "toolbar", dismissOnFocusOut);
  useLayoutEffect(() => {
    dismissMenu("context-change");
  }, [dismissMenu, presentation]);
  const platform = window.inertia?.getPlatform?.();
  const options = useMemo<readonly OpenInTargetOption[]>(() => {
    const editorOptions: OpenInTargetOption[] = [];
    if (onOpenInEditor) {
      const seen = new Set<EditorId>();
      if (isEditorId(preferredEditor)) {
        seen.add(preferredEditor);
        editorOptions.push({ target: `editor:${preferredEditor}`, label: editorLabel(preferredEditor) });
      }
      for (const editor of detectedEditors) {
        if (seen.has(editor.id)) continue;
        seen.add(editor.id);
        editorOptions.push({ target: `editor:${editor.id}`, label: editor.label });
      }
    }
    return [
      ...editorOptions,
      { target: "folder", label: "Folder" },
      { target: "file-manager", label: fileManagerLabel(platform) },
      { target: "files", label: "Files in Inertia" },
    ];
  }, [detectedEditors, onOpenInEditor, platform, preferredEditor]);

  const askEditorOnPrimary = preferredEditor === "ask"
    && storedPreferred === null
    && Boolean(onOpenInEditor)
    && detectedEditors.length > 0;

  const fallbackTarget: OpenInTarget = onOpenInEditor && isEditorId(preferredEditor)
    ? `editor:${preferredEditor}`
    : "folder";

  const candidateTarget = storedPreferred ?? fallbackTarget;
  const effectivePreferred: OpenInTarget = candidateTarget === "files" && !filesAvailable
    ? "folder"
    : options.some((option) => option.target === candidateTarget)
      ? candidateTarget
      : fallbackTarget;

  const primaryLabel = askEditorOnPrimary
    ? "editor"
    : options.find((option) => option.target === effectivePreferred)?.label ?? "Folder";
  const PrimaryIcon = askEditorOnPrimary ? Code2 : targetIcon(effectivePreferred);

  const open = (target: OpenInTarget): void => {
    if (target === "files" && !filesAvailable) return;
    layoutStorage.setItem(OPEN_IN_PREFERENCE_KEY, target);
    setStoredPreferred(target);
    if (menu) dismissMenu("selection");
    onRequestMenuClose?.();
    const editorId = editorIdFromTarget(target);
    if (editorId && onOpenInEditor) {
      onOpenInEditor(editorId);
    } else if (target === "folder") {
      onOpenFolder();
    } else if (target === "file-manager") {
      onRevealFolder();
    } else {
      onOpenFiles();
    }
  };
  const renderItems = (focusFirst = false): React.JSX.Element => (
    <Suspense fallback={<p className="header-menu-hint-text" role="status">Loading…</p>}>
      <OpenInMenuItems
        presentation={presentation}
        options={options}
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
          <span>Open in {primaryLabel}</span>
        </button>
        <HeaderMenuGroup label="Open in…" icon={<ExternalLink size={14} aria-hidden="true" />}>
          {renderItems()}
        </HeaderMenuGroup>
      </>
    );
  }

  return (
    <div ref={anchorRef} className="header-split-anchor" data-header-menu="open">
      <div className="header-split" role="group" aria-label="Open checkout">
        <TooltipButton
          type="button"
          className="header-split-primary"
          aria-label={`Open ${checkoutName} in ${primaryLabel}`}
          tooltip={`Open ${checkoutName} in ${primaryLabel}`}
          onClick={() => {
            if (askEditorOnPrimary) {
              if (detectedEditors.length === 1) {
                open(`editor:${detectedEditors[0]!.id}`);
              } else {
                toggleMenu("open");
              }
            } else {
              open(effectivePreferred);
            }
          }}
        >
          <PrimaryIcon size={16} aria-hidden="true" />
          <span className="header-split-label">Open</span>
        </TooltipButton>
        <TooltipButton
          ref={(node) => setMenuTrigger("open", node)}
          type="button"
          className="header-split-chevron"
          aria-label="Choose where to open"
          tooltip="Choose where to open"
          aria-haspopup="menu"
          aria-expanded={menu === "open"}
          aria-controls={menuId}
          onFocus={() => void loadHeaderActionMenus()}
          onPointerEnter={() => void loadHeaderActionMenus()}
          onClick={() => toggleMenu("open")}
        >
          <ChevronDown size={14} aria-hidden="true" />
        </TooltipButton>
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
