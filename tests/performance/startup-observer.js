(() => {
  if (globalThis.__inertiaStartupObserver) return;
  const now = () => performance.timeOrigin + performance.now();
  const state = {
    installedAt: now(),
    installedReadyState: document.readyState,
    timeOrigin: performance.timeOrigin,
    seen: {},
    painted: {},
    sockets: [],
    longTasks: [],
    lcp: [],
    done: false,
  };
  globalThis.__inertiaStartupObserver = state;
  const probes = {
    rootChild: () => document.getElementById("root")?.firstElementChild,
    appShell: () => document.querySelector(".app-shell"),
    online: () => document.querySelector('.app-shell[data-connection-status="online"]'),
    sidebarRow: () => document.querySelector(".activity-thread-title"),
    composer: () => document.querySelector('[aria-label="Message"]'),
    transcriptRow: () => document.querySelector(".message-scroll .response-virtual-item"),
  };
  const afterPaint = (name) => {
    requestAnimationFrame(() => {
      const frame = now();
      setTimeout(() => {
        state.painted[name] = { frame, afterFrame: now() };
      }, 0);
    });
  };
  const check = () => {
    for (const [name, probe] of Object.entries(probes)) {
      if (state.seen[name] !== undefined) continue;
      let element = null;
      try {
        element = probe();
      } catch {
        element = null;
      }
      if (!element) continue;
      state.seen[name] = now();
      if (name === "transcriptRow") {
        state.transcriptRowsAtFirstSight = document.querySelectorAll(".message-scroll .response-virtual-item").length;
      }
      afterPaint(name);
    }
    if (state.seen.composer !== undefined && state.seen.transcriptRow !== undefined && state.seen.online !== undefined) {
      if (!state.doneScheduled) {
        state.doneScheduled = true;
        setTimeout(() => {
          state.analyzeWelcome();
          state.done = true;
          state.doneAt = now();
          state.transcriptRowsAtDone = document.querySelectorAll(".message-scroll .response-virtual-item").length;
          state.sidebarRowsAtDone = document.querySelectorAll(".activity-thread-title").length;
          observer.disconnect();
        }, 1500);
      }
    }
  };
  const observer = new MutationObserver(check);
  const startObserving = () => {
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-connection-status", "class"] });
    check();
  };
  if (document.documentElement) startObserving();
  else document.addEventListener("readystatechange", startObserving, { once: true });
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTasks.push({ start: performance.timeOrigin + entry.startTime, duration: entry.duration });
      }
    }).observe({ type: "longtask", buffered: true });
  } catch {
    state.longTaskUnsupported = true;
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.lcp.push({ at: performance.timeOrigin + entry.startTime, size: entry.size, element: entry.element?.className ?? null });
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch {
    state.lcpUnsupported = true;
  }
  const pendingWelcome = [];
  state.analyzeWelcome = () => {
    for (const [entry, text] of pendingWelcome.splice(0)) {
      try {
        const parsed = JSON.parse(text);
        const snapshot = parsed.snapshot ?? {};
        entry.welcome = {
          topLevelKeys: Object.keys(snapshot).map((key) => [key, JSON.stringify(snapshot[key] ?? null).length]),
          projects: Array.isArray(snapshot.projects) ? snapshot.projects.length : null,
          conversations: Array.isArray(snapshot.conversations) ? snapshot.conversations.length : null,
        };
      } catch {
        entry.welcome = { unparsable: true };
      }
    }
  };
  const NativeWebSocket = globalThis.WebSocket;
  if (NativeWebSocket) {
    const Wrapped = function (url, protocols) {
      const socket = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
      const record = { createdAt: now(), openedAt: null, messages: [] };
      state.sockets.push(record);
      socket.addEventListener("open", () => { record.openedAt = now(); });
      socket.addEventListener("message", (message) => {
        if (record.messages.length >= 64) return;
        const data = message.data;
        const text = typeof data === "string" ? data : null;
        let type = null;
        if (text) {
          const match = /^\{"type":"([^"]+)"/u.exec(text.slice(0, 64));
          type = match ? match[1] : null;
        }
        const entry = {
          at: now(),
          bytes: text ? text.length : (data?.byteLength ?? data?.size ?? null),
          type,
        };
        if (type === "server.welcome" && text) pendingWelcome.push([entry, text]);
        record.messages.push(entry);
      });
      return socket;
    };
    Wrapped.prototype = NativeWebSocket.prototype;
    for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Wrapped[key] = NativeWebSocket[key];
    globalThis.WebSocket = Wrapped;
  }
})();
