import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadCommandPalette,
  loadTasksView,
  loadWorkspaceTerminal,
  prefetchFrequentSurfaces,
  scheduleFrequentSurfacePrefetch,
  SURFACES_PREFETCHED_ATTRIBUTE,
} from "../../src/renderer/src/components/lazySurfaceLoaders";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("lazy surface prefetching", () => {
  it("reuses the exact module promise used by the lazy component", async () => {
    const first = loadCommandPalette();
    const second = loadCommandPalette();

    expect(second).toBe(first);
    expect(loadCommandPalette.peek()).toBeNull();
    await expect(first).resolves.toHaveProperty("default");
    expect(loadCommandPalette.peek()).toHaveProperty("default");
  });

  it("waits for an idle workspace window and cancels on cleanup", () => {
    let idleCallback: IdleRequestCallback | null = null;
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      idleCallback = callback;
      return 17;
    });
    const cancelIdleCallback = vi.fn();
    const setTimeoutSpy = vi.fn(() => 23);
    const clearTimeoutSpy = vi.fn();
    vi.stubGlobal("window", {
      requestIdleCallback,
      cancelIdleCallback,
      setTimeout: setTimeoutSpy,
      clearTimeout: clearTimeoutSpy,
    });

    const cancel = scheduleFrequentSurfacePrefetch();
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 750,
    });
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 750);
    expect(idleCallback).not.toBeNull();
    cancel();
    expect(cancelIdleCallback).toHaveBeenCalledWith(17);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(23);
  });

  it("leaves the workspace terminal to load on intent", async () => {
    await prefetchFrequentSurfaces();

    expect(loadTasksView.peek()).toHaveProperty("default");
    expect(loadWorkspaceTerminal.peek()).toBeNull();
  });

  it("marks the document once the idle prefetch has loaded, and not after cleanup", async () => {
    vi.useFakeTimers();
    const dataset: Record<string, string> = {};
    vi.stubGlobal("document", { documentElement: { dataset } });
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    try {
      const cancel = scheduleFrequentSurfacePrefetch();
      cancel();
      await vi.advanceTimersByTimeAsync(750);
      await prefetchFrequentSurfaces();
      expect(dataset[SURFACES_PREFETCHED_ATTRIBUTE]).toBeUndefined();

      scheduleFrequentSurfacePrefetch();
      expect(dataset[SURFACES_PREFETCHED_ATTRIBUTE]).toBeUndefined();
      await vi.advanceTimersByTimeAsync(750);
      await prefetchFrequentSurfaces();
      expect(dataset[SURFACES_PREFETCHED_ATTRIBUTE]).toBe("ready");
      expect(loadCommandPalette.peek()).toHaveProperty("default");
    } finally {
      vi.useRealTimers();
    }
  });

});
