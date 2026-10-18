import { useCallback, useLayoutEffect, useReducer, useRef } from "react";
import { flushSync } from "react-dom";
import { defaultRangeExtractor, useVirtualizer, type Range, type ReactVirtualizer } from "@tanstack/react-virtual";

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
  options: Omit<Parameters<typeof useVirtualizer<TScrollElement, TItemElement>>[0], "onChange" | "useFlushSync" | "rangeExtractor">,
): readonly [ReactVirtualizer<TScrollElement, TItemElement>, (node: TItemElement | null) => void] {
  const [, renderSynchronously] = useReducer((count: number) => count + 1, 0);
  const rendered = useRef<RenderedVirtualWindow | null>(null);
  const measuring = useRef(false);
  const retainedIndex = useRef<number | null>(null);
  const scrollElement = useRef(options.getScrollElement);
  scrollElement.current = options.getScrollElement;
  const rangeExtractor = useCallback((range: Range): number[] => {
    const indexes = defaultRangeExtractor(range);
    const row = document.activeElement?.closest<HTMLElement>("[data-index]");
    const index = Number(row?.dataset.index);
    retainedIndex.current = row && scrollElement.current()?.contains(row)
      && Number.isInteger(index) && index < range.count && !indexes.includes(index)
      ? index : null;
    return retainedIndex.current === null
      ? indexes
      : [...indexes, retainedIndex.current].sort((left, right) => left - right);
  }, []);
  const virtualizer = useVirtualizer<TScrollElement, TItemElement>({
    ...options,
    rangeExtractor,
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
    const items = virtualizer.getVirtualItems().filter(({ index }) => index !== retainedIndex.current);
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
