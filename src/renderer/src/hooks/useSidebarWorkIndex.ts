import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { Conversation } from "@shared/contracts";

import type {
  SidebarWorkSection,
  SidebarWorkSectionId,
} from "../utils/sidebarModel";
import { useSidebarIndexMotion } from "./useSidebarIndexMotion";

const WORK_INDEX_VIRTUALIZATION_THRESHOLD = 60;
const WORK_INDEX_INITIAL_HEIGHT = 720;
const WORK_INDEX_OVERSCAN = 8;

export const COLLAPSIBLE_WORK_SECTIONS: ReadonlySet<SidebarWorkSectionId> = new Set([
  "earlier",
  "done",
  "snoozed",
]);

export type WorkIndexItem =
  | {
      id: `section:${SidebarWorkSectionId}`;
      kind: "section";
      section: SidebarWorkSection;
      expanded: boolean;
      disclosure: boolean;
    }
  | {
      id: `thread:${string}`;
      kind: "thread";
      conversation: Conversation;
      position: number;
      sectionId: SidebarWorkSectionId;
    }
  | {
      id: "show-more:done";
      kind: "show-more";
      remaining: number;
    };

interface SidebarWorkIndexOptions {
  activeConversationId: string | null;
  compact: boolean;
  doneVisible: number;
  expandedSections: ReadonlySet<SidebarWorkSectionId>;
  motionEnabled: boolean;
  navigationRef: RefObject<HTMLDivElement | null>;
  searchActive: boolean;
  sections: SidebarWorkSection[];
}

export function useSidebarWorkIndex({
  activeConversationId,
  compact,
  doneVisible,
  expandedSections,
  motionEnabled,
  navigationRef,
  searchActive,
  sections,
}: SidebarWorkIndexOptions) {
  const [keyboardTargetIndex, setKeyboardTargetIndex] = useState<number | null>(null);
  const [viewport, setViewport] = useState({
    height: WORK_INDEX_INITIAL_HEIGHT,
    start: 0,
  });
  const streamRef = useRef<HTMLDivElement>(null);
  const items = useMemo<WorkIndexItem[]>(() => {
    const next: WorkIndexItem[] = [];
    let threadPosition = 0;
    for (const section of sections) {
      if (section.threads.length === 0) continue;
      const collapsible = COLLAPSIBLE_WORK_SECTIONS.has(section.id);
      const disclosure = collapsible && !searchActive;
      const expanded = !collapsible
        || searchActive
        || expandedSections.has(section.id);
      next.push({
        id: `section:${section.id}`,
        kind: "section",
        section,
        expanded,
        disclosure,
      });
      if (!expanded) continue;
      const visibleThreads = section.id === "done"
        ? section.threads.slice(0, doneVisible)
        : section.threads;
      for (const { conversation } of visibleThreads) {
        threadPosition += 1;
        next.push({
          id: `thread:${conversation.id}`,
          kind: "thread",
          conversation,
          position: threadPosition,
          sectionId: section.id,
        });
      }
      if (section.id === "done" && visibleThreads.length < section.threads.length) {
        next.push({
          id: "show-more:done",
          kind: "show-more",
          remaining: section.threads.length - visibleThreads.length,
        });
      }
    }
    return next;
  }, [doneVisible, expandedSections, searchActive, sections]);
  const {
    focusOrder,
    indexByIdentity,
    navigationOrder,
    visibleConversationIds,
  } = useMemo(() => {
    const focus: string[] = [];
    const indexes = new Map<string, number>();
    const navigation: string[] = [];
    const visible = new Set<string>();
    items.forEach((item, index) => {
      indexes.set(item.id, index);
      if (item.kind === "thread") {
        visible.add(item.conversation.id);
        navigation.push(item.id);
        focus.push(item.id, `thread-actions:${item.conversation.id}`);
      } else if (item.kind !== "section" || item.disclosure) {
        navigation.push(item.id);
        focus.push(item.id);
      }
    });
    return {
      focusOrder: focus,
      indexByIdentity: indexes,
      navigationOrder: navigation,
      visibleConversationIds: visible,
    };
  }, [items]);
  const virtualized = items.length >= WORK_INDEX_VIRTUALIZATION_THRESHOLD;
  const estimateSize = useCallback((index: number): number => {
    const item = items[index];
    if (item?.kind === "section") return 26;
    if (item?.kind === "show-more") return 35;
    return compact ? 42 : 48;
  }, [compact, items]);
  const { offsets, totalSize } = useMemo(() => {
    const nextOffsets: number[] = [];
    let total = 0;
    for (let index = 0; index < items.length; index += 1) {
      nextOffsets.push(total);
      total += estimateSize(index);
    }
    return { offsets: nextOffsets, totalSize: total };
  }, [estimateSize, items.length]);
  const updateViewport = useCallback((): void => {
    const navigation = navigationRef.current;
    const stream = streamRef.current;
    if (!navigation || !stream) return;
    const next = {
      height: navigation.clientHeight || WORK_INDEX_INITIAL_HEIGHT,
      start: Math.max(0, navigation.scrollTop - stream.offsetTop),
    };
    setViewport((current) => (
      current.height === next.height && current.start === next.start
        ? current
        : next
    ));
  }, [navigationRef]);
  useLayoutEffect(() => {
    if (!virtualized) return;
    updateViewport();
    const navigation = navigationRef.current;
    if (!navigation) return;
    const observer = new ResizeObserver(updateViewport);
    observer.observe(navigation);
    return () => observer.disconnect();
  }, [compact, items.length, navigationRef, updateViewport, virtualized]);
  let renderedItems: Array<{
    index: number;
    item: WorkIndexItem;
    start: number | undefined;
  }>;
  if (!virtualized) {
    renderedItems = items.map((item, index) => ({ item, index, start: undefined }));
  } else {
    const viewportEnd = viewport.start + viewport.height;
    let first = 0;
    while (
      first < items.length
      && (offsets[first] ?? 0) + estimateSize(first) < viewport.start
    ) first += 1;
    let last = first;
    while (last < items.length && (offsets[last] ?? 0) <= viewportEnd) {
      last += 1;
    }
    const startIndex = Math.max(0, first - WORK_INDEX_OVERSCAN);
    const endIndex = Math.min(items.length, last + WORK_INDEX_OVERSCAN);
    renderedItems = items.slice(startIndex, endIndex).map((item, offset) => {
      const index = startIndex + offset;
      return { item, index, start: offsets[index] ?? 0 };
    });
  }
  const activeIndex = items.findIndex((item) => (
    item.kind === "thread" && item.conversation.id === activeConversationId
  ));
  const retainedTargetIndex = keyboardTargetIndex ?? activeIndex;
  if (
    virtualized
    && retainedTargetIndex >= 0
    && !renderedItems.some(({ index }) => index === retainedTargetIndex)
  ) {
    const item = items[retainedTargetIndex];
    if (item) {
      renderedItems = [
        ...renderedItems,
        { item, index: retainedTargetIndex, start: offsets[retainedTargetIndex] ?? 0 },
      ].sort((left, right) => left.index - right.index);
    }
  }
  const renderedConversationIds = new Set(renderedItems.flatMap(({ item }) => (
    item.kind === "thread" ? [item.conversation.id] : []
  )));
  useSidebarIndexMotion({
    containerRef: streamRef,
    enabled: motionEnabled,
    layoutKey: items,
  });
  const focusIdentity = useCallback((identity: string): boolean => {
    const itemIdentity = identity.startsWith("thread-actions:")
      ? `thread:${identity.slice("thread-actions:".length)}`
      : identity;
    const itemIndex = indexByIdentity.get(itemIdentity);
    if (itemIndex === undefined) return false;
    if (virtualized) {
      setKeyboardTargetIndex(itemIndex);
      const navigation = navigationRef.current;
      const stream = streamRef.current;
      if (navigation && stream) {
        const itemStart = offsets[itemIndex] ?? 0;
        const itemEnd = itemStart + estimateSize(itemIndex);
        const height = navigation.clientHeight || WORK_INDEX_INITIAL_HEIGHT;
        const currentStart = Math.max(0, navigation.scrollTop - stream.offsetTop);
        const nextStart = itemStart < currentStart
          ? itemStart
          : itemEnd > currentStart + height
            ? Math.max(0, itemEnd - height)
            : currentStart;
        navigation.scrollTop = stream.offsetTop + nextStart;
        setViewport({ height, start: nextStart });
      }
    }
    let attempts = 0;
    const focus = (): void => {
      const target = [...(
        navigationRef.current?.querySelectorAll<HTMLElement>("[data-work-focus-id]")
          ?? []
      )].find((candidate) => candidate.dataset.workFocusId === identity);
      if (target) {
        target.focus({ preventScroll: true });
        return;
      }
      if (attempts >= 8) return;
      attempts += 1;
      window.requestAnimationFrame(focus);
    };
    focus();
    return true;
  }, [estimateSize, indexByIdentity, navigationRef, offsets, virtualized]);

  return [
    focusIdentity,
    focusOrder,
    indexByIdentity,
    navigationOrder,
    renderedConversationIds,
    renderedItems,
    streamRef,
    totalSize,
    updateViewport,
    virtualized,
    visibleConversationIds,
  ] as const;
}
