import { describe, expect, it } from "vitest";

describe("test environment", () => {
  it("pins the locale variables and time zone on every platform", () => {
    expect([process.env.LANG, process.env.LC_ALL, process.env.TZ])
      .toEqual(["en_US.UTF-8", "en_US.UTF-8", "UTC"]);
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("UTC");
    expect(new Date(0).getHours()).toBe(0);
  });

  it.skipIf(process.platform === "win32")("formats with the pinned ICU locale where the environment controls it", () => {
    expect(new Intl.NumberFormat().resolvedOptions().locale).toBe("en-US");
    expect((8000).toLocaleString()).toBe("8,000");
  });
});
