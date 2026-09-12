import { describe, expect, it } from "vitest";
import { updatePercent, updatePresentation } from "../../src/renderer/src/components/sidebar/appUpdatePresentation";
import { updateStatus } from "../support/app-update-fixture";

describe("sidebar update actions", () => {
  it.each([
    ["idle", "idle", "check"], ["checking", "checking", "none"], ["current", "idle", "check"],
    ["available", "available", "download"], ["downloading", "downloading", "none"],
    ["cancelled", "available", "download"], ["downloaded", "downloaded", "install"],
    ["installing", "installing", "none"], ["unavailable", "attention", "check"], ["failed", "attention", "download"],
  ] as const)("%s has an accurate icon and safe action", (state, icon, action) => {
    expect(updatePresentation(updateStatus({ state }), false)).toMatchObject({ icon, action });
  });
  it("never retries installation after uncertain shutdown and never installs an unknown candidate", () => {
    expect(updatePresentation(updateStatus({ state: "failed", installBlocker: "shutdown" }), false).action).toBe("none");
    expect(updatePresentation(updateStatus({ state: "downloaded", installBlocker: "shutdown" }), false).action).toBe("none");
    expect(updatePresentation(updateStatus({ state: "downloaded", latestVersion: null }), false).action).toBe("none");
    expect(updatePresentation(updateStatus({ state: "downloaded", installBlocker: "active-work" }), false))
      .toMatchObject({ icon: "attention", action: "install" });
  });
  it("uses manual release handoff, never a native download, and keeps progress authoritative while checking", () => {
    expect(updatePresentation(updateStatus({ delivery: "manual" }), false).action).toBe("release");
    expect(updatePresentation(updateStatus({ delivery: "manual", releaseUrl: null }), false).action).toBe("check");
    expect(updatePresentation(updateStatus({ state: "downloading" }), true).icon).toBe("downloading");
    expect(updatePresentation(null, false).action).toBe("check");
    expect(updatePresentation(updateStatus(), true).action).toBe("none");
  });
  it.each([undefined, NaN, Infinity, -Infinity])("does not invent a percentage for %s", (value) => expect(updatePercent(value)).toBeNull());
  it("clamps and rounds real progress", () => {
    expect(updatePercent(42.7)).toBe(43); expect(updatePercent(-1)).toBe(0); expect(updatePercent(120)).toBe(100);
  });
});
