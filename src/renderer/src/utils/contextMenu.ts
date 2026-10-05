import type { KeyboardEvent, MouseEvent } from "react";
import type {
  ContextMenuAction,
  ContextMenuAnchor,
  ContextMenuRequest,
} from "@shared/context-menu";
import { UUID_PATTERN } from "@shared/desktop";
import { writeClipboardText } from "./clipboard";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type ContextMenuDescriptor = DistributiveOmit<ContextMenuRequest, "anchor">;

export interface ContextMenuHandlers<Surface extends HTMLElement> {
  onContextMenu: (event: MouseEvent<Surface>) => void;
  onKeyDown: (event: KeyboardEvent<Surface>) => void;
}

const NATIVE_MENU_TARGETS = "a[href], img, input, textarea, select, [contenteditable=''], [contenteditable='true']";

export function isContextMenuKey(event: Pick<KeyboardEvent, "key" | "shiftKey">): boolean {
  return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}

export function isContextMenuId(value: string | undefined): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function hasNativeMenuTarget(target: EventTarget | null, surface: Element): boolean {
  if (!(target instanceof Element)) return false;
  const native = target.closest(NATIVE_MENU_TARGETS);
  return native !== null && surface.contains(native);
}

export function selectionInside(element: Element): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  return element.contains(selection.anchorNode) && element.contains(selection.focusNode);
}

function clampedAnchor(x: number, y: number): ContextMenuAnchor {
  return {
    x: Math.min(Math.max(0, x), Math.max(0, window.innerWidth)),
    y: Math.min(Math.max(0, y), Math.max(0, window.innerHeight)),
  };
}

export function showContextMenu(
  descriptor: ContextMenuDescriptor,
  anchor: ContextMenuAnchor,
  perform: (action: ContextMenuAction) => void,
): void {
  const bridge = window.inertia;
  if (!bridge?.showContextMenu) return;
  void bridge.showContextMenu({ ...descriptor, anchor } as ContextMenuRequest)
    .then((action) => {
      if (action) perform(action);
    })
    .catch(() => undefined);
}

export function contextMenuHandlers<Surface extends HTMLElement>(
  describe: (target: EventTarget | null, surface: Surface) => ContextMenuDescriptor | null,
  perform: (action: ContextMenuAction, surface: Surface) => void,
): ContextMenuHandlers<Surface> {
  return {
    onContextMenu: (event) => {
      if (event.nativeEvent.defaultPrevented) return;
      const surface = event.currentTarget;
      const descriptor = describe(event.target, surface);
      if (!descriptor) return;
      event.preventDefault();
      showContextMenu(
        descriptor,
        clampedAnchor(event.clientX, event.clientY),
        (action) => perform(action, surface),
      );
    },
    onKeyDown: (event) => {
      if (!isContextMenuKey(event) || event.target !== event.currentTarget) return;
      const surface = event.currentTarget;
      const descriptor = describe(surface, surface);
      if (!descriptor) return;
      event.preventDefault();
      event.stopPropagation();
      const bounds = surface.getBoundingClientRect();
      showContextMenu(
        descriptor,
        clampedAnchor(bounds.left, bounds.bottom),
        (action) => perform(action, surface),
      );
    },
  };
}

export function absoluteProjectPath(root: string, relativePath: string): string {
  const windows = /^[A-Za-z]:[\\/]/u.test(root) || root.startsWith("\\\\");
  const separator = windows ? "\\" : "/";
  const base = root.replace(/[\\/]+$/u, "");
  const relative = windows ? relativePath.replaceAll("/", "\\") : relativePath;
  return `${base}${separator}${relative}`;
}

export interface ProjectPathMenuTarget {
  projectId: string;
  conversationId?: string;
  projectRoot: string;
  relativePath: string;
  open?: () => void;
}

function performProjectPathAction(
  action: ContextMenuAction,
  target: ProjectPathMenuTarget,
): void {
  const request = {
    projectId: target.projectId,
    ...(target.conversationId ? { conversationId: target.conversationId } : {}),
    relativePath: target.relativePath,
  };
  if (action === "open") {
    if (target.open) target.open();
    else void window.inertia.openProjectPath({ ...request, action: "open-externally" }).catch(() => undefined);
  } else if (action === "reveal") {
    void window.inertia.openProjectPath({ ...request, action: "reveal" }).catch(() => undefined);
  } else if (action === "copy-path") {
    void writeClipboardText(absoluteProjectPath(target.projectRoot, target.relativePath));
  } else if (action === "copy-relative-path") {
    void writeClipboardText(target.relativePath);
  }
}

export function projectPathContextMenu<Surface extends HTMLElement>(
  kind: "project-link" | "diff-file" | "file",
  target: ProjectPathMenuTarget & { directory?: boolean },
): ContextMenuHandlers<Surface> | undefined {
  if (!isContextMenuId(target.projectId)) return undefined;
  const conversation = isContextMenuId(target.conversationId)
    ? { conversationId: target.conversationId }
    : {};
  const identity = { projectId: target.projectId, ...conversation, relativePath: target.relativePath };
  return contextMenuHandlers<Surface>(
    () => kind === "file"
      ? { kind, ...identity, directory: target.directory === true }
      : { kind, ...identity },
    (action) => performProjectPathAction(action, target),
  );
}
