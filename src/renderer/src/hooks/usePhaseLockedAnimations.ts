import { useCallback, useLayoutEffect, useRef } from "react";
import { useDocumentVisibility } from "./useDocumentPresence";

export function lockAnimationPhase(element: Element | null): void {
  if (!element || typeof element.getAnimations !== "function") return;
  for (const animation of element.getAnimations({ subtree: true })) {
    if (!("animationName" in animation)) continue;
    if (animation.playState !== "running" || animation.startTime === 0) continue;
    animation.startTime = 0;
  }
}

export function usePhaseLockedAnimations<T extends Element>(
  key?: unknown,
): (element: T | null) => void {
  const elementRef = useRef<T | null>(null);
  const visible = useDocumentVisibility();
  const attach = useCallback((element: T | null) => {
    elementRef.current = element;
    lockAnimationPhase(element);
  }, []);
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!visible || !element || typeof element.getAnimations !== "function") return undefined;
    lockAnimationPhase(element);
    if (typeof window.requestAnimationFrame !== "function") return undefined;
    const frame = window.requestAnimationFrame(() => lockAnimationPhase(elementRef.current));
    return () => window.cancelAnimationFrame(frame);
  }, [key, visible]);
  return attach;
}
