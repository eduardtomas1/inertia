import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Rectangle } from "electron";
import { parseMascotPreferences, type MascotPreferences } from "../shared/mascot.js";
import type { WindowBoundsDisplay } from "./window-bounds.js";

export const MASCOT_SIZE = { width: 240, height: 316 };
export const MASCOT_FIGURE = { x: 72, y: 212, width: 96, height: 98 };
export const MASCOT_ARTWORK = { x: 89, y: 214, width: 60, height: 88 };
export const MASCOT_BUBBLE_BOTTOM = 192;
const LEGACY_HEIGHT = 240;
const POSITION_LIMIT = 8;

export type MascotDisplay = WindowBoundsDisplay & { id?: number };

export function supportsMascotPlacement(
  platform: string, environment: NodeJS.ProcessEnv, ozonePlatform: string,
): boolean {
  return platform !== "linux" || ozonePlatform === "x11"
    || (ozonePlatform !== "wayland" && !environment.WAYLAND_DISPLAY
      && environment.XDG_SESSION_TYPE !== "wayland");
}
export interface MascotPosition {
  display: number | null;
  x: number;
  y: number;
}

export interface MascotWindowState {
  preferences: MascotPreferences;
  positions: MascotPosition[];
}

function parsePositions(value: unknown): MascotPosition[] | null {
  if (!Array.isArray(value) || value.length > POSITION_LIMIT) return null;
  const positions: MascotPosition[] = [];
  for (const item of value as Array<Partial<MascotPosition> | null>) {
    if (!item || !Number.isSafeInteger(item.x) || !Number.isSafeInteger(item.y)
      || (item.display !== null && !Number.isSafeInteger(item.display))) return null;
    positions.push({ display: item.display!, x: item.x!, y: item.y! });
  }
  return positions;
}

export function readMascotWindowState(path: string): MascotWindowState {
  const fallback = { preferences: { enabled: false, motion: true }, positions: [] };
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_024) return fallback;
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<MascotWindowState> & { position?: { x?: unknown; y?: unknown } | null };
    const legacy = value.position && Number.isSafeInteger(value.position.x) && Number.isSafeInteger(value.position.y)
      ? [{ display: null, x: value.position.x as number, y: (value.position.y as number) - (MASCOT_SIZE.height - LEGACY_HEIGHT) }] : [];
    return {
      preferences: parseMascotPreferences(value.preferences) ?? fallback.preferences,
      positions: parsePositions(value.positions) ?? legacy,
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
  position: { x: number; y: number } | null,
  displays: readonly MascotDisplay[],
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

export function mascotPosition(
  positions: readonly MascotPosition[], displays: readonly MascotDisplay[],
): { x: number; y: number } | null {
  const position = positions.find(({ display }) => display !== null && displays.some(({ id }) => id === display)) ?? positions[0];
  return position ? { x: position.x, y: position.y } : null;
}

export function mascotDisplay(bounds: Rectangle, displays: readonly MascotDisplay[]): number | null {
  const x = bounds.x + MASCOT_FIGURE.x + MASCOT_FIGURE.width / 2;
  const y = bounds.y + MASCOT_FIGURE.y + MASCOT_FIGURE.height / 2;
  const distance = ({ workArea: area }: MascotDisplay): number => (
    Math.max(area.x - x, 0, x - area.x - area.width) ** 2 + Math.max(area.y - y, 0, y - area.y - area.height) ** 2
  );
  const nearest = displays.reduce<MascotDisplay | undefined>((best, next) => !best || distance(next) < distance(best) ? next : best, undefined);
  return nearest?.id ?? null;
}

export function rememberMascotPosition(
  positions: readonly MascotPosition[], bounds: Rectangle, displays: readonly MascotDisplay[],
): MascotPosition[] {
  const display = mascotDisplay(bounds, displays);
  return [{ display, x: bounds.x, y: bounds.y }, ...positions.filter((position) => position.display !== display)].slice(0, POSITION_LIMIT);
}
