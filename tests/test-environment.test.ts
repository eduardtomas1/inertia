import { describe, expect, it } from "vitest";

describe("test environment", () => {
  it("pins the locale and time zone so runs are hermetic", () => {
    expect([process.env.LANG, process.env.LC_ALL, process.env.TZ])
      .toEqual(["en_US.UTF-8", "en_US.UTF-8", "UTC"]);
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("UTC");
    expect(new Date(0).getHours()).toBe(0);
  });
});
