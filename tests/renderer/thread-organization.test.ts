import { describe, expect, it } from "vitest";
import { threadSnoozePresets, canOrganizeThread } from "../../src/shared/thread-organization";
import { conversation } from "./composer-fixtures";

describe("thread organization", () => {
  it("uses local calendar boundaries and never offers a past evening or Monday", () => {
    for (const date of [new Date(2026, 2, 28, 22), new Date(2026, 9, 24, 22), new Date(2026, 8, 7, 20)]) {
      const presets = threadSnoozePresets(date);
      expect(presets.some(({ id }) => id === "evening")).toBe(false);
      expect(presets.every(({ until }) => Date.parse(until) > date.getTime())).toBe(true);
      const tomorrow = new Date(presets.find(({ id }) => id === "tomorrow")!.until);
      expect(tomorrow.getHours()).toBe(9);
      const expected = new Date(date); expected.setDate(date.getDate() + 1);
      expect(tomorrow.getDate()).toBe(expected.getDate());
      const monday = new Date(presets.find(({ id }) => id === "next-week")!.until);
      expect(monday.getDay()).toBe(1); expect(monday.getHours()).toBe(9);
      expect(Date.parse(presets[0]!.until) - date.getTime()).toBe(3600000);
    }
  });
  it("keeps active and human-waiting threads out of settlement and snooze", () => {
    const chat = conversation("thread");
    expect(canOrganizeThread(chat, [])).toBe(true);
    expect(canOrganizeThread({ ...chat, status: "running" }, [])).toBe(false);
    expect(canOrganizeThread({ ...chat, status: "needs-input" }, [])).toBe(false);
  });
});
