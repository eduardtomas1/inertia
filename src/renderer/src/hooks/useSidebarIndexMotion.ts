import { useLayoutEffect, type RefObject } from "react";

interface SidebarIndexMotionOptions {
  containerRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  layoutKey: string;
}

let runtimePromise: Promise<typeof import("../utils/sidebarIndexMotionRuntime")> | null = null;

/** Loads the optional FLIP runtime only for users who allow index motion. */
export function useSidebarIndexMotion({
  containerRef,
  enabled,
  layoutKey,
}: SidebarIndexMotionOptions): void {
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!enabled) {
      void runtimePromise?.then(
        (runtime) => runtime.cancelSidebarIndexMotion(container),
        () => undefined,
      );
      return;
    }
    runtimePromise ??= import("../utils/sidebarIndexMotionRuntime");
    void runtimePromise.then((runtime) => {
      if (container.isConnected) runtime.updateSidebarIndexMotion(container);
    }, () => undefined);
  }, [containerRef, enabled, layoutKey]);
}
