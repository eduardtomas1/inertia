import { describe, expect, it } from "vitest";

import { formatStorageBytes } from "../../src/renderer/src/components/SettingsView";

describe("settings health presentation", () => {
  it("formats bounded byte counts without overstating precision", () => {
    expect(formatStorageBytes(0)).toBe("0 B");
    expect(formatStorageBytes(1_024)).toBe("1.0 KB");
    expect(formatStorageBytes(12 * 1_024)).toBe("12 KB");
    expect(formatStorageBytes(5.5 * 1_024 * 1_024)).toBe("5.5 MB");
    expect(formatStorageBytes(Number.NaN)).toBe("0 B");
  });
});
