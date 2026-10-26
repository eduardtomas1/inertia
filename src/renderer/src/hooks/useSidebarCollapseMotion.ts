import { useEffect, useState, type RefObject } from "react";

export type SidebarCollapseMotion = "collapsing" | "expanding" | null;

export const SIDEBAR_COLLAPSE_MOTION_LIMIT_MS = 450;

function collapseMotionAllowed(): boolean {
  if (typeof window.matchMedia !== "function") return false;
  return document.visibilityState === "visible"
    && window.matchMedia("(prefers-reduced-motion: no-preference)").matches
    && window.matchMedia("(min-width: 761px)").matches;
}

export function useSidebarCollapseMotion(
  collapsed: boolean,
  mobileNavigation: boolean,
  shellRef: RefObject<HTMLElement | null>,
): SidebarCollapseMotion {
  const [settledCollapsed, setSettledCollapsed] = useState(collapsed);
  const [motion, setMotion] = useState<SidebarCollapseMotion>(null);
  if (settledCollapsed !== collapsed) {
    setSettledCollapsed(collapsed);
    setMotion(!mobileNavigation && collapseMotionAllowed() ? (collapsed ? "collapsing" : "expanding") : null);
  }
  if (motion && mobileNavigation) setMotion(null);

  useEffect(() => {
    if (!motion) return;
    const shell = shellRef.current;
    const finish = (): void => setMotion(null);
    const onTransitionEnd = (event: TransitionEvent): void => {
      if (event.target === shell && event.propertyName === "grid-template-columns") finish();
    };
    shell?.addEventListener("transitionend", onTransitionEnd);
    const limit = window.setTimeout(finish, SIDEBAR_COLLAPSE_MOTION_LIMIT_MS);
    return () => {
      shell?.removeEventListener("transitionend", onTransitionEnd);
      window.clearTimeout(limit);
    };
  }, [motion, shellRef]);

  return motion;
}
