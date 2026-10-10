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
import "../sidebar-work-index.css";

const WORK_INDEX_VIRTUALIZATION_THRESHOLD = 60;
const WORK_INDEX_INITIAL_HEIGHT = 720;
const WORK_INDEX_OVERSCAN = 8;
export const WORK_ROW_HEIGHT = 32;
export const WORK_ROW_COMPACT_HEIGHT = 28;

export const COLLAPSIBLE_WORK_SECTIONS: ReadonlySet<SidebarWorkSectionId> = new Set([
  "earlier",
  "done",
  "snoozed",
  "no-project-done",
  "no-project-snoozed",
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
      id: `project:${string}`;
      kind: "project";
      projectId: string;
    }
  | {
      id: "show-more:done" | "show-more:no-project-done";
      kind: "show-more";
      sectionId: PaginatedWorkSectionId;
      remaining: number;
    };

export type PaginatedWorkSectionId = "done" | "no-project-done";

export function sidebarWorkLayoutKey(
  compact: boolean,
  items: readonly { id: string }[],
): string {
  return JSON.stringify([compact, items.map(({ id }) => id)]);
}

interface SidebarWorkIndexOptions {
  activeConversationId: string | null;
  compact: boolean;
  doneVisible: Readonly<Record<PaginatedWorkSectionId, number>>;
  enabled: boolean;
  expandedSections: ReadonlySet<SidebarWorkSectionId>;
  groupByProject: boolean;
  motionEnabled: boolean;
  navigationRef: RefObject<HTMLDivElement | null>;
  searchActive: boolean;
  sections: SidebarWorkSection[];
}

export function useSidebarWorkIndex({
  activeConversationId,
  compact,
  doneVisible,
  enabled,
  expandedSections,
  groupByProject,
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
    let span: Array<{ conversation: Conversation; sectionId: SidebarWorkSectionId }> = [];
    let previousProjectId: string | null = null;
    const flushSpan = (): void => {
      const grouped = groupByProject && span.length > 0 && !span[0]!.sectionId.startsWith("no-project");
      const projectOrder = new Map<string, number>();
      for (const { conversation } of span) {
        if (!projectOrder.has(conversation.projectId)) projectOrder.set(conversation.projectId, projectOrder.size);
      }
      const ordered = grouped
        ? span.map((entry, index) => ({ entry, index })).sort((left, right) => (
          projectOrder.get(left.entry.conversation.projectId)! - projectOrder.get(right.entry.conversation.projectId)!
          || left.index - right.index
        )).map(({ entry }) => entry)
        : span;
      for (const { conversation, sectionId } of ordered) {
        if (grouped && conversation.projectId !== previousProjectId) {
          previousProjectId = conversation.projectId;
          next.push({
            id: `project:${ordered[0]!.sectionId}:${conversation.projectId}`,
            kind: "project",
            projectId: conversation.projectId,
          });
        }
        threadPosition += 1;
        next.push({
          id: `thread:${conversation.id}`,
          kind: "thread",
          conversation,
          position: threadPosition,
          sectionId,
        });
      }
      span = [];
    };
    for (const section of sections) {
      if ((section.totalCount ?? section.threads.length) === 0) continue;
      const collapsible = COLLAPSIBLE_WORK_SECTIONS.has(section.id);
      const disclosure = collapsible && !searchActive;
      const expanded = !collapsible
        || searchActive
        || expandedSections.has(section.id);
      flushSpan();
      if (section.id !== "recent" && section.id !== "yesterday") {
        previousProjectId = null;
        next.push({
          id: `section:${section.id}`,
          kind: "section",
          section,
          expanded,
          disclosure,
        });
      }
      if (!expanded) continue;
      const pageId = section.id === "done" || section.id === "no-project-done" ? section.id : null;
      const visibleThreads = pageId
        ? section.threads.slice(0, doneVisible[pageId])
        : section.threads;
      for (const { conversation } of visibleThreads) {
        span.push({ conversation, sectionId: section.id });
      }
      if (pageId && visibleThreads.length < section.threads.length) {
        flushSpan();
        previousProjectId = null;
        next.push({
          id: `show-more:${pageId}`,
          kind: "show-more",
          sectionId: pageId,
          remaining: section.threads.length - visibleThreads.length,
        });
      }
    }
    flushSpan();
    return next;
  }, [doneVisible, expandedSections, groupByProject, searchActive, sections]);
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
        focus.push(item.id);
      } else if (item.kind === "show-more" || (item.kind === "section" && item.disclosure)) {
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
    if (item?.kind === "thread") return compact ? WORK_ROW_COMPACT_HEIGHT : WORK_ROW_HEIGHT;
    return WORK_ROW_HEIGHT;
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
    if (!enabled || !virtualized) return;
    updateViewport();
    const navigation = navigationRef.current;
    if (!navigation) return;
    const observer = new ResizeObserver(updateViewport);
    observer.observe(navigation);
    return () => observer.disconnect();
  }, [compact, enabled, items.length, navigationRef, updateViewport, virtualized]);
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
  const layoutKey = useMemo(
    () => sidebarWorkLayoutKey(compact, items),
    [compact, items],
  );
  useSidebarIndexMotion({
    containerRef: streamRef,
    enabled: motionEnabled,
    layoutKey,
  });
  const focusIdentity = useCallback((identity: string): boolean => {
    const itemIndex = indexByIdentity.get(identity);
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
