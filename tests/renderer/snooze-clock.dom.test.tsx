import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  nextLocalDayBoundary,
  nextSnoozeExpiry,
  useSnoozeClock,
} from "../../src/renderer/src/hooks/useSnoozeClock";
import type { Conversation } from "../../src/shared/contracts";

afterEach(() => {
  vi.useRealTimers();
});

describe("sidebar snooze clock", () => {
  it("selects the earliest future expiry and re-renders when it passes", () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-08-09T10:00:00.000Z");
    vi.setSystemTime(start);
    const conversations = [
      { snoozedUntil: new Date(start + 5_000).toISOString() },
      { snoozedUntil: new Date(start + 1_000).toISOString() },
      { snoozedUntil: new Date(start - 1_000).toISOString() },
    ] as Conversation[];

    expect(nextSnoozeExpiry(conversations, start)).toBe(start + 1_000);
    const { result } = renderHook(() => useSnoozeClock(conversations));
    expect(result.current).toBe(start);

    act(() => {
      vi.advanceTimersByTime(1_001);
    });
    expect(result.current).toBe(start + 1_001);
  });

  it("re-renders at the next local day boundary without a snooze", () => {
    vi.useFakeTimers();
    const start = new Date(2026, 7, 9, 23, 59, 59, 900).getTime();
    vi.setSystemTime(start);

    const boundary = nextLocalDayBoundary(start);
    expect(boundary - start).toBe(100);
    const { result } = renderHook(() => useSnoozeClock([]));
    expect(result.current).toBe(start);

    act(() => {
      vi.advanceTimersByTime(101);
    });
    expect(result.current).toBe(start + 101);
  });
});
