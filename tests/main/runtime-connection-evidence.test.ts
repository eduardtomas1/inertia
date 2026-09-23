import { EventEmitter } from "node:events";
import type { Page, TestInfo } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachRuntimeConnectionEvidence, createRuntimeConnectionEvidence } from "../e2e/support/runtime-connection-evidence";
import { observeElectronPage } from "../e2e/support/electron-app-lifecycle";

class FakePage extends EventEmitter {
  readonly frame = {};
  mainFrame() { return this.frame; }
  url() { throw new Error("URL must not be read"); }
  evaluate() { throw new Error("No renderer RPC is permitted"); }
}
class FakeSocket extends EventEmitter {
  url() { throw new Error("Endpoint must not be read"); }
}
const pageType = (page: FakePage) => page as unknown as Page;
const consoleError = (text: string) => ({ type: () => "error", text: () => text });
afterEach(() => { vi.useRealTimers(); });

describe("passive runtime connection evidence", () => {
  it("correlates late errors and closes with both request and delivery navigation", () => {
    let now = 0;
    const evidence = createRuntimeConnectionEvidence(() => now);
    const page = new FakePage();
    evidence.observe(pageType(page));
    const socket = new FakeSocket();
    page.emit("websocket", socket);
    page.emit("framenavigated", {}); // Child frames must not advance the ordinal.
    page.emit("framenavigated", page.frame);
    now = 12;
    socket.emit("socketerror", "net::ERR_NO_BUFFER_SPACE private endpoint");
    expect(evidence.snapshot().requestsWithoutObservedClose).toBe(1);
    socket.emit("close");
    socket.emit("close");
    const snapshot = evidence.snapshot();
    expect(snapshot).toMatchObject({ initialSocketCoverage: "partial-on-every-page", pagesObserved: 1,
      requestsObserved: 1, closeEventsObserved: 1, socketErrorsObserved: 1,
      requestsWithoutObservedClose: 0, peakRequestsWithoutObservedClose: 1 });
    expect(snapshot.events.slice(-2)).toEqual([
      { kind: "socket-error", pageOrdinal: 1, navigationOrdinal: 1, requestOrdinal: 1,
        requestNavigationOrdinal: 0, error: "ERR_NO_BUFFER_SPACE", sequence: 4, elapsedMs: 12 },
      { kind: "socket-close", pageOrdinal: 1, navigationOrdinal: 1, requestOrdinal: 1,
        requestNavigationOrdinal: 0, sequence: 5, elapsedMs: 12 },
    ]);
  });

  it("retains the latest bounded events, snapshots by value, and never retains raw diagnostics", () => {
    const evidence = createRuntimeConnectionEvidence();
    const page = new FakePage();
    evidence.observe(pageType(page));
    for (let i = 0; i < 40; i += 1) {
      const socket = new FakeSocket();
      page.emit("websocket", socket);
      socket.emit("socketerror", "net::ERR_PRIVATE_TOKEN ws://private.invalid/capability secret-header");
      socket.emit("close");
    }
    page.emit("console", consoleError("net::ERR_NO_BUFFER_SPACE_SUFFIX private"));
    page.emit("console", consoleError("net::ERR_NO_BUFFER_SPACE2 private"));
    page.emit("console", consoleError("net::ERR_NO_BUFFER_SPACEextra private"));
    page.emit("console", consoleError("net::ERR_NO_BUFFER_SPACE ws://private.invalid/capability"));
    const snapshot = evidence.snapshot();
    expect(snapshot.events).toHaveLength(32);
    expect(snapshot.droppedEvents).toBe(snapshot.totalEvents - 32);
    expect(snapshot.events.slice(-4, -1).map(event => event.error)).toEqual(["other", "other", "other"]);
    expect(snapshot.events.at(-1)?.error).toBe("ERR_NO_BUFFER_SPACE");
    const serialized = JSON.stringify(snapshot);
    expect(serialized.length).toBeLessThan(16_384);
    expect(serialized).not.toMatch(/PRIVATE|private|capability|header|ws:\/\//u);
    snapshot.events[0]!.sequence = -1;
    snapshot.events.pop();
    expect(evidence.snapshot().events).toHaveLength(32);
    expect(evidence.snapshot().events[0]!.sequence).toBeGreaterThan(0);
  });

  it("keeps page ordinals separate and bounds nonfinite or negative clock observations", () => {
    let now = 0;
    const evidence = createRuntimeConnectionEvidence(() => now);
    now = Number.NaN;
    evidence.observe(pageType(new FakePage()));
    now = -100;
    evidence.observe(pageType(new FakePage()));
    expect(evidence.snapshot().events.map(event => [event.pageOrdinal, event.elapsedMs])).toEqual([[1, 0], [2, 0]]);
  });

  it("installs the opt-in observer after the existing page error listeners", () => {
    const page = new FakePage();
    const observer = vi.fn((current: Page) => {
      expect(current).toBe(page);
      expect(page.listenerCount("console")).toBe(1);
      expect(page.listenerCount("requestfailed")).toBe(1);
    });
    observeElectronPage(pageType(page), [], undefined, observer);
    expect(observer).toHaveBeenCalledOnce();
  });

  it("does not let rejected attachment or throwing snapshot replace the assertion", async () => {
    const snapshot = createRuntimeConnectionEvidence().snapshot;
    const attach = vi.fn<TestInfo["attach"]>().mockRejectedValue(new Error("reporter unavailable"));
    await expect(attachRuntimeConnectionEvidence(() => ({ attach }), snapshot)).resolves.toBeUndefined();
    expect(attach).toHaveBeenCalledOnce();
    await expect(attachRuntimeConnectionEvidence(() => ({ attach }), () => { throw new Error("snapshot unavailable"); }))
      .resolves.toBeUndefined();
    expect(attach).toHaveBeenCalledOnce();
  });

  it("bounds a hung attachment to one existing 250ms attempt", async () => {
    vi.useFakeTimers();
    const attach = vi.fn<TestInfo["attach"]>(() => new Promise(() => {}));
    let settled = false;
    const pending = attachRuntimeConnectionEvidence(() => ({ attach }), createRuntimeConnectionEvidence().snapshot)
      .then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(249);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(attach).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
