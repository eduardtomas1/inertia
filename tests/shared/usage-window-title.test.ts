import { describe, expect, it } from "vitest";

import { usageLimitName, usageWindowDurationTitle, usageWindowTitle } from "../../src/shared/usage-window-title";

describe("usage window titles", () => {
  it("names Codex slots by what their duration means and never repeats the duration", () => {
    expect(usageWindowTitle({ id: "codex:primary", label: "Codex usage", windowMinutes: 300 })).toBe("Session");
    expect(usageWindowTitle({ id: "codex:secondary", label: "Codex usage · secondary", windowMinutes: 10_080 })).toBe("Weekly");
    expect(usageWindowTitle({ id: "codex:primary", label: "Codex usage", windowMinutes: 180 })).toBe("3-hour window");
    expect(usageWindowTitle({ id: "codex:primary", label: "Codex usage", windowMinutes: null })).toBe("Codex usage");
    expect(usageWindowTitle({ id: "codex_spark:secondary", label: "Spark · secondary", windowMinutes: 10_080 })).toBe("Spark · Weekly");
  });

  it("keeps a provider's own window name as it is", () => {
    expect(usageWindowTitle({ id: "claude:seven_day", label: "Weekly", windowMinutes: 10_080 })).toBe("Weekly");
    expect(usageWindowTitle({ id: "claude:seven_day_overage_included", label: "Weekly · Fable", windowMinutes: 10_080 })).toBe("Weekly · Fable");
    expect(usageWindowTitle({ id: "opencode:go_rolling", label: "Go · Session", windowMinutes: 300 })).toBe("Go · Session");
  });

  it("names a limit so it reads naturally and never doubles a word", () => {
    expect(usageLimitName({ id: "claude:five_hour", label: "Session", windowMinutes: 300 })).toBe("Session limit");
    expect(usageLimitName({ id: "claude:seven_day", label: "Weekly", windowMinutes: 10_080 })).toBe("Weekly limit");
    expect(usageLimitName({ id: "claude:seven_day_overage_included", label: "Weekly · Fable", windowMinutes: 10_080 })).toBe("Weekly limit · Fable");
    expect(usageLimitName({ id: "codex:primary", label: "Codex usage", windowMinutes: 300 })).toBe("Session limit");
    expect(usageLimitName({ id: "codex:primary", label: "Codex usage", windowMinutes: 180 })).toBe("3-hour limit");
    expect(usageLimitName({ id: "codex_spark:secondary", label: "Spark · secondary", windowMinutes: 10_080 })).toBe("Spark · Weekly limit");
    expect(usageLimitName({ id: "opencode:go_rolling", label: "Go · Session", windowMinutes: 300 })).toBe("Go · Session limit");
    expect(usageLimitName({ id: "claude:overage", label: "Extra usage", windowMinutes: null })).toBe("Extra usage limit");
    expect(usageLimitName({ id: "five-hour", label: "Five-hour limit", windowMinutes: 300 })).toBe("Five-hour limit");
  });

  it("titles a duration once", () => {
    expect(usageWindowDurationTitle(300)).toBe("Session");
    expect(usageWindowDurationTitle(10_080)).toBe("Weekly");
    expect(usageWindowDurationTitle(1_440)).toBe("Daily");
    expect(usageWindowDurationTitle(4_320)).toBe("3-day window");
    expect(usageWindowDurationTitle(45)).toBe("45-minute window");
    expect(usageWindowDurationTitle(null)).toBeNull();
    expect(usageWindowDurationTitle(0)).toBeNull();
  });
});
