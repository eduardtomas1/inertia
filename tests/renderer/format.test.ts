import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatClockTime,
  formatRelativeTime,
} from "../../src/renderer/src/lib/format";
import { INTERFACE_LOCALE } from "../../src/renderer/src/lib/locale";

describe("renderer time labels", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the English interface language independent of the operating-system locale", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));

    expect(formatRelativeTime("2026-07-22T11:59:59.000Z")).toBe("1 second ago");
    expect(formatRelativeTime("2026-07-20T12:00:00.000Z")).toBe("2 days ago");
    expect(formatClockTime("2026-07-22T12:05:00.000Z")).toMatch(/\d{1,2}:05\s[AP]M/u);
    expect(INTERFACE_LOCALE).toBe("en");
  });
});
