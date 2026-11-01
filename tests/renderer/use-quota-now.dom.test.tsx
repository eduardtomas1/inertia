import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useQuotaNow } from "../../src/renderer/src/hooks/useQuotaNow";

const START = Date.parse("2026-10-27T09:00:00.000Z");
let visibility: ReturnType<typeof vi.spyOn>;

function setVisibility(state: DocumentVisibilityState): void {
  visibility.mockReturnValue(state);
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
}

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});

afterEach(() => {
  visibility.mockRestore();
  vi.useRealTimers();
});

describe("quota clock", () => {
  const limits = [{ resetsAt: null }];

  it("ticks each minute only while the window is visible and catches up when it returns", () => {
    const setInterval = vi.spyOn(window, "setInterval");
    const { result } = renderHook(() => useQuotaNow(limits));
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(result.current[0]).toBe(START + 60_000);
    setVisibility("hidden");
    const intervalsWhileHidden = setInterval.mock.calls.length;
    act(() => { vi.advanceTimersByTime(10 * 60_000); });
    expect(result.current[0]).toBe(START + 60_000);
    expect(setInterval.mock.calls.length).toBe(intervalsWhileHidden);
    setVisibility("visible");
    expect(result.current[0]).toBe(START + 11 * 60_000);
    setInterval.mockRestore();
  });

  it("does not tick when there is nothing to show", () => {
    const empty = renderHook(() => useQuotaNow([]));
    const idle = renderHook(() => useQuotaNow(limits, false));
    act(() => { vi.advanceTimersByTime(5 * 60_000); });
    expect(empty.result.current[0]).toBe(START);
    expect(idle.result.current[0]).toBe(START);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still moves to the next reset while the window is hidden", () => {
    const reset = new Date(START + 90_000).toISOString();
    const { result } = renderHook(() => useQuotaNow([{ resetsAt: reset }]));
    setVisibility("hidden");
    act(() => { vi.advanceTimersByTime(90_050); });
    expect(result.current[0]).toBe(START + 90_050);
  });
});
