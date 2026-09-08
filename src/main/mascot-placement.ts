import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Rectangle } from "electron";
import { parseMascotPreferences, type MascotPreferences } from "../shared/mascot.js";
import type { WindowBoundsDisplay } from "./window-bounds.js";

export const MASCOT_SIZE = { width: 240, height: 240 };

export function supportsMascotPlacement(
  platform: string, environment: NodeJS.ProcessEnv, ozonePlatform: string,
): boolean {
  return platform !== "linux" || ozonePlatform === "x11"
    || (ozonePlatform !== "wayland" && !environment.WAYLAND_DISPLAY
      && environment.XDG_SESSION_TYPE !== "wayland");
}
export interface MascotWindowState {
  preferences: MascotPreferences;
  position: { x: number; y: number } | null;
}

export function readMascotWindowState(path: string): MascotWindowState {
  const fallback = { preferences: { enabled: false, motion: true }, position: null };
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_024) return fallback;
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<MascotWindowState>;
    return {
      preferences: parseMascotPreferences(value.preferences) ?? fallback.preferences,
      position: value.position && Number.isSafeInteger(value.position.x)
        && Number.isSafeInteger(value.position.y)
        ? { x: value.position.x, y: value.position.y } : null,
    };
  } catch { return fallback; }
}

export function writeMascotWindowState(path: string, state: MascotWindowState): void {
  // Atomic replacement avoids following a destination symlink or saving half a drag.
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

/** Clamp the entire small overlay in DIP coordinates, including negative displays. */
export function mascotBounds(
  position: MascotWindowState["position"],
  displays: readonly WindowBoundsDisplay[],
  anchor = position,
): Rectangle {
  const areas = displays.map(({ workArea }) => workArea)
    .filter(({ width, height }) => width > 0 && height > 0);
  const fallback = areas[0] ?? { x: 0, y: 0, width: 1_024, height: 768 };
  const point = position ?? {
    x: fallback.x + fallback.width - MASCOT_SIZE.width - 24,
    y: fallback.y + fallback.height - MASCOT_SIZE.height - 24,
  };
  // On drop the cursor chooses the display, even when the overlay still spans
  // a seam. Restoration and keyboard placement use the saved top-left point.
  const target = anchor ?? point;
  const distance = (area: Rectangle): number => (
    Math.max(area.x - target.x, 0, target.x - area.x - area.width + 1) ** 2
    + Math.max(area.y - target.y, 0, target.y - area.y - area.height + 1) ** 2
  );
  const area = areas.reduce((best, next) => distance(next) < distance(best) ? next : best, fallback);
  const width = Math.min(MASCOT_SIZE.width, area.width);
  const height = Math.min(MASCOT_SIZE.height, area.height);
  return {
    x: Math.round(Math.max(area.x, Math.min(point.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(point.y, area.y + area.height - height))),
    width, height,
  };
}
