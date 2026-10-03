import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatFullDateTime,
  formatMessageTime,
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
    expect(formatMessageTime("2026-07-22T12:05:00.000Z")).toMatch(/^\d{1,2}:05\s[AP]M$/u);
    expect(INTERFACE_LOCALE).toBe("en");
  });

  it("dates message times by the local calendar day outside UTC", () => {
    const original = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const now = new Date("2026-07-22T12:00:00.000Z");
      expect(formatMessageTime("2026-07-22T03:00:00.000Z", now)).toMatch(/^Jul 21, 8:00\sPM$/u);
      expect(formatMessageTime("2026-07-22T08:00:00.000Z", now)).toMatch(/^1:00\sAM$/u);
    } finally {
      process.env.TZ = original;
    }
    expect(formatMessageTime("2026-07-22T03:00:00.000Z", new Date("2026-07-22T12:00:00.000Z"))).toMatch(/^3:00\sAM$/u);
  });

  it("reuses its date formatters across transcript rows", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
    const construct = vi.spyOn(Intl, "DateTimeFormat");
    for (let row = 0; row < 50; row += 1) {
      formatMessageTime("2026-07-22T09:05:00.000Z");
      formatMessageTime("2026-07-21T16:14:00.000Z");
      formatMessageTime("2025-12-31T16:14:00.000Z");
      formatFullDateTime("2026-07-21T16:14:00.000Z");
    }
    expect(construct.mock.calls.length).toBeLessThanOrEqual(4);
    construct.mockRestore();
  });

  it("dates message times from earlier days and years", () => {
    const now = new Date("2026-07-22T12:00:00.000Z");

    expect(formatMessageTime("2026-07-22T09:05:00.000Z", now)).toMatch(/^9:05\sAM$/u);
    expect(formatMessageTime("2026-07-21T16:14:00.000Z", now)).toMatch(/^Jul 21, 4:14\sPM$/u);
    expect(formatMessageTime("2025-12-31T16:14:00.000Z", now)).toMatch(/^Dec 31, 2025, 4:14\sPM$/u);
    expect(formatFullDateTime("2026-07-21T16:14:00.000Z")).toMatch(/^Tuesday, July 21, 2026 at 4:14\sPM$/u);
  });
});
