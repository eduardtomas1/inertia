import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

export const MAX_MARKDOWN_IMAGES_PER_DOCUMENT = 8;
export const MAX_CONCURRENT_MARKDOWN_IMAGE_LOADS = 2;

export type MarkdownImageScheduleState =
  | "error"
  | "loaded"
  | "loading"
  | "overflow"
  | "waiting";

interface ScheduledImageEntry {
  token: symbol;
  element: HTMLElement;
  notify: (state: MarkdownImageScheduleState) => void;
  admitted: boolean;
  near: boolean;
  state: MarkdownImageScheduleState;
}

interface ScheduledImageRegistration {
  complete: (failed: boolean) => void;
  dispose: () => void;
}

class MarkdownImageScheduler {
  private readonly entries = new Map<symbol, ScheduledImageEntry>();
  private readonly elementTokens = new Map<Element, symbol>();
  private observer: IntersectionObserver | null | undefined;
  private activeLoads = 0;
  private disposed = false;

  register(
    element: HTMLElement,
    notify: (state: MarkdownImageScheduleState) => void,
  ): ScheduledImageRegistration {
    const token = Symbol("markdown-image");
    const entry: ScheduledImageEntry = {
      token,
      element,
      notify,
      admitted: false,
      near: false,
      state: "waiting",
    };
    this.entries.set(token, entry);
    this.elementTokens.set(element, token);
    this.rebalanceAdmissions();
    return {
      complete: (failed) => this.complete(token, failed),
      dispose: () => this.unregister(token),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer?.disconnect();
    this.entries.clear();
    this.elementTokens.clear();
    this.activeLoads = 0;
  }

  private intersectionObserver(): IntersectionObserver | null {
    if (this.observer !== undefined) return this.observer;
    if (typeof IntersectionObserver === "undefined") {
      this.observer = null;
      return null;
    }
    this.observer = new IntersectionObserver((observations) => {
      for (const observation of observations) {
        const token = this.elementTokens.get(observation.target);
        const entry = token ? this.entries.get(token) : undefined;
        if (!entry?.admitted) continue;
        const near = observation.isIntersecting || observation.intersectionRatio > 0;
        if (entry.near === near) continue;
        entry.near = near;
        if (!near && (entry.state === "loading" || entry.state === "loaded")) {
          if (entry.state === "loading") this.activeLoads -= 1;
          this.update(entry, "waiting");
        }
      }
      this.pump();
    }, { rootMargin: "600px 0px" });
    return this.observer;
  }

  private rebalanceAdmissions(): void {
    let admitted = 0;
    for (const entry of this.entries.values()) {
      const shouldAdmit = admitted < MAX_MARKDOWN_IMAGES_PER_DOCUMENT;
      if (shouldAdmit) admitted += 1;
      if (shouldAdmit === entry.admitted) {
        if (!shouldAdmit) this.update(entry, "overflow");
        continue;
      }
      if (shouldAdmit) {
        entry.admitted = true;
        entry.near = false;
        this.update(entry, "waiting");
        const observer = this.intersectionObserver();
        if (observer) observer.observe(entry.element);
        else entry.near = true;
      } else {
        this.intersectionObserver()?.unobserve(entry.element);
        if (entry.state === "loading") this.activeLoads -= 1;
        entry.admitted = false;
        entry.near = false;
        this.update(entry, "overflow");
      }
    }
    this.pump();
  }

  private pump(): void {
    if (this.disposed) return;
    for (const entry of this.entries.values()) {
      if (this.activeLoads >= MAX_CONCURRENT_MARKDOWN_IMAGE_LOADS) return;
      if (!entry.admitted || !entry.near || entry.state !== "waiting") continue;
      this.activeLoads += 1;
      this.update(entry, "loading");
    }
  }

  private complete(token: symbol, failed: boolean): void {
    const entry = this.entries.get(token);
    if (!entry || entry.state !== "loading") return;
    this.activeLoads -= 1;
    this.update(entry, failed ? "error" : "loaded");
    this.pump();
  }

  private unregister(token: symbol): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    this.intersectionObserver()?.unobserve(entry.element);
    if (entry.state === "loading") this.activeLoads -= 1;
    this.entries.delete(token);
    this.elementTokens.delete(entry.element);
    this.rebalanceAdmissions();
  }

  private update(
    entry: ScheduledImageEntry,
    state: MarkdownImageScheduleState,
  ): void {
    if (entry.state === state) return;
    entry.state = state;
    entry.notify(state);
  }
}

const MarkdownImageSchedulerContext = createContext<MarkdownImageScheduler | null>(
  null,
);

export function MarkdownImageSchedulerProvider({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const schedulerRef = useRef<MarkdownImageScheduler | null>(null);
  if (!schedulerRef.current) schedulerRef.current = new MarkdownImageScheduler();
  const scheduler = schedulerRef.current;
  useEffect(() => () => scheduler.dispose(), [scheduler]);
  return (
    <MarkdownImageSchedulerContext.Provider value={scheduler}>
      {children}
    </MarkdownImageSchedulerContext.Provider>
  );
}

export function useMarkdownImageSchedule(source: string | null): {
  complete: (failed: boolean) => void;
  shellRef: RefObject<HTMLSpanElement | null>;
  state: MarkdownImageScheduleState;
} {
  const scheduler = useContext(MarkdownImageSchedulerContext);
  if (!scheduler) throw new Error("Markdown image scheduler is unavailable.");
  const shellRef = useRef<HTMLSpanElement>(null);
  const registrationRef = useRef<ScheduledImageRegistration | null>(null);
  const [snapshot, setSnapshot] = useState<{
    source: string | null;
    state: MarkdownImageScheduleState;
  }>({ source: null, state: "waiting" });
  useEffect(() => {
    const element = shellRef.current;
    if (!source || !element) return;
    const registration = scheduler.register(element, (state) => {
      setSnapshot({ source, state });
    });
    registrationRef.current = registration;
    return () => {
      if (registrationRef.current === registration) {
        registrationRef.current = null;
      }
      registration.dispose();
    };
  }, [scheduler, source]);
  const complete = useCallback((failed: boolean): void => {
    registrationRef.current?.complete(failed);
  }, []);
  return {
    complete,
    shellRef,
    state: snapshot.source === source ? snapshot.state : "waiting",
  };
}
