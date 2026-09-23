import type { Page, TestInfo } from "@playwright/test";
import { settleOperationBounded } from "./electron-app-lifecycle";

const MAX_EVENTS = 32;
const MAX_COUNTER = 2_147_483_647;
const netErrors = ["ERR_NO_BUFFER_SPACE", "ERR_INSUFFICIENT_RESOURCES", "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_RESET", "ERR_CONNECTION_CLOSED", "ERR_ABORTED"] as const;
type NetError = typeof netErrors[number] | "other";
type EventKind = "page-observed" | "main-frame-navigation" | "socket-request" | "socket-error" | "socket-close" | "console-net-error";
interface ConnectionEvent {
  sequence: number; elapsedMs: number; pageOrdinal: number; navigationOrdinal: number; kind: EventKind;
  requestOrdinal?: number; requestNavigationOrdinal?: number; error?: NetError;
}

function increment(value: number): number { return Math.min(MAX_COUNTER, value + 1); }
function netError(message: string): NetError {
  const observed = /net::([A-Za-z0-9_]+)/u.exec(message)?.[1];
  return netErrors.find(code => code === observed) ?? "other";
}

/** Passive request/close observations; they do not establish open socket counts. */
export function createRuntimeConnectionEvidence(now: () => number = () => performance.now()) {
  const started = now();
  const events: ConnectionEvent[] = [];
  let pagesObserved = 0, totalEvents = 0, droppedEvents = 0;
  let requestsObserved = 0, closeEventsObserved = 0, socketErrorsObserved = 0, consoleNetErrorsObserved = 0;
  let requestsWithoutObservedClose = 0, peakRequestsWithoutObservedClose = 0;
  const record = (event: Omit<ConnectionEvent, "sequence" | "elapsedMs">): void => {
    totalEvents = increment(totalEvents);
    const elapsed = now() - started;
    events.push({ ...event, sequence: totalEvents,
      elapsedMs: Number.isFinite(elapsed) ? Math.min(MAX_COUNTER, Math.max(0, Math.round(elapsed))) : 0 });
    if (events.length > MAX_EVENTS) { events.shift(); droppedEvents = increment(droppedEvents); }
  };
  return {
    observe(page: Page): void {
      pagesObserved = increment(pagesObserved);
      const pageOrdinal = pagesObserved;
      let navigationOrdinal = 0;
      record({ kind: "page-observed", pageOrdinal, navigationOrdinal });
      page.on("framenavigated", frame => {
        if (frame !== page.mainFrame()) return;
        navigationOrdinal = increment(navigationOrdinal);
        record({ kind: "main-frame-navigation", pageOrdinal, navigationOrdinal });
      });
      page.on("websocket", socket => {
        requestsObserved = increment(requestsObserved);
        requestsWithoutObservedClose = increment(requestsWithoutObservedClose);
        peakRequestsWithoutObservedClose = Math.max(peakRequestsWithoutObservedClose, requestsWithoutObservedClose);
        const requestOrdinal = requestsObserved, requestNavigationOrdinal = navigationOrdinal;
        const context = { pageOrdinal, requestOrdinal, requestNavigationOrdinal };
        record({ kind: "socket-request", ...context, navigationOrdinal });
        socket.on("socketerror", message => {
          socketErrorsObserved = increment(socketErrorsObserved);
          record({ kind: "socket-error", ...context, navigationOrdinal, error: netError(message) });
        });
        socket.once("close", () => {
          closeEventsObserved = increment(closeEventsObserved);
          requestsWithoutObservedClose = Math.max(0, requestsWithoutObservedClose - 1);
          record({ kind: "socket-close", ...context, navigationOrdinal });
        });
      });
      page.on("console", message => {
        if (message.type() !== "error") return;
        const text = message.text();
        if (!text.includes("net::")) return;
        consoleNetErrorsObserved = increment(consoleNetErrorsObserved);
        record({ kind: "console-net-error", pageOrdinal, navigationOrdinal, error: netError(text) });
      });
    },
    snapshot() {
      return { schemaVersion: 1, clock: "observer-event-delivery", initialSocketCoverage: "partial-on-every-page",
        pagesObserved, requestsObserved, closeEventsObserved, socketErrorsObserved, consoleNetErrorsObserved,
        requestsWithoutObservedClose, peakRequestsWithoutObservedClose, totalEvents, droppedEvents,
        events: events.map(event => ({ ...event })) };
    },
  };
}

export async function attachRuntimeConnectionEvidence(
  readTestInfo: () => Pick<TestInfo, "attach">,
  snapshot: () => ReturnType<ReturnType<typeof createRuntimeConnectionEvidence>["snapshot"]>,
): Promise<void> {
  // Failure-only, one bounded attempt. Reporting cannot replace the assertion.
  await settleOperationBounded(Promise.resolve().then(() => readTestInfo().attach("runtime-connection-observations", {
    body: Buffer.from(JSON.stringify(snapshot())), contentType: "application/json",
  })), 250);
}
