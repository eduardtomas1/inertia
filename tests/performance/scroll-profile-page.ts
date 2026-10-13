export const reactCommitCounterSource = `
(() => {
  const PERFORMED_WORK = 1;
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);
  const seen = new WeakMap();
  const state = { enabled: false, commits: 0, traversalMs: 0, rendered: new Map(), mounted: new Map(), commitTimes: [] };
  const nameOf = (fiber) => {
    const candidates = [fiber.elementType, fiber.type];
    for (const type of candidates) {
      if (!type) continue;
      if (typeof type === "function") return type.displayName || type.name || "Anonymous";
      if (type.displayName) return type.displayName;
      if (type.type) return type.type.displayName || type.type.name || "Memo";
      if (type.render) return type.render.displayName || type.render.name || "ForwardRef";
    }
    return "Unknown";
  };
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  const visit = (root) => {
    const stack = [root.current];
    let renderedFibers = 0;
    while (stack.length) {
      const fiber = stack.pop();
      if (!fiber) continue;
      if (COMPONENT_TAGS.has(fiber.tag) && (fiber.flags & PERFORMED_WORK) !== 0) {
        const last = seen.get(fiber);
        if (!last || last.props !== fiber.memoizedProps || last.state !== fiber.memoizedState) {
          renderedFibers += 1;
          if (state.enabled) {
            const name = nameOf(fiber);
            bump(state.rendered, name);
            if (fiber.alternate === null) bump(state.mounted, name);
          }
        }
      }
      seen.set(fiber, { props: fiber.memoizedProps, state: fiber.memoizedState });
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
    return renderedFibers;
  };
  const renderers = new Map();
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers,
    inject(renderer) { const id = renderers.size + 1; renderers.set(id, renderer); return id; },
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      const startedAt = performance.now();
      const renderedFibers = visit(root);
      const elapsed = performance.now() - startedAt;
      if (state.enabled) {
        state.commits += 1;
        state.traversalMs += elapsed;
        state.commitTimes.push([Number(startedAt.toFixed(2)), renderedFibers]);
      }
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
  };
  window.__scrollProfileCommits = {
    start() {
      state.enabled = true; state.commits = 0; state.traversalMs = 0;
      state.rendered = new Map(); state.mounted = new Map(); state.commitTimes = [];
    },
    stop() {
      state.enabled = false;
      const sorted = (map) => [...map.entries()].sort((left, right) => right[1] - left[1]);
      return {
        commits: state.commits,
        traversalMs: Number(state.traversalMs.toFixed(2)),
        rendered: sorted(state.rendered).slice(0, 60),
        mounted: sorted(state.mounted).slice(0, 40),
        commitTimes: state.commitTimes,
      };
    },
  };
})();
`;

export interface FrameRecording {
  durationMs: number;
  frames: number;
  medianFrameMs: number;
  p90FrameMs: number;
  p95FrameMs: number;
  p99FrameMs: number;
  maximumFrameMs: number;
  framesOver1_5x: number;
  framesOver25Ms: number;
  framesOver50Ms: number;
  estimatedMissedFrames: number;
  scrollEvents: number;
  rowMounts: number;
  rowUnmounts: number;
  longTasks: number[];
  longAnimationFrames: Array<{
    startTime: number;
    duration: number;
    blockingDuration: number;
    renderStart: number;
    styleAndLayoutStart: number;
    scripts: Array<{
      invoker: string;
      invokerType: string;
      sourceURL: string;
      sourceFunctionName: string;
      sourceCharPosition: number;
      duration: number;
      forcedStyleAndLayoutDuration: number;
    }>;
  }>;
  intervals: number[];
}

export function installFrameRecorder(): void {
  type Recorder = {
    start(scrollSelector: string, rowSelector: string): void;
    stop(): unknown;
  };
  if (Reflect.get(window, "__scrollProfileFrames")) return;
  let intervals: number[] = [];
  let running = false;
  let previous = 0;
  let handle = 0;
  let startedAt = 0;
  let scrollEvents = 0;
  let rowMounts = 0;
  let rowUnmounts = 0;
  let longTasks: number[] = [];
  let loafs: unknown[] = [];
  let scrollTarget: Element | null = null;
  let observers: PerformanceObserver[] = [];
  let mutation: MutationObserver | null = null;
  const onScroll = (): void => { scrollEvents += 1; };
  const frame = (now: number): void => {
    if (!running) return;
    intervals.push(now - previous);
    previous = now;
    handle = requestAnimationFrame(frame);
  };
  const recorder: Recorder = {
    start(scrollSelector, rowSelector) {
      intervals = []; scrollEvents = 0; rowMounts = 0; rowUnmounts = 0; longTasks = []; loafs = [];
      scrollTarget = document.querySelector(scrollSelector);
      scrollTarget?.addEventListener("scroll", onScroll, { passive: true });
      mutation = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) if (node instanceof Element && node.matches(rowSelector)) rowMounts += 1;
          for (const node of record.removedNodes) if (node instanceof Element && node.matches(rowSelector)) rowUnmounts += 1;
        }
      });
      if (scrollTarget) mutation.observe(scrollTarget, { childList: true, subtree: true });
      observers = [];
      try {
        const longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push(entry.duration);
        });
        longTaskObserver.observe({ type: "longtask" });
        observers.push(longTaskObserver);
      } catch (error) {
        void error;
      }
      try {
        const loafObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as unknown as Array<Record<string, unknown>>) {
            const scripts = (entry.scripts as Array<Record<string, unknown>> | undefined) ?? [];
            loafs.push({
              startTime: entry.startTime,
              duration: entry.duration,
              blockingDuration: entry.blockingDuration,
              renderStart: entry.renderStart,
              styleAndLayoutStart: entry.styleAndLayoutStart,
              scripts: scripts.map((script) => ({
                invoker: script.invoker,
                invokerType: script.invokerType,
                sourceURL: script.sourceURL,
                sourceFunctionName: script.sourceFunctionName,
                sourceCharPosition: script.sourceCharPosition,
                duration: script.duration,
                forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration,
              })),
            });
          }
        });
        loafObserver.observe({ type: "long-animation-frame" });
        observers.push(loafObserver);
      } catch (error) {
        void error;
      }
      running = true;
      startedAt = performance.now();
      previous = startedAt;
      handle = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(handle);
      scrollTarget?.removeEventListener("scroll", onScroll);
      mutation?.disconnect();
      for (const observer of observers) {
        const pending = observer.takeRecords();
        for (const entry of pending) {
          if (entry.entryType === "longtask") longTasks.push(entry.duration);
        }
        observer.disconnect();
      }
      const sorted = [...intervals].sort((left, right) => left - right);
      const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
      const median = at(0.5);
      return {
        durationMs: performance.now() - startedAt,
        frames: intervals.length,
        medianFrameMs: median,
        p90FrameMs: at(0.9),
        p95FrameMs: at(0.95),
        p99FrameMs: at(0.99),
        maximumFrameMs: sorted.at(-1) ?? 0,
        framesOver1_5x: intervals.filter((value) => value > median * 1.5).length,
        framesOver25Ms: intervals.filter((value) => value > 25).length,
        framesOver50Ms: intervals.filter((value) => value > 50).length,
        estimatedMissedFrames: median > 0
          ? intervals.reduce((total, value) => total + Math.max(0, Math.round(value / median) - 1), 0)
          : 0,
        scrollEvents,
        rowMounts,
        rowUnmounts,
        longTasks,
        longAnimationFrames: loafs,
        intervals: intervals.map((value) => Number(value.toFixed(2))),
      };
    },
  };
  Reflect.set(window, "__scrollProfileFrames", recorder);
}

export function ablationSource(ablations: readonly string[]): string {
  return `
(() => {
  const ablations = new Set(${JSON.stringify(ablations)});
  const skipped = { remember: 0, minimapScrollIntoView: 0 };
  window.__scrollProfileAblations = skipped;
  if (ablations.has("remember")) {
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (type === "scroll" && typeof listener === "function" && listener.name === "remember") {
        skipped.remember += 1;
        return;
      }
      return add.call(this, type, listener, options);
    };
  }
  if (ablations.has("minimap-scroll-into-view")) {
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (options) {
      if (this.closest && this.closest(".timeline-minimap")) {
        skipped.minimapScrollIntoView += 1;
        return;
      }
      return scrollIntoView.call(this, options);
    };
  }
})();
`;
}
