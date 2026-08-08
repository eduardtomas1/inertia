import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  InterfaceScale,
  ResponseDensity,
  SubagentTrace,
} from "@shared/contracts";
import { INTERFACE_SCALE_WILL_CHANGE_EVENT } from "../../utils/interfaceScale";
import {
  isTimelineFocusDetail,
  TIMELINE_FOCUS_EVENT,
} from "../../utils/timelineFocus";
import { isTranscriptReaderNavigationKey } from "../../utils/transcriptNavigation";
import {
  buildResponseTimeline,
  buildTimelineMinimapMarkers,
  estimateTimelineItemRenderWeight,
  estimateTimelineRowSize,
  resolveTimelineKeyboardIntent,
  shouldAdjustTimelineScrollPosition,
  shouldConsolidateSettledWorkIntoRunDetails,
  shouldFollowTimeline,
  shouldShowTimelineMinimap,
  shouldShowTurnGitArtifactSummary,
  shouldVirtualizeTimeline,
  stabilizeResponseTimeline,
  updateResponseTimelineForActivityDelta,
  type BuildResponseTimelineInput,
  type ResponseTimelineItem,
} from "../../utils/responseTimeline";
import { CompatibilityTimeline } from "./compatibility";
import { TurnTimeline } from "./turn";
import type { ResponseTimelineProps } from "./types";

type TimelineJumpTarget = "turn" | "request" | "final" | "artifact";
const TIMELINE_ARTICLE_REQUEST_LABEL_MAX_CHARS = 96;

export function responseTimelineArticleLabel(
  item: ResponseTimelineItem,
): string {
  if (item.kind === "compatibility") {
    return "Recovered legacy and orphaned history";
  }
  const request = item.turn.userMessage.content.trim().replace(/\s+/gu, " ");
  const requestLabel = request
    ? request.length > TIMELINE_ARTICLE_REQUEST_LABEL_MAX_CHARS
      ? `${request.slice(0, TIMELINE_ARTICLE_REQUEST_LABEL_MAX_CHARS - 1)}…`
      : request
    : item.turn.userMessage.attachments.length > 0
      ? "Request with attachments"
      : "Request";
  return `Turn ${item.turn.index}: ${requestLabel}`;
}

function findTurnElement(
  root: HTMLElement | null | undefined,
  turnId: string,
): HTMLElement | null {
  if (!root) return null;
  return [...root.querySelectorAll<HTMLElement>("[data-turn-id]")]
    .find((element) => element.dataset.turnId === turnId) ?? null;
}

function currentPlainTimelineIndex(
  root: HTMLElement | null | undefined,
  scrollElement: HTMLElement | null | undefined,
  timeline: ResponseTimelineItem[],
): number {
  if (!root || !scrollElement || timeline.length === 0) return 0;
  const scrollTop = scrollElement.getBoundingClientRect().top;
  const visible = [...root.querySelectorAll<HTMLElement>("[data-response-row-id]")]
    .find((element) => element.getBoundingClientRect().bottom > scrollTop + 8);
  const index = visible
    ? timeline.findIndex(({ id }) => id === visible.dataset.responseRowId)
    : -1;
  return index >= 0 ? index : Math.max(0, timeline.length - 1);
}

function currentInterfaceScale(): InterfaceScale {
  if (typeof document === "undefined") return "default";
  const value = document.documentElement.dataset.interfaceScale;
  return value === "compact"
    || value === "comfortable"
    || value === "large"
    ? value
    : "default";
}

function currentResponseDensity(root: HTMLElement | null | undefined): ResponseDensity {
  const workspace = root?.closest<HTMLElement>(".chat-workspace");
  if (workspace?.classList.contains("response-density-compact")) return "compact";
  if (workspace?.classList.contains("response-density-comfortable")) return "comfortable";
  return "default";
}

interface TimelineEstimateLayout {
  availableWidth: number;
  interfaceScale: InterfaceScale;
  responseDensity: ResponseDensity;
}

interface TimelineLayoutAnchor {
  rowId: string | null;
  viewportOffset: number;
  wasFollowing: boolean;
}

const DEFAULT_TIMELINE_ESTIMATE_LAYOUT: TimelineEstimateLayout = {
  availableWidth: 880,
  interfaceScale: "default",
  responseDensity: "default",
};
const TIMELINE_WIDTH_ESTIMATE_BUCKET = 16;

function useTimelineEstimateLayout(
  timelineElementRef: RefObject<HTMLDivElement | null> | undefined,
  conversationId: string,
  onBeforeLayoutChange: () => void,
): TimelineEstimateLayout {
  const [layout, setLayout] = useState(DEFAULT_TIMELINE_ESTIMATE_LAYOUT);
  useEffect(() => {
    // The timeline element is owned by the parent ChatWorkspace. React runs
    // child layout effects before attaching an ancestor host ref on mount, so
    // registering from a layout effect can permanently miss this element.
    // Passive effects run after every host ref has been attached.
    const timelineElement = timelineElementRef?.current;
    if (!timelineElement) return;
    const workspace = timelineElement.closest<HTMLElement>(".chat-workspace");
    let lastLayout = DEFAULT_TIMELINE_ESTIMATE_LAYOUT;
    const measure = (): void => {
      const next = {
        availableWidth: Math.max(
          320,
          Math.round(
            timelineElement.clientWidth / TIMELINE_WIDTH_ESTIMATE_BUCKET,
          ) * TIMELINE_WIDTH_ESTIMATE_BUCKET,
        ),
        interfaceScale: currentInterfaceScale(),
        responseDensity: currentResponseDensity(timelineElement),
      };
      if (
        lastLayout.availableWidth === next.availableWidth
        && lastLayout.interfaceScale === next.interfaceScale
        && lastLayout.responseDensity === next.responseDensity
      ) return;
      onBeforeLayoutChange();
      lastLayout = next;
      setLayout(next);
    };
    measure();
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(measure);
    resizeObserver?.observe(timelineElement);
    const mutationObserver = typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(measure);
    window.addEventListener(
      INTERFACE_SCALE_WILL_CHANGE_EVENT,
      onBeforeLayoutChange,
    );
    mutationObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-interface-scale"],
    });
    if (workspace) {
      mutationObserver?.observe(workspace, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }
    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener(
        INTERFACE_SCALE_WILL_CHANGE_EVENT,
        onBeforeLayoutChange,
      );
    };
  }, [conversationId, onBeforeLayoutChange, timelineElementRef]);
  return layout;
}

interface TimelineGutter {
  available: number;
  minimapLeft: number;
}

const EMPTY_TIMELINE_GUTTER: TimelineGutter = { available: 0, minimapLeft: 0 };
const TIMELINE_MINIMAP_WIDTH = 12;

function useTimelineGutter(
  scrollElementRef: RefObject<HTMLDivElement | null> | undefined,
  timelineElement: HTMLDivElement | null,
  enabled: boolean,
  conversationId: string,
): TimelineGutter {
  const [gutter, setGutter] = useState<TimelineGutter>(EMPTY_TIMELINE_GUTTER);
  useLayoutEffect(() => {
    if (!enabled) {
      setGutter(EMPTY_TIMELINE_GUTTER);
      return;
    }
    const scrollElement = scrollElementRef?.current
      ?? timelineElement?.closest<HTMLDivElement>(".message-scroll")
      ?? null;
    if (!scrollElement || !timelineElement) return;
    const measure = (): void => {
      const scrollBounds = scrollElement.getBoundingClientRect();
      const timelineBounds = timelineElement.getBoundingClientRect();
      const visibleTurn = timelineElement.querySelector<HTMLElement>(".response-turn");
      const rowLeft = visibleTurn?.getBoundingClientRect().left
        ?? timelineBounds.left + Math.max(0, (timelineElement.clientWidth - Math.min(760, timelineElement.clientWidth)) / 2);
      const available = Math.max(0, Math.round(rowLeft - scrollBounds.left));
      const minimapLeft = Math.round(
        scrollBounds.left
          + Math.max(6, (available - TIMELINE_MINIMAP_WIDTH) / 2)
          - timelineBounds.left,
      );
      setGutter((current) =>
        current.available === available && current.minimapLeft === minimapLeft
          ? current
          : { available, minimapLeft });
    };
    measure();
    const frame = window.requestAnimationFrame(measure);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(scrollElement);
    observer.observe(timelineElement);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [conversationId, enabled, scrollElementRef, timelineElement]);
  return gutter;
}

export interface TimelineMarker {
  timelineIndex: number;
  id: string;
  label: string;
  number: number;
}

const EMPTY_SUBAGENTS: SubagentTrace[] = [];

export function TimelineMinimap({
  activeIndex,
  left,
  markers,
  onNavigate,
}: {
  activeIndex: number;
  left: number;
  markers: TimelineMarker[];
  onNavigate: (index: number, target: TimelineJumpTarget) => void;
}): React.JSX.Element {
  const [hoveredMarkerId, setHoveredMarkerId] = useState<string | null>(null);
  const [focusedMarkerId, setFocusedMarkerId] = useState<string | null>(null);
  const previewedMarkerId = hoveredMarkerId ?? focusedMarkerId;
  let activeMarker = 0;
  markers.forEach((marker, index) => {
    if (marker.timelineIndex <= activeIndex) activeMarker = index;
  });
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const focused = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : event.key === "ArrowUp"
          ? Math.max(0, focused - 1)
          : Math.min(buttons.length - 1, focused + 1);
    buttons[next]?.focus();
  };
  return (
    <div
      className="timeline-minimap-anchor"
      style={{ "--timeline-minimap-left": `${left}px` } as React.CSSProperties}
    >
      <nav className="timeline-minimap" aria-label="Conversation minimap" onKeyDown={onKeyDown}>
        {markers.map((marker, index) => (
          <button
            type="button"
            key={marker.id}
            aria-current={index === activeMarker ? "true" : undefined}
            aria-label={`Go to turn ${marker.number}: ${marker.label}`}
            data-emphasized={
              previewedMarkerId === marker.id ? "true" : undefined
            }
            tabIndex={index === activeMarker ? 0 : -1}
            onPointerEnter={() => setHoveredMarkerId(marker.id)}
            onPointerLeave={() => setHoveredMarkerId((current) =>
              current === marker.id ? null : current)}
            onFocus={() => setFocusedMarkerId(marker.id)}
            onBlur={() => setFocusedMarkerId((current) =>
              current === marker.id ? null : current)}
            onClick={() => onNavigate(marker.timelineIndex, "turn")}
          >
            {previewedMarkerId === marker.id && (
              <span
                className="timeline-minimap-preview"
                aria-hidden="true"
              >
                {`Turn ${marker.number} · ${marker.label}`}
              </span>
            )}
          </button>
        ))}
      </nav>
    </div>
  );
}

function ResponseTimelineView(props: ResponseTimelineProps): React.JSX.Element {
  const previousTimeline = useRef<ResponseTimelineItem[]>([]);
  const previousBuild = useRef<{
    input: BuildResponseTimelineInput;
    timeline: ResponseTimelineItem[];
  } | null>(null);
  const renderWeightCache = useRef(
    new WeakMap<ResponseTimelineItem, number>(),
  );
  const rowEstimateCache = useRef(
    new WeakMap<ResponseTimelineItem, Map<string, number>>(),
  );
  const previousSubagentsByTurn = useRef(
    new Map<string, SubagentTrace[]>(),
  );
  const pendingLayoutAnchor = useRef<TimelineLayoutAnchor | null>(null);
  const captureLayoutAnchorRef = useRef<() => void>(() => undefined);
  const restoreLayoutAnchorRef = useRef<() => void>(() => undefined);
  const captureLayoutAnchorBeforeChange = useCallback(() => {
    captureLayoutAnchorRef.current();
    // Keep scale restoration independent from the observer/state race. The
    // event is synchronous and arrives before Chromium applies new metrics.
    window.requestAnimationFrame(() => restoreLayoutAnchorRef.current());
  }, []);
  const builtTimeline = useMemo(() => {
    const input: BuildResponseTimelineInput = {
      turns: props.turns,
      messages: props.messages,
      activities: props.activities,
      reasonings: props.reasonings,
      plans: props.plans,
      approvals: props.approvals,
      inputRequests: props.inputRequests,
      checkpoints: props.checkpoints,
      gitArtifacts: props.gitArtifacts,
    };
    const previous = previousBuild.current;
    const activityOnly = previous !== null
      && previous.input.turns === input.turns
      && previous.input.messages === input.messages
      && previous.input.reasonings === input.reasonings
      && previous.input.plans === input.plans
      && previous.input.approvals === input.approvals
      && previous.input.inputRequests === input.inputRequests
      && previous.input.checkpoints === input.checkpoints
      && previous.input.gitArtifacts === input.gitArtifacts;
    const incremental = activityOnly
      ? updateResponseTimelineForActivityDelta(
          input,
          previous.input.activities,
          previous.timeline,
        )
      : null;
    const timeline = incremental ?? buildResponseTimeline(input);
    previousBuild.current = { input, timeline };
    return timeline;
  }, [
    props.activities,
    props.approvals,
    props.checkpoints,
    props.gitArtifacts,
    props.inputRequests,
    props.messages,
    props.plans,
    props.reasonings,
    props.turns,
  ]);
  const timeline = useMemo(() => {
    const next = stabilizeResponseTimeline(builtTimeline, previousTimeline.current);
    previousTimeline.current = next;
    return next;
  }, [builtTimeline]);
  const turnAnchorIndex = useMemo(() => props.turnAnchorId
    ? timeline.findIndex((item) =>
        item.kind === "turn" && item.turn.id === props.turnAnchorId)
    : -1, [props.turnAnchorId, timeline]);
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const previousComparableTurn = useMemo(() => {
    const result = new Map<string, string>();
    const previousByWorktree = new Map<string, string>();
    for (const item of timeline) {
      if (item.kind !== "turn") continue;
      const artifact = item.turn.gitArtifact;
      if (
        !artifact
        || artifact.status === "pending"
        || artifact.repositoryIdentity === null
        || artifact.worktreeIdentity === null
        || artifact.afterFingerprint === null
      ) continue;
      const key = `${artifact.repositoryIdentity}\u0000${artifact.worktreeIdentity}`;
      const previousTurnId = previousByWorktree.get(key);
      if (previousTurnId) result.set(artifact.turnId, previousTurnId);
      previousByWorktree.set(key, artifact.turnId);
    }
    return result;
  }, [timeline]);
  const renderWeight = useMemo(() => timeline.reduce((total, item) => {
    const cached = renderWeightCache.current.get(item);
    if (cached !== undefined) return total + cached;
    const weight = estimateTimelineItemRenderWeight(item);
    renderWeightCache.current.set(item, weight);
    return total + weight;
  }, 0), [timeline]);
  const virtualized = shouldVirtualizeTimeline(timeline.length, renderWeight);
  const estimateLayout = useTimelineEstimateLayout(
    props.timelineElementRef,
    props.conversationId,
    captureLayoutAnchorBeforeChange,
  );
  const estimateKey = [
    estimateLayout.availableWidth,
    estimateLayout.interfaceScale,
    estimateLayout.responseDensity,
    props.autoCollapseWorkLog ? "collapsed" : "expanded",
    props.showThinking ? "thinking" : "hidden-thinking",
    props.showChangedFileSummaries ? "files" : "hidden-files",
  ].join(":");
  const getItemKey = useCallback(
    (index: number) => timelineRef.current[index]?.id ?? `missing-${index}`,
    [],
  );
  const estimateSize = useCallback((index: number) => {
    const item = timeline[index];
    if (!item) return 280;
    const cachedByLayout = rowEstimateCache.current.get(item);
    const cached = cachedByLayout?.get(estimateKey);
    if (cached !== undefined) return cached;
    const artifact = item.kind === "turn" ? item.turn.gitArtifact : null;
    const expandsConsolidatedWork = item.kind === "turn"
      && !props.autoCollapseWorkLog
      && shouldConsolidateSettledWorkIntoRunDetails(item.turn);
    const estimate = estimateTimelineRowSize(item, {
      ...estimateLayout,
      workDetailsExpanded: !props.autoCollapseWorkLog,
      runDetailsExpanded: expandsConsolidatedWork,
      showThinking: props.showThinking,
      showChangedFiles: props.showChangedFileSummaries
        && artifact !== null
        && shouldShowTurnGitArtifactSummary(artifact),
    });
    const nextCache = cachedByLayout ?? new Map<string, number>();
    if (!nextCache.has(estimateKey) && nextCache.size >= 12) {
      const oldestKey = nextCache.keys().next().value;
      if (oldestKey !== undefined) nextCache.delete(oldestKey);
    }
    nextCache.set(estimateKey, estimate);
    rowEstimateCache.current.set(item, nextCache);
    return estimate;
  }, [
    props.autoCollapseWorkLog,
    props.showChangedFileSummaries,
    props.showThinking,
    estimateLayout,
    estimateKey,
    timeline,
  ]);
  const virtualizer = useVirtualizer({
    count: timeline.length,
    enabled: virtualized,
    getScrollElement: () => props.scrollElementRef?.current ?? null,
    getItemKey,
    estimateSize,
    overscan: 4,
    anchorTo: "end",
    followOnAppend: false,
    useAnimationFrameWithResizeObserver: true,
  });
  const initiallyFollowedConversation = useRef<string | null>(null);
  useEffect(() => {
    if (!virtualized || timeline.length === 0) return;
    if (initiallyFollowedConversation.current === props.conversationId) return;
    initiallyFollowedConversation.current = props.conversationId;
    virtualizer.scrollToIndex(timeline.length - 1, {
      align: "end",
      behavior: "auto",
    });
  }, [
    props.conversationId,
    timeline.length,
    virtualized,
    virtualizer,
  ]);
  type ExpansionAnchor = {
    sequence: number;
    sourceTurnId: string;
    sourceHeight: number | null;
    rowId: string;
    viewportOffset: number;
  };
  const nextExpansionAnchorSequence = useRef(0);
  const pendingAnchors = useRef(new Map<string, ExpansionAnchor>());
  const activeAnchorRestorations = useRef(new Map<string, number>());
  const manuallyAdjustedRows = useRef(new Set<string>());
  const layoutAnchorActive = useRef(false);
  const turnAnchorActive = useRef(false);
  const onTurnAnchorSettledRef = useRef(props.onTurnAnchorSettled);
  const onTurnAnchorCancelledRef = useRef(props.onTurnAnchorCancelled);
  onTurnAnchorSettledRef.current = props.onTurnAnchorSettled;
  onTurnAnchorCancelledRef.current = props.onTurnAnchorCancelled;
  const cancelLayoutAnchorRestoration = useRef<(() => void) | null>(null);
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    shouldAdjustTimelineScrollPosition({
      itemStart: item.start,
      itemSize: item.size,
      scrollOffset: instance.scrollOffset ?? 0,
      firstMeasurement: !instance.itemSizeCache.has(item.key),
      scrollDirection: instance.scrollDirection,
      manuallyAnchored: layoutAnchorActive.current
        || turnAnchorActive.current
        || manuallyAdjustedRows.current.has(String(item.key)),
    });

  useEffect(() => {
    const turnId = props.turnAnchorId;
    if (!turnId) return;
    const anchorIndex = turnAnchorIndex;
    if (anchorIndex < 0) return;
    const scrollElement = props.scrollElementRef?.current;
    const root = props.timelineElementRef?.current;
    if (!scrollElement || !root) return;

    cancelLayoutAnchorRestoration.current?.();
    turnAnchorActive.current = true;
    let finished = false;
    let frame = 0;
    let attempts = 0;
    let stableFrames = 0;
    let resizeObserver: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;

    const removeIntentListeners = (): void => {
      scrollElement.removeEventListener("wheel", cancelForUserIntent);
      scrollElement.removeEventListener("touchstart", cancelForUserIntent);
      scrollElement.removeEventListener("pointerdown", cancelForUserIntent);
      scrollElement.removeEventListener("keydown", cancelForUserIntent);
    };
    const finish = (settled: boolean): void => {
      if (finished) return;
      finished = true;
      turnAnchorActive.current = false;
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      removeIntentListeners();
      if (settled) onTurnAnchorSettledRef.current?.(turnId);
      else onTurnAnchorCancelledRef.current?.(turnId);
    };
    const scheduleSettle = (): void => {
      if (finished || frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        settle();
      });
    };
    const settle = (): void => {
      if (finished) return;
      const row = findTurnElement(root, turnId);
      if (!row) {
        if (virtualized && attempts % 4 === 0) {
          virtualizer.scrollToIndex(anchorIndex, {
            align: "start",
            behavior: "auto",
          });
        }
        attempts += 1;
        if (attempts < 30) scheduleSettle();
        return;
      }
      const currentOffset = row.getBoundingClientRect().top
        - scrollElement.getBoundingClientRect().top;
      const delta = currentOffset - 8;
      const previousScrollTop = scrollElement.scrollTop;
      if (Math.abs(delta) >= 0.5) scrollElement.scrollTop += delta;
      const settledOffset = row.getBoundingClientRect().top
        - scrollElement.getBoundingClientRect().top;
      stableFrames = Math.abs(settledOffset - 8) < 0.5
        ? stableFrames + 1
        : 0;
      attempts += 1;
      if (stableFrames < 2) {
        const scrollMoved = Math.abs(scrollElement.scrollTop - previousScrollTop)
          >= 0.5;
        if (stableFrames > 0 || scrollMoved) scheduleSettle();
      } else {
        finish(true);
      }
    };
    function cancelForUserIntent(event: Event): void {
      if (
        event instanceof KeyboardEvent
        && !isTranscriptReaderNavigationKey(event.key)
      ) return;
      if (event instanceof PointerEvent && event.target !== scrollElement) return;
      finish(false);
    }

    scrollElement.addEventListener("wheel", cancelForUserIntent, { passive: true });
    scrollElement.addEventListener("touchstart", cancelForUserIntent, { passive: true });
    scrollElement.addEventListener("pointerdown", cancelForUserIntent);
    scrollElement.addEventListener("keydown", cancelForUserIntent);
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(scheduleSettle);
      resizeObserver.observe(root);
    }
    if (typeof MutationObserver !== "undefined") {
      mutationObserver = new MutationObserver(scheduleSettle);
      mutationObserver.observe(root, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
    if (virtualized) {
      virtualizer.scrollToIndex(anchorIndex, {
        align: "start",
        behavior: "auto",
      });
    }
    scheduleSettle();
    return () => {
      if (finished) return;
      finished = true;
      turnAnchorActive.current = false;
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      removeIntentListeners();
    };
  }, [
    props.scrollElementRef,
    props.timelineElementRef,
    props.turnAnchorId,
    turnAnchorIndex,
    virtualized,
    virtualizer,
  ]);
  captureLayoutAnchorRef.current = () => {
    if (pendingLayoutAnchor.current) {
      if (!cancelLayoutAnchorRestoration.current) return;
      cancelLayoutAnchorRestoration.current();
    }
    const scrollElement = props.scrollElementRef?.current;
    const root = props.timelineElementRef?.current;
    if (!scrollElement || !root) return;
    const wasFollowing = shouldFollowTimeline(
      scrollElement.scrollTop,
      scrollElement.clientHeight,
      scrollElement.scrollHeight,
    );
    const viewportTop = scrollElement.getBoundingClientRect().top;
    const anchor = wasFollowing
      ? null
      : [...root.querySelectorAll<HTMLElement>("[data-response-row-id]")]
          .find((row) => row.getBoundingClientRect().bottom > viewportTop + 8) ?? null;
    pendingLayoutAnchor.current = {
      rowId: anchor?.dataset.responseRowId ?? null,
      viewportOffset: anchor
        ? anchor.getBoundingClientRect().top - viewportTop
        : 0,
      wasFollowing,
    };
  };
  restoreLayoutAnchorRef.current = () => {
    const layoutAnchor = pendingLayoutAnchor.current;
    if (!layoutAnchor || cancelLayoutAnchorRestoration.current) return;
    if (!virtualized) {
      pendingLayoutAnchor.current = null;
      return;
    }
    const scrollElement = props.scrollElementRef?.current;
    const root = props.timelineElementRef?.current;
    if (!scrollElement || !root) {
      pendingLayoutAnchor.current = null;
      return;
    }
    const { rowId, viewportOffset, wasFollowing } = layoutAnchor;
    const anchorIndex = rowId === null
      ? -1
      : timeline.findIndex((item) => item.id === rowId);
    layoutAnchorActive.current = true;
    virtualizer.measure();

    let cancelled = false;
    let attempts = 0;
    let stableFrames = 0;
    let anchorRow: HTMLElement | null = null;
    const settleUntil = performance.now() + 600;
    const maximumSettleFrames = 30;
    const removeIntentListeners = (): void => {
      scrollElement.removeEventListener("wheel", cancelForUserIntent);
      scrollElement.removeEventListener("touchstart", cancelForUserIntent);
      scrollElement.removeEventListener("pointerdown", cancelForUserIntent);
      scrollElement.removeEventListener("keydown", cancelForUserIntent);
    };
    const finishRestoration = (): void => {
      if (cancelled) return;
      cancelled = true;
      if (pendingLayoutAnchor.current === layoutAnchor) {
        pendingLayoutAnchor.current = null;
      }
      layoutAnchorActive.current = false;
      cancelLayoutAnchorRestoration.current = null;
      removeIntentListeners();
    };
    const restore = (): void => {
      if (cancelled) return;
      if (wasFollowing) {
        scrollElement.scrollTo({ top: scrollElement.scrollHeight, behavior: "auto" });
        finishRestoration();
        return;
      }
      if (!anchorRow?.isConnected && rowId) {
        anchorRow = [...root.querySelectorAll<HTMLElement>(
          "[data-response-row-id]",
        )].find((element) => element.dataset.responseRowId === rowId) ?? null;
      }
      const row = anchorRow;
      if (!row) {
        if (anchorIndex >= 0 && attempts % 4 === 0) {
          virtualizer.scrollToIndex(anchorIndex, { align: "start", behavior: "auto" });
        }
        attempts += 1;
        if (
          attempts < maximumSettleFrames
          && performance.now() < settleUntil
        ) {
          window.requestAnimationFrame(restore);
        } else {
          finishRestoration();
        }
        return;
      }
      const currentOffset = row.getBoundingClientRect().top
        - scrollElement.getBoundingClientRect().top;
      const delta = currentOffset - viewportOffset;
      if (Math.abs(delta) >= 0.5) scrollElement.scrollTop += delta;
      stableFrames = Math.abs(delta) < 0.5 ? stableFrames + 1 : 0;
      attempts += 1;
      if (
        attempts < maximumSettleFrames
        && performance.now() < settleUntil
        && stableFrames < 4
      ) {
        window.requestAnimationFrame(restore);
      } else {
        finishRestoration();
      }
    };
    function cancelForUserIntent(): void {
      finishRestoration();
    }
    scrollElement.addEventListener("wheel", cancelForUserIntent, { passive: true });
    scrollElement.addEventListener("touchstart", cancelForUserIntent, { passive: true });
    scrollElement.addEventListener("pointerdown", cancelForUserIntent);
    scrollElement.addEventListener("keydown", cancelForUserIntent);
    cancelLayoutAnchorRestoration.current = finishRestoration;
    window.requestAnimationFrame(restore);
  };
  const previousEstimateLayout = useRef(estimateLayout);
  useLayoutEffect(() => {
    const previous = previousEstimateLayout.current;
    previousEstimateLayout.current = estimateLayout;
    if (
      !virtualized
      || (
        previous.availableWidth === estimateLayout.availableWidth
        && previous.interfaceScale === estimateLayout.interfaceScale
        && previous.responseDensity === estimateLayout.responseDensity
      )
    ) return;
    restoreLayoutAnchorRef.current();
  }, [
    estimateLayout,
    virtualized,
  ]);
  useEffect(() => () => {
    cancelLayoutAnchorRestoration.current?.();
  }, []);

  const captureExpansionAnchor = useCallback((sourceTurnId: string): void => {
    const scrollElement = props.scrollElementRef?.current;
    const root = props.timelineElementRef?.current;
    if (!scrollElement || !root) return;
    const viewportTop = scrollElement.getBoundingClientRect().top;
    const rows = [...root.querySelectorAll<HTMLElement>("[data-response-row-id]")];
    const sourceIndex = rows.findIndex((row) => row.dataset.responseRowId === sourceTurnId);
    const rowsAfterSource = sourceIndex >= 0 ? rows.slice(sourceIndex + 1) : rows;
    const anchor = rowsAfterSource.find((row) => row.getBoundingClientRect().top >= viewportTop + 8)
      ?? rowsAfterSource.find((row) => row.getBoundingClientRect().bottom > viewportTop + 8)
      ?? rows.find((row) => row.getBoundingClientRect().top >= viewportTop + 8)
      ?? rows.find((row) => row.getBoundingClientRect().bottom > viewportTop + 8);
    if (!anchor?.dataset.responseRowId) return;
    const source = sourceIndex >= 0 ? rows[sourceIndex] : undefined;
    const capturedAnchor: ExpansionAnchor = {
      sequence: nextExpansionAnchorSequence.current += 1,
      sourceTurnId,
      sourceHeight: source?.getBoundingClientRect().height ?? null,
      rowId: anchor.dataset.responseRowId,
      viewportOffset: anchor.getBoundingClientRect().top - viewportTop,
    };
    pendingAnchors.current.set(sourceTurnId, capturedAnchor);
    manuallyAdjustedRows.current.add(sourceTurnId);
  }, [props.scrollElementRef, props.timelineElementRef]);

  const restoreExpansionAnchor = useCallback((sourceTurnId: string): void => {
    const anchor = pendingAnchors.current.get(sourceTurnId);
    if (!anchor) return;
    if (activeAnchorRestorations.current.get(sourceTurnId) === anchor.sequence) return;
    const scrollElement = props.scrollElementRef?.current;
    const root = props.timelineElementRef?.current;
    if (!scrollElement || !root) return;
    activeAnchorRestorations.current.set(sourceTurnId, anchor.sequence);
    let sourceHeight = anchor.sourceHeight;
    const adjustToAnchor = (): number | null => {
      const rows = [...root.querySelectorAll<HTMLElement>("[data-response-row-id]")];
      const source = rows.find((element) => element.dataset.responseRowId === sourceTurnId);
      const row = rows
        .find((element) => element.dataset.responseRowId === anchor.rowId);
      if (!row) {
        if (source && sourceHeight !== null) {
          const currentSourceHeight = source.getBoundingClientRect().height;
          const sizeDelta = currentSourceHeight - sourceHeight;
          if (Math.abs(sizeDelta) >= 0.5) scrollElement.scrollTop += sizeDelta;
          sourceHeight = currentSourceHeight;
          return Math.abs(sizeDelta);
        }
        return null;
      }
      const currentOffset = row.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top;
      const delta = currentOffset - anchor.viewportOffset;
      if (Math.abs(delta) >= 0.5) scrollElement.scrollTop += delta;
      if (source) sourceHeight = source.getBoundingClientRect().height;
      return Math.abs(delta);
    };
    let stableFrames = 0;
    let sawAdjustment = false;
    const settle = (remainingFrames: number): void => {
      if (pendingAnchors.current.get(sourceTurnId) !== anchor) {
        if (activeAnchorRestorations.current.get(sourceTurnId) === anchor.sequence) {
          activeAnchorRestorations.current.delete(sourceTurnId);
        }
        return;
      }
      const adjustment = adjustToAnchor();
      if (adjustment !== null && adjustment >= 0.5) sawAdjustment = true;
      stableFrames = sawAdjustment && adjustment !== null && adjustment < 0.5
        ? stableFrames + 1
        : 0;
      if (remainingFrames > 0 && stableFrames < 2) {
        window.requestAnimationFrame(() => settle(remainingFrames - 1));
        return;
      }
      pendingAnchors.current.delete(sourceTurnId);
      activeAnchorRestorations.current.delete(sourceTurnId);
      manuallyAdjustedRows.current.delete(sourceTurnId);
    };
    settle(10);
  }, [props.scrollElementRef, props.timelineElementRef]);

  const virtualItems = virtualized ? virtualizer.getVirtualItems() : [];
  const activeIndex = virtualized
    ? virtualizer.range?.startIndex ?? virtualItems[0]?.index ?? 0
    : 0;
  const [virtualWindowElement, setVirtualWindowElement] = useState<HTMLDivElement | null>(null);
  const gutter = useTimelineGutter(
    props.scrollElementRef,
    virtualWindowElement,
    virtualized,
    props.conversationId,
  );
  const turnItems = useMemo(() => timeline.flatMap((item, timelineIndex) =>
    item.kind === "turn" ? [{ turn: item.turn, timelineIndex }] : []), [timeline]);
  const markers = useMemo<TimelineMarker[]>(() =>
    buildTimelineMinimapMarkers(turnItems.map(({ turn }) => turn)).map((marker) => ({
      ...marker,
      number: turnItems[marker.index]!.turn.index,
      timelineIndex: turnItems[marker.index]!.timelineIndex,
    })), [turnItems]);
  const subagentsByTurn = useMemo(() => {
    const grouped = new Map<string, SubagentTrace[]>();
    for (const trace of props.subagents ?? []) {
      const current = grouped.get(trace.turnId);
      if (current) current.push(trace);
      else grouped.set(trace.turnId, [trace]);
    }
    for (const [turnId, traces] of grouped) {
      const previous = previousSubagentsByTurn.current.get(turnId);
      if (
        previous
        && previous.length === traces.length
        && previous.every((trace, index) => trace === traces[index])
      ) {
        grouped.set(turnId, previous);
      }
    }
    previousSubagentsByTurn.current = grouped;
    return grouped;
  }, [props.subagents]);

  const focusTimelineItem = useCallback((
    index: number,
    target: TimelineJumpTarget,
  ): void => {
    if (timeline.length === 0) return;
    const boundedIndex = Math.max(0, Math.min(index, timeline.length - 1));
    const item = timeline[boundedIndex];
    if (!item) return;
    if (virtualized) {
      virtualizer.scrollToIndex(boundedIndex, {
        align: target === "turn" ? "center" : "start",
        behavior: "auto",
      });
    }

    let attempts = 0;
    const focus = (): void => {
      const root = props.timelineElementRef?.current;
      const row = item.kind === "turn"
        ? findTurnElement(root, item.turn.id)
        : root?.querySelector<HTMLElement>('[data-response-row-id="legacy-orphan-history"]') ?? null;
      if (!row && attempts < 8) {
        attempts += 1;
        window.requestAnimationFrame(focus);
        return;
      }
      if (!row) return;
      if (!virtualized) row.scrollIntoView({ block: target === "turn" ? "center" : "start" });
      const destination = target === "turn"
        ? row
        : row.querySelector<HTMLElement>(`[data-turn-jump-target="${target}"]`) ?? row;
      destination.focus({ preventScroll: true });
    };
    window.requestAnimationFrame(focus);
  }, [props.timelineElementRef, timeline, virtualized, virtualizer]);

  useEffect(() => {
    const focusRequestedTurn = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (
        !isTimelineFocusDetail(detail)
        || detail.conversationId !== props.conversationId
      ) return;
      const index = timeline.findIndex((item) =>
        item.kind === "turn" && item.turn.id === detail.turnId);
      if (index >= 0) focusTimelineItem(index, "turn");
    };
    window.addEventListener(TIMELINE_FOCUS_EVENT, focusRequestedTurn);
    return () => window.removeEventListener(
      TIMELINE_FOCUS_EVENT,
      focusRequestedTurn,
    );
  }, [focusTimelineItem, props.conversationId, timeline]);

  useEffect(() => {
    const scrollElement = props.scrollElementRef?.current;
    if (!scrollElement) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.matches("input, textarea, select")
        || target?.isContentEditable
      ) return;
      const current = virtualized
        ? virtualizer.getVirtualItemForOffset(scrollElement.scrollTop + 8)?.index ?? 0
        : currentPlainTimelineIndex(props.timelineElementRef?.current, scrollElement, timeline);
      const intent = resolveTimelineKeyboardIntent(event, current, timeline.length);
      if (!intent) return;
      event.preventDefault();
      focusTimelineItem(intent.index, intent.target);
    };
    scrollElement.addEventListener("keydown", onKeyDown);
    return () => scrollElement.removeEventListener("keydown", onKeyDown);
  }, [
    focusTimelineItem,
    props.scrollElementRef,
    props.timelineElementRef,
    timeline,
    virtualized,
    virtualizer,
  ]);

  const renderItem = (item: ResponseTimelineItem): React.JSX.Element => item.kind === "turn"
    ? (
      <TurnTimeline
        turn={item.turn}
        props={props}
        subagents={subagentsByTurn.get(item.turn.id) ?? EMPTY_SUBAGENTS}
        previousArtifactTurnId={previousComparableTurn.get(item.turn.id) ?? null}
        onBeforeToggle={captureExpansionAnchor}
        onAfterToggle={restoreExpansionAnchor}
      />
    )
    : (
      <CompatibilityTimeline
        key={props.conversationId}
        compatibility={item.compatibility}
        props={props}
      />
    );

  return (
    <>
      {shouldShowTimelineMinimap(timeline.length, gutter.available) && (
        <TimelineMinimap
          activeIndex={activeIndex}
          left={gutter.minimapLeft}
          markers={markers}
          onNavigate={focusTimelineItem}
        />
      )}
      {virtualized
        ? (
          <div
            ref={setVirtualWindowElement}
            className="response-virtual-window"
            role="feed"
            aria-label={`${timeline.length} conversation turns`}
            data-timeline-side-gutter={gutter.available}
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualItems.map((virtualItem) => {
              const item = timeline[virtualItem.index];
              if (!item) return null;
              return (
                <article
                  className="response-virtual-item"
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  aria-posinset={virtualItem.index + 1}
                  aria-setsize={timeline.length}
                  aria-label={responseTimelineArticleLabel(item)}
                  ref={virtualizer.measureElement}
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  {renderItem(item)}
                </article>
              );
            })}
          </div>
        )
        : timeline.map((item) => <div className="response-static-item" key={item.id}>{renderItem(item)}</div>)}
    </>
  );
}

export const ResponseTimeline = memo(ResponseTimelineView);
ResponseTimeline.displayName = "ResponseTimeline";
