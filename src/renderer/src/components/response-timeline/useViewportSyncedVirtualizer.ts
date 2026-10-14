import { useCallback, useLayoutEffect, useReducer, useRef } from "react";
import { flushSync } from "react-dom";
import { useVirtualizer, type ReactVirtualizer } from "@tanstack/react-virtual";

export interface RenderedVirtualWindow {
  start: number;
  end: number;
  totalSize: number;
}

export function virtualWindowCoversViewport(
  rendered: RenderedVirtualWindow | null,
  scrollOffset: number | null,
  viewportHeight: number | undefined,
  totalSize: number,
): boolean {
  if (!rendered || scrollOffset === null || viewportHeight === undefined) return false;
  return rendered.totalSize === totalSize
    && rendered.start <= scrollOffset
    && scrollOffset + viewportHeight <= rendered.end;
}

export function useViewportSyncedVirtualizer<
  TScrollElement extends Element,
  TItemElement extends Element,
>(
  options: Omit<Parameters<typeof useVirtualizer<TScrollElement, TItemElement>>[0], "onChange" | "useFlushSync">,
): readonly [ReactVirtualizer<TScrollElement, TItemElement>, (node: TItemElement | null) => void] {
  const [, renderSynchronously] = useReducer((count: number) => count + 1, 0);
  const rendered = useRef<RenderedVirtualWindow | null>(null);
  const measuring = useRef(false);
  const virtualizer = useVirtualizer<TScrollElement, TItemElement>({
    ...options,
    useFlushSync: false,
    onChange: (instance, sync) => {
      if (!sync || measuring.current) return;
      if (virtualWindowCoversViewport(
        rendered.current,
        instance.scrollOffset,
        instance.scrollRect?.height,
        instance.getTotalSize(),
      )) return;
      flushSync(renderSynchronously);
    },
  });
  useLayoutEffect(() => {
    const items = virtualizer.getVirtualItems();
    const first = items[0];
    const last = items.at(-1);
    rendered.current = first && last
      ? { start: first.start, end: last.end, totalSize: virtualizer.getTotalSize() }
      : null;
  });
  const measureElement = useCallback((node: TItemElement | null): void => {
    measuring.current = true;
    try {
      virtualizer.measureElement(node);
    } finally {
      measuring.current = false;
    }
  }, [virtualizer]);
  return [virtualizer, measureElement] as const;
}
