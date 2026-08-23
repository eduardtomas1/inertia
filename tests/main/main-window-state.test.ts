import { describe, expect, it } from "vitest";

import {
  MAIN_WINDOW_DEFAULT_STATE,
  restoreMainWindowState,
} from "../../src/main/main-window-state";

const displays = [{
  workArea: { x: 0, y: 24, width: 1_440, height: 876 },
}];

describe("main window state", () => {
  it("restores a reachable title bar in device-independent work-area bounds", () => {
    expect(restoreMainWindowState({
      x: -40,
      y: 8,
      width: 1_200,
      height: 760,
      maximized: true,
    }, displays)).toEqual({
      x: -40,
      y: 8,
      width: 1_200,
      height: 760,
      maximized: true,
    });
  });

  it("drops stale positions after monitor removal and rejects one-pixel intersections", () => {
    expect(restoreMainWindowState({
      x: 1_439,
      y: 100,
      width: 900,
      height: 700,
      maximized: false,
    }, displays)).toEqual({ width: 900, height: 700, maximized: false });
    expect(restoreMainWindowState({
      x: 200,
      y: 880,
      width: 900,
      height: 700,
      maximized: false,
    }, displays)).toEqual({ width: 900, height: 700, maximized: false });
    expect(restoreMainWindowState({
      x: 200,
      y: -680,
      width: 900,
      height: 900,
      maximized: false,
    }, displays)).toEqual({ width: 900, height: 900, maximized: false });
  });

  it("clamps usable sizes and defaults malformed state", () => {
    expect(restoreMainWindowState({
      x: 20,
      y: 30,
      width: 100,
      height: 9_000,
      maximized: false,
    }, displays)).toEqual({
      x: 20,
      y: 30,
      width: 760,
      height: 3_000,
      maximized: false,
    });
    expect(restoreMainWindowState({ width: "wide" }, displays)).toEqual(
      MAIN_WINDOW_DEFAULT_STATE,
    );
  });
});
