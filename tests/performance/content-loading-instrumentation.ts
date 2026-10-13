export const CONTENT_LOADING_INIT_SCRIPT = String.raw`(() => {
  if (window.__contentBench) return;
  const bench = { log: [], longTasks: [], commits: [], census: false, root: null, seen: new WeakMap() };
  window.__contentBench = bench;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) bench.longTasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  const sniff = (data) => {
    if (typeof data !== "string") return { types: ["binary"], bytes: data.byteLength ?? data.size ?? 0 };
    const head = data.slice(0, 1200);
    const types = [...head.matchAll(/"type":"([a-z][a-z0-9._-]*)"/g)].slice(0, 3).map((match) => match[1]);
    const kind = /"kind":"([a-z][a-z0-9._-]*)"/.exec(head)?.[1] ?? null;
    const requestId = /"requestId":"([^"]+)"/.exec(head)?.[1] ?? null;
    return { types, kind, requestId, bytes: data.length };
  };
  const Native = window.WebSocket;
  class RecordedWebSocket extends Native {
    constructor(url, protocols) {
      super(url, protocols);
      this.addEventListener("message", (event) => {
        bench.log.push({ direction: "in", t: performance.now(), ...sniff(event.data) });
      });
    }
    send(data) {
      bench.log.push({ direction: "out", t: performance.now(), ...sniff(data) });
      return super.send(data);
    }
  }
  window.WebSocket = RecordedWebSocket;
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);
  const walk = (root, visit) => {
    const stack = root?.current ? [root.current] : [];
    while (stack.length) {
      const fiber = stack.pop();
      visit(fiber);
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
  };
  const matches = (entry, fiber) => entry && entry.props === fiber.memoizedProps && entry.state === fiber.memoizedState;
  const rendered = (fiber) => !matches(bench.seen.get(fiber), fiber)
    && !(fiber.alternate && matches(bench.seen.get(fiber.alternate), fiber));
  const remember = (root) => walk(root, (fiber) => {
    if (COMPONENT_TAGS.has(fiber.tag)) bench.seen.set(fiber, { props: fiber.memoizedProps, state: fiber.memoizedState });
  });
  const census = (root) => {
    let components = 0;
    let renderedComponents = 0;
    let rows = 0;
    let renderedRows = 0;
    walk(root, (fiber) => {
      if (COMPONENT_TAGS.has(fiber.tag)) {
        components += 1;
        if (rendered(fiber)) renderedComponents += 1;
      }
      if (fiber.tag === 5 && fiber.stateNode?.classList
        && (fiber.stateNode.classList.contains("response-virtual-item") || fiber.stateNode.classList.contains("response-static-item"))) {
        rows += 1;
        let child = fiber.child;
        for (let depth = 0; child && depth < 8 && !COMPONENT_TAGS.has(child.tag); depth += 1) child = child.child;
        if (child && rendered(child)) renderedRows += 1;
      }
    });
    remember(root);
    return { components, renderedComponents, rows, renderedRows };
  };
  bench.enableCensus = () => { bench.census = true; remember(bench.root); };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(),
    supportsFiber: true,
    isDisabled: false,
    inject(renderer) {
      const id = this.renderers.size + 1;
      this.renderers.set(id, renderer);
      return id;
    },
    onScheduleFiberRoot() {},
    onCommitFiberRoot(id, root) {
      const t = performance.now();
      if (!bench.root || root.containerInfo?.id === "root") bench.root = root;
      bench.commits.push(bench.census ? { t, ...census(root) } : { t });
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  };
})();`;

export interface FrameRecord {
  direction: "in" | "out";
  t: number;
  types: string[];
  kind: string | null;
  requestId: string | null;
  bytes: number;
}

export interface CommitRecord {
  t: number;
  components?: number;
  renderedComponents?: number;
  rows?: number;
  renderedRows?: number;
}

export interface OpenChatSample {
  clickToVisibleMs: number;
  clickToPaintMs: number;
  clickToSettledMs: number;
  phases: Record<string, number | null>;
  frames: (Omit<FrameRecord, "t"> & { atMs: number })[];
  longTaskCount: number;
  longTaskTotalMs: number;
  longTaskMaxMs: number;
  commitsToPaint: number;
  commitsToSettled: number;
  loadedTurns: number;
  renderedRows: number;
  censusCommits: CommitRecord[];
}

export interface OlderPageSample {
  clickToResultMs: number | null;
  clickToCountMs: number;
  clickToSettledMs: number;
  requestToResultMs: number | null;
  resultToCountMs: number | null;
  resultBytes: number | null;
  turnsBefore: number;
  turnsAfter: number;
  anchorShiftMaxPx: number;
  anchorShiftFinalPx: number;
  longFrameCount: number;
  maxFrameMs: number;
  longTaskTotalMs: number;
  longTaskMaxMs: number;
  commits: number;
  censusCommits: CommitRecord[];
}
