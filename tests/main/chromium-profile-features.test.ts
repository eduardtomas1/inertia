import { describe, expect, it, vi } from "vitest";

import {
  disableShutdownBlockingProfileFeatures,
  SHUTDOWN_BLOCKING_PROFILE_FEATURES,
  withShutdownBlockingProfileFeaturesDisabled,
} from "../../src/main/chromium-profile-features";

describe("shutdown-blocking Chromium profile features", () => {
  it("disables the bounce-tracking and declarative performance observer stores", () => {
    expect(SHUTDOWN_BLOCKING_PROFILE_FEATURES).toEqual(["DIPS", "DeclarativePerformanceObserver"]);
    expect(withShutdownBlockingProfileFeaturesDisabled(""))
      .toBe("DIPS,DeclarativePerformanceObserver");
  });

  it("preserves features already disabled by the launcher without duplicating ours", () => {
    expect(withShutdownBlockingProfileFeaturesDisabled(" CalculateNativeWinOcclusion, ,DIPS "))
      .toBe("CalculateNativeWinOcclusion,DIPS,DeclarativePerformanceObserver");
  });

  it("merges into the live command line through one disable-features switch", () => {
    const commandLine = {
      getSwitchValue: vi.fn(() => "HardwareMediaKeyHandling"),
      appendSwitch: vi.fn(),
    };
    disableShutdownBlockingProfileFeatures(commandLine);
    expect(commandLine.getSwitchValue).toHaveBeenCalledWith("disable-features");
    expect(commandLine.appendSwitch).toHaveBeenCalledExactlyOnceWith(
      "disable-features",
      "HardwareMediaKeyHandling,DIPS,DeclarativePerformanceObserver",
    );
  });
});
