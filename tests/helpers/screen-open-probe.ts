import type { Page } from "@playwright/test";

export interface ScreenOpenTarget {
  selector: string;
  text?: string;
  ready?: "visible" | "settled";
}

export type ScreenOpenStart =
  | { kind: "pointer" }
  | { kind: "key"; key: string };

export interface ScreenOpenFrame {
  t: number;
  type: string | null;
  inner: string | null;
  requestId: string | null;
  bytes: number;
}

export interface ScreenOpenLongTask {
  start: number;
  duration: number;
}

export interface ScreenOpenObservation {
  inputTimeStamp: number;
  handlerStartedAt: number;
  shellVisibleAt: number | null;
  contentVisibleAt: number;
  paintedAt: number;
  sent: ScreenOpenFrame[];
  received: ScreenOpenFrame[];
  longTasks: ScreenOpenLongTask[];
  timeOrigin: number;
}

export interface ScreenOpenCommand {
  type: string | null;
  sentAfterInputMs: number;
  roundTripMs: number | null;
  responseBytes: number | null;
  settledBeforePaint: boolean;
}

export interface ScreenOpenSample {
  inputAtEpochMs: number;
  paintAtEpochMs: number;
  inputToPaintMs: number;
  inputToContentMs: number;
  inputToShellMs: number | null;
  inputDispatchDelayMs: number;
  longTaskCount: number;
  longTaskTotalMs: number;
  longestTaskMs: number;
  postPaintLongTaskMs: number;
  commands: ScreenOpenCommand[];
  receivedFrames: number;
  receivedBytes: number;
}

const POST_PAINT_OBSERVATION_MS = 500;
const OBSERVATION_TIMEOUT_MS = 20_000;

export async function installScreenOpenProbe(page: Page): Promise<void> {
  await page.evaluate((postPaintMs) => {
    const scope = globalThis as typeof globalThis & { __screenOpenProbe?: unknown };
    if (scope.__screenOpenProbe) return;
    interface Armed {
      start: { kind: "pointer" } | { kind: "key"; key: string };
      target: { selector: string; text?: string; ready?: "visible" | "settled" };
      inputTimeStamp: number | null;
      handlerStartedAt: number | null;
      shellVisibleAt: number | null;
      contentVisibleAt: number | null;
      paintedAt: number | null;
      sent: unknown[];
      received: unknown[];
      longTasks: { start: number; duration: number }[];
      settle: (value: unknown) => void;
      fail: (error: Error) => void;
      done: Promise<unknown>;
      observer: MutationObserver | null;
      timeout: number;
    }
    let armed: Armed | null = null;
    const seenMessages = new WeakSet<MessageEvent>();
    const typePattern = /^\{"type":"([^"]+)"/u;
    const innerPattern = /"event":\{"type":"([^"]+)"/u;
    const requestPattern = /"requestId":"([^"]+)"/u;
    const describe = (data: string) => {
      const head = data.slice(0, 400);
      const type = typePattern.exec(head)?.[1] ?? null;
      const request = type?.startsWith("request.") || type === "terminal.created"
        ? requestPattern.exec(data.slice(0, 4_096))
        : requestPattern.exec(head);
      return {
        t: performance.now(),
        type,
        inner: innerPattern.exec(head)?.[1] ?? null,
        requestId: request?.[1] ?? null,
        bytes: data.length,
      };
    };
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function send(this: WebSocket, data) {
      if (armed && typeof data === "string") armed.sent.push(describe(data));
      return originalSend.call(this, data);
    };
    const dataDescriptor = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data");
    if (dataDescriptor?.get) {
      const readData = dataDescriptor.get;
      Object.defineProperty(MessageEvent.prototype, "data", {
        configurable: true,
        enumerable: dataDescriptor.enumerable ?? true,
        get(this: MessageEvent) {
          const value: unknown = readData.call(this);
          if (
            armed
            && typeof value === "string"
            && this.target instanceof WebSocket
            && !seenMessages.has(this)
          ) {
            seenMessages.add(this);
            armed.received.push(describe(value));
          }
          return value;
        },
      });
    }
    new PerformanceObserver((list) => {
      if (!armed) return;
      for (const entry of list.getEntries()) {
        armed.longTasks.push({ start: entry.startTime, duration: entry.duration });
      }
    }).observe({ entryTypes: ["longtask"] });
    const visible = (element: Element): boolean => {
      if (!element.isConnected) return false;
      if (!element.checkVisibility({ checkOpacity: true, visibilityProperty: true })) return false;
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0
        && bounds.bottom > 0 && bounds.right > 0
        && bounds.top < window.innerHeight && bounds.left < window.innerWidth;
    };
    const matches = (state: Armed): { shell: boolean; content: boolean } => {
      const elements = Array.from(document.querySelectorAll(state.target.selector)).filter(visible);
      if (elements.length === 0) return { shell: false, content: false };
      const withText = state.target.text
        ? elements.filter((element) => (element.textContent ?? "").includes(state.target.text!))
        : elements;
      if (withText.length === 0) return { shell: true, content: false };
      if (state.target.ready === "settled") {
        const settled = withText.some((element) =>
          element.querySelector('[aria-busy="true"], .loading-mark') === null
          && element.getAttribute("aria-busy") !== "true");
        return { shell: true, content: settled };
      }
      return { shell: true, content: true };
    };
    const frame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(() => resolve(performance.now())));
    const finish = async (state: Armed): Promise<void> => {
      await frame();
      state.paintedAt = await frame();
      performance.mark("screen-open:paint", { startTime: state.paintedAt });
      state.observer?.disconnect();
      await new Promise((resolve) => window.setTimeout(resolve, postPaintMs));
      window.clearTimeout(state.timeout);
      state.settle({
        inputTimeStamp: state.inputTimeStamp,
        handlerStartedAt: state.handlerStartedAt,
        shellVisibleAt: state.shellVisibleAt,
        contentVisibleAt: state.contentVisibleAt,
        paintedAt: state.paintedAt,
        sent: state.sent,
        received: state.received,
        longTasks: state.longTasks,
        timeOrigin: performance.timeOrigin,
      });
      if (armed === state) armed = null;
    };
    const check = (state: Armed): void => {
      if (state.inputTimeStamp === null || state.contentVisibleAt !== null) return;
      const result = matches(state);
      if (result.shell && state.shellVisibleAt === null) state.shellVisibleAt = performance.now();
      if (!result.content) return;
      state.contentVisibleAt = performance.now();
      performance.mark("screen-open:content", { startTime: state.contentVisibleAt });
      void finish(state);
    };
    const poll = (state: Armed): void => {
      if (state.contentVisibleAt !== null || armed !== state) return;
      check(state);
      requestAnimationFrame(() => poll(state));
    };
    const onInput = (event: Event): void => {
      const state = armed;
      if (!state || state.inputTimeStamp !== null) return;
      if (state.start.kind === "pointer" && event.type !== "pointerdown") return;
      if (state.start.kind === "key") {
        if (event.type !== "keydown") return;
        if ((event as KeyboardEvent).key.toLowerCase() !== state.start.key.toLowerCase()) return;
      }
      state.inputTimeStamp = event.timeStamp;
      state.handlerStartedAt = performance.now();
      performance.mark("screen-open:input", { startTime: event.timeStamp });
      state.observer = new MutationObserver(() => check(state));
      state.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      requestAnimationFrame(() => poll(state));
    };
    window.addEventListener("pointerdown", onInput, { capture: true });
    window.addEventListener("keydown", onInput, { capture: true });
    scope.__screenOpenProbe = {
      arm(start: Armed["start"], target: Armed["target"], timeoutMs: number) {
        if (armed) armed.fail(new Error("A previous screen-open observation was still armed."));
        let settle!: (value: unknown) => void;
        let fail!: (error: Error) => void;
        const done = new Promise((resolve, reject) => {
          settle = resolve;
          fail = reject;
        });
        void done.catch(() => undefined);
        const state: Armed = {
          start,
          target,
          inputTimeStamp: null,
          handlerStartedAt: null,
          shellVisibleAt: null,
          contentVisibleAt: null,
          paintedAt: null,
          sent: [],
          received: [],
          longTasks: [],
          settle,
          fail,
          done,
          observer: null,
          timeout: window.setTimeout(() => {
            state.observer?.disconnect();
            if (armed === state) armed = null;
            fail(new Error(`Screen target did not appear: ${target.selector} ${target.text ?? ""} (input ${state.inputTimeStamp === null ? "missing" : "seen"}, shell ${state.shellVisibleAt === null ? "missing" : "seen"})`));
          }, timeoutMs),
        };
        armed = state;
      },
      async result() {
        if (!armed) throw new Error("No screen-open observation is armed.");
        return await armed.done;
      },
      disarm() {
        if (!armed) return;
        window.clearTimeout(armed.timeout);
        armed.observer?.disconnect();
        armed = null;
      },
    };
  }, POST_PAINT_OBSERVATION_MS);
}

export async function armScreenOpen(
  page: Page,
  start: ScreenOpenStart,
  target: ScreenOpenTarget,
): Promise<void> {
  await page.evaluate(({ start, target, timeoutMs }) => {
    const probe = (globalThis as typeof globalThis & {
      __screenOpenProbe: { arm: (start: unknown, target: unknown, timeoutMs: number) => void };
    }).__screenOpenProbe;
    probe.arm(start, target, timeoutMs);
  }, { start, target, timeoutMs: OBSERVATION_TIMEOUT_MS });
}

export async function readScreenOpen(page: Page): Promise<ScreenOpenObservation> {
  return await page.evaluate(async () => {
    const probe = (globalThis as typeof globalThis & {
      __screenOpenProbe: { result: () => Promise<unknown> };
    }).__screenOpenProbe;
    return await probe.result();
  }) as ScreenOpenObservation;
}

export async function disarmScreenOpen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = (globalThis as typeof globalThis & {
      __screenOpenProbe?: { disarm: () => void };
    }).__screenOpenProbe;
    probe?.disarm();
  }).catch(() => undefined);
}

function round(value: number): number {
  return Number(value.toFixed(1));
}

export function summarizeScreenOpen(observation: ScreenOpenObservation): ScreenOpenSample {
  const start = observation.inputTimeStamp;
  const tasks = observation.longTasks.filter((task) => task.start + task.duration >= start);
  const duringOpen = tasks.filter((task) => task.start <= observation.paintedAt);
  const postPaint = tasks.filter((task) => task.start > observation.paintedAt);
  const commands = observation.sent
    .filter((frame) => frame.requestId !== null)
    .map((frame) => {
      const response = observation.received.find((received) =>
        received.requestId === frame.requestId
        && received.type !== null
        && (received.type.startsWith("request.") || received.type === "terminal.created"));
      return {
        type: frame.type,
        sentAfterInputMs: round(frame.t - start),
        roundTripMs: response ? round(response.t - frame.t) : null,
        responseBytes: response?.bytes ?? null,
        settledBeforePaint: response !== undefined && response.t <= observation.paintedAt,
      };
    });
  return {
    inputAtEpochMs: round(observation.timeOrigin + start),
    paintAtEpochMs: round(observation.timeOrigin + observation.paintedAt),
    inputToPaintMs: round(observation.paintedAt - start),
    inputToContentMs: round(observation.contentVisibleAt - start),
    inputToShellMs: observation.shellVisibleAt === null ? null : round(observation.shellVisibleAt - start),
    inputDispatchDelayMs: round(observation.handlerStartedAt - start),
    longTaskCount: duringOpen.length,
    longTaskTotalMs: round(duringOpen.reduce((total, task) => total + task.duration, 0)),
    longestTaskMs: round(Math.max(0, ...duringOpen.map((task) => task.duration))),
    postPaintLongTaskMs: round(postPaint.reduce((total, task) => total + task.duration, 0)),
    commands,
    receivedFrames: observation.received.length,
    receivedBytes: observation.received.reduce((total, frame) => total + frame.bytes, 0),
  };
}
