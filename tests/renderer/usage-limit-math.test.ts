import { describe, expect, it } from "vitest";

import {
  elapsedShare,
  formatLimitDuration,
  limitChipText,
  limitCountdown,
  limitPace,
  limitReadings,
  limitRemaining,
  limitResetText,
  limitRestoreWidth,
  limitWindowKind,
  paceOfShares,
  paceRemainingPercent,
  type LimitWindowValue,
} from "../../src/renderer/src/components/usage/limitMath";

const NOW = Date.parse("2026-11-11T10:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = (offset: number): string => new Date(NOW + offset).toISOString();
const window = (id: string, remainingPercent: number | null, windowMinutes: number | null, resetsAt: string | null): LimitWindowValue => (
  { id, remainingPercent, windowMinutes, resetsAt }
);
const reading = (remainingPercent: number | null, windowMinutes: number | null, resetsAt: string | null) => (
  limitReadings([window("plain", remainingPercent, windowMinutes, resetsAt)], NOW)[0]!
);

describe("pace of a limit window", () => {
  it("places the marker at the share of the window's time still left", () => {
    expect(paceRemainingPercent(reading(84, 10_080, at(78 * HOUR)), NOW)).toBe(46);
    expect(paceRemainingPercent(reading(50, 300, at(150 * MINUTE)), NOW)).toBe(50);
    expect(paceRemainingPercent(reading(50, 300, at(300 * MINUTE)), NOW)).toBe(100);
    expect(paceRemainingPercent(reading(50, 300, at(900 * MINUTE)), NOW)).toBe(100);
  });

  it("has no marker without a reset time, a window length or once the reset has passed", () => {
    expect(paceRemainingPercent(reading(50, 300, null), NOW)).toBeNull();
    expect(paceRemainingPercent(reading(50, null, at(HOUR)), NOW)).toBeNull();
    expect(paceRemainingPercent(reading(50, 300, "not a date"), NOW)).toBeNull();
    expect(paceRemainingPercent(reading(50, 300, at(-MINUTE)), NOW)).toBeNull();
    expect(elapsedShare({ resetsAt: at(HOUR), windowMinutes: 0 }, NOW)).toBeNull();
  });

  it("calls the pace ahead above five points, under below minus five and on pace in between", () => {
    expect(paceOfShares(55.1, 0.5)).toBe("ahead");
    expect(paceOfShares(55, 0.5)).toBe("on");
    expect(paceOfShares(45, 0.5)).toBe("on");
    expect(paceOfShares(44.9, 0.5)).toBe("under");
    expect(limitPace(reading(84, 10_080, at(78 * HOUR)), NOW)).toBe("under");
    expect(limitPace(reading(0, 10_080, at(23.5 * HOUR)), NOW)).toBe("ahead");
    expect(limitPace(reading(50, 300, at(150 * MINUTE)), NOW)).toBe("on");
  });

  it("gives no pace when the window cannot be timed or its quota is unknown", () => {
    expect(limitPace(reading(99, null, at(9 * HOUR)), NOW)).toBeNull();
    expect(limitPace(reading(null, 300, at(HOUR)), NOW)).toBeNull();
    expect(limitPace(reading(40, 300, at(-HOUR)), NOW)).toBeNull();
  });
});

describe("reset countdown", () => {
  it("floors to days and hours, hours and minutes, or minutes", () => {
    expect(formatLimitDuration(3 * DAY + 6 * HOUR + 59 * MINUTE)).toBe("3d 6h");
    expect(formatLimitDuration(DAY)).toBe("1d 0h");
    expect(formatLimitDuration(23 * HOUR + 33 * MINUTE + 59_000)).toBe("23h 33m");
    expect(formatLimitDuration(12 * MINUTE + 59_000)).toBe("12m");
    expect(formatLimitDuration(-5)).toBe("0m");
  });

  it("names the chip and the compact line from one countdown", () => {
    const counting = limitCountdown(at(3 * DAY + 6 * HOUR), NOW);
    expect(limitChipText(counting)).toBe("↻ 3d 6h");
    expect(limitResetText(counting)).toBe("Resets in 3d 6h");
    const soon = limitCountdown(at(30_000), NOW);
    expect(limitChipText(soon)).toBe("Resets momentarily");
    expect(limitResetText(soon)).toBe("Resets momentarily");
    const due = limitCountdown(at(0), NOW);
    expect(limitChipText(due)).toBe("Reset due");
    expect(limitResetText(due)).toBe("Reset due · updating");
    for (const missing of [null, undefined, "soon"]) {
      expect(limitChipText(limitCountdown(missing, NOW))).toBeNull();
      expect(limitResetText(limitCountdown(missing, NOW))).toBeNull();
    }
  });
});

describe("limit readings", () => {
  it("rounds and bounds what is left and treats a missing measurement as unknown", () => {
    expect(limitRemaining(83.6)).toBe(84);
    expect(limitRemaining(-30)).toBe(0);
    expect(limitRemaining(130)).toBe(100);
    expect(limitRemaining(null)).toBeNull();
    expect(limitRemaining(Number.NaN)).toBeNull();
  });

  it("orders windows as session, weekly, monthly and other", () => {
    expect([300, 10_080, 43_200, null, 1_440, 20_160].map(limitWindowKind)).toEqual([0, 1, 2, 3, 0, 1]);
  });

  it("hatches what the next reset restores, and nothing without a reset time", () => {
    expect(limitRestoreWidth(reading(84, 10_080, at(DAY)))).toBe(16);
    expect(limitRestoreWidth(reading(100, 10_080, at(DAY)))).toBe(0);
    expect(limitRestoreWidth(reading(40, 10_080, null))).toBe(0);
    expect(limitRestoreWidth(reading(null, 10_080, at(DAY)))).toBe(0);
    expect(limitRestoreWidth(reading(40, 300, at(-MINUTE)))).toBe(100);
  });

  it("shows a session as used up while the same account's weekly limit is exhausted", () => {
    const [session, weekly] = limitReadings([
      window("codex:primary", 58, 300, at(2 * HOUR)),
      window("codex:secondary", 0, 10_080, at(23 * HOUR)),
    ], NOW);
    expect(session).toMatchObject({ remaining: 0, used: 100, restore: 100, resetsAt: at(23 * HOUR), windowMinutes: null });
    expect(limitPace(session!, NOW)).toBeNull();
    expect(paceRemainingPercent(session!, NOW)).toBeNull();
    expect(weekly).toMatchObject({ remaining: 0, restore: 100, windowMinutes: 10_080 });
  });

  it("restores only the unused session share when the session outlives the weekly reset", () => {
    const [partial] = limitReadings([
      window("claude:five_hour", 70, 300, at(4 * HOUR)),
      window("claude:seven_day", 0, 10_080, at(HOUR)),
    ], NOW);
    expect(partial).toMatchObject({ remaining: 0, restore: 70, resetsAt: at(HOUR) });
    const [spent] = limitReadings([
      window("claude:five_hour", 0, 300, at(4 * HOUR)),
      window("claude:seven_day", 0, 10_080, at(HOUR)),
    ], NOW);
    expect(spent).toMatchObject({ remaining: 0, restore: 100, resetsAt: at(4 * HOUR) });
  });

  it("drops the countdown when either reset is unknown or already behind the reading", () => {
    const [unknown] = limitReadings([
      window("codex:primary", 58, 300, null),
      window("codex:secondary", 0, 10_080, at(DAY)),
    ], NOW);
    expect(unknown).toMatchObject({ remaining: 0, restore: 0, resetsAt: null });
    const [behind] = limitReadings([
      window("codex:primary", 58, 300, at(HOUR)),
      window("codex:secondary", 0, 10_080, at(DAY)),
    ], NOW, at(2 * HOUR));
    expect(behind).toMatchObject({ remaining: 0, restore: 0, resetsAt: null });
  });

  it("leaves the session alone for model weekly limits, other providers and a passed weekly reset", () => {
    expect(limitReadings([
      window("claude:five_hour", 70, 300, at(HOUR)),
      window("claude:seven_day_overage_included", 0, 10_080, at(DAY)),
    ], NOW)[0]).toMatchObject({ remaining: 70, windowMinutes: 300 });
    expect(limitReadings([
      window("opencode:session", 70, 300, at(HOUR)),
      window("opencode:weekly", 0, 10_080, at(DAY)),
    ], NOW)[0]).toMatchObject({ remaining: 70 });
    expect(limitReadings([
      window("codex:primary", 70, 300, at(HOUR)),
      window("codex:secondary", 0, 10_080, at(-MINUTE)),
    ], NOW)[0]).toMatchObject({ remaining: 70, due: false });
  });

  it("marks a window whose reset has passed as due instead of trusting its old percentage", () => {
    expect(reading(12, 300, at(-5_000))).toMatchObject({ due: true, remaining: 12 });
    expect(reading(12, 300, at(5_000))).toMatchObject({ due: false });
  });
});
