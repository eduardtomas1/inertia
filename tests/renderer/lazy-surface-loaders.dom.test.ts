import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadCommandPalette,
  scheduleFrequentSurfacePrefetch,
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
    await expect(first).resolves.toHaveProperty("CommandPalette");
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
});
