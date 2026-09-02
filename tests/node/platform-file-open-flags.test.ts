import { constants as fsConstants } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolvePlatformFileOpenFlags } from
  "../../src/node/platform-file-open-flags";

describe("platform file open flags", () => {
  it("corrects Electron 44 Linux ARM64 snapshot constants", () => {
    expect(resolvePlatformFileOpenFlags({
      platform: "linux",
      architecture: "arm64",
      constants: {
        O_DIRECTORY: 0x1_0000,
        O_NOFOLLOW: 0x2_0000,
      },
    })).toEqual({
      directory: 0x4000,
      noFollow: 0x8000,
    });
  });

  it("preserves runtime constants on other platforms", () => {
    expect(resolvePlatformFileOpenFlags({
      platform: "darwin",
      architecture: "arm64",
      constants: fsConstants,
    })).toEqual({
      directory: fsConstants.O_DIRECTORY ?? 0,
      noFollow: fsConstants.O_NOFOLLOW ?? 0,
    });
  });
});
