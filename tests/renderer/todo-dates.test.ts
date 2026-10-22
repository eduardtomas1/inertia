import { afterEach, describe, expect, it } from "vitest";

import {
  addMonthsToDateKey,
  formatTodoDay,
  formatTodoTime,
  localDateKey,
  parseTodoTime,
  todoDueInstant,
  todoDueLabel,
  todoDuePresetDate,
  todoIsOverdue,
  todoWeekStart,
} from "../../src/renderer/src/utils/todoDates";

const originalTimeZone = process.env.TZ;

afterEach(() => {
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
});

const due = (dueDate: string | null, dueTime: string | null = null) => ({ dueDate, dueTime });
const label = (dueDate: string | null, dueTime: string | null, now: Date) => todoDueLabel(due(dueDate, dueTime), now);
const time = formatTodoTime;

describe("task due labels", () => {
  const wednesdayNoon = new Date(2026, 9, 21, 12, 0);

  it("formats times through the interface locale", () => {
    expect(time("15:00")).toMatch(/^3:00\sPM$/u);
    expect(time("09:05")).toMatch(/^9:05\sAM$/u);
    expect(time("00:00")).toMatch(/^12:00\sAM$/u);
    expect(time("bad")).toBe("bad");
  });

  it("returns nothing without a due day", () => {
    expect(label(null, null, wednesdayNoon)).toBeNull();
  });

  it("labels today with and without a time", () => {
    expect(label("2026-10-21", null, wednesdayNoon)).toEqual({ text: "Today", overdue: false, today: true });
    expect(label("2026-10-21", "15:00", wednesdayNoon)).toEqual({ text: `Today ${time("15:00")}`, overdue: false, today: true });
    expect(label("2026-10-21", "09:00", wednesdayNoon)).toEqual({ text: `Today ${time("09:00")}`, overdue: true, today: true });
  });

  it("labels late days as whole days overdue without the time", () => {
    expect(label("2026-10-20", null, wednesdayNoon)).toEqual({ text: "Overdue · 1 d", overdue: true, today: false });
    expect(label("2026-10-20", "18:00", wednesdayNoon)).toEqual({ text: "Overdue · 1 d", overdue: true, today: false });
    expect(label("2026-10-09", null, wednesdayNoon)).toEqual({ text: "Overdue · 12 d", overdue: true, today: false });
  });

  it("labels tomorrow, the coming week and later days", () => {
    expect(label("2026-10-22", null, wednesdayNoon)).toEqual({ text: "Tomorrow", overdue: false, today: false });
    expect(label("2026-10-22", "09:00", wednesdayNoon)?.text).toBe(`Tomorrow ${time("09:00")}`);
    expect(label("2026-10-23", null, wednesdayNoon)?.text).toBe("Fri");
    expect(label("2026-10-23", "14:30", wednesdayNoon)?.text).toBe(`Fri ${time("14:30")}`);
    expect(label("2026-10-27", null, wednesdayNoon)?.text).toBe("Tue");
    expect(label("2026-10-28", null, wednesdayNoon)?.text).toBe("28 Oct");
    expect(label("2026-10-28", "10:00", wednesdayNoon)?.text).toBe(`28 Oct ${time("10:00")}`);
    expect(label("2026-12-31", null, wednesdayNoon)).toEqual({ text: "31 Dec", overdue: false, today: false });
  });

  it("keeps the year on days outside the current one", () => {
    const now = new Date(2026, 11, 28, 9);
    expect(label("2027-01-02", null, now)?.text).toBe("Sat");
    expect(label("2027-02-03", null, now)?.text).toBe("3 Feb 2027");
    expect(label("2027-02-03", "10:00", now)?.text).toBe(`3 Feb 2027 ${time("10:00")}`);
  });

  it("rolls over the year at midnight", () => {
    const newYearsEve = new Date(2026, 11, 31, 23, 30);
    expect(label("2027-01-01", null, newYearsEve)?.text).toBe("Tomorrow");
    expect(label("2026-12-31", "23:00", newYearsEve)).toEqual({ text: `Today ${time("23:00")}`, overdue: true, today: true });
    const newYear = new Date(2027, 0, 1, 0, 1);
    expect(label("2026-12-31", null, newYear)).toEqual({ text: "Overdue · 1 d", overdue: true, today: false });
    expect(label("2027-01-01", null, newYear)?.text).toBe("Today");
  });

  it("turns yesterday into one day overdue one minute after midnight", () => {
    const justAfterMidnight = new Date(2026, 9, 22, 0, 1);
    expect(label("2026-10-21", null, justAfterMidnight)).toEqual({ text: "Overdue · 1 d", overdue: true, today: false });
    expect(label("2026-10-21", "23:59", justAfterMidnight)?.text).toBe("Overdue · 1 d");
    expect(label("2026-10-22", null, justAfterMidnight)).toEqual({ text: "Today", overdue: false, today: true });
  });

  it("labels days from the local calendar day, not the UTC one", () => {
    process.env.TZ = "Pacific/Auckland";
    const now = new Date("2026-10-12T11:30:00.000Z");
    expect(localDateKey(now)).toBe("2026-10-13");
    expect(label("2026-10-13", null, now)?.text).toBe("Today");
    expect(label("2026-10-14", null, now)?.text).toBe("Tomorrow");
    expect(label("2026-10-15", null, now)?.text).toBe("Thu");
    expect(label("2026-10-20", null, now)?.text).toBe("20 Oct");
    expect(label("2026-10-12", null, now)?.text).toBe("Overdue · 1 d");

    process.env.TZ = "America/Los_Angeles";
    const evening = new Date("2026-10-13T05:30:00.000Z");
    expect(localDateKey(evening)).toBe("2026-10-12");
    expect(label("2026-10-12", null, evening)?.text).toBe("Today");
    expect(label("2026-10-13", null, evening)?.text).toBe("Tomorrow");
  });

  it("handles a due time on the spring-forward day", () => {
    process.env.TZ = "Europe/Madrid";
    const saturdayNight = new Date(2027, 2, 27, 22, 0);
    expect(label("2027-03-28", "02:30", saturdayNight)).toEqual({ text: `Tomorrow ${time("02:30")}`, overdue: false, today: false });
    expect(label("2027-04-03", null, new Date(2027, 2, 27, 12))?.text).toBe("3 Apr");
    expect(label("2027-04-02", null, new Date(2027, 2, 26, 12))?.text).toBe("2 Apr");
    expect(label("2027-03-26", null, new Date(2027, 2, 28, 12))?.text).toBe("Overdue · 2 d");

    const instant = todoDueInstant(due("2027-03-28", "02:30") as { dueDate: string; dueTime: string });
    expect(instant.getDate()).toBe(28);
    expect(instant.getHours()).toBe(3);
    expect(instant.getMinutes()).toBe(30);

    const beforeTheGap = new Date(2027, 2, 28, 1, 30);
    expect(label("2027-03-28", "02:30", beforeTheGap)).toEqual({ text: `Today ${time("02:30")}`, overdue: false, today: true });
    const afterTheGap = new Date(2027, 2, 28, 4, 0);
    expect(label("2027-03-28", "02:30", afterTheGap)?.overdue).toBe(true);
    expect(label("2027-03-28", "15:00", afterTheGap)).toEqual({ text: `Today ${time("15:00")}`, overdue: false, today: true });
  });

  it("crosses the autumn daylight saving change without skipping a day", () => {
    process.env.TZ = "Europe/Madrid";
    const saturday = new Date(2026, 9, 24, 23, 30);
    expect(todoDuePresetDate("tomorrow", saturday)).toBe("2026-10-25");
    expect(todoDuePresetDate("next-week", saturday)).toBe("2026-10-26");
    expect(label("2026-10-26", null, saturday)?.text).toBe("Mon");
    expect(label("2026-10-31", null, saturday)?.text).toBe("31 Oct");
  });
});

describe("task due instants and overdue checks", () => {
  it("reads due days as local wall-clock times", () => {
    const untimed = todoDueInstant({ dueDate: "2026-10-21", dueTime: null });
    expect([untimed.getFullYear(), untimed.getMonth(), untimed.getDate(), untimed.getHours(), untimed.getMinutes()]).toEqual([2026, 9, 21, 0, 0]);
    const timed = todoDueInstant({ dueDate: "2026-10-21", dueTime: "15:45" });
    expect([timed.getHours(), timed.getMinutes()]).toEqual([15, 45]);
  });

  it("is overdue only after the day or the time has passed", () => {
    const now = new Date(2026, 9, 21, 12, 0);
    expect(todoIsOverdue(due(null), now)).toBe(false);
    expect(todoIsOverdue(due("2026-10-21"), now)).toBe(false);
    expect(todoIsOverdue(due("2026-10-21", "12:00"), now)).toBe(false);
    expect(todoIsOverdue(due("2026-10-21", "11:59"), now)).toBe(true);
    expect(todoIsOverdue(due("2026-10-21", "12:01"), now)).toBe(false);
    expect(todoIsOverdue(due("2026-10-20", "23:59"), now)).toBe(true);
    expect(todoIsOverdue(due("2026-10-22", "00:00"), now)).toBe(false);
  });
});

describe("task due times", () => {
  it.each([
    ["15", "15:00"],
    ["1500", "15:00"],
    ["15:00", "15:00"],
    ["3pm", "15:00"],
    ["3:30 pm", "15:30"],
    ["15.30", "15:30"],
    ["9", "09:00"],
    ["930", "09:30"],
    ["0930", "09:30"],
    [" 7:05 ", "07:05"],
    ["12am", "00:00"],
    ["12pm", "12:00"],
    ["12:30 AM", "00:30"],
    ["3 p.m.", "15:00"],
    ["11a", "11:00"],
    ["3:00 PM", "15:00"],
    ["15h30", "15:30"],
    ["00:00", "00:00"],
    ["23:59", "23:59"],
  ])("parses %j as %s", (input, expected) => {
    expect(parseTodoTime(input)).toBe(expected);
  });

  it.each(["24:00", "7:60", "abc", "", "  ", "13pm", "0am", "25", "15:3", "1:2:3", "12345", "pm", "-1"])("rejects %j", (input) => {
    expect(parseTodoTime(input)).toBeNull();
  });

  it("reads back what it displays", () => {
    for (const value of ["00:00", "09:05", "12:00", "15:30", "23:59"]) {
      expect(parseTodoTime(formatTodoTime(value))).toBe(value);
    }
  });
});

describe("task due presets", () => {
  it("builds presets in local time across month and year boundaries", () => {
    const thursday = new Date(2026, 11, 31, 23, 45);
    expect(todoDuePresetDate("today", thursday)).toBe("2026-12-31");
    expect(todoDuePresetDate("tomorrow", thursday)).toBe("2027-01-01");
    expect(todoDuePresetDate("next-week", thursday)).toBe("2027-01-04");

    const monday = new Date(2026, 9, 12, 8);
    expect(todoDuePresetDate("next-week", monday)).toBe("2026-10-19");
  });

  it("resolves next week on a Sunday to the Monday eight days out", () => {
    const sunday = new Date(2026, 9, 18, 8);
    expect(todoDuePresetDate("tomorrow", sunday)).toBe("2026-10-19");
    expect(todoDuePresetDate("next-week", sunday)).toBe("2026-10-26");
  });

  it("shows the resolved day beside each preset", () => {
    const wednesday = new Date(2026, 9, 21, 12);
    expect(formatTodoDay(todoDuePresetDate("today", wednesday))).toBe("Wed 21 Oct");
    expect(formatTodoDay(todoDuePresetDate("tomorrow", wednesday))).toBe("Thu 22 Oct");
    expect(formatTodoDay(todoDuePresetDate("next-week", wednesday))).toBe("Mon 26 Oct");
    expect(formatTodoDay(todoDuePresetDate("next-week", new Date(2026, 11, 31)))).toBe("Mon 4 Jan");
  });
});

describe("task calendar helpers", () => {
  it("moves by months without spilling into the next one", () => {
    expect(addMonthsToDateKey("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsToDateKey("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonthsToDateKey("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonthsToDateKey("2026-01-15", -1)).toBe("2025-12-15");
  });

  it("starts the week on the locale's first day, else Monday", () => {
    expect(todoWeekStart("en-US")).toBe(0);
    expect(todoWeekStart("es-ES")).toBe(1);
    expect(todoWeekStart("ca")).toBe(1);
    expect(todoWeekStart("ar-EG")).toBe(6);
    expect(todoWeekStart("not a locale")).toBe(1);
  });
});
