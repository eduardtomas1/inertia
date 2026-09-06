import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mascotBounds, readMascotWindowState, supportsMascotPlacement, writeMascotWindowState } from "../../src/main/mascot-placement";
import { emptyMascotStatus, parseMascotPreferences, parseMascotStatus } from "../../src/shared/mascot";
import { parseRuntimeWorkerEvent } from "../../src/node/runtime-process-protocol";

const primary = { workArea: { x: 0, y: 24, width: 1440, height: 876 } };
const secondary = { workArea: { x: -1920, y: -200, width: 1920, height: 1080 } };

describe("mascot placement and contracts", () => {
  it("leaves native Wayland placement to the compositor without changing app platform flags", () => {
    expect(supportsMascotPlacement("darwin", {}, "")).toBe(true);
    expect(supportsMascotPlacement("win32", {}, "")).toBe(true);
    expect(supportsMascotPlacement("linux", {}, "")).toBe(true);
    expect(supportsMascotPlacement("linux", { WAYLAND_DISPLAY: "wayland-0" }, "")).toBe(false);
    expect(supportsMascotPlacement("linux", {}, "wayland")).toBe(false);
    expect(supportsMascotPlacement("linux", { WAYLAND_DISPLAY: "wayland-0" }, "x11")).toBe(true);
  });
  it("clamps the entire overlay after drag, monitor removal, and scale changes", () => {
    expect(mascotBounds({ x: -2000, y: -300 }, [primary, secondary])).toEqual({ x: -1920, y: -200, width: 240, height: 240 });
    expect(mascotBounds({ x: -1800, y: -150 }, [primary])).toEqual({ x: 0, y: 24, width: 240, height: 240 });
    expect(mascotBounds({ x: 1439, y: 899 }, [primary])).toEqual({ x: 1200, y: 660, width: 240, height: 240 });
    expect(mascotBounds(null, [primary])).toEqual({ x: 1176, y: 636, width: 240, height: 240 });
  });

  it("defaults off and atomically persists enablement, motion, and placement", () => {
    const directory = mkdtempSync(join(tmpdir(), "mascot-state-"));
    try {
      const path = join(directory, "state.json");
      expect(readMascotWindowState(path).preferences.enabled).toBe(false);
      const state = { preferences: { enabled: true, motion: false }, position: { x: -1800, y: 40 } };
      writeMascotWindowState(path, state);
      expect(readMascotWindowState(path)).toEqual(state);
      writeMascotWindowState(path, { ...state, position: null });
      expect(readMascotWindowState(path).position).toBeNull();
      writeFileSync(path, "{");
      expect(readMascotWindowState(path).preferences.enabled).toBe(false);
      writeFileSync(path, " ".repeat(2048));
      expect(readMascotWindowState(path).preferences.enabled).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects malformed preferences, unknown phases, extra payload, and broken identity", () => {
    expect(parseMascotPreferences({ enabled: "yes", motion: true })).toBeNull();
    expect(parseMascotPreferences({ enabled: true, motion: true, path: "/tmp" })).toBeNull();
    for (const value of [null, { ...emptyMascotStatus(), phase: "thinking" },
      { ...emptyMascotStatus(), conversationId: "chat" }, { ...emptyMascotStatus(), activeCount: Infinity },
      { ...emptyMascotStatus(), text: "secret" }, { ...emptyMascotStatus(), phase: "running" }]) {
      expect(parseMascotStatus(value)).toBeNull();
      expect(parseRuntimeWorkerEvent({ type: "runtime.mascot-status", status: value })).toBeNull();
    }
    expect(parseRuntimeWorkerEvent({ type: "runtime.mascot-status", status: emptyMascotStatus() }))
      .toEqual({ type: "runtime.mascot-status", status: emptyMascotStatus() });
  });
});
