import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
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
});
