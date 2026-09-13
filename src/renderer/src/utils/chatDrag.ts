import type { PointerEvent as ReactPointerEvent } from "react";

import type { SplitDropRect, SplitDropZone } from "./splitConversation";

export interface ChatDragSource {
  conversationId: string;
  title: string;
}

export interface ChatDragTarget extends SplitDropRect {
  zone: SplitDropZone;
}

export interface ChatDrag extends ChatDragSource {
  x: number;
  y: number;
  target: ChatDragTarget | null;
}

export interface ChatDropTarget {
  resolve: (conversationId: string, x: number, y: number) => ChatDragTarget | null;
  drop: (conversationId: string, zone: SplitDropZone) => void;
}

const DRAG_THRESHOLD_PX = 6;
const listeners = new Set<() => void>();
let current: ChatDrag | null = null;
let dropTarget: ChatDropTarget | null = null;

function publish(next: ChatDrag | null): void {
  current = next;
  for (const listener of listeners) listener();
}

export function subscribeChatDrag(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function currentChatDrag(): ChatDrag | null {
  return current;
}

export function registerChatDropTarget(target: ChatDropTarget): () => void {
  dropTarget = target;
  return () => {
    if (dropTarget === target) dropTarget = null;
  };
}

export function startChatDrag(
  event: ReactPointerEvent<HTMLElement>,
  source: ChatDragSource,
  onStart?: () => void,
): void {
  if (event.button !== 0 || current) return;
  const { pointerId, clientX: startX, clientY: startY } = event;
  const element = event.currentTarget;
  let dragging = false;

  const move = (moveEvent: PointerEvent): void => {
    if (moveEvent.pointerId !== pointerId) return;
    if ((moveEvent.buttons & 1) === 0) {
      finish(false);
      return;
    }
    if (!dragging) {
      if (
        Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY)
        < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      dragging = true;
      if (element.isConnected) element.setPointerCapture?.(pointerId);
      document.documentElement.dataset.chatDrag = "active";
      onStart?.();
    }
    publish({
      ...source,
      x: moveEvent.clientX,
      y: moveEvent.clientY,
      target: dropTarget?.resolve(
        source.conversationId,
        moveEvent.clientX,
        moveEvent.clientY,
      ) ?? null,
    });
  };
  const release = (upEvent: PointerEvent): void => {
    if (upEvent.pointerId === pointerId) finish(true);
  };
  const cancel = (): void => finish(false);
  const cancelOnEscape = (keyEvent: KeyboardEvent): void => {
    if (keyEvent.key !== "Escape" || !dragging) return;
    keyEvent.preventDefault();
    keyEvent.stopPropagation();
    finish(false);
  };
  const swallowClick = (clickEvent: MouseEvent): void => {
    clickEvent.preventDefault();
    clickEvent.stopPropagation();
  };

  function finish(drop: boolean): void {
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("pointerup", release, true);
    document.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", cancelOnEscape, true);
    window.removeEventListener("blur", cancel);
    if (!dragging) return;
    const drag = current;
    delete document.documentElement.dataset.chatDrag;
    publish(null);
    window.addEventListener("click", swallowClick, { capture: true, once: true });
    window.setTimeout(() => {
      window.removeEventListener("click", swallowClick, true);
    }, 0);
    if (drop && drag?.target) dropTarget?.drop(drag.conversationId, drag.target.zone);
  }

  document.addEventListener("pointermove", move, true);
  document.addEventListener("pointerup", release, true);
  document.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", cancelOnEscape, true);
  window.addEventListener("blur", cancel);
}
