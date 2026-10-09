import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

const DRAG_THRESHOLD = 4;
const EDGE_MARGIN = 24;

export interface TabRowEdges {
  start: boolean;
  end: boolean;
}

interface DragState<K extends string> {
  key: K;
  pointerId: number;
  startX: number;
  started: boolean;
  midpoints: number[];
  toIndex: number;
}

export function moveKey<K extends string>(keys: readonly K[], key: K, toIndex: number): K[] {
  const rest = keys.filter((entry) => entry !== key);
  if (rest.length === keys.length) return [...keys];
  rest.splice(Math.min(Math.max(toIndex, 0), rest.length), 0, key);
  return rest;
}

function tabElements(list: HTMLElement): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>(":scope > [data-tab-key]"));
}

export function usePanelTabRow<K extends string>({
  keys,
  activeKey,
  onMove,
}: {
  keys: readonly K[];
  activeKey: K | null;
  onMove?: (key: K, toIndex: number) => void;
}) {
  const [list, setList] = useState<HTMLElement | null>(null);
  const [edges, setEdges] = useState<TabRowEdges>({ start: false, end: false });
  const [drag, setDrag] = useState<{ key: K; toIndex: number } | null>(null);
  const dragRef = useRef<DragState<K> | null>(null);

  const measure = useCallback(() => {
    if (!list) return;
    const start = list.scrollLeft > 1;
    const end = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
    setEdges((current) => (
      current.start === start && current.end === end ? current : { start, end }
    ));
  }, [list]);

  const revealActive = useCallback(() => {
    if (!list) return;
    const tab = activeKey
      ? tabElements(list).find((element) => element.dataset.tabKey === activeKey)
      : null;
    if (tab) {
      const bounds = list.getBoundingClientRect();
      const box = tab.getBoundingClientRect();
      if (box.left < bounds.left + EDGE_MARGIN) {
        list.scrollLeft = Math.max(0, list.scrollLeft - (bounds.left + EDGE_MARGIN - box.left));
      } else if (box.right > bounds.right - EDGE_MARGIN) {
        list.scrollLeft += box.right - bounds.right + EDGE_MARGIN;
      }
    }
    measure();
  }, [activeKey, list, measure]);

  useLayoutEffect(revealActive, [keys.length, revealActive]);

  useEffect(() => {
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(revealActive);
    observer.observe(list);
    return () => observer.disconnect();
  }, [list, revealActive]);

  const endDrag = useCallback((commit: boolean) => {
    const current = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!current?.started) return;
    if (list?.hasPointerCapture?.(current.pointerId)) list.releasePointerCapture(current.pointerId);
    if (commit && current.toIndex !== keys.indexOf(current.key)) onMove?.(current.key, current.toIndex);
  }, [keys, list, onMove]);

  useEffect(() => {
    if (!drag) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      endDrag(false);
    };
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, [drag, endDrag]);

  const startPointer = (event: ReactPointerEvent<HTMLElement>, key: K): void => {
    if (!onMove || event.button !== 0 || keys.length < 2) return;
    if (event.target instanceof Element && event.target.closest("[data-tab-close]")) return;
    dragRef.current = {
      key,
      pointerId: event.pointerId,
      startX: event.clientX,
      started: false,
      midpoints: [],
      toIndex: keys.indexOf(key),
    };
  };

  const listHandlers = {
    ref: setList,
    onScroll: measure,
    onWheel: (event: ReactWheelEvent<HTMLElement>) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.currentTarget.scrollLeft += event.deltaY;
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const current = dragRef.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (!current.started) {
        if (Math.abs(event.clientX - current.startX) < DRAG_THRESHOLD) return;
        current.started = true;
        current.midpoints = tabElements(event.currentTarget)
          .filter((element) => element.dataset.tabKey !== current.key)
          .map((element) => {
            const box = element.getBoundingClientRect();
            return box.left + box.width / 2;
          });
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }
      const toIndex = current.midpoints.filter((midpoint) => midpoint < event.clientX).length;
      current.toIndex = toIndex;
      setDrag((previous) => (
        previous?.key === current.key && previous.toIndex === toIndex
          ? previous
          : { key: current.key, toIndex }
      ));
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      if (dragRef.current?.pointerId === event.pointerId) endDrag(true);
    },
    onPointerCancel: () => endDrag(false),
    onLostPointerCapture: () => {
      if (dragRef.current?.started) endDrag(false);
    },
  };

  return {
    edges,
    order: drag ? moveKey(keys, drag.key, drag.toIndex) : [...keys],
    draggingKey: drag?.key ?? null,
    listHandlers,
    startPointer,
  };
}
