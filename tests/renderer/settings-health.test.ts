import { describe, expect, it } from "vitest";

import { formatHealthBytes } from "../../src/renderer/src/components/StorageStatusSettings";
import { formatBytes } from "../../src/renderer/src/utils/formatBytes";

describe("settings health presentation", () => {
  it("formats bounded byte counts in binary units without overstating precision", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1_024)).toBe("1.0 KiB");
    expect(formatBytes(12 * 1_024)).toBe("12 KiB");
    expect(formatBytes(5.5 * 1_024 * 1_024)).toBe("5.5 MiB");
    expect(formatBytes(16 * 1_024 ** 3)).toBe("16 GiB");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  it("renders an unavailable metric honestly", () => {
    expect(formatHealthBytes(null)).toBe("Unavailable");
    expect(formatHealthBytes(1_024)).toBe("1.0 KiB");
  });
});
