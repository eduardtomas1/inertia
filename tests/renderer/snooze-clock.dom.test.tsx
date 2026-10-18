import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { nextSnoozeExpiry, useSnoozeClock } from "../../src/renderer/src/hooks/useSnoozeClock";
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

  it("re-renders within a minute when a snooze or the day ended while the computer slept", () => {
    vi.useFakeTimers();
    const start = new Date(2026, 7, 9, 18, 0, 0).getTime();
    vi.setSystemTime(start);
    const conversations = [{ snoozedUntil: new Date(start + 2 * 60 * 60 * 1_000).toISOString() }] as Conversation[];
    const { result } = renderHook(() => useSnoozeClock(conversations));
    vi.setSystemTime(start + 14 * 60 * 60 * 1_000);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBeGreaterThanOrEqual(start + 14 * 60 * 60 * 1_000);
  });
});
