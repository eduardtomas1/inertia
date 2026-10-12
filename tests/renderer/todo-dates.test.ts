import { afterEach, describe, expect, it } from "vitest";

import {
  localDateKey,
  todoDueLabel,
  todoDuePresetDate,
} from "../../src/renderer/src/utils/todoDates";

const originalTimeZone = process.env.TZ;

afterEach(() => {
  process.env.TZ = originalTimeZone;
});

describe("task due dates", () => {
  it("labels due days from the local calendar day, not the UTC one", () => {
    process.env.TZ = "Pacific/Auckland";
    const now = new Date("2026-10-12T11:30:00.000Z");
    expect(localDateKey(now)).toBe("2026-10-13");
    expect(todoDueLabel("2026-10-13", now)).toBe("Today");
    expect(todoDueLabel("2026-10-14", now)).toBe("Tomorrow");
    expect(todoDueLabel("2026-10-15", now)).toBe("Thu");
    expect(todoDueLabel("2026-10-19", now)).toBe("Mon");
    expect(todoDueLabel("2026-10-20", now)).toBe("20 Oct");
    expect(todoDueLabel("2026-10-12", now)).toBe("12 Oct");

    process.env.TZ = "America/Los_Angeles";
    const evening = new Date("2026-10-13T05:30:00.000Z");
    expect(localDateKey(evening)).toBe("2026-10-12");
    expect(todoDueLabel("2026-10-12", evening)).toBe("Today");
    expect(todoDueLabel("2026-10-13", evening)).toBe("Tomorrow");
  });

  it("keeps the year on dates outside the current one", () => {
    const now = new Date(2026, 11, 28, 9);
    expect(todoDueLabel("2027-01-02", now)).toBe("Sat");
    expect(todoDueLabel("2027-01-05", now)).toBe("5 Jan 2027");
    expect(todoDueLabel("2025-12-28", now)).toBe("28 Dec 2025");
  });

  it("builds presets in local time across month and year boundaries", () => {
    const thursday = new Date(2026, 11, 31, 23, 45);
    expect(todoDuePresetDate("today", thursday)).toBe("2026-12-31");
    expect(todoDuePresetDate("tomorrow", thursday)).toBe("2027-01-01");
    expect(todoDuePresetDate("next-week", thursday)).toBe("2027-01-04");

    const sunday = new Date(2026, 9, 18, 8);
    expect(todoDuePresetDate("next-week", sunday)).toBe("2026-10-19");
    const monday = new Date(2026, 9, 12, 8);
    expect(todoDuePresetDate("next-week", monday)).toBe("2026-10-19");
  });

  it("crosses a daylight saving change without skipping a day", () => {
    process.env.TZ = "Europe/Madrid";
    const saturday = new Date(2026, 9, 24, 23, 30);
    expect(todoDuePresetDate("tomorrow", saturday)).toBe("2026-10-25");
    expect(todoDuePresetDate("next-week", saturday)).toBe("2026-10-26");
    expect(todoDueLabel("2026-10-26", saturday)).toBe("Mon");
    expect(todoDueLabel("2026-10-31", saturday)).toBe("31 Oct");
  });
});
