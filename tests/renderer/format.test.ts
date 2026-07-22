import { afterEach, describe, expect, it, vi } from "vitest";

import { formatRelativeTime } from "../../src/renderer/src/lib/format";

describe("renderer time labels", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the English interface language independent of the operating-system locale", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));

    expect(formatRelativeTime("2026-07-22T11:59:59.000Z")).toBe("1 second ago");
    expect(formatRelativeTime("2026-07-20T12:00:00.000Z")).toBe("2 days ago");
  });
});
