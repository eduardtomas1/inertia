import { useEffect, useRef, type RefObject } from "react";

export interface NearTopHistoryControls {
  hasOlder: boolean;
  loading: boolean;
  error: string | null;
  online: boolean;
  loadOlder: () => void;
}

export function useOlderHistoryNearTop(
  scrollRef: RefObject<HTMLElement | null>,
  history: NearTopHistoryControls | undefined,
): void {
  const current = useRef(history);
  current.current = history;
  const enabled = Boolean(history?.hasOlder && history.online);
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || !enabled) return;
    let previousTop = scroll.scrollTop;
    const onScroll = (): void => {
      const top = scroll.scrollTop;
      const upward = top < previousTop;
      previousTop = top;
      const controls = current.current;
      if (!upward || top > scroll.clientHeight || !controls?.hasOlder || controls.loading || controls.error || !controls.online) return;
      controls.loadOlder();
    };
    scroll.addEventListener("scroll", onScroll, { passive: true });
    return () => scroll.removeEventListener("scroll", onScroll);
  }, [enabled, scrollRef]);
}
