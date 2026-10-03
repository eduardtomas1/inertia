import { describe, expect, it } from "vitest";

import { defaultSettings } from "../../src/shared/contracts/app";
import {
  RESTORE_DEFAULTS_CONFIRMATION,
  RESTORE_DEFAULTS_KEEPS,
  RESTORE_DEFAULTS_RESETS,
  restoredDefaultSettings,
} from "../../src/shared/restore-defaults";

describe("restore defaults copy", () => {
  it("names a category for every setting the command writes and nothing it does not write", () => {
    const written = Object.keys(restoredDefaultSettings(defaultSettings)).sort();
    const listed = RESTORE_DEFAULTS_RESETS.flatMap(({ keys }) => [...keys]).sort();
    expect(listed).toEqual(written);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("states every reset and kept item in the confirmation", () => {
    for (const { label } of RESTORE_DEFAULTS_RESETS) expect(RESTORE_DEFAULTS_CONFIRMATION).toContain(label);
    for (const kept of RESTORE_DEFAULTS_KEEPS) expect(RESTORE_DEFAULTS_CONFIRMATION).toContain(kept);
  });

  it("keeps imported sounds", () => {
    const library = [{ file: "0123456789abcdef.wav" as const, name: "Bell" }];
    expect(restoredDefaultSettings({ completionSound: { ...defaultSettings.completionSound, library } }).completionSound)
      .toEqual({ ...defaultSettings.completionSound, library });
  });
});
