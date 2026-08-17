import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAppUpdate } from "../../src/renderer/src/hooks/useAppUpdate";
import type { AppUpdateStatus, DesktopBridge } from "../../src/shared/desktop";

function update(revision: number, message: string): AppUpdateStatus {
  return {
    revision,
    state: "available",
    freshness: "fresh",
    delivery: "in-app",
    deliveryReason: null,
    installBlocker: null,
    progress: null,
    currentVersion: "0.0.35",
    latestVersion: "0.0.36",
    releaseUrl: "https://github.com/eduardtomas1/inertia/releases/tag/v0.0.36",
    checkedAt: "2030-01-01T00:00:00.000Z",
    lastAttemptedAt: "2030-01-01T00:00:00.000Z",
    message,
  };
}

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "inertia");
  window.localStorage.clear();
});

describe("application update controller", () => {
  it("subscribes before checking and refuses a stale invoke response", async () => {
    vi.useFakeTimers();
    let listener!: (status: AppUpdateStatus) => void;
    let resolveCheck!: (status: AppUpdateStatus) => void;
    const unsubscribe = vi.fn();
    const check = vi.fn(() => new Promise<AppUpdateStatus>((resolve) => {
      resolveCheck = resolve;
    }));
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        checkAppUpdate: check,
        onAppUpdateStatus: (next: (status: AppUpdateStatus) => void) => {
          listener = next;
          return unsubscribe;
        },
      } as unknown as DesktopBridge,
    });

    const hook = renderHook(() => useAppUpdate());
    let checking!: Promise<void>;
    act(() => {
      checking = hook.result.current.check(true);
    });
    act(() => listener(update(5, "newest")));
    await act(async () => {
      resolveCheck(update(4, "stale"));
      await checking;
    });

    expect(hook.result.current.status?.revision).toBe(5);
    expect(hook.result.current.status?.message).toBe("newest");
    hook.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("surfaces and dismisses a sanitized bridge failure", async () => {
    vi.useFakeTimers();
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        checkAppUpdate: vi.fn(async () => { throw new Error("private transport detail"); }),
        onAppUpdateStatus: vi.fn(() => () => undefined),
      } as unknown as DesktopBridge,
    });
    const hook = renderHook(() => useAppUpdate());

    await act(async () => {
      await expect(hook.result.current.check(true)).rejects.toThrow();
    });
    expect(hook.result.current.error).toBe("The update check could not be completed.");
    act(() => hook.result.current.dismissError());
    expect(hook.result.current.error).toBeNull();
  });
});
